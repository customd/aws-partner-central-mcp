// Tests for configuration loading + validation (endpoint SSRF guard, role,
// account, start URL). Run: node test/config.test.mjs

import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../server/config.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    fail += 1;
  }
}

const KEYS = [
  "AWS_SSO_START_URL",
  "AWS_SSO_ACCOUNT_ID",
  "AWS_SSO_ROLE_NAME",
  "AWS_REGION",
  "PARTNER_CENTRAL_ENDPOINT",
  "PARTNER_CENTRAL_DEFAULT_CATALOG",
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const base = {
  AWS_SSO_START_URL: "https://acme.awsapps.com/start",
  AWS_SSO_ACCOUNT_ID: "123456789012",
  AWS_SSO_ROLE_NAME: "PartnerCentral-Executives",
  AWS_REGION: "us-east-1",
  PARTNER_CENTRAL_DEFAULT_CATALOG: "Sandbox",
};

test("valid config loads with default endpoint", () => {
  const cfg = withEnv(base, () => loadConfig());
  assert.equal(cfg.sso.accountId, "123456789012");
  assert.equal(cfg.defaultCatalog, "Sandbox");
  assert.match(cfg.endpoint, /^https:\/\/partnercentral-agents-mcp\.us-east-1\.api\.aws\/mcp$/);
});

test("rejects non-12-digit account id", () => {
  assert.throws(
    () => withEnv({ ...base, AWS_SSO_ACCOUNT_ID: "123" }, () => loadConfig()),
    (e) => e instanceof ConfigError && /12 digits/.test(e.message),
  );
});

test("rejects non-awsapps start URL", () => {
  assert.throws(
    () => withEnv({ ...base, AWS_SSO_START_URL: "https://example.com/start" }, () => loadConfig()),
    (e) => e instanceof ConfigError && /awsapps\.com/.test(e.message),
  );
});

test("rejects endpoint on a non-AWS host (SSRF guard)", () => {
  assert.throws(
    () =>
      withEnv({ ...base, PARTNER_CENTRAL_ENDPOINT: "https://evil.example.com/mcp" }, () =>
        loadConfig(),
      ),
    (e) => e instanceof ConfigError && /api\.aws/.test(e.message),
  );
});

test("rejects non-HTTPS endpoint", () => {
  assert.throws(
    () =>
      withEnv({ ...base, PARTNER_CENTRAL_ENDPOINT: "http://x.us-east-1.api.aws/mcp" }, () =>
        loadConfig(),
      ),
    (e) => e instanceof ConfigError && /HTTPS/.test(e.message),
  );
});

test("accepts a valid endpoint override under *.api.aws", () => {
  const cfg = withEnv(
    { ...base, PARTNER_CENTRAL_ENDPOINT: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp" },
    () => loadConfig(),
  );
  assert.match(cfg.endpoint, /api\.aws\/mcp$/);
});

test("rejects a role name that looks like a URL/ARN", () => {
  assert.throws(
    () => withEnv({ ...base, AWS_SSO_ROLE_NAME: "https://acme.awsapps.com/start" }, () => loadConfig()),
    (e) => e instanceof ConfigError && /role name/.test(e.message),
  );
});

test("rejects missing required start URL", () => {
  const env = { ...base };
  delete env.AWS_SSO_START_URL;
  assert.throws(
    () => withEnv(env, () => loadConfig()),
    (e) => e instanceof ConfigError && /start URL is required/.test(e.message),
  );
});

test("loads with only the 3 required fields (trimmed install form)", () => {
  const cfg = withEnv(
    {
      AWS_SSO_START_URL: "https://acme.awsapps.com/start",
      AWS_SSO_ACCOUNT_ID: "123456789012",
      AWS_SSO_ROLE_NAME: "SomeRole",
    },
    () => loadConfig(),
  );
  // Region and catalog are not on the form anymore — code supplies defaults.
  assert.equal(cfg.region, "us-east-1");
  assert.equal(cfg.defaultCatalog, "AWS");
  assert.match(cfg.endpoint, /partnercentral-agents-mcp\.us-east-1\.api\.aws/);
});

test("loads with only the SSO start URL (account/role auto-detected later)", () => {
  const cfg = withEnv(
    { AWS_SSO_START_URL: "https://acme.awsapps.com/start" },
    () => loadConfig(),
  );
  assert.equal(cfg.sso.accountId, undefined);
  assert.equal(cfg.sso.roleName, undefined);
  assert.equal(cfg.region, "us-east-1");
  assert.equal(cfg.defaultCatalog, "AWS");
});

test("treats unsubstituted ${...} placeholders as unset (Claude Desktop blank optional fields)", () => {
  // Claude Desktop substitutes the literal "${user_config.x}" string for a
  // BLANK optional user_config field (it does not pass empty or omit the var).
  // The server must treat these as unset, not validate them as real values —
  // otherwise it exits at startup and Desktop reports "Could not attach".
  const cfg = withEnv(
    {
      AWS_SSO_START_URL: "https://acme.awsapps.com/start",
      AWS_SSO_ACCOUNT_ID: "${user_config.sso_account_id}",
      AWS_SSO_ROLE_NAME: "${user_config.sso_role_name}",
      PARTNER_CENTRAL_DEFAULT_CATALOG: "${user_config.default_catalog}",
    },
    () => loadConfig(),
  );
  assert.equal(cfg.sso.accountId, undefined);
  assert.equal(cfg.sso.roleName, undefined);
  assert.equal(cfg.defaultCatalog, "AWS");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
