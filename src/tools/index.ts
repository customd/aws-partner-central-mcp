import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "../logger.js";
import {
  PartnerCentralClient,
  PartnerCentralError,
  isThrottleError,
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
import { SessionMemory } from "../services/session-memory.js";
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
import type {
  ApprovalRequest,
  ContentBlock,
  NormalizedAgentResponse,
  PartnerCentralConfig,
} from "../types.js";
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

  // Throttling can arrive as JSON-RPC -32004 OR as the live HTTP 400 "Rate
  // exceeded" shape — handle both uniformly with accurate, actionable guidance.
  if (isThrottleError(err)) {
    parts.push(
      "(Rate limited — AWS throttles sendMessage to ~2 requests/minute (burst 10); other operations to ~10/minute. The client already retried with backoff. If it still failed, pause ~30s before retrying — bulk writes run about 1 per 30s, so large batches take a few minutes.)",
    );
    return parts.join(" ");
  }

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

/** Dependencies the session-scoped tool handlers need, injectable for tests. */
export interface ToolContext {
  client: Pick<PartnerCentralClient, "callTool" | "uploadDocuments">;
  memory: SessionMemory;
  defaultCatalog: string;
}

const MISSING_SESSION_HINT =
  "No session_id was supplied, and this extension hasn't handled a session for this catalog yet in the current run. " +
  "Call partner_central_send_message first — its response includes the session_id — then pass that session_id here.";

/**
 * Resolve which session a call targets. A supplied id always wins; otherwise fall
 * back to the most recent session for the catalog, because hosts strip `required`
 * from the advertised schema and the model then omits session_id entirely
 * (CLAUDE.md gotcha #12). Returns null when there is nothing to fall back to.
 */
export function resolveSessionId(
  ctx: ToolContext,
  catalog: string,
  supplied: string | undefined,
): { sessionId: string; inferred: boolean } | null {
  if (supplied !== undefined) return { sessionId: supplied, inferred: false };
  const remembered = ctx.memory.latestFor(catalog);
  return remembered !== undefined ? { sessionId: remembered, inferred: true } : null;
}

/**
 * Read a session's CURRENT pending write-approval requests.
 *
 * A non-streaming `requires_approval` sendMessage reply carries only the proposal
 * prose — the structured `tool_use_id` lives in the session's TOOL_REQUEST event
 * (CLAUDE.md gotcha #3). Fetching it here, immediately, is both what unblocks the
 * approval flow without a second client round-trip AND the freshest possible read
 * (the id changes whenever the agent re-proposes).
 *
 * Best-effort by design: recovery must never turn a usable reply into an error.
 */
async function fetchPendingApprovals(
  ctx: ToolContext,
  catalog: string,
  sessionId: string,
): Promise<ApprovalRequest[]> {
  try {
    const raw = await ctx.client.callTool("getSession", { sessionId, catalog });
    return parseAgentResponse(raw).approvalRequests ?? [];
  } catch (err) {
    logger.warn("Could not recover the pending approval from the session", {
      error: (err as Error).message,
    });
    return [];
  }
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

/**
 * Fill in a `requires_approval` reply's missing `tool_use_id` by reading it back
 * from the session, so the very first response carries what respond_to_approval
 * needs. Returns the response unchanged when there is nothing to add.
 */
async function withRecoveredApprovals(
  ctx: ToolContext,
  catalog: string,
  parsed: NormalizedAgentResponse,
): Promise<NormalizedAgentResponse> {
  const alreadyHas = parsed.approvalRequests !== undefined && parsed.approvalRequests.length > 0;
  if (parsed.status !== "requires_approval" || alreadyHas || parsed.sessionId === undefined) {
    return parsed;
  }
  const recovered = await fetchPendingApprovals(ctx, catalog, parsed.sessionId);
  return recovered.length > 0 ? { ...parsed, approvalRequests: recovered } : parsed;
}

/**
 * Core of partner_central_send_message, factored out for testability. Records the
 * resulting session so later calls can resolve a missing session_id, and back-fills
 * the pending approval's tool_use_id when the agent asks for approval.
 */
export async function runSendMessage(
  ctx: ToolContext,
  params: SendMessageInput,
): Promise<ReturnType<typeof errorResult> | ReturnType<typeof successResult>> {
  const catalog = params.catalog ?? ctx.defaultCatalog;
  try {
    const content: ContentBlock[] = [{ type: "text", text: params.message }];
    if (params.attachments && params.attachments.length > 0) {
      logger.debug("Uploading attachments", { count: params.attachments.length });
      const docs = await ctx.client.uploadDocuments(params.attachments);
      content.push(...docs);
    }
    const args: Record<string, unknown> = { content, catalog };
    if (params.session_id !== undefined) args.sessionId = params.session_id;
    logger.debug("Calling sendMessage", {
      catalog,
      hasSession: params.session_id !== undefined,
      attachments: params.attachments?.length ?? 0,
    });
    const raw = await ctx.client.callTool("sendMessage", args);
    const parsed = parseAgentResponse(raw);
    if (parsed.sessionId !== undefined) ctx.memory.remember(catalog, parsed.sessionId);
    const enriched = await withRecoveredApprovals(ctx, catalog, parsed);
    const formatted = formatAgentResponse(
      enriched,
      params.response_format,
      params.show_activity,
      catalog,
    );
    return successResult(formatted.text, formatted.structured);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Core of partner_central_get_session, factored out for testability. Falls back to
 * the catalog's most recent session when session_id is absent (see resolveSessionId)
 * and says so in the reply, so an inferred target is never silently assumed.
 */
export async function runGetSession(
  ctx: ToolContext,
  params: GetSessionInput,
): Promise<ReturnType<typeof errorResult> | ReturnType<typeof successResult>> {
  const catalog = params.catalog ?? ctx.defaultCatalog;
  const resolved = resolveSessionId(ctx, catalog, params.session_id);
  if (resolved === null) return errorResult(MISSING_SESSION_HINT);
  logger.debug("Calling getSession", { catalog, inferred: resolved.inferred });
  try {
    const raw = await ctx.client.callTool("getSession", {
      sessionId: resolved.sessionId,
      catalog,
    });
    const parsed = parseAgentResponse(raw);
    if (parsed.sessionId !== undefined) ctx.memory.remember(catalog, parsed.sessionId);
    const notice = resolved.inferred
      ? `_(No session_id was given — showing the most recent ${catalog} session: \`${resolved.sessionId}\`.)_`
      : undefined;
    const formatted = formatAgentResponse(parsed, params.response_format, true, catalog, notice);
    if (!resolved.inferred) return successResult(formatted.text, formatted.structured);
    return successResult(formatted.text, {
      ...formatted.structured,
      session_id_inferred: true,
    });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Core of partner_central_respond_to_approval, factored out for testability.
 * Resolves session_id and, when tool_use_id is absent, reads the session's current
 * pending request instead of dead-ending. Refuses to guess when several writes are
 * pending — approving the wrong one is not recoverable.
 */
export async function runRespondToApproval(
  ctx: ToolContext,
  params: RespondToApprovalInput,
): Promise<ReturnType<typeof errorResult> | ReturnType<typeof successResult>> {
  const catalog = params.catalog ?? ctx.defaultCatalog;
  const resolved = resolveSessionId(ctx, catalog, params.session_id);
  if (resolved === null) return errorResult(MISSING_SESSION_HINT);
  try {
    let toolUseId = params.tool_use_id;
    if (toolUseId === undefined) {
      const pending = await fetchPendingApprovals(ctx, catalog, resolved.sessionId);
      if (pending.length > 1) {
        return errorResult(
          `Session ${resolved.sessionId} has ${pending.length} writes awaiting approval, so tool_use_id cannot be inferred safely. ` +
            "Confirm with the user which one to act on, then pass its tool_use_id explicitly: " +
            pending.map((p) => `${p.toolName ?? "(unspecified)"} → ${p.toolUseId}`).join(" | "),
        );
      }
      const only = pending[0];
      if (only === undefined) {
        return errorResult(
          `No tool_use_id was supplied, and session ${resolved.sessionId} has no write awaiting approval. ` +
            "It may already have been approved or rejected, or the agent may have withdrawn it. Call partner_central_get_session to inspect the session, or continue conversationally with partner_central_send_message.",
        );
      }
      toolUseId = only.toolUseId;
      logger.debug("Recovered the pending tool_use_id from the session");
    }
    const block: ContentBlock = {
      type: "tool_approval_response",
      toolUseId,
      decision: params.decision,
      ...(params.message !== undefined ? { message: params.message } : {}),
    };
    logger.debug("Calling sendMessage with approval response", {
      catalog,
      decision: params.decision,
    });
    const raw = await ctx.client.callTool("sendMessage", {
      content: [block],
      catalog,
      sessionId: resolved.sessionId,
    });
    const parsed = parseAgentResponse(raw);
    if (parsed.sessionId !== undefined) ctx.memory.remember(catalog, parsed.sessionId);
    const enriched = await withRecoveredApprovals(ctx, catalog, parsed);
    const formatted = formatAgentResponse(
      enriched,
      params.response_format,
      params.show_activity,
      catalog,
    );
    return successResult(formatted.text, formatted.structured);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Classify a thrown error from the verify_connection probe (a read-only getSession
 * for a non-existent id) into a connection verdict.
 *
 * LOAD-BEARING: "healthy" is ANY processed JSON-RPC reply that is not an auth or
 * access failure — do NOT narrow it to a specific not-found code. A processed
 * reply (e.g. "session not found") proves SSO + SigV4 + reachability succeeded,
 * and this endpoint's error shapes drift from the docs (see CLAUDE.md gotcha #1),
 * so matching one code would silently regress to false "unhealthy". Pinned by
 * test/verify-connection.test.mjs.
 */
export function classifyVerifyError(err: unknown): "healthy" | "transient" | "failed" {
  if (!(err instanceof PartnerCentralError)) return "failed";
  // Auth / authorization problems are genuine setup failures.
  if (
    err.code === ERROR_CODE.AUTHENTICATION_FAILURE ||
    err.code === ERROR_CODE.ACCESS_DENIED ||
    err.code === ERROR_CODE.TOOL_PERMISSION_DENIED ||
    err.httpStatus === 401 ||
    err.httpStatus === 403
  ) {
    return "failed";
  }
  // Reached-but-degraded: a network blip or a server-side error (after retries).
  // The user's setup is fine; this is transient.
  if (
    err.isNetworkError ||
    err.code === ERROR_CODE.INTERNAL_ERROR ||
    (err.httpStatus !== undefined && err.httpStatus >= 500)
  ) {
    return "transient";
  }
  // Any other processed reply (not-found, invalid-request, limit-exceeded, …)
  // proves the request was authenticated, signed, and handled by the endpoint.
  return "healthy";
}

export function registerTools(
  server: McpServer,
  config: PartnerCentralConfig,
): void {
  const client = new PartnerCentralClient(config, {
    elicit: makeAccountRoleElicitor(server),
  });
  const ctx: ToolContext = {
    client,
    memory: new SessionMemory(),
    defaultCatalog: config.defaultCatalog,
  };

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
  If the agent proposes a write (create/update/submit opportunity, create/submit funding application), the response has status 'requires_approval' and describes the proposed change in the reply text. Show the user exactly what will change. This tool resolves the pending action's tool_use_id for you and returns it in approval_requests[], so no extra get_session call is needed. To proceed, EITHER call partner_central_respond_to_approval (passing this session_id and decision; tool_use_id is optional — it is re-resolved if omitted), OR reply in this same session with a natural-language partner_central_send_message ("approve", "reject because…", or "change X to Y"). No write executes without your confirmation.

Continuing a conversation: ALWAYS pass session_id from the previous response when following up. Omitting it silently starts a NEW session with no memory of the prior turns.

Writes & stage progression: opportunity writes — including progressing a stage all the way to 'Launched' (closed-won) — are PARTNER-initiated. The agent may run an advisory readiness check and report an opportunity is "not ready" (e.g. "AWS hasn't launched it on their side", "no marketplace offer linked", "no customer deal acceptance"). That is GUIDANCE, not a hard API constraint — the Selling API enforces the real rules and will often accept the write regardless (confirmed: a 'For Visibility Only' opp was moved to Launched while the advisor said is_valid:false). To actually perform a change, phrase your message as an instruction to EXECUTE it ("set Stage to Launched and proceed", "make the update") — not a validity question ("is this transition valid?"), which makes the agent editorialize and refuse. Always confirm the concrete change with the user before approving the write.

Presentation: the returned 'text' is already formatted for the user and includes clickable links to any opportunities in the AWS console — show it to the user rather than replacing it with a bare summary.

Returns structured content: { session_id, status ('complete'|'requires_approval'|'error'), text, approval_requests?, opportunity_links?, truncated? }. For the full upstream payload, call again with response_format:'json'.

Errors: AuthenticationFailure/-32001 or HTTP 403 (run partner_central_verify_connection); LimitExceeded/-32004 (rate-limited, retry shortly); InvalidRequest (often a cross-catalog session_id); ResourceNotFound/-30001 (session expired or wrong catalog).`,
      inputSchema: SendMessageInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        title: "Ask Partner Central",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: SendMessageInput) => runSendMessage(ctx, params),
  );

  server.registerTool(
    "partner_central_respond_to_approval",
    {
      title: "Approve, Reject, or Override a Partner Central Write Operation",
      description: `Respond to a Partner Central write operation that is awaiting approval (a send_message response with status 'requires_approval').

Use this for an explicit, structured decision. (You can also approve/reject conversationally by sending a natural-language partner_central_send_message in the same session — the agent honors it.) Always confirm the proposed values with the user before approving.

Args:
  - session_id (string, strongly recommended): The session that returned 'requires_approval'. If omitted, the most recent session for the catalog is used.
  - tool_use_id (string, optional): The pending action's tool_use_id, as given in the send_message response's approval_requests[]. If you omit it, this tool reads the session's CURRENT pending request and uses that — which is also the fix for a "does not match pending tool request" error, so on that error simply retry WITHOUT tool_use_id. If several writes are pending at once it will not guess: it returns the list so you can confirm which one with the user.
  - decision ('approve' | 'reject' | 'override', required): 'approve' executes as proposed; 'reject' cancels (use message to explain); 'override' executes with the modified instructions in message.
  - message (string, optional): Required for 'override', recommended for 'reject'.
  - catalog ('AWS' | 'Sandbox', optional), response_format ('markdown' | 'json', optional).

Returns the agent's response after the decision is applied (same shape as send_message). Show the returned 'text' (with any clickable opportunity links) to the user rather than only summarizing it.`,
      inputSchema: RespondToApprovalInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        title: "Respond to Approval",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RespondToApprovalInput) => runRespondToApproval(ctx, params),
  );

  server.registerTool(
    "partner_central_get_session",
    {
      title: "Get AWS Partner Central Conversation Session",
      description: `Retrieve the transcript and current state of an existing Partner Central conversation session.

Use when the user references a previous Partner Central conversation by session ID, or to inspect a session's full state before sending more messages.

Args:
  - session_id (string, strongly recommended): The session identifier from a previous send_message response. ALWAYS pass it when you have it. If you omit it, the most recent session this extension handled for the catalog is used and the reply says so (structuredContent.session_id_inferred = true) — a convenience, not a substitute for the real id.
  - catalog ('AWS' | 'Sandbox', optional): Catalog the session was created in. Sessions are catalog-scoped.
  - response_format ('markdown' | 'json', optional, default 'markdown').

Presentation: show the returned 'text' (rendered transcript, with clickable opportunity links) to the user rather than summarizing it away.

Returns structured content: { session_id, status, text (rendered transcript), events, opportunity_links?, truncated? }. For the full upstream payload, call again with response_format:'json'.

Errors: ResourceNotFound/-30001 (session expired >48h or wrong catalog); HTTP 403 / AuthenticationFailure (SSO expired or insufficient permissions).`,
      inputSchema: GetSessionInputSchema.shape,
      outputSchema: AgentResponseOutputSchema.shape,
      annotations: {
        title: "Get Conversation Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetSessionInput) => runGetSession(ctx, params),
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
        title: "Verify Connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        const verdict = classifyVerifyError(err);
        // Any processed (non-auth, non-access) reply means SSO + signing +
        // reachability all worked — the probe's "not found" is the success signal.
        if (verdict === "healthy") return verified();

        const { summary, lines } = buildSetup();

        if (verdict === "transient") {
          const detail =
            err instanceof PartnerCentralError
              ? describePartnerCentralError(err)
              : ((err as Error).message ?? String(err));
          const text = [
            "⚠️ Could not complete the check — but this looks transient, not a setup problem.",
            "AWS was reached (or retried), but Partner Central was unreachable or returned a server error. Your SSO start URL / account / role appear fine — retry in a moment.",
            `Detail: ${detail}`,
            ...lines,
          ].join("\n");
          return {
            isError: true,
            content: [{ type: "text" as const, text }],
            structuredContent: { ok: false, catalog, config: summary, error: detail },
          };
        }

        // verdict === "failed" — a genuine setup / auth / access problem.
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
        title: "Select Account / Role",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SelectAccountInput) => runSelectAccount(client, params),
  );
}
