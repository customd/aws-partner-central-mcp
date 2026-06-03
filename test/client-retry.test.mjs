// Tests for the client retry/re-auth policy (AWS-documented strategy):
//  - retry transient network errors, INTERNAL_ERROR (-32603), LIMIT_EXCEEDED (-32004)
//  - re-auth ONCE on AUTHENTICATION_FAILURE (-32001) / HTTP 401, then stop
//  - do not retry other errors
// The TS `private` modifiers are compile-time only, so we stub invokeOnce at
// runtime and count attempts. Run: node test/client-retry.test.mjs

import assert from "node:assert/strict";
import {
  PartnerCentralClient,
  PartnerCentralError,
} from "../server/services/partner-central-client.js";

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

function makeClient() {
  const c = new PartnerCentralClient({
    endpoint: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
    region: "us-east-1",
    defaultCatalog: "Sandbox",
    sso: {
      startUrl: "https://acme.awsapps.com/start",
      accountId: "123456789012",
      roleName: "TestRole",
      region: "us-east-1",
    },
  });
  // Stub the (instance) backoff sleep so retry tests assert attempt COUNTS without
  // actually waiting — the throttle backoff is deliberately long in real use.
  c.sleep = async () => {};
  return c;
}

await test("non-retryable error (INVALID_REQUEST) → single attempt", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError("bad request", -32600, 400);
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 1);
});

await test("LIMIT_EXCEEDED (-32004) is retried up to the max", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError("rate limited", -32004, 200);
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 3);
});

await test("live throttle shape (HTTP 400 'Rate exceeded') is retried", async () => {
  // The live endpoint returns HTTP 400 with this body for throttling — NOT the
  // documented -32004. classifyRetry must treat it as a throttle (retryable).
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError(
      'Partner Central returned HTTP 400: {"message":"Rate exceeded. Try again later."}',
      undefined,
      400,
      '{"message":"Rate exceeded. Try again later."}',
    );
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 3);
});

await test("HTTP 429 (too many requests) is retried", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError("Partner Central returned HTTP 429", undefined, 429, "");
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 3);
});

await test("HTTP 400 that is NOT a throttle (bad request) is not retried", async () => {
  // Critical: throttle detection keys on the body text, not httpStatus===400, so a
  // genuine 400 bad-request must still be non-retryable (single attempt).
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError(
      "Partner Central returned HTTP 400: invalid parameter 'stage'",
      undefined,
      400,
      "invalid parameter 'stage'",
    );
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 1);
});

await test("throttle backoff is longer than transient backoff", async () => {
  // Throttle must back off across the ~30s sendMessage refill window — far longer
  // than the short transient/5xx backoff.
  const throttle = makeClient();
  const throttleDelays = [];
  throttle.sleep = async (ms) => {
    throttleDelays.push(ms);
  };
  throttle.invokeOnce = async () => {
    throw new PartnerCentralError("Rate exceeded. Try again later.", undefined, 400, "Rate exceeded");
  };
  await assert.rejects(() => throttle.callTool("sendMessage", {}));

  const transient = makeClient();
  const transientDelays = [];
  transient.sleep = async (ms) => {
    transientDelays.push(ms);
  };
  transient.invokeOnce = async () => {
    throw new PartnerCentralError("ECONNRESET", undefined, undefined, undefined, true);
  };
  await assert.rejects(() => transient.callTool("sendMessage", {}));

  assert.ok(throttleDelays.length > 0 && transientDelays.length > 0);
  assert.ok(
    Math.min(...throttleDelays) > Math.max(...transientDelays),
    `throttle delays ${JSON.stringify(throttleDelays)} should all exceed transient ${JSON.stringify(transientDelays)}`,
  );
});

await test("transient network errors are retried", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError("ECONNRESET", undefined, undefined, undefined, true);
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  assert.equal(n, 3);
});

await test("AUTHENTICATION_FAILURE (-32001) re-auths once, then stops", async () => {
  const c = makeClient();
  let n = 0;
  let invalidated = 0;
  c.resolver.invalidate = () => {
    invalidated += 1;
  };
  c.invokeOnce = async () => {
    n += 1;
    throw new PartnerCentralError("auth failed", -32001, 401);
  };
  await assert.rejects(() => c.callTool("sendMessage", {}));
  // attempt1 → reauth → attempt2 → reauthAttempted, decision none → stop
  assert.equal(n, 2);
  assert.equal(invalidated, 1);
});

await test("HTTP 500 is retried; eventual success returns the result", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    if (n < 2) throw new PartnerCentralError("server error", undefined, 500);
    return { ok: true };
  };
  const result = await c.callTool("sendMessage", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(n, 2);
});

await test("a successful first attempt is not retried", async () => {
  const c = makeClient();
  let n = 0;
  c.invokeOnce = async () => {
    n += 1;
    return { content: [] };
  };
  await c.callTool("sendMessage", {});
  assert.equal(n, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
