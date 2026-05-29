import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "../logger.js";
import {
  PartnerCentralClient,
  PartnerCentralError,
} from "../services/partner-central-client.js";
import { AttachmentError } from "../services/attachment-uploader.js";
import { parseAgentResponse } from "../services/response-parser.js";
import {
  GetSessionInputSchema,
  RespondToApprovalInputSchema,
  SendMessageInputSchema,
  VerifyConnectionInputSchema,
  type GetSessionInput,
  type RespondToApprovalInput,
  type SendMessageInput,
  type VerifyConnectionInput,
} from "../schemas/inputs.js";
import {
  AgentResponseOutputSchema,
  VerifyConnectionOutputSchema,
} from "../schemas/outputs.js";
import { formatAgentResponse } from "./format.js";
import type { ContentBlock, PartnerCentralConfig } from "../types.js";
import { CATALOG_SANDBOX, ERROR_CODE } from "../constants.js";

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
      parts.push(
        "(InvalidRequest — a common cause is reusing a session_id across catalogs. Sessions are catalog-scoped: drop session_id or switch catalog.)",
      );
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
  if (err instanceof PartnerCentralError) {
    return errorResult(describePartnerCentralError(err));
  }
  return errorResult(`Unexpected error: ${(err as Error).message ?? String(err)}`);
}

export function registerTools(
  server: McpServer,
  config: PartnerCentralConfig,
): void {
  const client = new PartnerCentralClient(config);

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
  - tool_use_id (string, required): The pending action's tool_use_id. It is usually NOT in the send_message response (it arrives via streaming) — call partner_central_get_session(session_id) and read approval_requests[].tool_use_id to obtain it.
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
      title: "Verify AWS Partner Central Connection",
      description: `Diagnostic tool that verifies AWS SSO credentials, SigV4 signing, and Partner Central reachability by sending a benign test message.

Run this when:
  - The user is setting up the extension for the first time
  - send_message is returning auth errors and you want to isolate the failure
  - The user asks "is Partner Central working?" or similar

This always runs against the 'Sandbox' catalog for safety (overriding any configured default) so it can never surface or mutate production data. Note: it creates a short throwaway Sandbox session.

Args:
  - catalog ('AWS' | 'Sandbox', optional): Override the catalog to verify against. Defaults to 'Sandbox'.

Returns structured content: { ok, catalog, session_id?, agent_status?, preview?, error? }.`,
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
      const catalog = params.catalog ?? CATALOG_SANDBOX;
      try {
        const raw = await client.callTool("sendMessage", {
          content: [
            {
              type: "text",
              text: "Reply with exactly: 'Partner Central MCP connection OK.'",
            },
          ],
          catalog,
        });
        const parsed = parseAgentResponse(raw);
        const structured = {
          ok: true,
          catalog,
          session_id: parsed.sessionId,
          agent_status: parsed.status,
          preview: parsed.text.slice(0, 500),
        };
        const text = [
          "Partner Central connection verified.",
          `- Catalog: ${catalog}`,
          structured.session_id ? `- Session: ${structured.session_id}` : null,
          structured.agent_status ? `- Status: ${structured.agent_status}` : null,
          parsed.text ? `- Agent reply: ${parsed.text.slice(0, 200)}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n");
        return successResult(text, structured);
      } catch (err) {
        const message =
          err instanceof PartnerCentralError
            ? describePartnerCentralError(err)
            : `Unexpected error: ${(err as Error).message ?? String(err)}`;
        const structured = {
          ok: false,
          catalog,
          error: message,
        };
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Partner Central connection failed.\n${message}` },
          ],
          structuredContent: structured,
        };
      }
    },
  );
}
