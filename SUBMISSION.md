# Claude Connectors Directory — Submission Packet

Copy-paste content for the **Desktop Extensions submission form**.

- **Submission form (desktop extensions / MCPB):** <https://clau.de/desktop-extention-submission>
  (linked from the canonical docs: <https://claude.com/docs/connectors/building/submission>)
- Local desktop extensions (MCPB) **are** eligible for the directory.
- Review time varies with queue; escalations: `mcp-review@anthropic.com`.

> **Pre-flight (all current ✅):** `npx mcpb validate manifest.json` passes; every tool has a `title` + `readOnlyHint`/`destructiveHint`; README has a **Privacy Policy** section and `manifest.json` has a `privacy_policies` array; `PRIVACY.md` is public; README has setup + ≥3 examples + support contact; the **v1.0.1** `.mcpb` is attached to the GitHub release.

---

## Form fields

**Name:** AWS Partner Central

**Tagline:** Talk to the AWS Partner Central 3.0 agent from Claude — pipeline, opportunities, funding, and document analysis.

**Description:**
A Claude Desktop extension (local MCPB) that bridges Claude to AWS's hosted Partner Central agents MCP endpoint. AWS partners can ask natural-language questions about their co-sell pipeline, get opportunity summaries and next-step guidance, generate sales plays and customer profiles, check AWS funding-program eligibility, and create or update opportunities and fund requests — with every write gated behind explicit human approval. Documents (proposals, transcripts, spreadsheets) can be attached for analysis. Authentication is via AWS IAM Identity Center; no long-lived AWS keys are stored.

**Use cases:**
1. "List my open ACE opportunities closing in Q1 2026."
2. "Give me a summary of opportunity O1234567890 and tell me what I need to do next."
3. "Am I eligible for any funding programs on opportunity O6789012345?"
4. "Here are my call notes (attached PDF) — create an opportunity from this transcript." (then approve the proposed write)

**Category / tags:** Sales · CRM · AWS · Productivity

**Repository / documentation:** <https://github.com/customd/aws-partner-central-mcp> (README is the public docs link)

**Artifact:** v1.0.1 release — `aws-partner-central.mcpb` attached:
<https://github.com/customd/aws-partner-central-mcp/releases/tag/v1.0.1>

**Authentication type:** AWS IAM Identity Center (AWS SSO) device-authorization flow + AWS SigV4 request signing. **No Claude OAuth** and **no claude.ai/claude.com OAuth callback URLs** apply — auth is between the user's machine and their own AWS account.

**Transport protocol:** Local **stdio** (MCPB desktop extension). The local server bridges to AWS's remote HTTPS JSON-RPC endpoint (`partnercentral-agents-mcp.us-east-1.api.aws`, TLS 1.2+, SigV4).

**Capabilities:** Tools only (4). No resources, no prompts. Not an MCP App (no custom UI).

**Tools (all have `title` + annotations):**
- `partner_central_send_message` — readOnlyHint:false, destructiveHint:false
- `partner_central_respond_to_approval` — readOnlyHint:false, **destructiveHint:true** (executes approved writes)
- `partner_central_get_session` — readOnlyHint:true, idempotentHint:true
- `partner_central_verify_connection` — readOnlyHint:false (creates a throwaway Sandbox session)

**Setup instructions:**
1. Install the `.mcpb` in Claude Desktop → Settings → Extensions.
2. Fill the config dialog: AWS SSO start URL, 12-digit account ID, SSO role name, region (`us-east-1`), default catalog.
3. On first use, the browser opens for AWS IAM Identity Center sign-in → Allow access.
IAM-permission guidance: README → "IAM permissions".

**Data handling:** Processes only the user's prompts and the agent's responses, scoped to the authenticated AWS principal. Stored locally: only the AWS SSO access token cache (`~/.aws/sso/cache/`, `0600`, ~8h) — same as the AWS CLI. Temporary role credentials are in-memory only. Optional file attachments are uploaded to an AWS-managed ephemeral S3 bucket for analysis. **No telemetry, no analytics, no third-party services.** Full policy: PRIVACY.md.

**Third-party connections:** AWS only (Partner Central agents MCP endpoint + AWS IAM Identity Center / OIDC + AWS S3 for attachments). None else.

**Health data access:** None.

**Privacy policy URL:** <https://github.com/customd/aws-partner-central-mcp/blob/main/PRIVACY.md>

**Support contact:** <https://github.com/customd/aws-partner-central-mcp/issues>

**Logo / favicon:** `icon.png` (512×512) in the repo root and bundle.

**Screenshots:** N/A — tool-only server, no custom UI (not an MCP App). A screenshot of Claude using the tools can be supplied on request.

**GA date:** 2026-05-30

**Tested surfaces:** Claude Desktop on macOS. (Windows/Linux declared in the manifest; macOS is the surface tested to date — see note below.)

**Test account / credentials for reviewers:**
Live use requires an AWS Partner Central account enrolled via IAM Identity Center, which reviewers won't have by default. Options we can provide:
- The `partner_central_verify_connection` tool runs a benign check against the **Sandbox** catalog (no production data).
- On request (via the support URL or `mcp-review@anthropic.com` thread), we can provision a **temporary scoped test SSO account** limited to the Sandbox catalog, or do a **live screen-share demo**.
Please reach out and we'll arrange reviewer access promptly.

---

## Before you submit — final checks
- [ ] (Recommended) Smoke-test the installed `.mcpb` on **Windows** too, or state "macOS-tested" in the form (done above).
- [ ] Confirm the v1.0.1 release `.mcpb` downloads and installs cleanly.
- [ ] Have a plan ready for the **reviewer test-access** ask (Sandbox demo or temp SSO).
- [ ] Privacy policy URL resolves (200) and README has the Privacy Policy section. ✅
