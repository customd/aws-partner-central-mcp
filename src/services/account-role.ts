import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

import { logger } from "../logger.js";

export interface AccountRoleSelection {
  accountId: string;
  roleName: string;
}

export interface AccountRoleOption extends AccountRoleSelection {
  /** Human-friendly label shown in the picker, e.g. "Acme Prod (1234…) · PartnerCentral-Executives". */
  label: string;
}

/**
 * Asks the user to choose among multiple account/role options (e.g. via an MCP
 * elicitation dropdown). Returns the chosen selection, or null if the client
 * can't prompt or the user declined.
 */
export type ElicitAccountRole = (
  options: AccountRoleOption[],
) => Promise<AccountRoleSelection | null>;

/** Thrown when multiple options exist and no selection could be made (no picker / declined). */
export class NeedsSelectionError extends Error {
  constructor(public readonly options: AccountRoleOption[]) {
    super(
      "Multiple AWS Partner Central accounts/roles are available — a selection is required.",
    );
    this.name = "NeedsSelectionError";
  }
}

/** Thrown when the signed-in user has no usable account/role. */
export class NoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAccessError";
  }
}

// ---------------------------------------------------------------------------
// Persistence — the extension's OWN non-secret selection cache (account + role
// pointers, no credentials). Keyed by SSO start URL so orgs don't collide.
// ---------------------------------------------------------------------------
function selectionDir(): string {
  return path.join(os.homedir(), ".aws-partner-central");
}
function selectionFile(startUrl: string): string {
  const hash = createHash("sha1").update(startUrl).digest("hex");
  return path.join(selectionDir(), `selection-${hash}.json`);
}

export async function readSelection(startUrl: string): Promise<AccountRoleSelection | null> {
  try {
    const raw = await fs.readFile(selectionFile(startUrl), "utf-8");
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.accountId === "string" && typeof p.roleName === "string") {
      return { accountId: p.accountId, roleName: p.roleName };
    }
  } catch {
    /* no persisted selection */
  }
  return null;
}

export async function writeSelection(
  startUrl: string,
  sel: AccountRoleSelection,
): Promise<void> {
  try {
    const dir = selectionDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    const finalPath = selectionFile(startUrl);
    const tmp = `${finalPath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(sel, null, 2), { mode: 0o600 });
    await fs.rename(tmp, finalPath);
  } catch (err) {
    logger.warn("Could not persist account/role selection", {
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export interface ResolveDeps {
  startUrl: string;
  configAccountId?: string;
  configRoleName?: string;
  listAccounts: () => Promise<Array<{ accountId: string; accountName?: string }>>;
  listAccountRoles: (accountId: string) => Promise<string[]>;
  readSelection?: (startUrl: string) => Promise<AccountRoleSelection | null>;
  writeSelection?: (startUrl: string, sel: AccountRoleSelection) => Promise<void>;
  elicit?: ElicitAccountRole;
}

function makeLabel(
  accountId: string,
  accountName: string | undefined,
  roleName: string,
): string {
  const acct = accountName ? `${accountName} (${accountId})` : accountId;
  return `${acct} · ${roleName}`;
}

/**
 * Determine the effective account ID + role name:
 *   1. explicit config (both set) → use as-is
 *   2. previously persisted choice (respecting any config hint) → use
 *   3. discover via SSO; single combo → auto-use + persist;
 *      multiple → elicit (dropdown) + persist, else throw NeedsSelectionError
 */
export async function resolveAccountRole(deps: ResolveDeps): Promise<AccountRoleSelection> {
  if (deps.configAccountId && deps.configRoleName) {
    return { accountId: deps.configAccountId, roleName: deps.configRoleName };
  }

  const persisted = deps.readSelection ? await deps.readSelection(deps.startUrl) : null;
  if (
    persisted &&
    (!deps.configAccountId || persisted.accountId === deps.configAccountId) &&
    (!deps.configRoleName || persisted.roleName === deps.configRoleName)
  ) {
    return persisted;
  }

  const accounts = await deps.listAccounts();
  const nameById = new Map(accounts.map((a) => [a.accountId, a.accountName]));
  const accountIds = deps.configAccountId
    ? [deps.configAccountId]
    : accounts.map((a) => a.accountId);

  const options: AccountRoleOption[] = [];
  for (const accountId of accountIds) {
    let roles = await deps.listAccountRoles(accountId);
    if (deps.configRoleName) roles = roles.filter((r) => r === deps.configRoleName);
    for (const roleName of roles) {
      options.push({
        accountId,
        roleName,
        label: makeLabel(accountId, nameById.get(accountId), roleName),
      });
    }
  }

  if (options.length === 0) {
    throw new NoAccessError(
      "No AWS accounts/roles were found for this sign-in. Confirm with your administrator that your IAM Identity Center user has a permission set granting Partner Central access.",
    );
  }
  if (options.length === 1) {
    const sel = { accountId: options[0].accountId, roleName: options[0].roleName };
    if (deps.writeSelection) await deps.writeSelection(deps.startUrl, sel);
    logger.info("Auto-detected a single Partner Central account/role");
    return sel;
  }

  if (deps.elicit) {
    const choice = await deps.elicit(options);
    if (choice) {
      if (deps.writeSelection) await deps.writeSelection(deps.startUrl, choice);
      return choice;
    }
  }
  throw new NeedsSelectionError(options);
}
