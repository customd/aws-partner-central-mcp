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

- Latest release: **v1.0.6** (adds `partner_central_select_account`: in-chat account/role pick + switch). `main` in sync at tag `v1.0.6`.
- Known follow-ups: verify the prod test opportunity **O21117997** was actually closed; Windows install smoke
  test (only macOS verified); directory submission pending the user.
