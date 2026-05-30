# Claude Connectors Directory — Submission Packet

Copy-paste content for the **Desktop Extensions submission form**.

- **Submission form (desktop extensions / MCPB):** <https://clau.de/desktop-extention-submission>
  (linked from the canonical docs: <https://claude.com/docs/connectors/building/submission>)
- Local desktop extensions (MCPB) **are** eligible for the directory.
- Review time varies with queue; escalations: `mcp-review@anthropic.com`.

> **Pre-flight (all current ✅):** `npx mcpb validate manifest.json` passes; every tool has a `title` + `readOnlyHint`/`destructiveHint`; README has a **Privacy Policy** section and `manifest.json` has a `privacy_policies` array; `PRIVACY.md` is public; README has setup + ≥3 examples + support contact; the **v1.0.7** `.mcpb` is attached to the GitHub release.

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
5. "Switch to the customd account with the PartnerCentral-Executives role." (when your sign-in can reach several account/role combos)

**Category / tags:** Sales · CRM · AWS · Productivity

**Repository / documentation:** <https://github.com/customd/aws-partner-central-mcp> (README is the public docs link)

**Artifact:** v1.0.7 release — `aws-partner-central.mcpb` attached:
<https://github.com/customd/aws-partner-central-mcp/releases/tag/v1.0.7>

**Authentication type:** AWS IAM Identity Center (AWS SSO) device-authorization flow + AWS SigV4 request signing. **No Claude OAuth** and **no claude.ai/claude.com OAuth callback URLs** apply — auth is between the user's machine and their own AWS account.

**Transport protocol:** Local **stdio** (MCPB desktop extension). The local server bridges to AWS's remote HTTPS JSON-RPC endpoint (`partnercentral-agents-mcp.us-east-1.api.aws`, TLS 1.2+, SigV4).

**Capabilities:** Tools only (5). No resources, no prompts. Not an MCP App (no custom UI).

**Tools (all have `title` + annotations):**
- `partner_central_send_message` — readOnlyHint:false, destructiveHint:false
- `partner_central_respond_to_approval` — readOnlyHint:false, **destructiveHint:true** (executes approved writes)
- `partner_central_get_session` — readOnlyHint:true, idempotentHint:true
- `partner_central_verify_connection` — readOnlyHint:true, idempotentHint:true (read-only reachability probe; creates nothing, may trigger SSO sign-in)
- `partner_central_select_account` — readOnlyHint:false, destructiveHint:false, idempotentHint:true

**Setup instructions:**
1. Install the `.mcpb` in Claude Desktop → Settings → Extensions.
2. Fill the config dialog: **AWS SSO start URL** is the only required field. Account ID, role name, and default catalog are optional — account/role are auto-detected from the SSO session after sign-in (a dropdown appears if several are available). Region is fixed to `us-east-1`.
3. On first use, the browser opens for AWS IAM Identity Center sign-in → Allow access.
IAM-permission guidance: README → "IAM permissions".

**Data handling:** Processes only the user's prompts and the agent's responses, scoped to the authenticated AWS principal. To auto-detect the account/role it calls `sso:ListAccounts`/`sso:ListAccountRoles` (the user's own access list; no extra IAM permissions, no local files read). Stored locally (both `0600`): the AWS SSO access token cache (`~/.aws/sso/cache/`, ~8h, same as the AWS CLI) and a small account/role selection file (`~/.aws-partner-central/`, non-secret identifiers only). Temporary role credentials are in-memory only. Optional file attachments are uploaded to an AWS-managed ephemeral S3 bucket for analysis. **No telemetry, no analytics, no third-party services.** Full policy: PRIVACY.md.

**Third-party connections:** AWS only (Partner Central agents MCP endpoint + AWS IAM Identity Center / OIDC + AWS S3 for attachments). None else.

**Health data access:** None.

**Privacy policy URL:** <https://github.com/customd/aws-partner-central-mcp/blob/main/PRIVACY.md>

**Support contact:** <https://github.com/customd/aws-partner-central-mcp/issues>

**Logo / favicon:** `icon.png` (512×512) in the repo root and bundle.

**Screenshots:** N/A — tool-only server, no custom UI (not an MCP App). A screenshot of Claude using the tools can be supplied on request.

**GA date:** 2026-05-30

**Supported surfaces:** Claude Desktop (macOS, Windows, and Linux — all declared in the manifest).

**Test account / credentials for reviewers:**
Live use requires an AWS Partner Central account enrolled via IAM Identity Center, which reviewers won't have by default. Options we can provide:
- The `partner_central_verify_connection` tool runs a read-only reachability probe (a non-existent-session lookup that creates nothing); reviewers can target the **Sandbox** catalog explicitly via the `catalog` argument.
- On request (via the support URL or `mcp-review@anthropic.com` thread), we can provision a **temporary scoped test SSO account** limited to the Sandbox catalog, or do a **live screen-share demo**.
Please reach out and we'll arrange reviewer access promptly.

---

## Before you submit — final checks
- [ ] (Recommended) Smoke-test the installed `.mcpb` on your target platform(s).
- [ ] Confirm the v1.0.4 release `.mcpb` downloads and installs cleanly.
- [ ] Have a plan ready for the **reviewer test-access** ask (Sandbox demo or temp SSO).
- [ ] Privacy policy URL resolves (200) and README has the Privacy Policy section. ✅
