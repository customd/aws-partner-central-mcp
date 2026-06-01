# Agent-reply visibility, opportunity links + friendly tool labels — design spec

- **Date:** 2026-06-02
- **Status:** Design approved; pending implementation plan
- **Target version:** v1.0.8

## Problem

When the user runs `partner_central_send_message` in **Claude Desktop**, the agent's actual
reply is effectively invisible: expanding the **"Used partner_central_send_message"** tool-call
disclosure shows a **genuinely blank** output area, so the user only ever sees whatever Claude
chooses to paraphrase. The substance of the agent's response is "hidden away."

Separately, the agent refers to opportunities by their `O…` ID in prose, but those IDs are not
clickable — there's no quick path from a reply to the opportunity in the AWS console.

## Background — root-cause investigation (so the next agent doesn't re-derive it)

**The blank disclosure is a host display problem, not a data problem.** Every tool here declares
an `outputSchema` and returns `structuredContent`. That object is dominated by `raw: z.unknown()`
— a large, **untyped** payload. MCP clients handle the `content`-vs-`structuredContent` split
inconsistently and can render nothing useful:

- [anthropics/claude-code#15412](https://github.com/anthropics/claude-code/issues/15412) — client
  renders `structuredContent` and **ignores** the human-readable `content` text.
- [anthropics/claude-code#4427](https://github.com/anthropics/claude-code/issues/4427) — the
  mirror bug: `structuredContent` ignored. The two together show how version-dependent this path is.
- [modelcontextprotocol/mcpb#174](https://github.com/modelcontextprotocol/mcpb/issues/174) —
  Claude Desktop fails to compile/render complex/loosely-typed MCP output schemas.

The leading hypothesis: Desktop attempts the structured view, the untyped `raw` blob renders to
nothing → blank panel, and our nicely-formatted `content[0].text` is not shown. **Crucially, the
model still receives the `content` text** (that's why Claude can still answer) — this is purely a
*display* gap. **We cannot change Claude Desktop's disclosure UI**, so the durable fix is to make
the reply land in the conversation itself.

**A true visual widget is still blocked.** Extension-served MCP Apps UI (`ui://` over
`io.modelcontextprotocol/ui`) does not reliably render for a local stdio extension in current
Claude Desktop — [claude-ai-mcp#165](https://github.com/anthropics/claude-ai-mcp/issues/165) and
[#274](https://github.com/anthropics/claude-ai-mcp/issues/274) are both still **OPEN** (last
touched 2026-05-09). See the [2026-05-30 account-selection spec](./2026-05-30-in-chat-account-role-selection-design.md)
non-goals. Image/PNG cards would need a rasterizer dependency — disproportionate for a thin stdio
bridge.

**Console-link region research.** The Partner Central Selling API is **us-east-1 only** — single
endpoint `partnercentral-selling.us-east-1.api.aws`, no other region, no home-region or
per-opportunity region concept ([Supported AWS regions](https://docs.aws.amazon.com/partner-central/latest/APIReference/selling-regions.html)).
The `region=` in a console URL is just the standard
[console region-selector query param](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-deeplinks.html).
The reporting user's own working link used `region=ap-southeast-2` — a region where Partner Central
does not exist — which proves the opportunity is resolved **by its `O…` ID alone** and the region
param is cosmetic. The user then tested the param-less URL directly: **it works.** So the canonical
deep link omits the query string entirely.

## Goal

Make the agent's reply **visible in the conversation** (independent of the broken disclosure), and
turn opportunity IDs into **clickable AWS-console links** — on every client, with no new
dependencies and no new configuration. Also surface **human-friendly tool labels** in the client
UI instead of the raw snake_case tool names (e.g. `partner_central_respond_to_approval`).

## Non-goals (deferred / rejected)

- **MCP Apps interactive widget** — blocked (#165/#274); see Background.
- **Image/PNG-rendered card** — rejected: needs a rasterizer dependency; over-engineered for a
  thin stdio bridge.
- **Re-tabulating the agent's prose** — rejected: the agent returns natural-language prose (often
  already markdown-formatted). Reformatting it into our own tables risks mangling its structure.
  We preserve the reply and *augment* it (links), we don't restructure it.
- **A "home region" config field** — unnecessary: the service is single-region; the link needs no
  region. Avoiding a new optional field also dodges the `${...}` placeholder startup-crash gotcha
  (CLAUDE.md gotcha #7).
- **Linkifying non-opportunity entities** (engagements, resource snapshots, …) — out of scope;
  the linkifier is structured to extend later.

## Design

### 1. Console-link helper — new module `src/tools/console-links.ts`

A small, focused, dependency-free module:

- `linkifyOpportunities(text: string, catalog: string): { text: string; links: OpportunityLink[] }`
  - Finds bare opportunity IDs with `\bO\d{6,}\b` (covers observed IDs: `O7000000` (7),
    `O2100000` (8), `O1234567890` (10)).
  - Wraps each in a markdown link: `[O7000000](<BASE>/O7000000)`.
  - **Skips** any ID already inside a markdown link (`](…)` / `[…]`) and inside inline-code/code
    fences, so existing links and JSON blocks aren't corrupted.
  - Returns the rewritten text plus the **de-duplicated** list of `{ id, url }` found.
  - **Catalog-gated:** only emits links when `catalog === "AWS"` (production). For `Sandbox`
    (test data that likely won't resolve in the production console) it returns the text unchanged
    and an empty list. (Confirm Sandbox console behavior during acceptance; if Sandbox *does*
    resolve, relax the gate later.)
- `OpportunityLink = { id: string; url: string }`.

Base URL constant in `src/constants.ts`:
`PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE = "https://us-east-1.console.aws.amazon.com/partnercentral/opportunities"`
→ link = `${BASE}/${id}` (no query string; see Background).

### 2. Surface-in-chat (the reliable fix)

Two parts, both in scope:

**(a) Augment the rendered reply (`src/tools/format.ts`).**
- Thread the active `catalog` into `formatAgentResponse(...)`.
- Apply `linkifyOpportunities` to the agent-prose portion only — i.e. the `parsed.text` we push
  at the existing "agent reply" line — **not** the whole assembled document (so the approval-JSON
  code fence and the activity `<details>` block are untouched).
- Prefix the existing `**Status:**` line with a small status emoji (✅ complete /
  ⚠️ requires_approval / ❌ error) for scannability. No other structural change to the text.

**(b) Make Claude present the reply (tool descriptions in `src/tools/index.ts`).**
- Add explicit guidance to `partner_central_send_message`, `partner_central_respond_to_approval`,
  and `partner_central_get_session`: after the call, **show the agent's reply to the user** —
  render the returned `text`, preserving its formatting and the clickable opportunity links —
  rather than silently summarizing it. This is what actually defeats "hidden away" and works on
  every client regardless of the disclosure.

### 3. Trim `structuredContent` (likely un-blanks the disclosure)

- **Remove** `raw` (the untyped `z.unknown()` blob — prime suspect for the blank render) from
  `buildStructured()` in `format.ts` **and** from `AgentResponseOutputSchema` in
  `src/schemas/outputs.ts`.
- **Add** a typed `opportunity_links: { id: string; url: string }[]` (optional; omitted when
  empty) populated from §1's collected links.
- **Escape hatch preserved:** the full upstream payload is still reachable via
  `response_format: "json"` (which renders `parsed.raw` into `content.text`) and via
  `partner_central_get_session`. Update the truncation note in `format.ts` (currently "…in the
  tool's structuredContent ('raw' field)…") to point at `response_format: "json"` / `get_session`
  instead. `parsed.raw` itself stays on `NormalizedAgentResponse` (json format still uses it) — we
  only stop copying it into `structuredContent`.

**Framing:** §2 is the guaranteed win (reply becomes visible in chat). §3 is the leading
hypothesis for *also* un-blanking the Desktop disclosure panel and is good hygiene regardless —
but it is **not yet verified on Claude Desktop** (we can't easily reproduce Desktop's structured
render headlessly). If it doesn't un-blank, §2 still satisfies the goal.

### 4. Friendly tool labels — `annotations.title`

Claude Desktop shows the raw tool `name` (e.g. `partner_central_respond_to_approval`) because it
reads **`annotations.title`** for the tool-call label — the MCP spec gives `annotations.title`
display precedence for Tools ([2025-06-18 schema](https://modelcontextprotocol.io/specification/2025-06-18/schema))
— and our `annotations` objects currently carry only the hint flags. Add a concise
`annotations.title` to each of the **5** tools (keep the existing longer top-level `title` for tool
pickers / newer spec-compliant clients):

| Tool `name` | `annotations.title` |
|---|---|
| `partner_central_send_message` | Ask Partner Central |
| `partner_central_respond_to_approval` | Respond to Approval |
| `partner_central_get_session` | Get Conversation Session |
| `partner_central_verify_connection` | Verify Connection |
| `partner_central_select_account` | Select Account / Role |

Confidence is high (documented spec precedence; client lag tracked in
[cloudflare/agents#1360](https://github.com/cloudflare/agents/issues/1360),
[dify#27550](https://github.com/langgenius/dify/issues/27550)), but the actual Desktop render is a
**confirmation step** in testing — if Desktop ignores `annotations.title` too, it's a pure client
limitation with no server-side lever (`name` can't contain spaces).

## Internals / components (files touched)

- `src/tools/console-links.ts` — **new.** `linkifyOpportunities`, `OpportunityLink`, regex.
- `src/constants.ts` — add `PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE`; bump `SERVER_VERSION` →
  `1.0.8`.
- `src/tools/format.ts` — `formatAgentResponse` takes `catalog`; linkify the prose; status emoji;
  drop `raw` from `buildStructured`; add `opportunity_links`; update truncation note.
- `src/schemas/outputs.ts` — remove `raw` from `AgentResponseOutputSchema`; add
  `opportunity_links`.
- `src/tools/index.ts` — pass `catalog` to the three `formatAgentResponse` call sites
  (`send_message`, `respond_to_approval`, `get_session`); update those tool descriptions
  (present-the-reply guidance; replace the `raw`/structured-content "Returns" lines with the new
  shape); add `annotations.title` to all **5** tool registrations (table in §4).
- `manifest.json`, `package.json`, `package-lock.json` — version `1.0.8`.

No new dependencies, no bundler change, no manifest UI surface, no `pack-mcpb.sh` change.

## Error handling

- Linkifier is pure/total: any non-matching text returns unchanged with an empty link list. It
  never throws on malformed input and never blocks a response.
- Unknown/missing catalog → treat as non-production → no links (fail safe; never emit a link that
  might 404).
- Removing `raw` must not break the truncation path: the truncation branch keeps working on the
  assembled `text`; only its guidance message changes.

## Testing

Plain `node:assert` `.mjs` runners against compiled `server/` (existing style; `pretest` builds):

- **`test/console-links.test.mjs`** (new):
  - Links the three observed ID lengths; output is valid markdown to the param-less us-east-1 URL.
  - Does **not** double-link an ID already inside a markdown link; does not touch IDs inside code
    spans/fences.
  - No false positives (e.g. `O5` / `Order123` / a 5-digit `O12345` are left alone given `{6,}`).
  - De-dupes repeated IDs in the returned link list.
  - `Sandbox` catalog → text unchanged, empty link list. `AWS` catalog → links emitted.
- **`test/format*.test.mjs`** (update): `structuredContent` no longer carries `raw`; carries
  `opportunity_links` when (AWS catalog) IDs are present; status line shows the emoji; the
  approval-JSON block and activity `<details>` are unaffected by linkification.
- **`test/response-parser*.test.mjs`**: unaffected (parser still populates `parsed.raw`); add a
  guard if any existing assertion reads `structuredContent.raw`.
- **`scripts/smoke-tools-list.mjs`**: still **5** annotated tools with schemas (unchanged count);
  assert each advertises a non-empty `annotations.title`.

## Docs & packaging

- `README.md` — note clickable opportunity links in replies; brief "how the reply is shown".
- `CLAUDE.md` — update **State** (latest release → v1.0.8, what shipped); add a one-line gotcha
  that `structuredContent` deliberately excludes `raw` (blank-disclosure mitigation) with the
  json/get_session escape hatch, so it isn't "helpfully" re-added.
- `PRIVACY.md` — re-confirm no change: links are constructed locally from an ID already in the
  response; no new data is sent or written, no new API is called.
- Version bump to **1.0.8** in the three sync'd files (+ `package-lock.json`).

## Risks & assumptions

1. **§3 may not un-blank Desktop** (unverified host render). Mitigated: §2 makes the reply visible
   regardless. Acceptance explicitly checks the Desktop disclosure before/after.
2. **Param-less console URL** confirmed working by the user (2026-06-02). Fallback if it ever
   regresses: append `?region=us-east-1` (the service region — never the user's local region).
3. **Sandbox console links** assumed not to resolve → gated off. If Sandbox opportunities *do* open
   in the console, relax the gate (one-line change).
4. **Present-the-reply nudge is model behavior**, not enforced. It's reliable in practice and the
   linkified, self-contained `text` makes compliance easy; not a hard guarantee.
5. **Desktop may ignore `annotations.title` too** (client lag). Then friendly labels aren't
   achievable server-side (`name` can't contain spaces) — accept as a known limitation; the rest of
   the release is unaffected.

## Acceptance criteria

1. In Claude Desktop (AWS catalog), a `send_message` reply that mentions an opportunity shows that
   `O…` ID as a clickable link to `https://us-east-1.console.aws.amazon.com/partnercentral/opportunities/<ID>`,
   and the link opens the correct opportunity.
2. The agent's reply is visible in the conversation (Claude presents it) without expanding the
   tool-call disclosure.
3. `structuredContent` no longer contains `raw`; it contains `opportunity_links` when applicable;
   `response_format: "json"` still returns the full payload.
4. Sandbox-catalog replies emit **no** console links.
5. Tool-call labels in Claude Desktop render the friendly `annotations.title` (e.g.
   *Respond to Approval*) rather than the raw `name` — recorded as a confirmation (see §4 risk).
6. Disclosure check recorded: note whether the panel still renders blank after the `raw` trim
   (informational — criterion 2 is the binding one).
7. `npm test` green incl. the new link tests; smoke shows 5 annotated tools each with a
   non-empty `annotations.title`; `npx mcpb validate` passes.
