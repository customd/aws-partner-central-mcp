// Tests for the partner_central_select_account handler (runSelectAccount).
// Pure logic with a fake client — no AWS, no filesystem, no MCP server.
// Verifies: a bogus pair is rejected (lists options, does NOT persist), and a
// valid pair pins the identity and returns the account ID MASKED.
// Run: node test/select-account.test.mjs

import assert from "node:assert/strict";
import { runSelectAccount } from "../server/tools/index.js";

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

const options = [
  { accountId: "111111111111", roleName: "RoleA", label: "Acme (111111111111) · RoleA" },
  {
    accountId: "222222222222",
    roleName: "PartnerCentral-Executives",
    label: "Beta (222222222222) · PartnerCentral-Executives",
  },
];

function makeClient() {
  const calls = [];
  return {
    calls,
    client: {
      listAvailableAccountRoles: async () => options,
      setSelectedIdentity: async (sel) => {
        calls.push(sel);
      },
    },
  };
}

await test("bogus pair → isError, lists options, does NOT persist", async () => {
  const { client, calls } = makeClient();
  const result = await runSelectAccount(client, {
    account_id: "999999999999",
    role_name: "RoleA",
  });
  assert.equal(result.isError, true, "expected an error result");
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /Acme \(111111111111\) · RoleA/);
  assert.match(text, /Beta \(222222222222\) · PartnerCentral-Executives/);
  assert.equal(calls.length, 0, "setSelectedIdentity must NOT be called for a bogus pair");
});

await test("valid pair → pins identity once and masks the account ID", async () => {
  const { client, calls } = makeClient();
  const result = await runSelectAccount(client, {
    account_id: "222222222222",
    role_name: "PartnerCentral-Executives",
  });
  assert.equal(calls.length, 1, "setSelectedIdentity must be called exactly once");
  assert.deepEqual(calls[0], {
    accountId: "222222222222",
    roleName: "PartnerCentral-Executives",
  });
  assert.notEqual(result.isError, true, "a valid pair must not be an error");
  assert.equal(
    result.structuredContent.account_id,
    "********2222",
    "account_id must be masked, not the raw id",
  );
  assert.equal(result.structuredContent.role_name, "PartnerCentral-Executives");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
