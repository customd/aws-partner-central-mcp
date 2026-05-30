import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "../logger.js";
import {
  PartnerCentralClient,
  PartnerCentralError,
} from "../services/partner-central-client.js";
import { AttachmentError } from "../services/attachment-uploader.js";
import {
  NeedsSelectionError,
  NoAccessError,
  findOption,
  type AccountRoleOption,
  type ElicitAccountRole,
} from "../services/account-role.js";
import { parseAgentResponse } from "../services/response-parser.js";
import {
  GetSessionInputSchema,
  RespondToApprovalInputSchema,
  SendMessageInputSchema,
  SelectAccountInputSchema,
  VerifyConnectionInputSchema,
  type GetSessionInput,
  type RespondToApprovalInput,
  type SendMessageInput,
  type SelectAccountInput,
  type VerifyConnectionInput,
} from "../schemas/inputs.js";
import {
  AgentResponseOutputSchema,
  SelectAccountOutputSchema,
  VerifyConnectionOutputSchema,
} from "../schemas/outputs.js";
import { formatAgentResponse } from "./format.js";
import type { ContentBlock, PartnerCentralConfig } from "../types.js";
import { ERROR_CODE } from "../constants.js";

/**
 * Mask all but the last 4 digits of an AWS account ID for display/logging
 * (e.g. "123456789012" → "********9012"). Returns "(auto-detect on sign-in)"
 * when the id is not yet known — the single source of truth for this format,
 * shared by the tools, verify_connection, and the startup log.
 */
export function maskAccountId(id?: string): string {
  return id ? id.replace(/\d(?=\d{4})/g, "*") : "(auto-detect on sign-in)";
}

function describePartnerCentralError(err: PartnerCentralError): string {
  const parts: string[] = [`Error: ${err.message}`];
  if (err.httpStatus !== undefined) parts.push(`HTTP ${err.httpStatus}`);
  if (err.code !== undefined) parts.push(`JSON-RPC code ${err.code}`);

  switch (err.code) {
    case ERROR_CODE.AUTHENTICATION_FAILURE:
      parts.push(
        "(AuthenticationFailure — your AWS SSO session or credentials expired. Run partner_central_verify_connection to re-authorize.)",
      );
      break;
    case ERROR_CODE.TOOL_PERMISSION_DENIED:
      parts.push(
        "(ToolPermissionDenied — your AWS role lacks the partnercentral: action required for this operation. Ask your administrator to grant it, e.g. CreateOpportunity, UpdateOpportunity, or CreateBenefitApplication.)",
      );
      break;
    case ERROR_CODE.ACCESS_DENIED:
      parts.push(
        "(AccessDenied — the account may not be enrolled in Partner Central, or there is a region/catalog mismatch.)",
      );
      break;
    case ERROR_CODE.LIMIT_EXCEEDED:
      parts.push(
        "(LimitExceeded — Partner Central rate limits sendMessage to ~2 requests/minute. Wait a few seconds and try again.)",
      );
      break;
    case ERROR_CODE.RESOURCE_NOT_FOUND:
      parts.push(
        "(ResourceNotFound — the session may have expired (>48h), the resource ID may be wrong, or the session belongs to a different catalog.)",
      );
      break;
    case ERROR_CODE.INVALID_PARAMS:
    case ERROR_CODE.INVALID_REQUEST:
      if (/tool use id|pending tool request/i.test(err.message)) {
        parts.push(
          "(Stale approval — the pending action changed since its tool_use_id was read (e.g. the agent re-proposed it). Call partner_central_get_session to read the CURRENT approval_requests[].tool_use_id, reconfirm the proposal with the user, then retry partner_central_respond_to_approval with that id.)",
        );
      } else {
        parts.push(
          "(InvalidRequest — a common cause is reusing a session_id across catalogs. Sessions are catalog-scoped: drop session_id or switch catalog.)",
        );
      }
      break;
    default:
      if (err.httpStatus === 403) {
        parts.push(
          "(AccessDenied — the SSO role may lack partnercentral:UseSession, or the SSO session has expired.)",
        );
      }
  }
  return parts.join(" ");
}

function errorResult(text: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

function successResult(
  text: string,
  structured: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

function handleError(err: unknown): ReturnType<typeof errorResult> {
  if (err instanceof AttachmentError) {
    return errorResult(`Attachment error: ${err.message}`);
  }
  if (err instanceof NeedsSelectionError) {
    const lines = [
      "You can access more than one AWS Partner Central account/role, so one must be chosen.",
      "Show the user these options, ask which to use, then call partner_central_select_account with that account_id and role_name:",
      ...err.options.map(
        (o, i) => `  ${i + 1}. ${o.label}   (account_id ${o.accountId}, role_name ${o.roleName})`,
      ),
    ];
    return errorResult(lines.join("\n"));
  }
  if (err instanceof NoAccessError) {
    return errorResult(err.message);
  }
  if (err instanceof PartnerCentralError) {
    return errorResult(describePartnerCentralError(err));
  }
  return errorResult(`Unexpected error: ${(err as Error).message ?? String(err)}`);
}

/**
 * Build the account/role picker. If the connected client supports MCP
 * elicitation, present a single-select form (rendered as a dropdown);
 * otherwise return null so the caller can surface the options as text.
 */
function makeAccountRoleElicitor(server: McpServer): ElicitAccountRole {
  return async (options: AccountRoleOption[]) => {
    const caps = server.server.getClientCapabilities?.();
    if (!caps?.elicitation) {
      logger.debug("Client lacks elicitation capability — surfacing options as text");
      return null;
    }
    const labels = options.map((o) => o.label);
    try {
      const result = await server.server.elicitInput({
        message:
          "You can access more than one AWS Partner Central account/role. Which should this extension use?",
        requestedSchema: {
          type: "object",
          properties: {
            selection: {
              type: "string",
              title: "Account / role",
              description: "Choose the AWS account and permission-set role to use.",
              enum: labels,
            },
          },
          required: ["selection"],
        },
      });
      if (result.action !== "accept") return null;
      const chosen = result.content?.selection;
      const picked = options.find((o) => o.label === chosen);
      return picked ? { accountId: picked.accountId, roleName: picked.roleName } : null;
    } catch (err) {
      logger.warn("Elicitation failed; falling back to text selection", {
        error: (err as Error).message,
      });
      return null;
    }
  };
}

/**
 * Core of partner_central_select_account, factored out for testability: enumerate
 * the account/role options, validate the requested pair against them, and either
 * reject (listing the valid options) or pin + persist the selection. The registered
 * tool callback is a thin wrapper around this.
 */
export async function runSelectAccount(
  client: Pick<PartnerCentralClient, "listAvailableAccountRoles" | "setSelectedIdentity">,
  params: SelectAccountInput,
): Promise<ReturnType<typeof errorResult> | ReturnType<typeof successResult>> {
  try {
    const options = await client.listAvailableAccountRoles();
    const match = findOption(options, {
      accountId: params.account_id,
      roleName: params.role_name,
    });
    if (!match) {
      const lines = [
        "That account/role isn't one you can access. Choose from:",
        ...options.map(
          (o: AccountRoleOption, i: number) =>
            `  ${i + 1}. ${o.label}   (account_id ${o.accountId}, role_name ${o.roleName})`,
        ),
      ];
      return errorResult(lines.join("\n"));
    }
    await client.setSelectedIdentity({
      accountId: match.accountId,
      roleName: match.roleName,
    });
    const masked = maskAccountId(match.accountId);
    return successResult(
      `✅ Using AWS account ${masked} with role ${match.roleName}. I'll remember this for future requests — call partner_central_select_account anytime to switch.`,
      { ok: true, account_id: masked, role_name: match.roleName },
    );
  } catch (err) {
    return handleError(err);
  }
}

export function registerTools(
  server: McpServer,
  config: PartnerCentralConfig,
): void {
  const client = new PartnerCentralClient(config, {
    elicit: makeAccountRoleElicitor(server),
  });

  server.registerTool(
    "partner_central_send_message",
    {
      title: "Send Message to AWS Partner Central Agent",
      description: `Send a natural-language message (optionally with file attachments) to the AWS Partner Central 3.0 agent and return its response.

The Partner Central agent helps with co-sell workflows: pipeline insights, opportunity creation/cloning/summary/progression, sales plays, customer profiles, solution recommendations, and AWS funding programs. It reads your live Partner Central data and can perform write operations — but every write is gated behind an explicit approval step (see below).

Use this tool whenever the user asks about their AWS partner account: opportunities (ACE deal registrations), pipeline, invitations, partner programs, certifications, funding (MAP/POC/etc.), or wants to create/update an opportunity or funding request — including from an attached document.

Args:
  - message (string, required): The instruction or question. Examples: "List my open opportunities closing in Q1", "Summarize opportunity O1234567890", "Create an opportunity from the attached proposal", "Am I eligible for MAP funding on O123?".
  - attachments (string[], optional): Up to 3 absolute local file paths to upload for analysis (doc, docx, pdf, png, jpeg, xlsx, csv, txt; docs <=4.5MB, images <=3.75MB). Uploaded to an AWS ephemeral bucket — never attach secrets.
  - catalog ('AWS' | 'Sandbox', optional): Override the default catalog. Sessions are catalog-scoped.
  - session_id (string, optional): Continue an existing conversation. Sessions expire 48 hours after creation.
  - response_format ('markdown' | 'json', optional, default 'markdown').
  - show_activity (boolean, optional, default true): append a collapsed, expandable trace of the agent's internal tool steps and 'thinking'. Set false to hide it.

Approval workflow:
  If the agent proposes a write (create/update/submit opportunity, create/submit funding application), the response has status 'requires_approval' and describes the proposed change in the reply text. Show the user exactly what will change. To proceed, EITHER reply in this same session with a natural-language partner_central_send_message ("approve", "reject because…", or "change X to Y"), OR call partner_central_get_session to fetch the pending action's tool_use_id and then call partner_central_respond_to_approval. No write executes without your confirmation.

Returns structured content: { session_id, status ('complete'|'requires_approval'|'error'), text, approval_requests?, raw, truncated? }.

Errors: AuthenticationFailure/-32001 or HTTP 403 (run partner_central_verify_connection); LimitExceeded/-32004 (rate-limited, retry shortly); InvalidRequest (often a cross-catalog session_id); ResourceNotFound/-30001 (session expired or wrong catalog).`,
      inputSchema: SendMessageInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: SendMessageInput) => {
      const catalog = params.catalog ?? config.defaultCatalog;
      try {
        const content: ContentBlock[] = [{ type: "text", text: params.message }];
        if (params.attachments && params.attachments.length > 0) {
          logger.debug("Uploading attachments", {
            count: params.attachments.length,
          });
          const docs = await client.uploadDocuments(params.attachments);
          content.push(...docs);
        }
        const args: Record<string, unknown> = { content, catalog };
        if (params.session_id !== undefined) args.sessionId = params.session_id;
        logger.debug("Calling sendMessage", {
          catalog,
          hasSession: params.session_id !== undefined,
          attachments: params.attachments?.length ?? 0,
        });
        const raw = await client.callTool("sendMessage", args);
        const parsed = parseAgentResponse(raw);
        const formatted = formatAgentResponse(
          parsed,
          params.response_format,
          params.show_activity,
        );
        return successResult(formatted.text, formatted.structured);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "partner_central_respond_to_approval",
    {
      title: "Approve, Reject, or Override a Partner Central Write Operation",
      description: `Respond to a Partner Central write operation that is awaiting approval (a send_message response with status 'requires_approval').

Use this for an explicit, structured decision. (You can also approve/reject conversationally by sending a natural-language partner_central_send_message in the same session — the agent honors it.) Always confirm the proposed values with the user before approving.

Args:
  - session_id (string, required): The session that returned 'requires_approval'.
  - tool_use_id (string, required): The pending action's tool_use_id. It is usually NOT in the send_message response (it arrives via streaming) — call partner_central_get_session(session_id) and read approval_requests[].tool_use_id to obtain it. Fetch it immediately before approving; the id changes if the agent re-proposes, so if you get a "does not match pending tool request" error, re-fetch via get_session and retry.
  - decision ('approve' | 'reject' | 'override', required): 'approve' executes as proposed; 'reject' cancels (use message to explain); 'override' executes with the modified instructions in message.
  - message (string, optional): Required for 'override', recommended for 'reject'.
  - catalog ('AWS' | 'Sandbox', optional), response_format ('markdown' | 'json', optional).

Returns the agent's response after the decision is applied (same shape as send_message).`,
      inputSchema: RespondToApprovalInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RespondToApprovalInput) => {
      const catalog = params.catalog ?? config.defaultCatalog;
      const block: ContentBlock = {
        type: "tool_approval_response",
        toolUseId: params.tool_use_id,
        decision: params.decision,
        ...(params.message !== undefined ? { message: params.message } : {}),
      };
      logger.debug("Calling sendMessage with approval response", {
        catalog,
        decision: params.decision,
      });
      try {
        const raw = await client.callTool("sendMessage", {
          content: [block],
          catalog,
          sessionId: params.session_id,
        });
        const parsed = parseAgentResponse(raw);
        const formatted = formatAgentResponse(
          parsed,
          params.response_format,
          params.show_activity,
        );
        return successResult(formatted.text, formatted.structured);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "partner_central_get_session",
    {
      title: "Get AWS Partner Central Conversation Session",
      description: `Retrieve the transcript and current state of an existing Partner Central conversation session.

Use when the user references a previous Partner Central conversation by session ID, or to inspect a session's full state before sending more messages.

Args:
  - session_id (string, required): The session identifier from a previous send_message response.
  - catalog ('AWS' | 'Sandbox', optional): Catalog the session was created in. Sessions are catalog-scoped.
  - response_format ('markdown' | 'json', optional, default 'markdown').

Returns structured content: { session_id, status, text (rendered transcript), events, raw, truncated? }.

Errors: ResourceNotFound/-30001 (session expired >48h or wrong catalog); HTTP 403 / AuthenticationFailure (SSO expired or insufficient permissions).`,
      inputSchema: GetSessionInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetSessionInput) => {
      const catalog = params.catalog ?? config.defaultCatalog;
      logger.debug("Calling getSession", { catalog });
      try {
        const raw = await client.callTool("getSession", {
          sessionId: params.session_id,
          catalog,
        });
        const parsed = parseAgentResponse(raw);
        const formatted = formatAgentResponse(parsed, params.response_format);
        return successResult(formatted.text, formatted.structured);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "partner_central_verify_connection",
    {
      title: "Verify AWS Partner Central Setup & Connection",
      description: `Setup & diagnostics: verifies AWS SSO sign-in, SigV4 signing, and Partner Central reachability with a read-only probe (a lookup of a non-existent session, which creates nothing), and reports the effective configuration (account ID masked) so you can confirm or correct the user's setup conversationally.

Run this when:
  - The user is setting up the extension for the first time — show them the returned 'config' and confirm each value looks right (especially the role name and account ID, which they enter manually).
  - send_message is returning auth errors and you want to isolate the failure.
  - The user asks "is Partner Central working?" or "did I set this up right?"

On failure, explain what to fix and where: the SSO start URL, account ID, and role name come from the user's AWS access portal, and are edited in Claude Desktop → Settings → Extensions → AWS Partner Central. This runs a read-only reachability probe against your default catalog (override with 'catalog'); it creates nothing in any catalog.

Args:
  - catalog ('AWS' | 'Sandbox', optional): Override the catalog to verify against. Defaults to your configured default catalog.

Returns structured content: { ok, catalog, config: { sso_start_url, account_id (masked), role_name, region, default_catalog }, error? }.`,
      inputSchema: VerifyConnectionInputSchema.shape,
      outputSchema: VerifyConnectionOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: VerifyConnectionInput) => {
      const catalog = params.catalog ?? config.defaultCatalog;
      // A session id that cannot exist; the probe below is a read-only lookup, so a
      // "not found" reply proves SSO + SigV4 + reachability without creating anything.
      const PROBE_SESSION_ID = "session-00000000-0000-0000-0000-000000000000";
      // Built after the call so it reflects the resolved/auto-detected identity.
      const buildSetup = (): {
        summary: Record<string, string>;
        lines: string[];
      } => {
        const resolved = client.getResolvedIdentity();
        const accountId = resolved?.accountId ?? config.sso.accountId;
        const roleName = resolved?.roleName ?? config.sso.roleName;
        const tag = resolved ? " (auto-detected)" : "";
        const summary = {
          sso_start_url: config.sso.startUrl,
          account_id: maskAccountId(accountId),
          role_name: roleName ?? "(auto-detect on sign-in)",
          region: config.region,
          default_catalog: config.defaultCatalog,
        };
        const lines = [
          "",
          "Setup:",
          `- SSO start URL: ${summary.sso_start_url}`,
          `- Account ID: ${summary.account_id}${tag}`,
          `- Role name: ${summary.role_name}${tag}`,
          `- Region: ${summary.region}`,
          `- Default catalog: ${summary.default_catalog}`,
        ];
        return { summary, lines };
      };
      const verified = (): ReturnType<typeof successResult> => {
        const { summary, lines } = buildSetup();
        const text = [
          "✅ Partner Central connection verified.",
          `- Catalog tested: ${catalog}`,
          "- SSO sign-in, SigV4 signing, and Partner Central reachability: all OK.",
          "- (Read-only reachability probe — no session or data was created.)",
          ...lines,
        ].join("\n");
        return successResult(text, { ok: true, catalog, config: summary });
      };

      try {
        // Read-only reachability probe: look up a session that cannot exist. A
        // processed "not found" reply (HTTP 200 business error) proves SSO +
        // SigV4 + endpoint reachability succeeded — without creating anything.
        await client.callTool("getSession", {
          sessionId: PROBE_SESSION_ID,
          catalog,
        });
        // The probe id resolved to a real session (astronomically unlikely) — still healthy.
        return verified();
      } catch (err) {
        // A processed business-error reply (e.g. "session not found") still proves
        // SSO + signing + reachability worked; only network, auth, or access
        // failures mean the connection/setup is actually broken.
        if (
          err instanceof PartnerCentralError &&
          !err.isNetworkError &&
          err.code !== ERROR_CODE.AUTHENTICATION_FAILURE &&
          err.code !== ERROR_CODE.ACCESS_DENIED &&
          err.code !== ERROR_CODE.TOOL_PERMISSION_DENIED &&
          err.httpStatus !== 401 &&
          err.httpStatus !== 403
        ) {
          return verified();
        }

        let message: string;
        if (err instanceof NeedsSelectionError) {
          message =
            "Multiple accounts/roles are available — ask the user which to use, then call partner_central_select_account with its account_id and role_name. Options: " +
            err.options.map((o) => `${o.label} (account_id ${o.accountId}, role_name ${o.roleName})`).join(" | ");
        } else if (err instanceof NoAccessError) {
          message = err.message;
        } else if (err instanceof PartnerCentralError) {
          message = describePartnerCentralError(err);
        } else {
          message = `Unexpected error: ${(err as Error).message ?? String(err)}`;
        }
        const { summary, lines } = buildSetup();
        const structured = {
          ok: false,
          catalog,
          config: summary,
          error: message,
        };
        const text = [
          "❌ Partner Central connection failed.",
          message,
          ...lines,
          "",
          "If a value above looks wrong, edit it in Claude Desktop → Settings → Extensions → AWS Partner Central. The SSO start URL (and, if set, account ID / role name) come from your AWS access portal.",
        ].join("\n");
        return {
          isError: true,
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      }
    },
  );

  server.registerTool(
    "partner_central_select_account",
    {
      title: "Select AWS Account & Role for Partner Central",
      description: `Pin which AWS account + permission-set role this extension uses — and switch it later.

Use this when another tool reports that multiple AWS accounts/roles are available and asks the user to choose, or whenever the user wants to switch account/role. Present the options to the user, confirm their choice, then call this with that account_id + role_name. The choice is remembered for future calls. If you don't already have the list of options, the selection error from the other tools includes it.

Args:
  - account_id (string, required): the 12-digit AWS account ID, chosen from the listed options.
  - role_name (string, required): the permission-set / role name in that account.

Returns { ok, account_id (masked), role_name }. If the pair isn't one the user can access, returns an error listing the valid options.`,
      inputSchema: SelectAccountInputSchema.shape,
      outputSchema: SelectAccountOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SelectAccountInput) => runSelectAccount(client, params),
  );
}
