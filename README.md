# AWS Partner Central — Claude Desktop Extension

A drag-and-drop Claude Desktop extension that connects Claude to the **AWS Partner Central 3.0 agent**. Ask natural-language questions about your AWS partner account — pipeline, opportunities (ACE deal registrations), funding programs, solutions, customer profiles — and let Claude create or update records on your behalf, with every write gated behind your explicit approval.

- **One-click install** — no AWS CLI, no Python, no Node setup required (Claude Desktop ships with Node)
- **AWS IAM Identity Center (SSO) sign-in** via browser device authorization — no long-lived access keys
- **AWS SigV4 request signing** handled transparently
- **File attachments** — attach proposals, transcripts, or spreadsheets (PDF, DOCX, XLSX, CSV, images) for the agent to analyze
- **Human-in-the-loop approval** — no write (create/update/submit) executes without your explicit confirmation
- **48-hour sessions** so conversations can be resumed
- **Production-grade** error handling, rate-limit-aware retries, and automatic credential refresh

---

## Install

1. Download `aws-partner-central.mcpb` from this repository's [Releases](https://github.com/customd/aws-partner-central-mcp/releases) page (or build from source — see below).
2. Open Claude Desktop.
3. Go to **Settings → Extensions**.
4. Drag the `.mcpb` file into the Extensions panel.
5. Claude Desktop opens a configuration dialog. Fill in:

   | Field | What to enter | Example |
   |---|---|---|
   | **AWS SSO Start URL** | Your IAM Identity Center portal URL | `https://your-org.awsapps.com/start` |
   | **AWS Account ID** | The 12-digit account ID that has Partner Central enrolled | `123456789012` |
   | **AWS SSO Role Name** | The permission set granting Partner Central access | `PartnerCentral-Executives` |
   | **AWS Region** | Partner Central region (only `us-east-1` is supported today) | `us-east-1` |
   | **Default Catalog** | `AWS` for production data, `Sandbox` for testing | `AWS` |
   | **Log Level** | `debug`, `info`, `warn`, `error` | `info` |

6. Click **Install**.

The first time you use a Partner Central tool, your default browser opens to authorize the extension. Click **Allow access** and return to Claude.

> **Tip:** the very first thing to try is asking Claude to *"verify my Partner Central connection."* That runs a safe Sandbox check and triggers sign-in.

---

## What Claude can do once installed

The Partner Central agent supports the full AWS co-sell workflow. Example prompts:

**Pipeline & insights**
- "List my open ACE opportunities closing in Q1 2026."
- "Which opportunities need my attention this week?"
- "What are the top reasons we lost opportunities in the last 6 months?"

**Opportunity details & next steps**
- "Give me a summary of opportunity O1234567890."
- "What do I need to do next to advance this opportunity? Is it ready for submission?"
- "Generate a sales play for the GlobalTech data-analytics deal."

**Create & update (with approval)**
- "Create an opportunity for Acme Corp — Redshift migration, close end of Q3, ~$40K/mo spend."
- "Clone opportunity O1234567890 for a new customer, Globex, same workload."
- "Update opportunity O1234567890: move it to Qualified and set revenue to $300K." *(Claude shows you exactly what will change and waits for your approval.)*

**Documents**
- "Here are my call notes (attached) — create an opportunity from this transcript."
- "Use this proposal PDF to draft an opportunity for the customer's SAP migration."

**Funding**
- "Am I eligible for any funding programs on opportunity O6789012345?"
- "Create a MAP benefit application for this opportunity."

If you want to continue a conversation later, ask Claude to note the session ID. Sessions live for 48 hours.

---

## Working with documents

Attach local files and the agent will read them alongside your question — for example to create or progress an opportunity from a proposal, meeting transcript, or spreadsheet.

- Provide **absolute file paths**. Up to **3 files** per message.
- Allowed types: **doc, docx, pdf, png, jpeg, xlsx, csv, txt**. Documents up to **4.5 MB**, images up to **3.75 MB**.
- Files are uploaded to an AWS-managed **ephemeral** S3 bucket scoped to your account, used transiently for analysis. **Never attach files containing credentials or secrets.**

Uploading requires that your AWS role can write to the Partner Central document bucket (`s3:PutObject` on `aws-partner-central-marketplace-ephemeral-writeonly-files/<your-account-id>/*`). If uploads fail with a permissions error, ask your AWS administrator to grant this.

---

## Write operations & the approval workflow

Every operation that changes data in Partner Central — creating, updating, or submitting an opportunity, or creating/submitting a funding application — is **human-in-the-loop**. The flow:

1. You ask Claude to make a change (e.g. "update the close date to March 31").
2. The agent responds with status `requires_approval` and the exact proposed values, plus an approval ID.
3. Claude shows you what will change. **Nothing has happened yet.**
4. You confirm; Claude calls `partner_central_respond_to_approval` to **approve**, **reject** (with a reason), or **override** (with corrected instructions).
5. Only then does the write execute.

This means you can review and correct any write before it touches your live partner data.

---

## Seeing the agent's reasoning

Each reply can include a collapsed **"🔧 Agent activity"** trace showing the internal tools the Partner Central agent ran (e.g. `analyze_pipeline`, `opportunity_creator`) and its `thinking` steps, with their inputs/outputs. It's on by default and tucked inside an expandable `<details>` block — open it when you want to see *how* the agent reached its answer, or pass `show_activity: false` to omit it. (The complete raw payload is always available via `response_format: "json"`.)

---

## Tools exposed to Claude

| Tool | What it does | Annotation |
|---|---|---|
| `partner_central_send_message` | Send a natural-language message (optionally with file attachments) to the Partner Central agent. Supports optional `session_id` for continuation and `catalog` override. | not read-only, not destructive |
| `partner_central_respond_to_approval` | Approve / reject / override a pending write operation (status `requires_approval`). The only path through which writes execute. | **destructive** |
| `partner_central_get_session` | Retrieve the transcript and state of an existing session by ID. | read-only, idempotent |
| `partner_central_verify_connection` | Diagnostic — sends a benign test message in **Sandbox** to confirm SSO + SigV4 + endpoint all work. | not read-only (creates a throwaway session) |

---

## How it works (under the hood)

```
Claude Desktop  <—stdio—>  this extension (Node)  <—HTTPS + SigV4—>  https://partnercentral-agents-mcp.us-east-1.api.aws/mcp
                                     │
                                     └─ file attachments ──> s3://aws-partner-central-marketplace-ephemeral-writeonly-files/<account-id>/
```

- The extension runs as a local Node process spawned by Claude Desktop's bundled Node runtime.
- AWS credentials are obtained via the OAuth 2.0 device authorization grant against your IAM Identity Center instance — no long-lived access keys are ever stored.
- The SSO access token is cached at `~/.aws/sso/cache/<sha1(start_url)>.json` (the same location and format the AWS CLI uses, so you can share a session with `aws sso login`).
- Temporary role credentials from `sso:GetRoleCredentials` are held in memory and refreshed automatically before expiry (and re-fetched if the endpoint reports an authentication failure).
- Every HTTPS request to the Partner Central endpoint is signed with AWS SigV4. The extension identifies itself to AWS via the recommended `_meta` integrator header.

No credentials touch disk except the standard AWS SSO token cache.

---

## Prerequisites

You need:

1. **Access to AWS Partner Central via IAM Identity Center.** Your AWS reseller or administrator provisions this. The typical permission set is `PartnerCentral-Executives`.
2. **The SSO portal URL, account ID, and role name** — your administrator can share these, or find them in the SSO portal.
3. **Claude Desktop 1.0+** (the Node runtime ships with it).

You do **not** need the AWS CLI, an existing `~/.aws/config` profile, or any IAM access keys.

### IAM permissions

At minimum the role needs MCP protocol access:

```json
{
  "Effect": "Allow",
  "Action": ["partnercentral:UseSession"],
  "Resource": "*",
  "Condition": { "Bool": { "aws:IsMcpServiceAction": "true" } }
}
```

To actually read and write Partner Central data, the role also needs data-access permissions. AWS publishes a managed policy (`AWSMcpServiceActionsFullAccess`) plus example **read-only** and **full-access** policies covering `partnercentral:List*`, `Get*`, `CreateOpportunity`, `UpdateOpportunity`, `SubmitOpportunity`, the `*BenefitApplication` funding actions, and the relevant `aws-marketplace:*` actions. See the [AWS Getting Started guide](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html) for the exact policy JSON. For file attachments, add `s3:PutObject` on the ephemeral document bucket.

Use the **read-only** policy for reporting use cases and grant write actions only when users need to create/update opportunities or funding applications.

---

## Troubleshooting

### "Configuration error: AWS SSO start URL is required"
The MCPB install dialog didn't save your config. Reinstall the extension and make sure all required fields are filled.

### Browser opens but no auth screen
Check that the URL in your default browser starts with your SSO portal hostname (e.g. `your-org.awsapps.com`). If you have multiple browser profiles, make sure the one signed into your work identity is the default — or copy the URL into the right profile manually.

### Auth errors (HTTP 403 / `AuthenticationFailure` / code -32001)
- Your SSO session expired. Run `partner_central_verify_connection` to trigger reauthorization (the extension also auto-refreshes credentials once on an auth failure).
- Or your role doesn't have `partnercentral:UseSession`. Confirm with your AWS administrator.

### "ToolPermissionDenied" (code -31004)
The agent tried an operation your role isn't allowed to perform (e.g. `CreateOpportunity`). Ask your administrator to grant the relevant `partnercentral:` action, or use a read-only request.

### "LimitExceeded" (code -32004)
Partner Central rate-limits `sendMessage` to ~2 requests/minute. The extension retries with backoff; if you still hit it, wait a few seconds.

### "InvalidRequest" / wrong-catalog session
Sessions are scoped per catalog. A session created in Sandbox cannot be reused in AWS (and vice-versa). Drop the `session_id` or switch catalogs.

### Attachment upload fails
Confirm the file is an allowed type within the size limits, and that your AWS role can write to the ephemeral document bucket (`s3:PutObject`).

### Logs
The extension logs JSON lines to stderr. View them in Claude Desktop's developer console (Cmd+Shift+I → Console). Set **Log Level** to `debug` in the extension config for verbose logs. Credentials and tokens are never logged.

---

## Build from source

```bash
git clone https://github.com/customd/aws-partner-central-mcp.git
cd aws-partner-central-mcp
npm install
npm run build
npm test
bash scripts/pack-mcpb.sh
# dist/aws-partner-central.mcpb is your bundle
```

Validate the manifest standalone:

```bash
npx mcpb validate manifest.json
```

Inspect a built bundle:

```bash
npx mcpb info dist/aws-partner-central.mcpb
```

See [DISTRIBUTION.md](./DISTRIBUTION.md) for how to publish this to the Claude extension directory.

---

## Project layout

```
.
├── manifest.json              # MCPB manifest (install dialog + runtime config)
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # Entry point — bootstraps McpServer over stdio
│   ├── config.ts              # Reads + validates env vars from MCPB user_config
│   ├── constants.ts
│   ├── logger.ts              # stderr-only structured logger
│   ├── types.ts
│   ├── services/
│   │   ├── sso-auth.ts        # SSO device flow + GetRoleCredentials + token cache
│   │   ├── signer.ts          # SigV4 request signing
│   │   ├── attachment-uploader.ts  # Ephemeral S3 upload for file attachments
│   │   └── partner-central-client.ts  # JSON-RPC over HTTPS, retries, re-auth
│   ├── schemas/
│   │   ├── inputs.ts          # Zod input schemas
│   │   └── outputs.ts         # Zod output schemas (structuredContent contract)
│   └── tools/
│       ├── index.ts           # Tool registrations
│       └── format.ts          # Response formatting (markdown/json + approval)
├── test/                      # Node-based tests (run with `npm test`)
├── server/                    # Compiled JS (gitignored; ships in .mcpb)
├── scripts/pack-mcpb.sh       # Production bundler
├── PRIVACY.md                 # Privacy policy
├── DISTRIBUTION.md            # How to distribute / submit to the directory
└── dist/aws-partner-central.mcpb  # The shippable artifact
```

---

## Security & privacy

- No long-lived AWS access keys are stored or transmitted.
- SSO access tokens are cached at `~/.aws/sso/cache/<sha1>.json` with `0600` permissions; the cache directory is tightened to `0700`.
- Temporary role credentials (~1-hour TTL) are held in memory only.
- The `PARTNER_CENTRAL_ENDPOINT` is validated to an AWS `*.api.aws` HTTPS host so signed credentials can't be redirected elsewhere.
- All endpoint traffic is HTTPS with AWS SigV4 signing (TLS 1.2+).
- The extension logs no credential material and collects no telemetry.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy.

---

## Support

Questions, bugs, or feature requests: open an issue at
[github.com/customd/aws-partner-central-mcp/issues](https://github.com/customd/aws-partner-central-mcp/issues).

---

## License

MIT — see [LICENSE](./LICENSE).
