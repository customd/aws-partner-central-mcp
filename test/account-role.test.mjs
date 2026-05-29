// Tests for account/role resolution: explicit config, persisted choice, and
// SSO discovery (single→auto, multiple→elicit / NeedsSelection, none→NoAccess).
// Pure logic with injected deps — no AWS, no filesystem.
// Run: node test/account-role.test.mjs

import assert from "node:assert/strict";
import {
  resolveAccountRole,
  NeedsSelectionError,
  NoAccessError,
} from "../server/services/account-role.js";

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

const baseDeps = (over = {}) => ({
  startUrl: "https://acme.awsapps.com/start",
  listAccounts: async () => [{ accountId: "111111111111", accountName: "Prod" }],
  listAccountRoles: async () => ["OnlyRole"],
  readSelection: async () => null,
  writeSelection: async () => {},
  ...over,
});

await test("explicit config short-circuits (no discovery)", async () => {
  let listed = false;
  const sel = await resolveAccountRole(
    baseDeps({
      configAccountId: "222222222222",
      configRoleName: "ExplicitRole",
      listAccounts: async () => {
        listed = true;
        return [];
      },
    }),
  );
  assert.equal(sel.accountId, "222222222222");
  assert.equal(sel.roleName, "ExplicitRole");
  assert.equal(listed, false, "discovery should be skipped when config is explicit");
});

await test("single account + single role auto-resolves and persists", async () => {
  let persisted = null;
  const sel = await resolveAccountRole(
    baseDeps({
      writeSelection: async (_url, s) => {
        persisted = s;
      },
    }),
  );
  assert.equal(sel.accountId, "111111111111");
  assert.equal(sel.roleName, "OnlyRole");
  assert.deepEqual(persisted, { accountId: "111111111111", roleName: "OnlyRole" });
});

await test("persisted selection is reused without discovery", async () => {
  let listed = false;
  const sel = await resolveAccountRole(
    baseDeps({
      readSelection: async () => ({ accountId: "333333333333", roleName: "Saved" }),
      listAccounts: async () => {
        listed = true;
        return [];
      },
    }),
  );
  assert.equal(sel.accountId, "333333333333");
  assert.equal(sel.roleName, "Saved");
  assert.equal(listed, false);
});

await test("persisted ignored when a config hint disagrees (re-discovers)", async () => {
  let listed = false;
  const sel = await resolveAccountRole(
    baseDeps({
      readSelection: async () => ({ accountId: "111111111111", roleName: "Old" }),
      configRoleName: "New",
      listAccounts: async () => {
        listed = true;
        return [{ accountId: "111111111111" }];
      },
      listAccountRoles: async () => ["New", "Other"],
    }),
  );
  assert.equal(sel.roleName, "New");
  assert.equal(listed, true);
});

await test("multiple options → elicit picks", async () => {
  const sel = await resolveAccountRole(
    baseDeps({
      listAccountRoles: async () => ["RoleA", "RoleB"],
      elicit: async (opts) => {
        assert.equal(opts.length, 2);
        assert.ok(opts[0].label.includes("RoleA"));
        return { accountId: opts[1].accountId, roleName: opts[1].roleName };
      },
    }),
  );
  assert.equal(sel.roleName, "RoleB");
});

await test("multiple + no elicit → NeedsSelectionError with options", async () => {
  await assert.rejects(
    () => resolveAccountRole(baseDeps({ listAccountRoles: async () => ["RoleA", "RoleB"] })),
    (e) => e instanceof NeedsSelectionError && e.options.length === 2,
  );
});

await test("multiple + elicit returns null → NeedsSelectionError", async () => {
  await assert.rejects(
    () =>
      resolveAccountRole(
        baseDeps({ listAccountRoles: async () => ["RoleA", "RoleB"], elicit: async () => null }),
      ),
    (e) => e instanceof NeedsSelectionError,
  );
});

await test("no roles → NoAccessError", async () => {
  await assert.rejects(
    () => resolveAccountRole(baseDeps({ listAccountRoles: async () => [] })),
    (e) => e instanceof NoAccessError,
  );
});

await test("config role hint filters discovered roles", async () => {
  const sel = await resolveAccountRole(
    baseDeps({
      listAccountRoles: async () => ["RoleA", "RoleB", "Wanted"],
      configRoleName: "Wanted",
    }),
  );
  assert.equal(sel.roleName, "Wanted");
});

await test("config account hint limits role lookup to that account", async () => {
  const queried = [];
  const sel = await resolveAccountRole(
    baseDeps({
      configAccountId: "999999999999",
      listAccounts: async () => [{ accountId: "111111111111" }, { accountId: "999999999999" }],
      listAccountRoles: async (acct) => {
        queried.push(acct);
        return ["TheRole"];
      },
    }),
  );
  assert.equal(sel.accountId, "999999999999");
  assert.equal(sel.roleName, "TheRole");
  assert.deepEqual(queried, ["999999999999"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
