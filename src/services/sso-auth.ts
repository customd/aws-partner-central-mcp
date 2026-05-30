import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  AuthorizationPendingException,
  SlowDownException,
} from "@aws-sdk/client-sso-oidc";
import {
  SSOClient,
  GetRoleCredentialsCommand,
  ListAccountsCommand,
  ListAccountRolesCommand,
  UnauthorizedException,
} from "@aws-sdk/client-sso";

import { logger } from "../logger.js";
import {
  resolveAccountRole,
  buildAccountRoleOptions,
  readSelection,
  writeSelection,
  type AccountRoleOption,
  type AccountRoleSelection,
  type ElicitAccountRole,
} from "./account-role.js";
import type { AwsCredentials, SsoConfig } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * The minimal token shape persisted to disk. Note: client_id and client_secret
 * from RegisterClient are deliberately NOT persisted — they are only used during
 * the device flow and serve no purpose post-acquisition (we re-register on each
 * flow instead of refreshing tokens via the OIDC refresh_token grant).
 */
interface PersistedSsoToken {
  startUrl: string;
  region: string;
  accessToken: string;
  expiresAt: string;
}

function ssoCacheDir(): string {
  return path.join(os.homedir(), ".aws", "sso", "cache");
}

function tokenCacheFilename(startUrl: string): string {
  const hash = createHash("sha1").update(startUrl).digest("hex");
  return path.join(ssoCacheDir(), `${hash}.json`);
}

async function readTokenCache(startUrl: string): Promise<PersistedSsoToken | null> {
  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.readFile(tokenCacheFilename(startUrl), "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "string") {
    return null;
  }
  const result: PersistedSsoToken = {
    startUrl: typeof parsed.startUrl === "string" ? parsed.startUrl : startUrl,
    region: typeof parsed.region === "string" ? parsed.region : "us-east-1",
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
  };
  // Migrate legacy caches that carried clientId/clientSecret to the minimal shape.
  if ("clientId" in parsed || "clientSecret" in parsed || "registrationExpiresAt" in parsed) {
    logger.info("Migrating legacy SSO token cache to minimal shape (dropping clientSecret)");
    await writeTokenCache(result).catch((err) => {
      logger.warn("Failed to migrate token cache", { error: (err as Error).message });
    });
  }
  return result;
}

async function writeTokenCache(token: PersistedSsoToken): Promise<void> {
  const dir = ssoCacheDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is a no-op when the directory already exists (e.g. the AWS
  // CLI created it at 0o755), so tighten it explicitly. Tolerate EPERM.
  await fs.chmod(dir, 0o700).catch(() => {});
  const finalPath = tokenCacheFilename(token.startUrl);
  // Atomic write: write to temp then rename. fs.rename is atomic within a
  // filesystem on POSIX and Windows. Prevents partial-write corruption on crash.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Clean up the temp file if rename failed (e.g. cross-device)
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function deleteTokenCache(startUrl: string): Promise<void> {
  try {
    await fs.unlink(tokenCacheFilename(startUrl));
  } catch {
    /* ignore — cache may not exist */
  }
}

/**
 * Open a URL in the user's default browser using execFile (no shell).
 * The URL is also pre-validated as http(s); defense in depth against
 * shell-metacharacter injection if the AWS OIDC response is ever tampered with.
 */
async function openBrowser(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn("Refusing to open malformed URL in browser", {
      preview: url.slice(0, 80),
    });
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    logger.warn("Refusing to open non-http(s) URL in browser", {
      protocol: parsed.protocol,
    });
    return;
  }

  // Use the normalized href rather than the raw input (defense in depth).
  const href = parsed.href;
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await execFileAsync("open", [href]);
    } else if (platform === "win32") {
      // `start` is a cmd.exe built-in, so we must invoke cmd /c. The empty ""
      // is the window-title placeholder that `start` expects when its first
      // quoted argument would otherwise be interpreted as the title.
      await execFileAsync("cmd.exe", ["/c", "start", "", href]);
    } else {
      await execFileAsync("xdg-open", [href]);
    }
  } catch (err) {
    logger.warn("Could not open browser automatically", {
      error: (err as Error).message,
    });
  }
}

function isTokenLive(cache: PersistedSsoToken, skewMs = 60_000): boolean {
  return new Date(cache.expiresAt).getTime() > Date.now() + skewMs;
}

async function runDeviceFlow(config: SsoConfig): Promise<PersistedSsoToken> {
  const oidc = new SSOOIDCClient({ region: config.region });

  logger.info("Starting AWS SSO device authorization flow", {
    startUrl: config.startUrl,
    region: config.region,
  });

  const reg = await oidc.send(
    new RegisterClientCommand({
      clientName: "aws-partner-central-mcp",
      clientType: "public",
      scopes: ["sso:account:access"],
    }),
  );

  if (!reg.clientId || !reg.clientSecret) {
    throw new Error("SSO RegisterClient response missing clientId or clientSecret");
  }

  const dev = await oidc.send(
    new StartDeviceAuthorizationCommand({
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      startUrl: config.startUrl,
    }),
  );

  if (!dev.deviceCode || !dev.verificationUriComplete || !dev.verificationUri || !dev.userCode) {
    throw new Error("SSO StartDeviceAuthorization response is incomplete");
  }

  process.stderr.write(
    [
      "",
      "============================================================",
      "  AWS Partner Central MCP — sign-in required",
      "============================================================",
      `  Opening your browser to authorize this MCP server.`,
      `  If it does not open, visit: ${dev.verificationUri}`,
      `  and enter the code: ${dev.userCode}`,
      "============================================================",
      "",
    ].join("\n"),
  );

  await openBrowser(dev.verificationUriComplete);

  const intervalMs = (dev.interval ?? 5) * 1000;
  const expiresInSec = dev.expiresIn ?? 600;
  const deadline = Date.now() + expiresInSec * 1000;

  let pollIntervalMs = intervalMs;
  let accessToken: string | undefined;
  let tokenExpiresIn = 28_800;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const token = await oidc.send(
        new CreateTokenCommand({
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode: dev.deviceCode,
        }),
      );
      if (token.accessToken) {
        accessToken = token.accessToken;
        tokenExpiresIn = token.expiresIn ?? 28_800;
        break;
      }
    } catch (err) {
      if (err instanceof AuthorizationPendingException) continue;
      if (err instanceof SlowDownException) {
        // Back off, but cap so a late large sleep can't overshoot the deadline.
        pollIntervalMs = Math.min(pollIntervalMs + 5_000, 30_000);
        logger.warn("AWS SSO throttled device-flow polling; backing off", {
          pollIntervalMs,
        });
        continue;
      }
      throw err;
    }
  }

  if (!accessToken) {
    throw new Error(
      "AWS SSO authorization timed out. The browser window must be approved within ~10 minutes.",
    );
  }

  const cache: PersistedSsoToken = {
    startUrl: config.startUrl,
    region: config.region,
    accessToken,
    expiresAt: new Date(Date.now() + tokenExpiresIn * 1000).toISOString(),
  };

  await writeTokenCache(cache);
  logger.info("AWS SSO token acquired and cached", {
    expiresAt: cache.expiresAt,
  });
  return cache;
}

async function getOrAcquireSsoToken(config: SsoConfig): Promise<string> {
  const cached = await readTokenCache(config.startUrl);
  if (cached && isTokenLive(cached)) {
    logger.debug("Using cached SSO access token", {
      expiresAt: cached.expiresAt,
    });
    return cached.accessToken;
  }
  const fresh = await runDeviceFlow(config);
  return fresh.accessToken;
}

async function fetchRoleCredentials(
  sso: SSOClient,
  accessToken: string,
  accountId: string,
  roleName: string,
): Promise<AwsCredentials> {
  const resp = await sso.send(
    new GetRoleCredentialsCommand({ accessToken, accountId, roleName }),
  );
  const c = resp.roleCredentials;
  if (
    !c ||
    !c.accessKeyId ||
    !c.secretAccessKey ||
    !c.sessionToken ||
    c.expiration === undefined
  ) {
    throw new Error("sso:GetRoleCredentials returned an incomplete response");
  }
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    expiration: new Date(c.expiration),
  };
}

/** Enumerate the accounts the signed-in user can access (paginated). */
async function listAccounts(
  sso: SSOClient,
  accessToken: string,
): Promise<Array<{ accountId: string; accountName?: string }>> {
  const out: Array<{ accountId: string; accountName?: string }> = [];
  let nextToken: string | undefined;
  do {
    const resp = await sso.send(new ListAccountsCommand({ accessToken, nextToken }));
    for (const a of resp.accountList ?? []) {
      if (a.accountId) out.push({ accountId: a.accountId, accountName: a.accountName });
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return out;
}

/** Enumerate the role names available to the user in an account (paginated). */
async function listAccountRoles(
  sso: SSOClient,
  accessToken: string,
  accountId: string,
): Promise<string[]> {
  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await sso.send(
      new ListAccountRolesCommand({ accessToken, accountId, nextToken }),
    );
    for (const r of resp.roleList ?? []) {
      if (r.roleName) out.push(r.roleName);
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return out;
}

export class SsoCredentialResolver {
  private cached: AwsCredentials | null = null;
  private inflight: Promise<AwsCredentials> | null = null;
  private resolvedIdentity: AccountRoleSelection | null = null;

  constructor(
    private readonly config: SsoConfig,
    private readonly elicit?: ElicitAccountRole,
  ) {}

  /** The effective account/role once resolved (explicit, persisted, or discovered). */
  getResolvedIdentity(): AccountRoleSelection | null {
    return this.resolvedIdentity;
  }

  /**
   * Resolve AWS temporary credentials, sharing the in-flight refresh among
   * concurrent callers and caching the result until ~60s before expiry.
   *
   * Race-free: `this.cached` is set BEFORE `this.inflight` is cleared,
   * so a concurrent caller arriving between microtasks always sees either
   * a live cached value or the still-active inflight promise — never a
   * gap that would trigger a redundant device flow.
   */
  async resolve(): Promise<AwsCredentials> {
    if (
      this.cached &&
      this.cached.expiration.getTime() > Date.now() + 60_000
    ) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.refreshAndCache();
    return this.inflight;
  }

  /**
   * Evict the in-memory credential cache so the next resolve() fetches fresh
   * role credentials. Called when the endpoint rejects a signed request
   * (HTTP 401 / AUTHENTICATION_FAILURE) even though the creds looked live —
   * the cached temp credentials may have been revoked or expired early.
   */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Enumerate every account/role the signed-in user can access — used to present
   * an in-chat picker and to validate an explicit selection. Read-only; reuses the
   * cached SSO token (no extra browser sign-in unless the token is missing/expired).
   */
  async listAvailableAccountRoles(): Promise<AccountRoleOption[]> {
    const token = await getOrAcquireSsoToken(this.config);
    const sso = new SSOClient({ region: this.config.region });
    try {
      return await buildAccountRoleOptions({
        listAccounts: () => listAccounts(sso, token),
        listAccountRoles: (accountId) => listAccountRoles(sso, token, accountId),
        configAccountId: this.config.accountId,
        configRoleName: this.config.roleName,
      });
    } finally {
      sso.destroy();
    }
  }

  /**
   * Pin (or switch to) an explicit account/role: update the in-memory resolved
   * identity, persist it, and invalidate cached temp credentials so the next
   * request uses the new identity.
   */
  async setSelectedIdentity(sel: AccountRoleSelection): Promise<void> {
    this.resolvedIdentity = sel;
    await writeSelection(this.config.startUrl, sel);
    this.invalidate();
  }

  private async refreshAndCache(): Promise<AwsCredentials> {
    try {
      const fresh = await this.refresh();
      // Important: assign to `cached` BEFORE the finally clears `inflight`.
      // This closes the race where a concurrent caller could observe both
      // `inflight === null` and `cached === null` between microtask beats.
      this.cached = fresh;
      return fresh;
    } finally {
      this.inflight = null;
    }
  }

  private async refresh(): Promise<AwsCredentials> {
    let token = await getOrAcquireSsoToken(this.config);
    try {
      return await this.discoverAndFetch(token);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        logger.warn(
          "SSO access token rejected — re-running device flow",
        );
        await deleteTokenCache(this.config.startUrl);
        token = await getOrAcquireSsoToken(this.config);
        return await this.discoverAndFetch(token);
      }
      throw err;
    }
  }

  /**
   * Resolve the effective account/role (once), then fetch temporary
   * credentials for it. Account/role come from explicit config, a persisted
   * choice, or live discovery (sso:ListAccounts/ListAccountRoles) — with an
   * elicitation picker when the choice is ambiguous.
   */
  private async discoverAndFetch(token: string): Promise<AwsCredentials> {
    const sso = new SSOClient({ region: this.config.region });
    try {
      if (!this.resolvedIdentity) {
        this.resolvedIdentity = await resolveAccountRole({
          startUrl: this.config.startUrl,
          configAccountId: this.config.accountId,
          configRoleName: this.config.roleName,
          listAccounts: () => listAccounts(sso, token),
          listAccountRoles: (accountId) => listAccountRoles(sso, token, accountId),
          readSelection,
          writeSelection,
          elicit: this.elicit,
        });
      }
      return await fetchRoleCredentials(
        sso,
        token,
        this.resolvedIdentity.accountId,
        this.resolvedIdentity.roleName,
      );
    } finally {
      sso.destroy();
    }
  }
}
