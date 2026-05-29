// Tests for SigV4 request signing. Run: node test/signer.test.mjs

import assert from "node:assert/strict";
import { signRequest } from "../server/services/signer.js";

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

const creds = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/EXAMPLEKEY",
  sessionToken: "FQoGZXIvYXdzEXAMPLESESSIONTOKEN",
  expiration: new Date(Date.now() + 3_600_000),
};

function header(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

await test("produces a SigV4 Authorization header", async () => {
  const signed = await signRequest({
    url: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
    method: "POST",
    body: '{"jsonrpc":"2.0"}',
    service: "partnercentral-agents-mcp",
    region: "us-east-1",
    credentials: creds,
  });
  const auth = header(signed.headers, "authorization");
  assert.ok(auth, "authorization header present");
  assert.match(auth, /^AWS4-HMAC-SHA256 /);
  assert.match(auth, /Credential=AKIAEXAMPLEEXAMPLE\/\d{8}\/us-east-1\/partnercentral-agents-mcp\/aws4_request/);
  assert.match(auth, /SignedHeaders=/);
  assert.match(auth, /Signature=[0-9a-f]{64}/);
});

await test("includes session token and host headers", async () => {
  const signed = await signRequest({
    url: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
    method: "POST",
    body: "{}",
    service: "partnercentral-agents-mcp",
    region: "us-east-1",
    credentials: creds,
  });
  assert.equal(header(signed.headers, "x-amz-security-token"), creds.sessionToken);
  assert.equal(header(signed.headers, "host"), "partnercentral-agents-mcp.us-east-1.api.aws");
  assert.ok(header(signed.headers, "x-amz-date"), "x-amz-date present");
  assert.equal(signed.method, "POST");
  assert.equal(signed.body, "{}");
});

await test("preserves the request URL and content-type", async () => {
  const signed = await signRequest({
    url: "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
    method: "POST",
    body: "{}",
    service: "partnercentral-agents-mcp",
    region: "us-east-1",
    credentials: creds,
  });
  assert.equal(signed.url, "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp");
  assert.equal(header(signed.headers, "content-type"), "application/json");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
