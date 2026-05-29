# Connectors Directory — Submission Packet

Copy-paste content for the **MCP Directory Server Review Form** (linked from
<https://claude.com/docs/connectors/building/submission>). Anthropic reviews manually; expect ~2 weeks.
See [DISTRIBUTION.md](./DISTRIBUTION.md) Part C for the requirements rationale.

> **Pre-flight:** `npx mcpb validate manifest.json` passes, every tool is annotated, `PRIVACY.md`
> is public, README has setup + ≥3 examples + support contact, and the v1.0.1 `.mcpb` is attached
> to the GitHub release. ✅ all current.

---

**Server / connector name:** AWS Partner Central

**One-line description:**
Talk to the AWS Partner Central 3.0 agent from Claude Desktop — pipeline insights, opportunities, funding programs, and document analysis — over AWS IAM Identity Center SSO.

**Category / tags:** Sales · CRM · AWS · Productivity

**Full description:**
A Claude Desktop extension (local MCPB) that bridges Claude to AWS's hosted Partner Central agents MCP endpoint. AWS partners can ask natural-language questions about their co-sell pipeline, get opportunity summaries and next-step guidance, generate sales plays and customer profiles, check AWS funding-program eligibility, and create or update opportunities and fund requests — with every write gated behind explicit human approval. Documents (proposals, transcripts, spreadsheets) can be attached for the agent to analyse. Authentication is handled via AWS IAM Identity Center; no long-lived AWS keys are stored.

**Key features:**
- Conversational access to AWS Partner Central (opportunities / ACE deal registrations, funding, solutions, customer profiles)
- Pipeline insights, opportunity summaries, sales plays, next-step recommendations
- Create / update / progress opportunities and funding applications — **human-in-the-loop approval on every write**
- File attachments (PDF, DOCX, XLSX, CSV, images) for document-driven workflows
- AWS IAM Identity Center (SSO) device-flow auth + SigV4 signing; no stored access keys
- Sandbox catalog for safe testing; rate-limit-aware retries; automatic credential refresh

**Tools (all annotated):**
- `partner_central_send_message` — readOnly:false, destructive:false
- `partner_central_respond_to_approval` — readOnly:false, **destructive:true**
- `partner_central_get_session` — readOnly:true, idempotent:true
- `partner_central_verify_connection` — readOnly:false (creates a throwaway Sandbox session)

**Setup / authentication instructions:**
1. Install the `.mcpb` in Claude Desktop → Settings → Extensions.
2. Fill the config dialog: AWS SSO start URL, 12-digit account ID, SSO role name, region (`us-east-1`), default catalog.
3. On first use, the browser opens for AWS IAM Identity Center sign-in → Allow access.
Full IAM-permission guidance is in the [README](./README.md#iam-permissions).

**Authentication model — IMPORTANT (read this so you don't request OAuth URLs):**
This is a **local MCPB desktop extension**, not a remote OAuth connector. It authenticates the **end user to their own AWS account** via AWS IAM Identity Center (AWS SSO) device authorization + SigV4 request signing, entirely on the user's machine. There is **no claude.ai / claude.com OAuth redirect**, so OAuth callback URLs do **not** apply. The requirements that do apply — tool annotations, published privacy policy, documentation with ≥3 examples, and a support contact — are all met.

**Usage examples (≥3):**
1. "List my open ACE opportunities closing in Q1 2026."
2. "Give me a summary of opportunity O1234567890 and tell me what I need to do next."
3. "Am I eligible for any funding programs on opportunity O6789012345?"
4. "Here are my call notes (attached PDF) — create an opportunity from this transcript." (then approve the proposed write)

**Privacy policy:** <https://github.com/customd/aws-partner-central-mcp/blob/main/PRIVACY.md>

**Support contact:** <https://github.com/customd/aws-partner-central-mcp/issues>

**Repository / artifact:** <https://github.com/customd/aws-partner-central-mcp> — v1.0.1 release has the signed-ready `.mcpb`.

**Test access for reviewers:**
Live use requires an AWS Partner Central account enrolled via IAM Identity Center, which reviewers won't have by default. To exercise it: (a) the `partner_central_verify_connection` tool runs a benign check against the **Sandbox** catalog; (b) we can provide a temporary scoped test SSO account / live demo on request. Please contact us via the support URL to arrange reviewer access — happy to screen-share a Sandbox walkthrough.

**Screenshots:** This is a tool-only server with no custom interactive UI (not an MCP App), so UI screenshots are **N/A**. (A screenshot of Claude using the tools can be supplied on request.)
