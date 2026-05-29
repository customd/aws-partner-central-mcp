// Test SsoCredentialResolver concurrency: concurrent callers should share
// the same in-flight refresh (no double device flow), serial callers after
// a successful resolve should hit the cache.
//
// Run: node test/sso-resolver.test.mjs

import assert from "node:assert/strict";
import { SsoCredentialResolver } from "../server/services/sso-auth.js";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeResolver() {
  const r = new SsoCredentialResolver({
    startUrl: "https://example.awsapps.com/start",
    accountId: "111111111111",
    roleName: "TestRole",
    region: "us-east-1",
  });
  // Replace the internal refresh method with a controllable stub. The TS
  // `private` modifier is compile-time only, so this works at runtime.
  let count = 0;
  let delayMs = 20;
  let nextExpiration = () => new Date(Date.now() + 3600_000);
  r.refresh = async () => {
    count += 1;
    await sleep(delayMs);
    return {
      accessKeyId: `AKIA${count}`,
      secretAccessKey: "secret",
      sessionToken: "session",
      expiration: nextExpiration(),
    };
  };
  return {
    resolver: r,
    get count() { return count; },
    setDelay: (ms) => { delayMs = ms; },
    setExpiration: (fn) => { nextExpiration = fn; },
  };
}

await test("concurrent resolve() calls share one refresh", async () => {
  const { resolver, count, setDelay: _ } = (() => { const h = makeResolver(); h.setDelay(50); return h; })();
  const [a, b, c] = await Promise.all([
    resolver.resolve(),
    resolver.resolve(),
    resolver.resolve(),
  ]);
  // All three must get the same credentials object
  assert.equal(a.accessKeyId, b.accessKeyId);
  assert.equal(b.accessKeyId, c.accessKeyId);
});

await test("3 concurrent calls only invoke refresh ONCE", async () => {
  const handle = makeResolver();
  handle.setDelay(30);
  await Promise.all([
    handle.resolver.resolve(),
    handle.resolver.resolve(),
    handle.resolver.resolve(),
    handle.resolver.resolve(),
    handle.resolver.resolve(),
  ]);
  assert.equal(handle.count, 1, `expected 1 refresh call, got ${handle.count}`);
});

await test("serial resolve after success returns cached (no second refresh)", async () => {
  const handle = makeResolver();
  await handle.resolver.resolve();
  await handle.resolver.resolve();
  await handle.resolver.resolve();
  assert.equal(handle.count, 1);
});

await test("rapid sequential calls after a delay still cache", async () => {
  const handle = makeResolver();
  await handle.resolver.resolve();
  await sleep(10);
  await handle.resolver.resolve();
  await sleep(10);
  await handle.resolver.resolve();
  assert.equal(handle.count, 1);
});

await test("expired creds trigger exactly one refresh on next resolve", async () => {
  const handle = makeResolver();
  // First refresh returns creds expiring in the past
  handle.setExpiration(() => new Date(Date.now() - 1000));
  await handle.resolver.resolve();
  assert.equal(handle.count, 1);

  // Reset expiration so the next refresh returns live creds
  handle.setExpiration(() => new Date(Date.now() + 3600_000));
  await handle.resolver.resolve();
  assert.equal(handle.count, 2);
});

await test("burst of concurrent calls after cache expires shares one refresh", async () => {
  const handle = makeResolver();
  // Stale on first round, then fresh thereafter
  let isFirst = true;
  handle.setExpiration(() => {
    if (isFirst) { isFirst = false; return new Date(Date.now() - 1); }
    return new Date(Date.now() + 3600_000);
  });
  handle.setDelay(20);
  await handle.resolver.resolve();      // refresh #1 → returns stale creds
  // Now burst-call: stale cached, all should share one new refresh
  const burst = await Promise.all([
    handle.resolver.resolve(),
    handle.resolver.resolve(),
    handle.resolver.resolve(),
  ]);
  assert.equal(handle.count, 2, `expected 2 total refreshes, got ${handle.count}`);
  assert.equal(burst[0].accessKeyId, burst[1].accessKeyId);
  assert.equal(burst[1].accessKeyId, burst[2].accessKeyId);
});

await test("refresh error propagates to all concurrent callers", async () => {
  const handle = makeResolver();
  handle.resolver.refresh = async () => {
    await sleep(10);
    throw new Error("simulated SSO failure");
  };
  const results = await Promise.allSettled([
    handle.resolver.resolve(),
    handle.resolver.resolve(),
    handle.resolver.resolve(),
  ]);
  assert.ok(results.every((r) => r.status === "rejected"));
  for (const r of results) {
    assert.match(r.reason.message, /simulated SSO failure/);
  }
});

await test("after error, a fresh resolve attempts refresh again (no permanent inflight)", async () => {
  const handle = makeResolver();
  let calls = 0;
  handle.resolver.refresh = async () => {
    calls += 1;
    if (calls === 1) throw new Error("first failure");
    return {
      accessKeyId: "AKIA-retry",
      secretAccessKey: "s",
      sessionToken: "t",
      expiration: new Date(Date.now() + 3600_000),
    };
  };
  await assert.rejects(() => handle.resolver.resolve(), /first failure/);
  const ok = await handle.resolver.resolve();
  assert.equal(ok.accessKeyId, "AKIA-retry");
  assert.equal(calls, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
