# Privacy Policy — AWS Partner Central (Claude Desktop Extension)

**Effective date:** 2026-05-29

This privacy policy describes how the **AWS Partner Central** Claude Desktop
Extension (the "Extension") handles data. The Extension is an open-source,
locally-run MCP (Model Context Protocol) server distributed as an `.mcpb`
bundle. It runs on your own computer inside Claude Desktop and acts purely as a
**conduit** between Claude and Amazon Web Services (AWS). It is not a hosted
service, and the maintainer operates no servers, databases, or analytics
infrastructure on your behalf.

- **Author:** Josh / Custom D
- **Source code:** https://github.com/customd/aws-partner-central-mcp
- **License:** MIT

---

## Summary (TL;DR)

- The Extension runs **locally** on your machine. There is **no backend** operated by the author.
- It talks to **AWS only** — the AWS Partner Central agent endpoint and AWS IAM Identity Center / OIDC sign-in endpoints. Nothing else.
- It stores **no long-lived AWS access keys**. Sign-in uses AWS IAM Identity Center (SSO) via the OAuth 2.0 device authorization flow.
- The only thing written to disk is the **AWS SSO access token cache** (`~/.aws/sso/cache/`, `0600` permissions, ~8-hour validity) — identical to what the AWS CLI writes.
- **No telemetry, no analytics, no third-party data sharing.** Logs go to stderr only and never contain credentials or tokens.
- Your Partner Central business data and conversation sessions live in **AWS**, governed by your AWS agreement and the AWS Responsible AI Policy.

---

## 1. What the Extension is

The Extension is a local Node.js stdio MCP server. Claude Desktop spawns it as a
child process using its bundled Node runtime. The Extension:

1. Authenticates you to AWS via **IAM Identity Center** (formerly AWS SSO) using the OAuth 2.0 device authorization grant.
2. Exchanges your SSO token for **temporary role credentials** via `sso:GetRoleCredentials`.
3. **SigV4-signs** HTTPS requests with those temporary credentials.
4. Forwards JSON-RPC `tools/call` requests to the AWS Partner Central agents MCP endpoint at `https://partnercentral-agents-mcp.us-east-1.api.aws/mcp`.
5. Returns the agent's responses to Claude.

The Extension does not itself store or analyze your business data; AWS does that
on the server side.

---

## 2. Data the Extension processes

The Extension processes the following categories of data, all transiently and
locally, in order to perform its function:

- **Configuration you provide** at install time: your AWS IAM Identity Center start URL, 12-digit AWS account ID, SSO role/permission-set name, AWS region, default catalog (`AWS` or `Sandbox`), and log level. These are supplied to the Extension as environment variables by Claude Desktop's MCPB configuration system.
- **Your messages to the Partner Central agent**: the natural-language prompts and parameters you (via Claude) send to the agent — for example, questions about opportunities, ACE deal registrations, invitations, partner programs, certifications, training, or funding.
- **Agent responses**: the data the AWS Partner Central agent returns (opportunity details, session transcripts, etc.).
- **AWS credentials**: the SSO access token and temporary role credentials described in Section 4.
- **Optional file attachments**: local documents you choose to attach for analysis, described in Section 6.

All of this data is processed **only** to fulfill your request and is **scoped to
the authenticated AWS partner principal** (your account/role). The Extension does
not aggregate, mine, profile, or resell any of it.

---

## 3. What is stored locally (and where)

The Extension writes **exactly one** category of data to disk:

| Item | Location | Permissions | Lifetime |
|---|---|---|---|
| AWS SSO access token cache | `~/.aws/sso/cache/<sha1(startUrl)>.json` | `0600` (owner read/write only) | ~8 hours (AWS-issued token TTL) |

This is the **same location and file format used by the AWS CLI**. If you have
already run `aws sso login` for the same start URL, the Extension reuses that
cached session, and vice versa. The cache contains the SSO **access token** used
to request role credentials; it does **not** contain long-lived AWS access keys.

Nothing else is persisted to disk by the Extension — no configuration files, no
conversation history, no business data, no logs (logs go to stderr; see
Section 7).

---

## 4. Credential handling

- **No long-lived AWS access keys are ever stored or transmitted.** Authentication uses the OAuth 2.0 **device authorization flow** against your IAM Identity Center instance. The first time a tool is used in a session, your default browser opens to authorize the Extension; you click **Allow access** to grant it.
- The resulting **SSO access token** is cached on disk as described in Section 3 (~8-hour validity, `0600` permissions).
- **Temporary role credentials** obtained via `sso:GetRoleCredentials` (typically ~1-hour TTL) are held **in memory only** and refreshed automatically before expiry. They are **never written to disk**.
- All requests to AWS are signed with **AWS Signature Version 4 (SigV4)** and transmitted over **HTTPS (TLS 1.2+)**.

---

## 5. What is transmitted, and to whom

The Extension communicates with **AWS endpoints only**:

1. **AWS IAM Identity Center / OIDC endpoints** — for the device authorization sign-in flow and to obtain role credentials.
2. **AWS Partner Central agents MCP endpoint** — `https://partnercentral-agents-mcp.us-east-1.api.aws/mcp` — for your messages and the agent's responses.
3. **AWS S3** — only when you attach a local file (see Section 6).

The Extension **does not** transmit any data to the author, to Anthropic
servers, to analytics providers, or to any other third party. It "phones home"
to nothing except the AWS endpoints listed above.

All data sent to the Partner Central agent is governed by your agreement with
AWS and by the **AWS Responsible AI Policy**:
https://aws.amazon.com/machine-learning/responsible-ai/policy/

---

## 6. File attachments and the ephemeral S3 bucket

If you attach a local document for the agent to analyze, the Extension uploads it
to an **AWS-managed ephemeral S3 bucket**:

- **Bucket:** `aws-partner-central-marketplace-ephemeral-writeonly-files`
- **Prefix:** your AWS **account-ID** prefix within that bucket.
- AWS states these files are stored **temporarily and are not retained permanently**. Retention and deletion are controlled by AWS, not by this Extension or its author.

**Allowed file types:** `doc`, `docx`, `pdf`, `png`, `jpeg`, `xlsx`, `csv`, `txt`.

**Limits:**

- Maximum **3 files per message**.
- Document files (`doc`, `docx`, `pdf`, `xlsx`, `csv`, `txt`): **≤ 4.5 MB** each.
- Image files (`png`, `jpeg`): **≤ 3.75 MB** each.

> **WARNING — do not upload secrets.** Files you attach leave your machine and
> are uploaded to AWS for processing by the Partner Central agent. **Do not
> upload passwords, private keys, access keys, personal data, or any other
> sensitive material you do not want sent to AWS.** You are responsible for the
> contents of any file you choose to attach.

---

## 7. Logging

- The Extension emits **structured JSON log lines to `stderr` only**, visible in Claude Desktop's developer console.
- Logs are **not written to any file** by the Extension and are **not transmitted anywhere**.
- The Extension **does not log credential material** — SSO tokens, temporary role credentials, and SigV4 signatures are never written to the log.
- Log verbosity is controlled by the `Log Level` configuration field (`debug`, `info`, `warn`, `error`).

---

## 8. What we do NOT collect

- **No telemetry.** The Extension reports no usage data.
- **No analytics.** There is no analytics SDK, beacon, or event pipeline.
- **No third-party services.** No data is shared with the author or any third party.
- **No persistent business data.** The Extension does not maintain a database or persist your Partner Central content. Your data lives in AWS.
- **No advertising / no profiling.** None of your data is used for marketing or profiling.

---

## 9. Data retention

- **Local SSO token cache:** ~8 hours (the AWS-issued token TTL), after which it expires and the next tool call triggers re-authorization. You can delete it sooner (see Section 10).
- **In-memory role credentials:** ~1 hour, never persisted; discarded when the Extension process exits.
- **Partner Central conversation sessions:** stored in AWS and **expire after 48 hours**. Session lifecycle is controlled by AWS.
- **Ephemeral S3 file uploads:** retained temporarily by AWS per AWS's policy (see Section 6); not controlled by this Extension.

Because the Extension holds no server-side state, uninstalling it and clearing
the local token cache removes everything it stored on your machine.

---

## 10. Your control and choices

You remain in control of your data at all times:

- **Revoke the AWS SSO session:** run `aws sso logout` (if you have the AWS CLI), or **delete the cached token** at `~/.aws/sso/cache/`. The next tool call will require fresh browser authorization.
- **Clear local state entirely:** delete the file(s) under `~/.aws/sso/cache/` that correspond to your start URL.
- **Uninstall the Extension:** remove it from **Claude Desktop → Settings → Extensions**. This stops the local server from running.
- **Control write operations:** write/destructive actions surfaced by the Partner Central agent require **human approval** before they are carried out.
- **Choose your catalog:** use the `Sandbox` catalog for testing to avoid touching production partner data.
- **Decline file uploads:** simply do not attach files you do not want sent to AWS.

To revoke the Extension's permission set at the AWS level, contact your AWS
administrator (the permission set / role is provisioned by your organization in
IAM Identity Center).

---

## 11. Security measures

- OAuth 2.0 device authorization for sign-in; **no long-lived keys**.
- SSO token cached with restrictive `0600` file permissions.
- Temporary credentials held **in memory only**, never on disk.
- **HTTPS (TLS 1.2+)** for all network traffic.
- **AWS SigV4** request signing on every AWS request.
- Credential material is **never logged**.
- Open-source code available for independent audit at the repository linked above.

---

## 12. Children's privacy

The Extension is a business-to-business tool for AWS partners and is not directed
to children. It collects no personal data from anyone, including children.

---

## 13. Changes to this policy

This policy may be updated as the Extension evolves. Material changes will be
reflected in this `PRIVACY.md` file in the project repository, with an updated
**Effective date** at the top. Because the Extension is distributed as a
versioned bundle, you can review the policy that corresponds to the version you
have installed in the repository's history. Continued use of the Extension after
an update constitutes acceptance of the revised policy.

---

## 14. Contact and support

Questions, concerns, or privacy reports can be filed as a GitHub issue:

- **Support / contact:** https://github.com/customd/aws-partner-central-mcp/issues

---

*This Extension is an independent open-source project. "AWS", "Amazon Web
Services", and "AWS Partner Central" are trademarks of Amazon.com, Inc. or its
affiliates. Your use of AWS Partner Central is governed by your agreement(s)
with AWS, including the AWS Responsible AI Policy.*
