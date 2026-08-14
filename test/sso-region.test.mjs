// Tests for the SSO region / Partner Central region split (GitHub issue #2).
//
// The reporter needed to sign in via IAM Identity Center in eu-central-1, but the
// extension drove BOTH the SSO calls and the SigV4 signing off one region. Forcing
// the region to eu-central-1 fixed sign-in and then broke Partner Central, which is
// us-east-1 only. These are two independent regions and must stay independent.
//
// Everything here is hermetic: the routing test records the resolved request host in
// the SDK's build phase and then aborts, so no credentials and no network are needed.
// Run: node test/sso-region.test.mjs

import assert from "node:assert/strict";
import { SSOOIDCClient, RegisterClientCommand } from "@aws-sdk/client-sso-oidc";
import { SSOClient, ListAccountsCommand } from "@aws-sdk/client-sso";
import { loadConfig, ConfigError } from "../server/config.js";
import { signRequest } from "../server/services/signer.js";
import { isCachedTokenUsable } from "../server/services/sso-auth.js";
import { DEFAULT_REGION, DEFAULT_SSO_REGION, SERVICE_NAME } from "../server/constants.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    fail += 1;
  }
}

const BASE_ENV = { AWS_SSO_START_URL: "https://example.awsapps.com/start" };

/** Run loadConfig() with a controlled environment. */
function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AWS_") || k.startsWith("PARTNER_CENTRAL_")) delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// --- config: the two regions are independent --------------------------------

await test("defaults: both regions are us-east-1 (existing users are unaffected)", () => {
  const c = withEnv(BASE_ENV, loadConfig);
  assert.equal(c.region, DEFAULT_REGION);
  assert.equal(c.sso.region, DEFAULT_SSO_REGION);
});

await test("AWS_SSO_REGION moves ONLY the SSO region, never the signing region", () => {
  const c = withEnv({ ...BASE_ENV, AWS_SSO_REGION: "eu-central-1" }, loadConfig);
  assert.equal(c.sso.region, "eu-central-1", "sign-in must go to eu-central-1");
  assert.equal(c.region, "us-east-1", "Partner Central must stay us-east-1 — the reporter's 2nd failure");
});

await test("ambient AWS_REGION no longer hijacks either region", () => {
  // AWS_REGION is not a manifest field: it leaks in from the user's shell. Honouring
  // it silently broke signing for anyone who exports it (issue #2's likely first half).
  const c = withEnv({ ...BASE_ENV, AWS_REGION: "eu-central-1" }, loadConfig);
  assert.equal(c.region, "us-east-1", "signing region must ignore AWS_REGION");
  assert.equal(c.sso.region, "us-east-1", "SSO region must be set explicitly, not inherited");
});

await test("signing region is derived from the endpoint, so it always matches it", () => {
  const c = withEnv(
    {
      ...BASE_ENV,
      PARTNER_CENTRAL_ENDPOINT: "https://partnercentral-agents-mcp.eu-west-1.api.aws/mcp",
      AWS_SSO_REGION: "ap-southeast-2",
    },
    loadConfig,
  );
  assert.equal(c.region, "eu-west-1", "must track the endpoint host, not a constant");
  assert.equal(c.sso.region, "ap-southeast-2");
});

await test("a malformed AWS_SSO_REGION is rejected at startup with a clear message", () => {
  assert.throws(
    () => withEnv({ ...BASE_ENV, AWS_SSO_REGION: "Europe" }, loadConfig),
    (err) => err instanceof ConfigError && /not a valid AWS region/.test(err.message),
  );
});

await test("a blank optional sso_region placeholder is treated as unset (gotcha #7)", () => {
  // Claude Desktop substitutes the LITERAL "${user_config.sso_region}" when blank.
  const c = withEnv({ ...BASE_ENV, AWS_SSO_REGION: "${user_config.sso_region}" }, loadConfig);
  assert.equal(c.sso.region, DEFAULT_SSO_REGION, "must not crash at startup");
});

await test("non-standard partitions are accepted (gov/iso)", () => {
  const c = withEnv({ ...BASE_ENV, AWS_SSO_REGION: "us-gov-west-1" }, loadConfig);
  assert.equal(c.sso.region, "us-gov-west-1");
});

// --- SigV4: the credential scope follows the endpoint, not the SSO region ----

await test("signRequest scopes credentials to the Partner Central region only", async () => {
  const signed = await signRequest({
    url: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
    method: "POST",
    body: "{}",
    service: SERVICE_NAME,
    // The signing region comes from config.region — an eu-central-1 SSO user still
    // signs for us-east-1. Passing eu-central-1 here would reproduce the bug.
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token",
      expiration: new Date(Date.now() + 3_600_000),
    },
  });
  const auth = signed.headers.authorization ?? signed.headers.Authorization;
  assert.match(auth, /\/us-east-1\//, "credential scope must be us-east-1");
  assert.match(auth, new RegExp(`/${SERVICE_NAME}/`));
  assert.doesNotMatch(auth, /eu-central-1/);
});

// --- token cache: a token from another region must not be reused --------------

const live = () => new Date(Date.now() + 3_600_000).toISOString();

await test("cached token from the SAME region is reused", () => {
  assert.equal(isCachedTokenUsable({ region: "eu-central-1", expiresAt: live() }, "eu-central-1"), true);
});

await test("cached token from ANOTHER region is a cache miss (re-authorize)", () => {
  // The cache is keyed on sha1(startUrl) only and shared with the AWS CLI, so this
  // is reachable simply by changing AWS_SSO_REGION.
  assert.equal(isCachedTokenUsable({ region: "us-east-1", expiresAt: live() }, "eu-central-1"), false);
});

await test("expired token is a cache miss even in the right region", () => {
  const expired = new Date(Date.now() - 1_000).toISOString();
  assert.equal(isCachedTokenUsable({ region: "eu-central-1", expiresAt: expired }, "eu-central-1"), false);
});

await test("absent cache is a cache miss", () => {
  assert.equal(isCachedTokenUsable(null, "eu-central-1"), false);
});

// --- SDK routing: the region string reaches the right regional endpoint ------

/**
 * Resolve the host an AWS SDK client would call, without credentials or network:
 * record it in the build phase (after endpoint resolution, before signing) and abort.
 */
async function resolvedHost(client, command) {
  const sentinel = new Error("probe-abort");
  let host;
  client.middlewareStack.add(
    (next) => async (args) => {
      host = args.request?.hostname;
      throw sentinel;
    },
    { step: "build", name: "hostProbe" },
  );
  await client.send(command).catch((err) => {
    if (err !== sentinel) throw err;
  });
  return host;
}

for (const region of ["us-east-1", "eu-central-1", "ap-southeast-2"]) {
  await test(`SSO device flow + role lookup route to ${region}`, async () => {
    const oidcHost = await resolvedHost(
      new SSOOIDCClient({ region }),
      new RegisterClientCommand({ clientName: "probe", clientType: "public" }),
    );
    const ssoHost = await resolvedHost(
      new SSOClient({ region }),
      new ListAccountsCommand({ accessToken: "probe" }),
    );
    assert.equal(oidcHost, `oidc.${region}.amazonaws.com`);
    assert.equal(ssoHost, `portal.sso.${region}.amazonaws.com`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
