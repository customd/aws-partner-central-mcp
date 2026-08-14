# CLAUDE.md — working in this project

Guidance for AI agents (and humans) working on the **AWS Partner Central** Claude Desktop extension.
Keep this file PII-free — it's in the public repo. Live AWS config (start URL, account, role) lives in
this project's **private session memory**, not here.

## What this is

A **Claude Desktop extension (MCPB bundle)** that bridges Claude to **AWS's hosted Partner Central agents
MCP endpoint** (`https://partnercentral-agents-mcp.us-east-1.api.aws/mcp`, `us-east-1` only). It is a thin
**local stdio MCP server** that:

1. Authenticates the user to AWS via **IAM Identity Center (SSO device flow)**, caching the token like the AWS CLI.
2. Auto-discovers / resolves the AWS **account + role** (or uses explicit config), then gets temporary role creds.
3. **SigV4-signs** each request and forwards JSON-RPC `tools/call` to the remote endpoint.

**The remote endpoint exposes exactly two tools: `sendMessage` and `getSession`.** Everything this extension
does is built on those. "All functionality" means the documented *capabilities* of those two tools (text,
**file attachments**, **human-in-the-loop write approval**), not more remote tools.

We expose **5 tools** to Claude: `partner_central_send_message`, `partner_central_respond_to_approval`,
`partner_central_get_session`, `partner_central_verify_connection`, `partner_central_select_account`.

## Layout

`src/` (TypeScript, strict, ESM) compiles to `server/` (gitignored; ships in the `.mcpb`).
- `index.ts` — entry; boots `McpServer` over stdio; graceful shutdown.
- `config.ts` — reads/validates env from the MCPB install dialog (SSRF guard on the endpoint).
- `services/sso-auth.ts` — SSO device flow, token cache, credential resolver, SSO discovery calls.
- `services/account-role.ts` — account/role resolution (explicit → persisted → discover → elicit).
- `services/signer.ts` — SigV4. `services/partner-central-client.ts` — JSON-RPC client, retries, re-auth.
- `services/response-parser.ts` — normalizes agent responses (**see gotchas**).
- `services/attachment-uploader.ts` — uploads files to the ephemeral S3 bucket for `document` blocks.
- `schemas/inputs.ts` / `schemas/outputs.ts` — Zod input + output (`structuredContent`) schemas.
- `tools/index.ts` — the 4 tool registrations + error mapping + elicitation wiring.
- `tools/format.ts` — markdown/json rendering, approval callout, activity trace.

## Commands

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # pretest builds; runs test/*.test.mjs
bash scripts/pack-mcpb.sh         # production bundle -> dist/aws-partner-central.mcpb (audit gate + prune)
npx mcpb validate manifest.json   # manifest schema check (manifest_version 0.3)
node scripts/smoke-tools-list.mjs # spawn server, assert tools/list (no AWS calls)
```

Tests are **plain `node:assert` `.mjs` runners** (no Jest/Vitest), importing the **compiled `server/`** —
build before running (npm test's `pretest` does this). Keep that style; inject mocks for AWS/fs/elicit.

## Conventions

- **Node16 ESM** → relative imports must end in `.js`.
- **stderr-only logging** (`logger`) — never `console.log`/stdout (would corrupt MCP stdio framing). Never log credentials/tokens.
- **No secrets or real PII** anywhere committed — code, tests, this file. Use synthetic values (`123456789012`, `test-user@example.com`). The repo is public.
- Strict types, Zod validation at boundaries, small focused files, immutable updates.
- Version lives in **three places that must stay in sync**: `manifest.json`, `package.json`, `src/constants.ts` (`SERVER_VERSION`).

## Critical gotchas (hard-won — read before changing the client/parser)

1. **Docs vs. reality.** The live endpoint's response shapes differ from AWS's published docs. The parser
   intentionally handles **both** the live "stringified inner payload" form (the agent JSON is a string inside
   `content[0].text`) **and** the documented inline form. Don't "simplify" it; `test/response-parser*.test.mjs`
   pin both.
2. **JSON-RPC errors ride on HTTP 200.** Classify retries by the JSON-RPC **`code` before `httpStatus`**
   (`partner-central-client.ts#classifyRetry`) — otherwise the `httpStatus===200` branch swallows code-based
   decisions. Retry `-32004` (LIMIT_EXCEEDED) + `-32603`; re-auth once on `-32001`/HTTP 401. Rate limit:
   `sendMessage` ≈ **2/min** (burst 10).
3. **Write-approval flow is non-streaming-tricky.** A `requires_approval` response carries **only prose** —
   the structured `tool_use_id` is **not** in it. It lives in `get_session` (`stateType: TOOL_REQUEST`) as
   `{tool_use_id, name, input}` (snake_case — *not* the documented `tool_approval_request` block). The parser
   recovers it from session events. **The `tool_use_id` changes whenever the agent re-proposes**, so fetch the
   latest right before `respond_to_approval` (a stale id → `-32602` "does not match pending tool request").
   Approval also works conversationally (a natural-language follow-up `send_message`).
4. **Account/role auto-discovery** (`account-role.ts`): only the SSO **start URL** is required. Account+role are
   discovered via `sso:ListAccounts`/`sso:ListAccountRoles` (the user's own access list — **no extra IAM perms,
   no reading `~/.aws/config`**). Single → auto; multiple → **elicitation dropdown** if the client supports it,
   else a text list. Choice persists to `~/.aws-partner-central/selection-<sha1>.json` (0600, non-secret).
5. **Elicitation support is client-dependent.** Observed Claude Desktop advertises `io.modelcontextprotocol/ui`
   but **not `elicitation`**, so the dropdown **falls back to text there**; it renders in Claude Code. Always
   capability-detect (`server.server.getClientCapabilities()?.elicitation`) with a text fallback.
6. **Endpoint is `us-east-1` only**; `config.ts` SSRF-guards `PARTNER_CENTRAL_ENDPOINT` to `https://*.api.aws`.
7. **Blank optional config → literal `${...}` placeholders (startup crash that masquerades as a connection error).**
   Claude Desktop substitutes the LITERAL string `${user_config.sso_account_id}` / `${user_config.sso_role_name}`
   into the env when an **optional** `user_config` field is left blank — it does **not** pass empty or omit the var.
   `config.ts#readEnv` must treat an unsubstituted `^${...}$` as **unset**; otherwise `validateAccountId` rejects the
   placeholder → `ConfigError` → `process.exit(2)` **during config load, before the MCP handshake** → Desktop reports
   **"Could not attach / Server disconnected."** This looks like connection churn but is a startup crash; the server's
   stderr doesn't reach Desktop's per-server log (crash precedes transport connect), so diagnose by running the bundle
   directly with that env. Regressed in **v1.0.3** (account/role became optional), fixed in **v1.0.5**. Pinned by
   `test/config.test.mjs` → "treats unsubstituted ${...} placeholders".
8. **`structuredContent` deliberately excludes `raw`.** A large untyped `raw` blob made Claude
   Desktop render the tool-result disclosure **blank** (display-only bug; the model still receives
   the `content` text, so Claude can still answer). `format.ts#buildStructured` omits it on purpose —
   the full upstream payload is reachable via `response_format:'json'` or `get_session`. Don't
   "helpfully" re-add it. Pinned by `test/format.test.mjs` → "structuredContent no longer carries the
   raw payload".
9. **Throttling's LIVE shape is HTTP 400 `{"message":"Rate exceeded. Try again later."}` — NOT the
   documented `-32004`.** The endpoint throttles `sendMessage` to 2/min (burst 10) and other ops to
   10/min (burst 20) but signals it as an **HTTP 400 body**, which `isRetryableHttpStatus` treats as
   fatal — so throttles used to surface raw to the model (confirmed in the *ACE opportunities
   reconciliation* co-work run: **18** throttles, all surfaced, forcing manual pauses).
   `partner-central-client.ts#isThrottleError` now recognizes **both** the `-32004` code AND any
   HTTP 429 / 4xx whose **body** matches `/rate exceeded|throttl|too many requests/i` — keyed on the
   BODY, not the 400 status, so a genuine bad-request 400 stays non-retryable. Throttle retries use a
   deeper backoff (`THROTTLE_BASE_DELAY_MS`/`THROTTLE_MAX_DELAY_MS`, ~4–20s × 3 attempts ≈ up to ~30s)
   to span the refill; transient/5xx keep the short backoff. Pinned by `test/client-retry.test.mjs`.
10. **Tool results are capped to `CHARACTER_LIMIT` (40k), applied to the COMBINED `text` +
   `structuredContent`.** The client (Claude Desktop / co-work host loop) rejects results over its
   ~25k-token cap with "exceeds maximum allowed tokens" and saves them to a temp file the sandboxed
   agent often **can't read** — so a large `get_session` (esp. `response_format:'json'`, which dumps
   the whole `raw`) silently dead-ends (seen in the same co-work run). `format.ts` trims to fit: caps
   `structuredContent.events` to `MAX_STRUCTURED_EVENTS` (20), then drops events / truncates text as
   needed, and **always preserves `status` + `approval_requests`** (the approval loop's `tool_use_id`).
   Don't raise `CHARACTER_LIMIT` back to 100k. Pinned by `test/format.test.mjs`.
11. **The agent's stage-readiness "validation" is ADVISORY, not a hard gate — writes are partner-initiated.**
   The remote `deal_progression_advisor` / `validate_stage_transition` can return `is_valid:false` with reasons
   like *"AWS Launch Status REQUIRED — AWS hasn't marked it Launched"*, *"no marketplace offer"*, *"no customer
   acceptance"*. Those are **soft heuristics**; the Selling API enforces the real constraints and frequently
   accepts the write anyway. **Empirically confirmed 2026-06-03:** a real `For Visibility Only` opportunity was
   progressed Qualified→Launched and the Selling API returned `success:true` **while the advisor still said
   `is_valid:false`** (its rule #1 just checks whether `AWS.LifeCycle.Stage` is null — expected for visibility-only
   deals — so it's structurally wrong to treat as a gate). Two consequences: (a) the **partner** drives `Stage`
   (incl. Launched/closed-won); there is no "AWS must launch first" step. (b) **Phrasing matters** — "is this
   transition valid?" makes the agent editorialize and refuse; an instruction to EXECUTE ("set Stage to Launched
   and proceed") makes it build the real `update_opportunity_enhanced` write. The extension only forwards — this
   lives as guidance in the `send_message` tool description; do **not** add a code gate.

12. **Hosts STRIP `required` from the advertised input schema — so no tool may hard-depend on a
   parameter arriving.** Diagnosed 2026-08-14 from a Cowork bug report: `get_session` failed on *every*
   call with `-32602 Input validation error: … path ["session_id"] … "Required"`. That string is emitted by
   **our own** server (`@modelcontextprotocol/sdk/server/mcp.js#validateToolInput`), not the bridge — the
   arguments genuinely arrived without `session_id`. Two clues pinned the cause: the schema is `.strict()`,
   so a *renamed* key would have added an `unrecognized_keys` issue (the report had only the one issue ⇒
   nothing unexpected was sent, `session_id` was simply absent), and the schema surfaced to the calling
   model was `{properties:{catalog,response_format,session_id},type:"object"}` — **no `required`**, and no
   `pattern`/`minLength`/`maxLength`, with sibling `description`s dropped. The server advertises all of
   those correctly (verify with `scripts/`-style `tools/list` dump), so the loss is **host-side schema
   normalisation under a size budget**. With `required` gone, `session_id` reads as optional and the model
   omits it. Same root cause for the "sessions have no memory" report: an omitted (genuinely optional)
   `session_id` on `send_message` silently starts a NEW session. **Not an AWS-side change** — the remote
   honours `session_id` fine (proved live: two `sendMessage`s in one Sandbox session round-tripped
   "BANANA", and `getSession` with an explicit id returned a proper remote "not found").
   Fix (v1.0.10): `session_id` (and `respond_to_approval`'s `tool_use_id`) are `.optional()` in Zod so the
   SDK cannot dead-end the call **before the handler runs**; the handler then resolves them —
   `session-memory.ts` remembers the latest session **per catalog**, and a missing `tool_use_id` is read
   back from the session. Format checks still apply when a value IS supplied, and an inferred session is
   always disclosed (`session_id_inferred`). **Don't "tidy" these back to required** — SDK-level
   enforcement is exactly what fails unrecoverably here. Pinned by `test/session-resilience.test.mjs`.
13. **The approval `tool_use_id` is now recovered server-side — `get_session` is off the critical path.**
   The reported *impact* of #12 was that writes were unreachable: `requires_approval` carries only prose,
   so the caller had to fetch `tool_use_id` via `get_session`, which was the broken tool. `send_message` /
   `respond_to_approval` now call `getSession` internally on a `requires_approval` reply and merge the
   pending request into `approval_requests[]`, so the **first** response carries the id (also the freshest
   possible read — gotcha #3's id changes on re-propose, so omitting `tool_use_id` is the *fix* for a stale
   "does not match pending tool request", not a risk). Recovery is best-effort (a throttled/failed lookup
   must never turn a usable reply into an error) and only runs for approvals, and `respond_to_approval`
   **refuses to guess** when >1 write is pending — it lists them instead.

## Live testing & safety

- The extension is usually connected to the dev session as `mcp__AWS_Partner_Central__*` — but that's the
  **installed** build (often older). To test the **current** build, spawn `node server/index.js` over stdio
  with env vars and do the MCP handshake (see `scripts/smoke-tools-list.mjs` / the `/tmp/*.mjs` harness pattern).
- SSO token cache: `~/.aws/sso/cache/<sha1(startUrl)>.json` (~8h). If expired, spawning triggers an
  **interactive browser device flow** — fine with the user present; don't trigger it unprompted.
- **`Sandbox` catalog = safe test data; `AWS` catalog = real production.** Use Sandbox for tests.
- **Safety boundaries (the classifier enforces these — don't work around them):** never extract the raw SSO
  token to drive the AWS CLI directly; never advance **agent-fabricated writes into production**. Read-only prod
  checks and Sandbox writes are OK. Production writes are the **user's** action (their data, their approval).

## Releasing & distribution

- Repo: `github.com/customd/aws-partner-central-mcp`. **Pushing to the `customd` org needs the `moacode` gh
  account** (the work account can't create/push there) — `gh auth switch --user moacode` first (see memory).
- Bump version in the three files above, `npm test`, `bash scripts/pack-mcpb.sh`, then
  `gh release create vX.Y.Z dist/aws-partner-central.mcpb -R customd/aws-partner-central-mcp --latest`.
- Docs: **README** (users), **PRIVACY.md** (required for directory; keep accurate re: files written & APIs
  called), **DISTRIBUTION.md** (build + submit process), **SUBMISSION.md** (paste-ready directory-form packet),
  **TESTING.md** (Sandbox acceptance test + live results).
- Directory submission is the **user's** manual step (Google form, their account). Local desktop extensions are
  eligible; OAuth-callback requirements do **not** apply (auth is AWS SSO, not Claude OAuth).

## State (update as you go)

- Latest tag: **v1.0.9** (on `main`; the earlier "v1.0.8/v1.0.9 pending, untagged" note was stale — `git tag`
  shows v1.0.9 exists). **v1.0.10** is committed but **not yet tagged or released**.
  - **v1.0.10** (session-id resilience, from the Cowork `get_session` bug report — gotchas #12/#13): tools no
    longer hard-depend on `session_id` arriving (hosts strip `required`); `session-memory.ts` resolves the
    latest session per catalog; the approval `tool_use_id` is recovered server-side so `get_session` is off
    the write path. Handlers factored into exported `runSendMessage`/`runGetSession`/`runRespondToApproval`
    for testability (same pattern as `runSelectAccount`).
  - **v1.0.8**: clickable opportunity console links in replies, friendly tool labels (`annotations.title`), a status emoji, and removes `raw` from `structuredContent` (blank-disclosure fix).
  - **v1.0.9** (scale-resilience, from the *ACE opportunities reconciliation* diagnosis): recognizes the live **HTTP 400 "Rate exceeded"** throttle (not just `-32004`) with a deeper throttle backoff (gotcha #9), and **caps tool-result size** to keep large `get_session`/json payloads under the client's token cap (gotcha #10). `gh release create vX.Y.Z …` (moacode account) is the user's manual step.
- Known follow-ups: verify the prod test opportunity **O2100000** was actually closed; Windows install smoke
  test (only macOS verified); directory submission pending the user.
- **"AWS needs to launch" was the advisor hallucinating (see gotcha #11) — proven by doing it.** On 2026-06-03
  a real `For Visibility Only` opportunity was progressed **Qualified→Launched** via the agent and the Selling
  API returned `success:true`, even though `validate_stage_transition` reported `is_valid:false`. So
  the reconciliation's other launch/closed-won items can be launched **directly by the partner** (instruct the
  agent to EXECUTE — "set Stage to Launched and proceed" — don't ask "is it valid?"); they do **not** need AWS
  coordination. `send_message`'s description now carries this "Writes & stage progression" guidance.
