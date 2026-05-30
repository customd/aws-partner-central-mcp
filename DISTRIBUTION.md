# Distribution Guide — AWS Partner Central Extension

This guide is for the **maintainer**. It covers how to build and validate the
`.mcpb` bundle, and the two ways to get it into users' hands:

- **Part B — Direct distribution** (GitHub Release, no review).
- **Part C — Claude Connectors Directory** (public listing, manually reviewed by Anthropic).

A copy-paste **pre-submission checklist** is in Part D.

> **Key references**
> - MCPB extensions overview: https://claude.com/docs/connectors/building/mcpb
> - Submission to the Connectors Directory: https://claude.com/docs/connectors/building/submission
> - Building desktop extensions with MCPB (support article): https://support.claude.com/en/articles/12922929-building-desktop-extensions-with-mcpb
> - MCPB tooling + manifest spec: https://github.com/modelcontextprotocol/mcpb
> - MCPB manifest spec (`MANIFEST.md`): https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
> - Desktop-extension allowlist (enterprise admins): https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist

---

## Part A — Build & validate the bundle

### Prerequisites

- **Node.js 18+** (`node --version`). Claude Desktop ships its own Node runtime for end users, but you need Node locally to build.
- **The `@anthropic-ai/mcpb` CLI.** It is already a `devDependency` in `package.json`, so after `npm install` you invoke it with `npx mcpb`. (You do not need a global install.)

### Build steps

Run everything from the project root:

```bash
# 1. Install all dependencies (incl. devDependencies)
npm install

# 2. Compile TypeScript (src/ -> server/)
npm run build      # runs `tsc`

# 3. Produce the production .mcpb bundle
bash scripts/pack-mcpb.sh
```

`scripts/pack-mcpb.sh` is the **production bundler**. It:

1. Cleans previous build artifacts and recompiles TypeScript with `npx tsc`.
2. Stages the bundle in a temporary directory (so your working tree stays intact).
3. Copies `server/`, `manifest.json`, `package.json`, `package-lock.json`, and — when present — `README.md`, `LICENSE`, and `icon.png` into the stage.
4. Runs `npm install --omit=dev` **inside the stage** so only production dependencies are bundled.
5. Runs a **security audit gate** (`npm audit --omit=dev --audit-level=high`) that fails the build on high/critical CVEs in shipped deps. Override only after triage with `SKIP_AUDIT=1 bash scripts/pack-mcpb.sh`.
6. **Prunes** non-runtime files (`*.ts`, `*.map`, `*.md`, test dirs) from bundled dependencies to shrink the artifact.
7. Runs `npx mcpb pack <stage> dist/aws-partner-central.mcpb`.
8. Removes the staging directory.

The result is **`dist/aws-partner-central.mcpb`** — the single shippable artifact.

> There is also a `package.json` script `npm run pack:mcpb`, but it packs the
> *current working directory* (including devDependencies unless you've pruned).
> **Prefer `bash scripts/pack-mcpb.sh`** for releases — it guarantees a clean,
> production-only bundle.

### Validate and inspect

```bash
# Validate the manifest against the MCPB manifest schema
npx mcpb validate manifest.json

# Inspect the contents/metadata of a built bundle
npx mcpb info dist/aws-partner-central.mcpb
```

`npx mcpb validate` must pass with no errors before you ship or submit. The
manifest spec it validates against lives at
https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
(this project targets `manifest_version` **0.3**).

### Signing (optional)

```bash
npx mcpb sign dist/aws-partner-central.mcpb     # see `npx mcpb sign --help` for key options
```

- Bundle **signing** is supported by the MCPB CLI. You can **self-sign**, or use a **verified-publisher** certificate if you have one.
- Signing is **optional** for both direct distribution and Directory submission, but it lets Claude Desktop display provenance/integrity information. A self-signed bundle still installs; the distinction is whether the signature chains to a recognized verified publisher.

### Cross-platform testing

Test the **installed `.mcpb`** on **both macOS and Windows**. Claude Desktop
ships a Node runtime on both platforms, so the server should run identically, but
filesystem paths (the SSO cache lives under `~/.aws/sso/cache/`) and the browser
device-auth handoff are worth verifying on each OS. The manifest also declares
`linux` support — test there too if you intend to support it.

---

## Part B — Direct distribution (no review)

This is the fastest path. Anyone with the `.mcpb` file can install it; there is
no Anthropic review.

1. Create (or use) a **public GitHub repository**: https://github.com/customd/aws-partner-central-mcp
2. Cut a **GitHub Release** and **attach `dist/aws-partner-central.mcpb`** as a release asset. Tag the release to match the manifest `version` (currently `1.0.4`).
3. End users install by:
   - **Claude Desktop → Settings → Extensions**, then
   - **drag-and-drop the `.mcpb`** into the Extensions panel (or **double-click** the file), then
   - fill in the **configuration dialog**: **AWS SSO start URL** is the only required field; account ID and role name auto-detect after sign-in (a dropdown appears if several exist), and default catalog (`AWS`/`Sandbox`) is optional — then click **Install**. (Region is fixed to `us-east-1`; verbose logging is the `LOG_LEVEL` env var, not a form field.)

### Enterprise rollout (optional)

Organization admins can approve the Extension **org-wide** using the **desktop
extension allowlist**, so it can be deployed to managed Claude Desktop installs
without each user side-loading it. See:
https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist

---

## Part C — Submit to the Claude Connectors Directory (public listing, reviewed)

This is the **official path to be listed and discoverable** in Claude. Anthropic
reviews submissions **manually**; expect roughly **~2 weeks** for a decision.

### How to submit

Submit via the **"MCP Directory Server Review Form"** — a Google Form linked from
the submission docs:
https://claude.com/docs/connectors/building/submission

### Requirements checklist (these are the real rejection reasons)

> Treat every item below as mandatory. The first two are the most common reasons
> submissions are **rejected**.

1. **Tool annotations on EVERY tool.** Each tool must declare its behavior hints — at minimum `readOnlyHint` and `destructiveHint` (this project also sets `idempotentHint` and `openWorldHint`). **This is the #1 rejection cause (~30% of denials).**
   - **Status in this project:** all four tools in `src/tools/index.ts` are fully annotated, and each carries an `outputSchema`:
     - `partner_central_send_message` → `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`
     - `partner_central_respond_to_approval` → `readOnlyHint: false`, **`destructiveHint: true`**, `idempotentHint: false`, `openWorldHint: true` (this is the tool that actually executes writes)
     - `partner_central_get_session` → `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
     - `partner_central_verify_connection` → `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true` (creates a throwaway Sandbox session, so not read-only)
   - **Action:** if you add or change tools, annotate them too, and re-confirm before submitting.

2. **Published privacy policy.** A publicly reachable privacy policy is **required** — **missing = immediate rejection.** Host `PRIVACY.md` publicly (it renders directly on GitHub) and include the link in the submission and in the README. Use the canonical URL, e.g.
   `https://github.com/customd/aws-partner-central-mcp/blob/main/PRIVACY.md`.

3. **Documentation.** The listing must include:
   - A clear **server description**.
   - A **feature list** (what the tools do).
   - **Setup / authentication instructions** (here: install the `.mcpb`, fill the config dialog, complete the IAM Identity Center browser sign-in).
   - **At least 3 working usage examples with example prompts** (see below).
   - A **privacy policy link** (item 2).
   - A **support contact** (the repo issues URL: https://github.com/customd/aws-partner-central-mcp/issues).

4. **Test account / test credentials (where applicable).** Reviewers must be able to exercise the server. This Extension requires **AWS Partner Central access via IAM Identity Center**, which reviewers will not have by default. Provide a working path for them:
   - The simplest option is a **Sandbox-catalog test path** — point reviewers at the `Default Catalog = Sandbox` setting and the `partner_central_verify_connection` diagnostic tool, which sends a benign test message in Sandbox.
   - If a live exercise is required, supply temporary scoped test credentials / a test SSO account, or clearly document that access is gated by AWS partner enrollment and offer to demo on request. Explain this constraint explicitly in the submission so the reviewer isn't blocked.

5. **Screenshots (interactive / MCP-Apps only).** Servers with interactive UI must include screenshots. **This is a tool-only server with no custom UI, so screenshots are likely N/A** — note this in the submission rather than leaving the field unexplained.

### Example prompts to include (≥3)

Use these (already in the README) as the required working usage examples:

1. "List my open ACE opportunities closing in Q1 2026."
2. "Give me a summary of opportunity O1234567890 and tell me what I need to do next."
3. "Am I eligible for any funding programs on opportunity O6789012345?"
4. "Here are my call notes (attached PDF) — create an opportunity from this transcript." (then approve the proposed write)

### Important nuance — local MCPB vs. remote OAuth connector

Read this so you're not tripped up by the Directory's documentation:

- The Connectors Directory **historically targets REMOTE OAuth connectors** — hosted servers that implement an OAuth flow with **`claude.ai` and `claude.com` callback/redirect URLs**.
- **This Extension is a LOCAL MCPB desktop extension.** It authenticates the user via **AWS IAM Identity Center (AWS SSO)**, **not** via Claude OAuth, and it runs on the user's machine over stdio.
- Therefore the **OAuth-callback-URL requirements do NOT apply** to this submission (there is no Claude-side OAuth redirect to register).
- The requirements that **DO apply** are the universal ones: **tool annotations, a published privacy policy, complete documentation with ≥3 usage examples, and a support contact.**

State this plainly in the submission form so the reviewer understands the
authentication model and doesn't request OAuth redirect URIs that don't exist
for a local SSO-authenticated extension.

---

## Part D — Pre-submission checklist

Copy this into your release issue/PR and tick every box before submitting:

```markdown
### Build & manifest
- [ ] `npm install` && `npm run build` succeed with no errors
- [ ] `bash scripts/pack-mcpb.sh` produces `dist/aws-partner-central.mcpb` cleanly
- [ ] `npx mcpb validate manifest.json` passes with no errors
- [ ] `npx mcpb info dist/aws-partner-central.mcpb` shows the expected files/metadata
- [ ] `version` bumped in BOTH `manifest.json` and `package.json` (and matched by the git tag)

### Required for Directory submission
- [ ] EVERY tool has `readOnlyHint` + `destructiveHint` annotations (plus idempotent/openWorld) — #1 rejection cause
- [ ] `PRIVACY.md` is published at a public URL and linked from README + submission
- [ ] README has server description, feature list, setup/auth instructions
- [ ] README has at least 3 working usage examples with example prompts
- [ ] Support contact present (repo issues URL)
- [ ] Test path for reviewers documented (Sandbox catalog + verify_connection), or test credentials supplied
- [ ] Screenshots included OR explicitly noted N/A (tool-only server)

### Packaging hygiene
- [ ] Icon present and 512x512 (`icon.png`)
- [ ] LICENSE file present in the repo and bundle (✅ `LICENSE` exists; `pack-mcpb.sh` copies it)
- [ ] No secrets in the bundle (no `.env`, no AWS keys, no tokens) — verify with `npx mcpb info`
- [ ] `npm test` passes
- [ ] Bundle tested by installing the `.mcpb` on macOS
- [ ] Bundle tested by installing the `.mcpb` on Windows
- [ ] (Optional) bundle signed with `npx mcpb sign`
```

> **Repository note:** the `author.url`, `repository`, README install links, and
> `git clone` target all point at `https://github.com/customd/aws-partner-central-mcp`.
> **This repo must be created and made public, with a Release that has the `.mcpb`
> attached, before the README/links resolve and before you submit.** Verify each
> URL returns HTTP 200 first.

---

## Versioning reminder

Keep `version` in **`manifest.json`** and **`package.json`** in lockstep, and tag
each GitHub Release to match (currently `1.0.4`). Claude Desktop uses the manifest
version to detect and offer updates to installed extensions.
