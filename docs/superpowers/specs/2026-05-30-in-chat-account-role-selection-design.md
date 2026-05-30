# In-chat account/role selection — design spec

- **Date:** 2026-05-30
- **Status:** Design approved; pending implementation plan
- **Target version:** v1.0.6

## Problem

A user whose AWS IAM Identity Center sign-in grants access to **multiple account/role
combinations** (one real user has 14) must choose which account + role this extension uses.
Role and account **names are arbitrary per org**, so there is no reliable way to auto-detect
"the right one" — the user must choose. After choosing once, the pick persists to
`~/.aws-partner-central/selection-<sha1(startUrl)>.json` and is reused.

Today (`v1.0.5`), resolution lives in `services/account-role.ts#resolveAccountRole`:
- **Claude Code** advertises MCP `elicitation` → a dropdown picker (good).
- **Claude Desktop** does **not** advertise `elicitation` → the tool returns a text message
  telling the user to pin the account ID + role in **Settings → Extensions**. It works, but the
  "configure it yourself" first run is poor UX.

## Goal

Let the user select — and later switch — the account/role **in the conversation**, persisted
after one choice. No web UI, no new dependencies, works on current Claude Desktop.

## Non-goals (explicitly deferred / rejected)

- **MCP Apps interactive widget — deferred.** Extension-served MCP Apps UI (`ui://` over
  `io.modelcontextprotocol/ui`) does **not** reliably render for a **local stdio** extension in
  current Claude Desktop: open bug [claude-ai-mcp #165](https://github.com/anthropics/claude-ai-mcp/issues/165)
  (iframe handshake never starts, `app.connect()` hangs; exact stack: `ext-apps` + SDK 1.29.0 +
  stdio) and [#274](https://github.com/anthropics/claude-ai-mcp/issues/274) (local stdio servers
  may not get `io.modelcontextprotocol/ui` negotiated → raw JSON). The directory also requires
  3–5 screenshots of the UI rendering in a shipping client — impossible if it doesn't render.
  Revisit when those bugs close and Desktop reliably renders extension-served stdio UI. The
  picker observed earlier was the **model improvising** a widget, not an extension-served app.
- **Name-based auto-select / "recommended" role — rejected.** Account/role names are arbitrary;
  no dependable heuristic. The user always chooses (which also removes any silent "it just knows"
  behavior).

## Design

### New tool: `partner_central_select_account`

Pins (or switches) the active account/role.

- **Inputs** (Zod): `account_id` (string, exactly 12 digits), `role_name` (string, permission-set
  name).
- **Behavior:**
  1. Enumerate the caller's available combos via the SSO token (`ListAccounts` /
     `ListAccountRoles`).
  2. Verify `(account_id, role_name)` is in that set. If not → return an error listing the valid
     options (do **not** persist).
  3. Persist via the existing `writeSelection(startUrl, sel)`.
  4. **Refresh the live resolver**: set `resolvedIdentity` and invalidate cached temp credentials
     so the next request uses the new identity. (This is the fix for the stale-in-memory-identity
     bug the widget design would have had.)
  5. Return a masked confirmation.
- **Output (`structuredContent`):** `{ ok: boolean, account_id (masked), role_name }`.
- **Annotations:** `readOnlyHint:false, destructiveHint:false, idempotentHint:true,
  openWorldHint:true` (validates against AWS; no remote write). Annotations are the #1 directory
  rejection cause, so the new tool ships fully annotated.
- **Re-callable anytime** → this *is* the "switch account" capability.

### Selection flow

`resolveAccountRole` remains the single source of truth; resolution order is unchanged:
explicit config → saved pick → discovery (1 combo → auto-use; multiple → elicit / `NeedsSelectionError`).

When multiple combos exist and the client lacks elicitation (Desktop):
1. The triggering tool (e.g. `send_message`) returns a **guided, numbered list** of options and
   instructs the model to ask the user which one.
2. User replies ("the customd one" / "1").
3. Model calls `partner_central_select_account` with the chosen `account_id` + `role_name`.
4. Tool validates, persists, refreshes the resolver, confirms.
5. Model **re-runs the original request**, which now resolves from the saved pick.

- **Claude Code:** existing elicitation dropdown — unchanged.
- **Single combo / explicit config / existing saved pick:** auto-resolve, no prompt — unchanged.
- **No elicitation and not driven to `select_account`:** the text list remains as a last-resort
  fallback (unchanged behavior, improved wording).

> **Note (validated 2026-05-30):** Claude may render the numbered options as a display-only
> artifact on its own (as observed when prompted). That is cosmetic — it cannot call our local
> stdio tools. The authoritative pinning always goes through `partner_central_select_account`,
> which works in Claude Desktop, Claude Code, and restricted networks. We do not depend on
> extension-served MCP Apps UI (see Non-goals: claude-ai-mcp #165/#274).

### Internals / components

- `services/sso-auth.ts` (`SsoCredentialResolver`):
  - Refactor the inline `listAccounts` / `listAccountRoles` enumeration into a reusable method,
    e.g. `listAvailableAccountRoles(): Promise<AccountRoleOption[]>` (acquires token, enumerates).
  - Add `setSelectedIdentity(sel: AccountRoleSelection): Promise<void>` → `writeSelection` +
    set `this.resolvedIdentity` + `this.invalidate()`. Works with existing `resolve()` (which
    skips re-resolution when `resolvedIdentity` is set).
- `services/account-role.ts`: extract the option-building loop from `resolveAccountRole` into a
  shared helper so enumeration/labeling isn't duplicated; add `findOption(options, sel)` for
  validation.
- `services/partner-central-client.ts`: expose `listAvailableAccountRoles()` and
  `setSelectedIdentity()` passthroughs the tool layer can call.
- `tools/index.ts`: register `partner_central_select_account`; rewrite the `NeedsSelectionError`
  handling (in `handleError` and the `verify_connection` path) into the guided runbook wording.
- `schemas/inputs.ts` / `schemas/outputs.ts`: input + output schemas for the new tool.

### Error handling

- Invalid `(account_id, role_name)` → validation error that lists the valid options (no persist).
- SSO token expired during enumeration → existing re-auth path (`UnauthorizedException` → device
  flow).
- `writeSelection` failure → warn (existing behavior); `resolvedIdentity` is still set in-memory
  so the current session continues to work.

### Testing

- **Unit** (`test/account-role*.test.mjs`, `test/select-account.test.mjs`): valid pair → persists
  + returns ok; bogus pair → rejected with options list; `setSelectedIdentity` persists +
  invalidates creds.
- **Integration** (`test/sso-resolver.test.mjs`): after `setSelectedIdentity`, `resolve()` returns
  the chosen identity without re-prompting; switching changes it.
- **Smoke** (`scripts/smoke-tools-list.mjs`): assert **5** tools, each with annotations + schemas.

### Docs & packaging

- `manifest.json`: add the 5th tool (name + description); bump `version` → `1.0.6`.
- `package.json`, `src/constants.ts` (`SERVER_VERSION`), `package-lock.json`: `1.0.6`.
- `CLAUDE.md`: "4 tools" → "5 tools"; document the selection flow; keep the deferred-widget note
  (#165/#274) so the next agent doesn't re-attempt it.
- `README.md`, `SUBMISSION.md`, `DISTRIBUTION.md`: tool count + annotations (5 tools); add a
  usage example for selecting/switching accounts.
- `TESTING.md`: add a Sandbox acceptance step for multi-account selection + switching.

**No new dependencies, no bundler, no manifest UI surface, no `pack-mcpb.sh` changes.**

## Acceptance criteria

1. Desktop, multiple combos, no saved pick: first message → guided numbered list; calling
   `select_account` with a listed pair pins it and the original request proceeds; later messages
   do **not** re-prompt.
2. `select_account` rejects a pair not in the user's available set, returning the valid options.
3. Switching: calling `select_account` with a different valid pair changes the active identity;
   the next request uses it (no stale credentials).
4. Claude Code behavior (elicitation dropdown) and single-combo/explicit-config auto-resolve are
   unchanged.
5. `npm test` green (incl. new tests); smoke shows 5 annotated tools; `npx mcpb validate` passes.
