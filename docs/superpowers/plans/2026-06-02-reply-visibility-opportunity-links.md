# Agent-reply visibility, opportunity links + friendly tool labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Partner Central agent's reply visible in-chat with clickable AWS-console opportunity links, stop `structuredContent` from rendering a blank disclosure, and show friendly tool labels in Claude Desktop — shipped as v1.0.8.

**Architecture:** A new dependency-free `console-links.ts` linkifies `O…` opportunity IDs (AWS catalog only) into console URLs. `format.ts` applies it to the agent's prose, adds a status emoji, drops the untyped `raw` blob from `structuredContent`, and adds a typed `opportunity_links[]`. Tool descriptions nudge the model to present the reply; each tool gains an `annotations.title`.

**Tech Stack:** TypeScript (strict, Node16 ESM → `.js` imports), Zod schemas, MCP TS SDK, plain `node:assert` `.mjs` tests importing the compiled `server/`.

**Spec:** [docs/superpowers/specs/2026-06-02-agent-reply-visibility-and-opportunity-links-design.md](../specs/2026-06-02-agent-reply-visibility-and-opportunity-links-design.md)

**Conventions reminder:** stderr-only logging; relative imports end in `.js`; no real PII/secrets; `npm test` runs `pretest` (build) first, so tests import from `server/` — always build before running a single `.mjs` directly.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/constants.ts` | Shared constants | Add console base URL; bump `SERVER_VERSION` (Task 4) |
| `src/tools/console-links.ts` | Opportunity-ID → console-link helper | **Create** |
| `src/schemas/outputs.ts` | Zod output schemas | Drop `raw`, add `opportunity_links` |
| `src/tools/format.ts` | Render reply + build `structuredContent` | Linkify prose, status emoji, drop `raw`, add links, new `catalog` param |
| `src/tools/index.ts` | Tool registration + handlers | Pass `catalog`, edit descriptions, add `annotations.title` |
| `test/console-links.test.mjs` | Unit tests for the linkifier | **Create** |
| `test/format.test.mjs` | Formatter tests | Update for emoji/links/no-raw |
| `scripts/smoke-tools-list.mjs` | Tool advertisement smoke | Assert `annotations.title` |
| `manifest.json`, `package.json`, `package-lock.json` | Packaging | Version → 1.0.8 (Task 4) |
| `README.md`, `CLAUDE.md` | Docs | v1.0.8 notes (Task 4) |

---

## Task 1: Console-link helper (`console-links.ts`)

**Files:**
- Modify: `src/constants.ts` (add base-URL constant near the other endpoint constants)
- Create: `src/tools/console-links.ts`
- Test: `test/console-links.test.mjs`

- [ ] **Step 1: Add the console base-URL constant**

In `src/constants.ts`, immediately after line 3 (`export const DEFAULT_REGION = "us-east-1";`), add:

```typescript
/**
 * Base URL for deep-linking to an opportunity in the AWS Partner Central
 * console. Partner Central is us-east-1 only (the Selling API has no other
 * region), so the console host is pinned to us-east-1 and NO `region=` query
 * param is needed — the opportunity resolves by its `O…` ID alone. Final link:
 * `${BASE}/<opportunityId>`.
 */
export const PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE =
  "https://us-east-1.console.aws.amazon.com/partnercentral/opportunities";
```

- [ ] **Step 2: Write the failing test**

Create `test/console-links.test.mjs`:

```javascript
// Tests for opportunity-ID linkification (console-links.ts).
// Run: node test/console-links.test.mjs   (build first: npm run build)

import assert from "node:assert/strict";
import { linkifyOpportunities } from "../server/tools/console-links.js";

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

const BASE = "https://us-east-1.console.aws.amazon.com/partnercentral/opportunities";

test("links the three observed ID lengths (7, 8, 10 digits) for the AWS catalog", () => {
  for (const id of ["O7000000", "O2100000", "O1234567890"]) {
    const r = linkifyOpportunities(`See ${id} now.`, "AWS");
    assert.equal(r.text, `See [${id}](${BASE}/${id}) now.`);
    assert.deepEqual(r.links, [{ id, url: `${BASE}/${id}` }]);
  }
});

test("Sandbox catalog emits no links", () => {
  const r = linkifyOpportunities("See O7000000 now.", "Sandbox");
  assert.equal(r.text, "See O7000000 now.");
  assert.deepEqual(r.links, []);
});

test("undefined/unknown catalog emits no links (fail safe)", () => {
  assert.deepEqual(linkifyOpportunities("O7000000", undefined).links, []);
  assert.deepEqual(linkifyOpportunities("O7000000", "Nope").links, []);
});

test("does not double-link an ID already inside a markdown link", () => {
  const input = `[O7000000](${BASE}/O7000000) and O2100000`;
  const r = linkifyOpportunities(input, "AWS");
  // existing link untouched; only the bare second ID linked
  assert.equal(r.text, `[O7000000](${BASE}/O7000000) and [O2100000](${BASE}/O2100000)`);
  assert.deepEqual(r.links, [{ id: "O2100000", url: `${BASE}/O2100000` }]);
});

test("leaves IDs inside inline code / code fences alone", () => {
  const r = linkifyOpportunities("Use `O7000000` in code, but O2100000 in prose.", "AWS");
  assert.equal(
    r.text,
    "Use `O7000000` in code, but [O2100000](" + BASE + "/O2100000) in prose.",
  );
  assert.deepEqual(r.links, [{ id: "O2100000", url: `${BASE}/O2100000` }]);
});

test("no false positives: < 6 digits, or O mid-identifier", () => {
  const r = linkifyOpportunities("O5 and O12345 and FOO7000000 stay literal.", "AWS");
  assert.equal(r.text, "O5 and O12345 and FOO7000000 stay literal.");
  assert.deepEqual(r.links, []);
});

test("de-dupes a repeated ID in the links list but links every occurrence", () => {
  const r = linkifyOpportunities("O7000000 then O7000000 again.", "AWS");
  assert.equal(
    r.text,
    `[O7000000](${BASE}/O7000000) then [O7000000](${BASE}/O7000000) again.`,
  );
  assert.deepEqual(r.links, [{ id: "O7000000", url: `${BASE}/O7000000` }]);
});

test("empty / missing text is safe", () => {
  assert.deepEqual(linkifyOpportunities("", "AWS"), { text: "", links: [] });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && node test/console-links.test.mjs`
Expected: FAIL — `Cannot find module '../server/tools/console-links.js'` (file not created yet).

- [ ] **Step 4: Implement `console-links.ts`**

Create `src/tools/console-links.ts`:

```typescript
import { CATALOG_AWS, PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE } from "../constants.js";

/** A clickable link from an opportunity ID to its AWS-console page. */
export interface OpportunityLink {
  id: string;
  url: string;
}

/** Bare Partner Central opportunity IDs: `O` followed by 6+ digits, at word
 * boundaries (so mid-identifier `O`s and short numbers are not matched). */
const OPPORTUNITY_ID = /\bO\d{6,}\b/g;

/** Protected runs we must NOT rewrite: inline code / fenced code (`` `…` ``)
 * and existing markdown links (`[text](url)`). Split with a capturing group so
 * the delimiters land at odd indices and plain text at even indices. */
const PROTECTED = /(`+[^`]*`+|\[[^\]]*\]\([^)]*\))/g;

function consoleUrl(id: string): string {
  return `${PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE}/${id}`;
}

/**
 * Turn bare opportunity IDs in agent prose into markdown links to the AWS
 * console, returning the rewritten text and the de-duplicated links found.
 *
 * Only the production "AWS" catalog is linked — Sandbox is test data that does
 * not resolve in the production console, and an unknown catalog fails safe to
 * no links. Existing links and code spans are left untouched. Pure/total: never
 * throws; non-matching input returns unchanged.
 */
export function linkifyOpportunities(
  text: string,
  catalog: string | undefined,
): { text: string; links: OpportunityLink[] } {
  if (!text || catalog !== CATALOG_AWS) {
    return { text: text ?? "", links: [] };
  }

  const links: OpportunityLink[] = [];
  const seen = new Set<string>();

  const rewritten = text
    .split(PROTECTED)
    .map((part, i) => {
      if (i % 2 === 1) return part; // protected (code span/fence or existing link)
      return part.replace(OPPORTUNITY_ID, (id) => {
        if (!seen.has(id)) {
          seen.add(id);
          links.push({ id, url: consoleUrl(id) });
        }
        return `[${id}](${consoleUrl(id)})`;
      });
    })
    .join("");

  return { text: rewritten, links };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && node test/console-links.test.mjs`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts src/tools/console-links.ts test/console-links.test.mjs
git commit -m "feat(links): add opportunity-ID console linkifier (AWS catalog only)"
```

---

## Task 2: Surface links + status emoji in `format.ts`; trim `raw`

**Files:**
- Modify: `src/schemas/outputs.ts:50` (remove `raw`, add `opportunity_links`)
- Modify: `src/tools/format.ts` (imports, `buildStructured`, `formatAgentResponse` signature + body, truncation note)
- Test: `test/format.test.mjs` (update one assertion, add four)

- [ ] **Step 1: Update the output schema**

In `src/schemas/outputs.ts`, replace the trailing `raw` line of `AgentResponseOutputSchema` (currently line 50, `  raw: z.unknown(),`) with the typed links field:

```typescript
  opportunity_links: z
    .array(z.object({ id: z.string(), url: z.string() }))
    .optional()
    .describe("Opportunities referenced in the reply, linked to the AWS console."),
```

(The full upstream payload is no longer mirrored into `structuredContent`; it remains available via `response_format: "json"`.)

- [ ] **Step 2: Write the failing tests**

In `test/format.test.mjs`:

(a) Update the existing assertion on line 35 — the status line now carries an emoji:

```javascript
  assert.match(r.text, /\*\*Status:\*\* ✅ complete/);
```

(b) Add these four tests just before the final `console.log(...)` line:

```javascript
test("markdown: opportunity IDs are linked for the AWS catalog", () => {
  const r = formatAgentResponse(
    { text: "See opportunity O7000000 for details.", status: "complete", isError: false, raw: {} },
    "markdown",
    true,
    "AWS",
  );
  assert.match(
    r.text,
    /\[O7000000\]\(https:\/\/us-east-1\.console\.aws\.amazon\.com\/partnercentral\/opportunities\/O7000000\)/,
  );
  assert.ok(Array.isArray(r.structured.opportunity_links));
  assert.equal(r.structured.opportunity_links[0].id, "O7000000");
});

test("markdown: opportunity IDs are NOT linked for the Sandbox catalog", () => {
  const r = formatAgentResponse(
    { text: "See opportunity O7000000 for details.", status: "complete", isError: false, raw: {} },
    "markdown",
    true,
    "Sandbox",
  );
  assert.ok(!/\]\(https:\/\//.test(r.text), "no markdown link for Sandbox");
  assert.equal(r.structured.opportunity_links, undefined);
});

test("structuredContent no longer carries the raw payload", () => {
  const r = formatAgentResponse(
    { text: "hi", status: "complete", isError: false, raw: { sessionId: "s", secret: 1 } },
    "markdown",
  );
  assert.equal(r.structured.raw, undefined);
});

test("markdown: status line shows an emoji for known statuses", () => {
  const approval = formatAgentResponse(
    { text: "Proposed.", status: "requires_approval", isError: false, raw: {} },
    "markdown",
  );
  assert.match(approval.text, /\*\*Status:\*\* ⚠️ requires_approval/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run build && node test/format.test.mjs`
Expected: FAIL — the AWS-link test fails (no link emitted; `formatAgentResponse` ignores a 4th arg), the emoji assertions fail (no emoji yet), and `structured.raw` is still defined.

- [ ] **Step 4: Update `format.ts` — imports, `buildStructured`, status emoji, signature, linkify, truncation note**

(a) After the existing import block (top of `src/tools/format.ts`, after the `../types.js` import), add:

```typescript
import { linkifyOpportunities, type OpportunityLink } from "./console-links.js";
```

(b) Replace the whole `buildStructured` function (currently lines 23-39) with a version that takes the links and omits `raw`:

```typescript
function buildStructured(
  parsed: NormalizedAgentResponse,
  links: OpportunityLink[],
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    text: parsed.text,
  };
  if (parsed.sessionId !== undefined) structured.session_id = parsed.sessionId;
  if (parsed.status !== undefined) structured.status = parsed.status;
  if (parsed.events !== undefined) structured.events = parsed.events;
  if (parsed.approvalRequests !== undefined && parsed.approvalRequests.length > 0) {
    structured.approval_requests = mapApprovalRequests(parsed.approvalRequests);
  }
  if (parsed.activity !== undefined && parsed.activity.length > 0) {
    structured.activity = parsed.activity;
  }
  if (links.length > 0) structured.opportunity_links = links;
  if (parsed.isError) structured.is_error = true;
  // `raw` is intentionally NOT mirrored here: an untyped blob makes Claude
  // Desktop render the result disclosure blank. The full payload is available
  // via response_format:"json" (and partner_central_get_session).
  return structured;
}
```

(c) Add a status-emoji helper just above `formatAgentResponse` (e.g. after `renderGenericApprovalNote`):

```typescript
/** Small leading glyph for the Status line, for quick visual scanning. */
function statusEmoji(status?: string): string {
  switch (status) {
    case "complete":
      return "✅ ";
    case "requires_approval":
      return "⚠️ ";
    case "error":
      return "❌ ";
    default:
      return "";
  }
}
```

(d) Change the `formatAgentResponse` signature to accept `catalog`, compute links once, and use them. Replace the signature line and the first two body lines (currently lines 132-137):

```typescript
export function formatAgentResponse(
  parsed: NormalizedAgentResponse,
  format: "markdown" | "json",
  showActivity = true,
  catalog?: string,
): FormattedToolResult {
  const { text: linkedReply, links } = linkifyOpportunities(parsed.text, catalog);
  const structured = buildStructured(parsed, links);
```

(e) In the markdown branch, render the status line with the emoji and push the linkified reply. Replace the existing status-push line (currently line 144) :

```typescript
    if (parsed.status) lines.push(`**Status:** ${statusEmoji(parsed.status)}${parsed.status}`);
```

and replace the agent-reply push (currently line 148, `lines.push(parsed.text);`) with:

```typescript
      lines.push(linkedReply);
```

(f) Update the truncation note (currently lines 166-169) — `raw` is gone from `structuredContent`:

```typescript
    const message =
      `\n\n_[Visible text truncated from ${originalLength.toLocaleString()} to ${CHARACTER_LIMIT.toLocaleString()} characters. ` +
      `Call this tool again with response_format:'json' for the complete payload, ` +
      `or partner_central_get_session with the session_id for individual events.]_`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build && node test/format.test.mjs`
Expected: PASS — all tests including the four new ones.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the 3 call sites in `index.ts` still compile — `catalog` is the optional 4th arg).

- [ ] **Step 7: Commit**

```bash
git add src/schemas/outputs.ts src/tools/format.ts test/format.test.mjs
git commit -m "feat(format): link opportunities in replies, add status emoji, drop raw from structuredContent"
```

---

## Task 3: Wire `catalog`, tool descriptions + `annotations.title` in `index.ts`

**Files:**
- Modify: `src/tools/index.ts` (3 `formatAgentResponse` call sites; 3 descriptions; 5 `annotations.title`)
- Modify: `scripts/smoke-tools-list.mjs` (assert `annotations.title`)

- [ ] **Step 1: Pass `catalog` to the three `formatAgentResponse` call sites**

In `src/tools/index.ts`:

`send_message` handler (currently lines 328-332):

```typescript
        const formatted = formatAgentResponse(
          parsed,
          params.response_format,
          params.show_activity,
          catalog,
        );
```

`respond_to_approval` handler (currently lines 384-388):

```typescript
        const formatted = formatAgentResponse(
          parsed,
          params.response_format,
          params.show_activity,
          catalog,
        );
```

`get_session` handler (currently line 430, `const formatted = formatAgentResponse(parsed, params.response_format);`):

```typescript
        const formatted = formatAgentResponse(parsed, params.response_format, true, catalog);
```

- [ ] **Step 2: Add `annotations.title` to all five tools**

Add a `title` as the first property of each tool's `annotations` object:

- `partner_central_send_message` (annotations at lines 301-306):

```typescript
      annotations: {
        title: "Ask Partner Central",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
```

- `partner_central_respond_to_approval` (annotations at lines 358-363):

```typescript
      annotations: {
        title: "Respond to Approval",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
```

- `partner_central_get_session` (annotations at lines 414-419):

```typescript
      annotations: {
        title: "Get Conversation Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
```

- `partner_central_verify_connection` (annotations at lines 457-462):

```typescript
      annotations: {
        title: "Verify Connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
```

- `partner_central_select_account` (annotations at lines 594-599):

```typescript
      annotations: {
        title: "Select Account / Role",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
```

- [ ] **Step 3: Update the `send_message` description — present-the-reply guidance + new `structuredContent` shape**

In `partner_central_send_message`'s description, replace the existing "Returns structured content:" line (currently line 296) with:

```typescript
Presentation: the returned 'text' is already formatted for the user and includes clickable links to any opportunities in the AWS console — show it to the user rather than replacing it with a bare summary.

Returns structured content: { session_id, status ('complete'|'requires_approval'|'error'), text, approval_requests?, opportunity_links?, truncated? }. For the full upstream payload, call again with response_format:'json'.
```

- [ ] **Step 4: Update the `get_session` description — new `structuredContent` shape + presentation**

In `partner_central_get_session`'s description, replace the existing "Returns structured content:" line (currently line 409) with:

```typescript
Presentation: show the returned 'text' (rendered transcript, with clickable opportunity links) to the user rather than summarizing it away.

Returns structured content: { session_id, status, text (rendered transcript), events, opportunity_links?, truncated? }. For the full upstream payload, call again with response_format:'json'.
```

- [ ] **Step 5: Add presentation guidance to `respond_to_approval`**

In `partner_central_respond_to_approval`'s description, replace the existing final line (currently line 355, `Returns the agent's response after the decision is applied (same shape as send_message).`) with:

```typescript
Returns the agent's response after the decision is applied (same shape as send_message). Show the returned 'text' (with any clickable opportunity links) to the user rather than only summarizing it.
```

- [ ] **Step 6: Assert `annotations.title` in the smoke test**

In `scripts/smoke-tools-list.mjs`, inside the `for (const t of tools)` loop, add after the `readOnlyHint` check (currently lines 93-95):

```javascript
    if (!t.annotations.title || typeof t.annotations.title !== "string") {
      fail(`${t.name}: missing annotations.title`);
    }
```

- [ ] **Step 7: Build, typecheck, run the smoke test + full suite**

Run: `npm run build && npm run typecheck && node scripts/smoke-tools-list.mjs`
Expected: `All smoke checks passed.` (5 tools, each with `annotations.title`).

Run: `npm test`
Expected: all `.mjs` suites pass (pretest rebuilds first).

- [ ] **Step 8: Commit**

```bash
git add src/tools/index.ts scripts/smoke-tools-list.mjs
git commit -m "feat(tools): pass catalog to formatter, add annotations.title labels, present-the-reply guidance"
```

---

## Task 4: Version bump (v1.0.8) + docs

**Files:**
- Modify: `src/constants.ts:32` (`SERVER_VERSION`)
- Modify: `manifest.json`, `package.json`, `package-lock.json`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Bump `SERVER_VERSION`**

In `src/constants.ts`, change line 32:

```typescript
export const SERVER_VERSION = "1.0.8";
```

- [ ] **Step 2: Bump `package.json` + `package-lock.json` together**

Run: `npm version 1.0.8 --no-git-tag-version`
Expected: updates the `version` field in `package.json` and `package-lock.json` (no commit/tag created). Confirm with:
Run: `grep '"version"' package.json` → `"version": "1.0.8",`

- [ ] **Step 3: Bump `manifest.json`**

In `manifest.json`, change the top-level `"version": "1.0.7"` (line 3 area, the first `version` key) to:

```json
  "version": "1.0.8",
```

- [ ] **Step 4: README — note clickable links + friendly tool names**

In `README.md`, add a short bullet to the features/usage section (match surrounding style):

```markdown
- Replies surface inline with **clickable links** to opportunities in the AWS console (production `AWS` catalog), and tools show friendly names (e.g. *Ask Partner Central*, *Respond to Approval*) in supporting clients.
```

- [ ] **Step 5: CLAUDE.md — update State + add a gotcha**

In `CLAUDE.md`, update the **State** section's first bullet to:

```markdown
- Latest release: **v1.0.7**; **v1.0.8** in `main` adds clickable opportunity console links + friendly tool labels (`annotations.title`) and removes `raw` from `structuredContent` (blank-disclosure fix). Release (`gh release create v1.0.8 …`) is the user's manual step.
```

And add to the **Critical gotchas** list a new numbered item:

```markdown
8. **`structuredContent` deliberately excludes `raw`.** A large untyped `raw` blob made Claude
   Desktop render the tool-result disclosure **blank** (display-only bug; the model still receives
   the `content` text). `format.ts#buildStructured` omits it on purpose — the full upstream payload
   is reachable via `response_format:'json'` or `get_session`. Don't "helpfully" re-add it. Pinned
   by `test/format.test.mjs` → "structuredContent no longer carries the raw payload".
```

- [ ] **Step 6: Full verification**

Run: `npm test`
Expected: all suites pass.

Run: `node scripts/smoke-tools-list.mjs`
Expected: `All smoke checks passed.`

Run: `npx mcpb validate manifest.json`
Expected: manifest valid (manifest_version 0.3).

- [ ] **Step 7: Commit**

```bash
git add src/constants.ts manifest.json package.json package-lock.json README.md CLAUDE.md
git commit -m "chore(release): v1.0.8 (opportunity links, friendly tool labels, trim structuredContent raw)"
```

> **Out of scope (user's manual steps, per CLAUDE.md):** `bash scripts/pack-mcpb.sh`, `gh release create v1.0.8 …` (needs the `moacode` gh account for the `customd` org), and the live Sandbox/Desktop acceptance run that confirms (a) the link opens the right opportunity, (b) friendly labels render, and (c) whether the `raw` trim un-blanks the disclosure.

---

## Self-Review

**1. Spec coverage:**
- §1 console-link helper → Task 1. ✔ (regex `\bO\d{6,}\b`, AWS-only gate, skip existing links/code, dedupe, base URL constant — all in Task 1 tests + impl.)
- §2 surface-in-chat: linkify prose + status emoji → Task 2; present-the-reply description nudge → Task 3 (steps 3-5). ✔
- §3 trim `structuredContent` (drop `raw`, add `opportunity_links`, move escape hatch to json, update truncation note) → Task 2 (schema + buildStructured + truncation note). ✔
- §4 friendly tool labels (`annotations.title` on 5 tools) → Task 3 step 2; smoke assertion → Task 3 step 6; spec table values match. ✔
- Internals/components files → all mapped in File Structure + tasks. ✔
- Testing (new `console-links.test.mjs`, updated `format.test.mjs`, smoke `annotations.title`, still 5 tools) → Tasks 1-3. ✔
- Docs & packaging (v1.0.8 across the 3 sync'd files + lock; README; CLAUDE.md state + gotcha) → Task 4. ✔
- Acceptance criteria 1-7 → covered by tests (3,4,7) + out-of-scope live confirmations (1,2,5,6) explicitly noted. ✔

**2. Placeholder scan:** No TBD/TODO; every code/test step shows complete content; exact commands with expected output. ✔

**3. Type consistency:** `linkifyOpportunities(text, catalog) → { text, links: OpportunityLink[] }` defined in Task 1 and consumed identically in Task 2; `OpportunityLink = { id, url }` matches the Zod `opportunity_links` shape in `outputs.ts`; `formatAgentResponse(parsed, format, showActivity, catalog?)` signature in Task 2 matches all three call sites updated in Task 3; `buildStructured(parsed, links)` arity matches its single caller. ✔
