# In-chat Account/Role Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `partner_central_select_account` tool so a user with multiple AWS account/role combos can pick (and later switch) which one the extension uses, in-conversation, persisted after one choice.

**Architecture:** Reuse the existing resolver + `~/.aws-partner-central` persistence. A new tool enumerates the user's available account/roles, validates the requested pair, persists it, and refreshes the live resolver (`resolvedIdentity` + credential invalidation). The `NeedsSelectionError` messages are rewritten to guide the model to drive this conversationally. No MCP Apps widget (deferred — see spec Non-goals: claude-ai-mcp #165/#274).

**Tech Stack:** TypeScript (Node16 ESM, `.js` import suffixes), Zod, `@modelcontextprotocol/sdk`, `node:assert` `.mjs` tests importing compiled `server/`.

**Spec:** `docs/superpowers/specs/2026-05-30-in-chat-account-role-selection-design.md`

---

## File structure

- `src/services/account-role.ts` — **modify**: extract `buildAccountRoleOptions(deps)` from `resolveAccountRole`; add pure `findOption(options, sel)`.
- `src/services/sso-auth.ts` — **modify**: add `SsoCredentialResolver.listAvailableAccountRoles()` and `.setSelectedIdentity(sel)`.
- `src/services/partner-central-client.ts` — **modify**: add `listAvailableAccountRoles()` + `setSelectedIdentity(sel)` passthroughs.
- `src/schemas/inputs.ts` — **modify**: add `SelectAccountInputSchema` + type.
- `src/schemas/outputs.ts` — **modify**: add `SelectAccountOutputSchema`.
- `src/tools/index.ts` — **modify**: register `partner_central_select_account`; rewrite `NeedsSelectionError` guidance; add `maskAccountId` helper.
- `manifest.json` / `package.json` / `src/constants.ts` / `package-lock.json` — **modify**: 5th tool + version `1.0.6`.
- `scripts/smoke-tools-list.mjs` — **modify**: expect 5 tools.
- `test/account-role.test.mjs` — **create**: `buildAccountRoleOptions` + `findOption`.
- `test/sso-resolver.test.mjs` — **modify**: `setSelectedIdentity` test.
- `CLAUDE.md`, `README.md`, `SUBMISSION.md`, `DISTRIBUTION.md`, `TESTING.md`, spec — **modify**: docs.

---

### Task 1: Extract `buildAccountRoleOptions` + add `findOption` (account-role.ts)

**Files:**
- Modify: `src/services/account-role.ts`
- Test: `test/account-role.test.mjs` (create)

- [ ] **Step 1: Write the failing test** — create `test/account-role.test.mjs`:

```javascript
// Tests for option-building + lookup used by account/role selection.
// Run: node test/account-role.test.mjs
import assert from "node:assert/strict";
import { buildAccountRoleOptions, findOption } from "../server/services/account-role.js";

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass += 1; }
  catch (err) { console.error(`  FAIL  ${name}\n        ${err.message}`); fail += 1; }
}

const deps = {
  listAccounts: async () => [
    { accountId: "111111111111", accountName: "Acme" },
    { accountId: "222222222222", accountName: "Beta" },
  ],
  listAccountRoles: async (id) => (id === "111111111111" ? ["RoleA", "RoleB"] : ["RoleC"]),
};

await test("buildAccountRoleOptions expands every account x role", async () => {
  const opts = await buildAccountRoleOptions(deps);
  assert.equal(opts.length, 3);
  assert.deepEqual(opts.map((o) => `${o.accountId}/${o.roleName}`).sort(), [
    "111111111111/RoleA", "111111111111/RoleB", "222222222222/RoleC",
  ]);
  assert.match(opts[0].label, /Acme \(111111111111\) · RoleA/);
});

await test("configAccountId narrows to one account", async () => {
  const opts = await buildAccountRoleOptions({ ...deps, configAccountId: "222222222222" });
  assert.deepEqual(opts.map((o) => o.roleName), ["RoleC"]);
});

await test("configRoleName filters roles", async () => {
  const opts = await buildAccountRoleOptions({ ...deps, configRoleName: "RoleB" });
  assert.deepEqual(opts.map((o) => `${o.accountId}/${o.roleName}`), ["111111111111/RoleB"]);
});

await test("findOption matches an exact pair, else undefined", async () => {
  const opts = await buildAccountRoleOptions(deps);
  assert.ok(findOption(opts, { accountId: "111111111111", roleName: "RoleB" }));
  assert.equal(findOption(opts, { accountId: "111111111111", roleName: "Nope" }), undefined);
  assert.equal(findOption(opts, { accountId: "999999999999", roleName: "RoleA" }), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run build && node test/account-role.test.mjs`
Expected: build fails or test fails — `buildAccountRoleOptions`/`findOption` are not exported yet.

- [ ] **Step 3: Implement** — in `src/services/account-role.ts`, add after the `makeLabel` function:

```typescript
export interface OptionDeps {
  listAccounts: () => Promise<Array<{ accountId: string; accountName?: string }>>;
  listAccountRoles: (accountId: string) => Promise<string[]>;
  configAccountId?: string;
  configRoleName?: string;
}

/** Enumerate every (account × role) combo the signed-in user can access, labeled for display. */
export async function buildAccountRoleOptions(deps: OptionDeps): Promise<AccountRoleOption[]> {
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
  return options;
}

/** Find the option matching an exact (accountId, roleName) pair, or undefined. */
export function findOption(
  options: AccountRoleOption[],
  sel: AccountRoleSelection,
): AccountRoleOption | undefined {
  return options.find((o) => o.accountId === sel.accountId && o.roleName === sel.roleName);
}
```

Then in `resolveAccountRole`, replace the inline option-building block (the `const accounts = await deps.listAccounts();` … `}` loop that builds `options`) with:

```typescript
  const options = await buildAccountRoleOptions(deps);
```

(`ResolveDeps` already has `listAccounts`, `listAccountRoles`, `configAccountId`, `configRoleName`, so it satisfies `OptionDeps`.)

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run build && node test/account-role.test.mjs`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Confirm no regression in existing resolver behavior**

Run: `node test/config.test.mjs` (sanity — unrelated) and `npm test` won't run new file until added; verify build clean: `npm run typecheck`
Expected: typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/account-role.ts test/account-role.test.mjs
git commit -m "refactor: extract buildAccountRoleOptions + add findOption"
```

---

### Task 2: Resolver methods — `listAvailableAccountRoles` + `setSelectedIdentity` (sso-auth.ts)

**Files:**
- Modify: `src/services/sso-auth.ts`
- Test: `test/sso-resolver.test.mjs`

- [ ] **Step 1: Write the failing test** — append to `test/sso-resolver.test.mjs` (before the final `console.log`). Also add these imports at the top of the file:

```javascript
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { readSelection } from "../server/services/account-role.js";
```

Test body (insert before the final `console.log` line):

```javascript
await test("setSelectedIdentity persists, sets identity, and invalidates creds", async () => {
  const startUrl = "https://example.awsapps.com/start"; // matches makeResolver's config
  const handle = makeResolver();
  await handle.resolver.resolve();                 // refresh #1, creds cached
  assert.equal(handle.count, 1);

  const sel = { accountId: "222222222222", roleName: "OtherRole" };
  await handle.resolver.setSelectedIdentity(sel);

  assert.deepEqual(handle.resolver.getResolvedIdentity(), sel);        // in-memory updated
  assert.deepEqual(await readSelection(startUrl), sel);                // persisted to disk

  await handle.resolver.resolve();                 // creds were invalidated → refresh #2
  assert.equal(handle.count, 2);

  // cleanup the synthetic selection file
  const file = path.join(
    os.homedir(), ".aws-partner-central",
    `selection-${createHash("sha1").update(startUrl).digest("hex")}.json`,
  );
  await fs.unlink(file).catch(() => {});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run build && node test/sso-resolver.test.mjs`
Expected: FAIL — `setSelectedIdentity is not a function`.

- [ ] **Step 3: Implement** — in `src/services/sso-auth.ts`:

Add to the `account-role.js` import (it currently imports `resolveAccountRole, readSelection, writeSelection, type AccountRoleSelection, type ElicitAccountRole`) the names `buildAccountRoleOptions` and `type AccountRoleOption`:

```typescript
import {
  resolveAccountRole,
  buildAccountRoleOptions,
  readSelection,
  writeSelection,
  type AccountRoleOption,
  type AccountRoleSelection,
  type ElicitAccountRole,
} from "./account-role.js";
```

Add these two methods to the `SsoCredentialResolver` class (e.g. just after `invalidate()`):

```typescript
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
```

(`getOrAcquireSsoToken`, `listAccounts`, `listAccountRoles` are existing module-level functions in this file; `this.resolvedIdentity` and `invalidate()` already exist.)

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run build && node test/sso-resolver.test.mjs`
Expected: all PASS including the new test (`9 passed, 0 failed`).

- [ ] **Step 5: Commit**

```bash
git add src/services/sso-auth.ts test/sso-resolver.test.mjs
git commit -m "feat(resolver): add listAvailableAccountRoles + setSelectedIdentity"
```

---

### Task 3: Client passthroughs (partner-central-client.ts)

**Files:**
- Modify: `src/services/partner-central-client.ts`

- [ ] **Step 1: Implement** — update the `account-role.js` type import and add two methods.

Change the import on line 12 to also bring in `AccountRoleOption`:

```typescript
import type { AccountRoleOption, AccountRoleSelection, ElicitAccountRole } from "./account-role.js";
```

Add to the `PartnerCentralClient` class, just after `getResolvedIdentity()`:

```typescript
  /** Enumerate the account/role options available to the signed-in user (for the in-chat picker). */
  listAvailableAccountRoles(): Promise<AccountRoleOption[]> {
    return this.resolver.listAvailableAccountRoles();
  }

  /** Pin (or switch to) an explicit account/role. */
  setSelectedIdentity(sel: AccountRoleSelection): Promise<void> {
    return this.resolver.setSelectedIdentity(sel);
  }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/partner-central-client.ts
git commit -m "feat(client): expose listAvailableAccountRoles + setSelectedIdentity"
```

---

### Task 4: Schemas (inputs.ts + outputs.ts)

**Files:**
- Modify: `src/schemas/inputs.ts`, `src/schemas/outputs.ts`

- [ ] **Step 1: Implement inputs** — append to `src/schemas/inputs.ts`:

```typescript
export const SelectAccountInputSchema = z
  .object({
    account_id: z
      .string()
      .regex(/^\d{12}$/, "account_id must be a 12-digit AWS account ID")
      .describe("The 12-digit AWS account ID to use, chosen from the options the extension listed."),
    role_name: z
      .string()
      .min(1, "role_name is required")
      .max(64, "role_name is too long")
      .describe(
        "The permission-set / role name to use in that account (e.g. 'PartnerCentral-Executives').",
      ),
  })
  .strict();

export type SelectAccountInput = z.infer<typeof SelectAccountInputSchema>;
```

- [ ] **Step 2: Implement outputs** — append to `src/schemas/outputs.ts`:

```typescript
export const SelectAccountOutputSchema = z.object({
  ok: z.boolean(),
  account_id: z.string().describe("The selected AWS account ID (masked)."),
  role_name: z.string().describe("The selected permission-set / role name."),
  error: z.string().optional(),
});
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/schemas/inputs.ts src/schemas/outputs.ts
git commit -m "feat(schemas): add select_account input/output schemas"
```

---

### Task 5: Register the tool + rewrite selection guidance (tools/index.ts) + smoke test

**Files:**
- Modify: `src/tools/index.ts`, `scripts/smoke-tools-list.mjs`

- [ ] **Step 1: Update the smoke test (failing first)** — in `scripts/smoke-tools-list.mjs`, add the new tool to `EXPECTED`:

```javascript
const EXPECTED = [
  "partner_central_send_message",
  "partner_central_respond_to_approval",
  "partner_central_get_session",
  "partner_central_verify_connection",
  "partner_central_select_account",
];
```

- [ ] **Step 2: Run smoke to confirm it fails**

Run: `npm run build && node scripts/smoke-tools-list.mjs`
Expected: FAIL — `expected 5 tools, got 4`.

- [ ] **Step 3: Implement** — in `src/tools/index.ts`:

(a) Extend imports:

```typescript
import {
  NeedsSelectionError,
  NoAccessError,
  findOption,
  type AccountRoleOption,
  type ElicitAccountRole,
} from "../services/account-role.js";
```

```typescript
import {
  GetSessionInputSchema,
  RespondToApprovalInputSchema,
  SendMessageInputSchema,
  SelectAccountInputSchema,
  VerifyConnectionInputSchema,
  type GetSessionInput,
  type RespondToApprovalInput,
  type SendMessageInput,
  type SelectAccountInput,
  type VerifyConnectionInput,
} from "../schemas/inputs.js";
import {
  AgentResponseOutputSchema,
  SelectAccountOutputSchema,
  VerifyConnectionOutputSchema,
} from "../schemas/outputs.js";
```

(b) Add a module-level mask helper (above `describePartnerCentralError`):

```typescript
function maskAccountId(id: string): string {
  return id.replace(/\d(?=\d{4})/g, "*");
}
```

(c) Rewrite the `NeedsSelectionError` branch inside `handleError` to drive the conversational flow:

```typescript
  if (err instanceof NeedsSelectionError) {
    const lines = [
      "You can access more than one AWS Partner Central account/role, so one must be chosen.",
      "Show the user these options, ask which to use, then call partner_central_select_account with that account_id and role_name:",
      ...err.options.map(
        (o, i) => `  ${i + 1}. ${o.label}   (account_id ${o.accountId}, role_name ${o.roleName})`,
      ),
    ];
    return errorResult(lines.join("\n"));
  }
```

(d) In `partner_central_verify_connection`'s catch block, update the `NeedsSelectionError` message similarly:

```typescript
        if (err instanceof NeedsSelectionError) {
          message =
            "Multiple accounts/roles are available — ask the user which to use, then call partner_central_select_account with its account_id and role_name. Options: " +
            err.options.map((o) => `${o.label} (account_id ${o.accountId}, role_name ${o.roleName})`).join(" | ");
        } else if (err instanceof NoAccessError) {
```

(e) Register the new tool (e.g. immediately after the `partner_central_verify_connection` registration, before the closing `}` of `registerTools`):

```typescript
  server.registerTool(
    "partner_central_select_account",
    {
      title: "Select AWS Account & Role for Partner Central",
      description: `Pin which AWS account + permission-set role this extension uses — and switch it later.

Use this when another tool reports that multiple AWS accounts/roles are available and asks the user to choose, or whenever the user wants to switch account/role. Present the options to the user, confirm their choice, then call this with that account_id + role_name. The choice is remembered for future calls. (You may also call it with a best-guess pair to get the list of valid options back in the error.)

Args:
  - account_id (string, required): the 12-digit AWS account ID, chosen from the listed options.
  - role_name (string, required): the permission-set / role name in that account.

Returns { ok, account_id (masked), role_name }. If the pair isn't one the user can access, returns an error listing the valid options.`,
      inputSchema: SelectAccountInputSchema.shape,
      outputSchema: SelectAccountOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SelectAccountInput) => {
      try {
        const options = await client.listAvailableAccountRoles();
        const match = findOption(options, {
          accountId: params.account_id,
          roleName: params.role_name,
        });
        if (!match) {
          const lines = [
            "That account/role isn't one you can access. Choose from:",
            ...options.map(
              (o: AccountRoleOption, i: number) =>
                `  ${i + 1}. ${o.label}   (account_id ${o.accountId}, role_name ${o.roleName})`,
            ),
          ];
          return errorResult(lines.join("\n"));
        }
        await client.setSelectedIdentity({
          accountId: match.accountId,
          roleName: match.roleName,
        });
        const masked = maskAccountId(match.accountId);
        return successResult(
          `✅ Using AWS account ${masked} with role ${match.roleName}. I'll remember this for future requests — call partner_central_select_account anytime to switch.`,
          { ok: true, account_id: masked, role_name: match.roleName },
        );
      } catch (err) {
        return handleError(err);
      }
    },
  );
```

- [ ] **Step 4: Run smoke + typecheck to confirm pass**

Run: `npm run build && node scripts/smoke-tools-list.mjs`
Expected: `PASS  tools/list advertises all 5 tools` and a PASS line for `partner_central_select_account (readOnly=false, destructive=false)`; "All smoke checks passed."

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts scripts/smoke-tools-list.mjs
git commit -m "feat(tools): add partner_central_select_account + conversational selection guidance"
```

---

### Task 6: Manifest + version bump → 1.0.6

**Files:**
- Modify: `manifest.json`, `package.json`, `src/constants.ts`, `package-lock.json`

- [ ] **Step 1: Add the 5th tool to `manifest.json`** — append to the `tools` array (after the `partner_central_verify_connection` entry):

```json
    {
      "name": "partner_central_select_account",
      "description": "Pin which AWS account + permission-set role the extension uses, and switch it later. Use when multiple accounts/roles are available and the user must choose, or to switch accounts."
    }
```

- [ ] **Step 2: Bump version in all three files + lockfile**

In `manifest.json`: `"version": "1.0.5",` → `"version": "1.0.6",`
In `package.json`: `"version": "1.0.5",` → `"version": "1.0.6",`
In `src/constants.ts`: `export const SERVER_VERSION = "1.0.5";` → `"1.0.6";`

Then sync the lockfile:

Run: `npm install --package-lock-only`

- [ ] **Step 3: Validate manifest + version consistency**

Run: `npx mcpb validate manifest.json`
Expected: "Manifest schema validation passes!"

Run: `node -e 'console.log(require("./manifest.json").version, require("./package.json").version, require("./package-lock.json").version)'`
Expected: `1.0.6 1.0.6 1.0.6`

- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json package-lock.json src/constants.ts
git commit -m "chore(release): v1.0.6 — add select_account tool to manifest"
```

---

### Task 7: Docs + spec note

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `SUBMISSION.md`, `DISTRIBUTION.md`, `TESTING.md`, `docs/superpowers/specs/2026-05-30-in-chat-account-role-selection-design.md`

- [ ] **Step 1: Spec note** — in the spec, under "Selection flow", after the last-resort fallback bullet, add:

```markdown
> **Note (validated 2026-05-30):** Claude may render the numbered options as a display-only
> artifact on its own (as observed when prompted). That is cosmetic — it cannot call our local
> stdio tools. The authoritative pinning always goes through `partner_central_select_account`,
> which works in Claude Desktop, Claude Code, and restricted networks. We do not depend on
> extension-served MCP Apps UI (see Non-goals: claude-ai-mcp #165/#274).
```

- [ ] **Step 2: `CLAUDE.md`** — update the "We expose 4 tools" sentence to 5 and add `partner_central_select_account`:

Change `We expose **4 tools** to Claude: ... partner_central_verify_connection.` to include `partner_central_select_account`, and update the count to **5**. Update the State line: `Latest release: **v1.0.6** (adds partner_central_select_account: in-chat account/role pick + switch). main in sync at tag v1.0.6.`

- [ ] **Step 3: `README.md`** — in the tools list / features, add a bullet for `partner_central_select_account` ("Pick or switch which AWS account + role the extension uses, in-chat"). Add a usage example: `"Switch to the customd account with the PartnerCentral-Executives role."`

- [ ] **Step 4: `SUBMISSION.md`** — bump artifact refs `v1.0.5` → `v1.0.6`; add a 5th tool line under "Tools (all have title + annotations)": `partner_central_select_account — readOnlyHint:false, destructiveHint:false, idempotentHint:true`. Add a usage example for selecting/switching accounts.

- [ ] **Step 5: `DISTRIBUTION.md`** — update tool-annotation checklist to list 5 tools incl. `partner_central_select_account`; bump `(currently 1.0.5)` → `(currently 1.0.6)`.

- [ ] **Step 6: `TESTING.md`** — add a Sandbox acceptance step: "Multi-account selection: with no saved pick, a first message lists account/role options; calling select_account with a listed pair pins it and the request proceeds; a follow-up does not re-prompt; selecting a different pair switches it."

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md SUBMISSION.md DISTRIBUTION.md TESTING.md docs/superpowers/specs/2026-05-30-in-chat-account-role-selection-design.md
git commit -m "docs: document select_account tool + selection flow (v1.0.6)"
```

---

### Task 8: Full verification + production bundle

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all test files pass, including `account-role.test.mjs` and the updated `sso-resolver.test.mjs`. `0 failed` across the board.

- [ ] **Step 2: Smoke + manifest**

Run: `node scripts/smoke-tools-list.mjs && npx mcpb validate manifest.json`
Expected: 5 tools, all annotated; manifest validates.

- [ ] **Step 3: Build the production bundle**

Run: `bash scripts/pack-mcpb.sh`
Expected: `Bundle ready: dist/aws-partner-central.mcpb`, version `1.0.6`, audit gate passes.

- [ ] **Step 4: Regression guard — bundle still boots under the placeholder env (the v1.0.5 fix)**

Run:
```bash
rm -rf /tmp/pc106 && mkdir -p /tmp/pc106 && unzip -q dist/aws-partner-central.mcpb -d /tmp/pc106
INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-ai","version":"0.1.0"}}}'
( printf '%s\n' "$INIT"; sleep 3 ) | env AWS_SSO_START_URL="https://customd.awsapps.com/start" AWS_SSO_ACCOUNT_ID='${user_config.sso_account_id}' AWS_SSO_ROLE_NAME='${user_config.sso_role_name}' PARTNER_CENTRAL_DEFAULT_CATALOG='${user_config.default_catalog}' NODE_ENV=production node /tmp/pc106/server/index.js
```
Expected: clean `initialize` result with `"version":"1.0.6"`, exit 0 (no crash).

- [ ] **Step 5: Final commit (if any docs/build tweaks)**

```bash
git status --porcelain   # expect clean (server/ + dist/ are gitignored)
```

---

## Notes for the implementer

- **No new dependencies, no bundler, no `pack-mcpb.sh` changes.**
- **Releasing (push + GitHub release) is NOT part of this plan** — it requires explicit user authorization (the auto-mode classifier gates pushes to `customd/main`). Stop after Task 8 and hand back for the release decision.
- Tests import the **compiled `server/`**, so always `npm run build` before running a `.mjs` test.
- The `partner_central_select_account` handler is thin glue over already-tested parts (`findOption`, `setSelectedIdentity`); its registration + annotations are covered by the smoke test, and the live path by the `TESTING.md` Sandbox step.
