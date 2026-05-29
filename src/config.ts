import {
  CATALOG_AWS,
  DEFAULT_ENDPOINT,
  DEFAULT_REGION,
  ENDPOINT_ALLOWED_HOST_SUFFIX,
  VALID_CATALOGS,
} from "./constants.js";
import type { PartnerCentralConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireEnv(name: string, friendly: string): string {
  const v = readEnv(name);
  if (v === undefined) {
    throw new ConfigError(
      `${friendly} is required. Set ${name} (configured via the Claude Desktop extension settings).`,
    );
  }
  return v;
}

function validateAccountId(accountId: string): void {
  if (!/^\d{12}$/.test(accountId)) {
    throw new ConfigError(
      `AWS account ID must be exactly 12 digits, got: '${accountId}'.`,
    );
  }
}

function validateStartUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`SSO start URL is not a valid URL: '${url}'.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError(`SSO start URL must use HTTPS: '${url}'.`);
  }
  if (!parsed.hostname.endsWith(".awsapps.com")) {
    throw new ConfigError(
      `SSO start URL must be an awsapps.com domain (got '${parsed.hostname}'). Example: https://your-org.awsapps.com/start`,
    );
  }
}

/**
 * The endpoint is SigV4-signed with temporary AWS credentials, so an
 * attacker-controlled value would exfiltrate those credentials in the
 * Authorization header. Restrict to HTTPS hosts under the AWS API domain.
 * (PARTNER_CENTRAL_ENDPOINT is not a manifest user_config field — this guards
 * against process-env injection / operator misconfiguration.)
 */
function validateEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`Partner Central endpoint is not a valid URL: '${url}'.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError(`Partner Central endpoint must use HTTPS: '${url}'.`);
  }
  if (!parsed.hostname.endsWith(ENDPOINT_ALLOWED_HOST_SUFFIX)) {
    throw new ConfigError(
      `Partner Central endpoint host must be an AWS '${ENDPOINT_ALLOWED_HOST_SUFFIX}' domain (got '${parsed.hostname}').`,
    );
  }
  return url;
}

function validateRoleName(roleName: string): string {
  if (!/^[\w+=,.@/-]{1,64}$/.test(roleName)) {
    throw new ConfigError(
      `AWS SSO role name '${roleName}' is invalid. Use the permission-set / role name (e.g. 'PartnerCentral-Executives'), not a URL or ARN.`,
    );
  }
  return roleName;
}

function validateCatalog(value: string): string {
  if (!VALID_CATALOGS.includes(value as (typeof VALID_CATALOGS)[number])) {
    throw new ConfigError(
      `Default catalog must be one of: ${VALID_CATALOGS.join(", ")}. Got: '${value}'.`,
    );
  }
  return value;
}

export function loadConfig(): PartnerCentralConfig {
  const startUrl = requireEnv("AWS_SSO_START_URL", "AWS SSO start URL");
  validateStartUrl(startUrl);

  // Account ID and role name are OPTIONAL — when omitted they are
  // auto-discovered from the SSO session (sso:ListAccounts/ListAccountRoles).
  // When provided they are validated and used as an explicit override.
  const accountId = readEnv("AWS_SSO_ACCOUNT_ID");
  if (accountId !== undefined) validateAccountId(accountId);

  const roleName = readEnv("AWS_SSO_ROLE_NAME");
  if (roleName !== undefined) validateRoleName(roleName);

  const region = readEnv("AWS_REGION") ?? DEFAULT_REGION;
  const endpoint = validateEndpoint(
    readEnv("PARTNER_CENTRAL_ENDPOINT") ?? DEFAULT_ENDPOINT,
  );
  const defaultCatalog = validateCatalog(
    readEnv("PARTNER_CENTRAL_DEFAULT_CATALOG") ?? CATALOG_AWS,
  );

  return {
    endpoint,
    region,
    defaultCatalog,
    sso: {
      startUrl,
      accountId,
      roleName,
      region,
    },
  };
}
