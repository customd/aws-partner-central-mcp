import { CHARACTER_LIMIT, MAX_STRUCTURED_EVENTS } from "../constants.js";
import type {
  AgentActivityStep,
  ApprovalRequest,
  NormalizedAgentResponse,
} from "../types.js";
import { linkifyOpportunities, type OpportunityLink } from "./console-links.js";

export interface FormattedToolResult {
  text: string;
  structured: Record<string, unknown>;
}

function mapApprovalRequests(
  requests: ApprovalRequest[],
): Array<Record<string, unknown>> {
  return requests.map((r) => ({
    tool_use_id: r.toolUseId,
    ...(r.toolName !== undefined ? { tool_name: r.toolName } : {}),
    ...(r.parameters !== undefined ? { parameters: r.parameters } : {}),
  }));
}

function buildStructured(
  parsed: NormalizedAgentResponse,
  links: OpportunityLink[],
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    text: parsed.text,
  };
  if (parsed.sessionId !== undefined) structured.session_id = parsed.sessionId;
  if (parsed.status !== undefined) structured.status = parsed.status;
  if (parsed.events !== undefined) {
    // get_session can carry hundreds of events; mirror only the most recent into
    // structuredContent (the full transcript is still rendered in `text`).
    if (parsed.events.length > MAX_STRUCTURED_EVENTS) {
      structured.events = parsed.events.slice(-MAX_STRUCTURED_EVENTS);
      structured.events_truncated = true;
      structured.event_count = parsed.events.length;
    } else {
      structured.events = parsed.events;
    }
  }
  if (parsed.approvalRequests !== undefined && parsed.approvalRequests.length > 0) {
    structured.approval_requests = mapApprovalRequests(parsed.approvalRequests);
  }
  if (parsed.activity !== undefined && parsed.activity.length > 0) {
    structured.activity = parsed.activity;
  }
  if (links.length > 0) structured.opportunity_links = links;
  if (parsed.isError) structured.is_error = true;
  // `raw` is intentionally NOT mirrored here: an untyped blob makes Claude
  // Desktop render the result disclosure blank. The full payload is available
  // via response_format:"json" (and partner_central_get_session).
  return structured;
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Turn an internal tool name like "analyze_pipeline" / "opportunityCreator" into "Analyze pipeline". */
function humanizeName(name: string): string {
  const words = name
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ");
  return capitalizeFirst(words.toLowerCase());
}

/** Friendly label for a step: prefer the agent's own activity label, else humanize the tool name. */
function stepLabel(s: AgentActivityStep): string {
  if (s.activity && s.activity.trim().length > 0) return capitalizeFirst(s.activity.trim());
  if (s.name && s.name.trim().length > 0) return humanizeName(s.name);
  return s.kind === "tool_use" ? "Working" : "Result";
}

/**
 * Render the agent's internal tool/thinking steps as a collapsed, expandable
 * trace — present but out of the way unless the reader wants it. Uses the
 * agent's friendly activity labels (and humanized tool names) so no raw
 * snake_case identifiers leak into the UI.
 */
function renderActivity(steps: AgentActivityStep[]): string {
  const lines: string[] = [
    "",
    "<details>",
    `<summary>🔧 Agent activity — ${steps.length} step${steps.length === 1 ? "" : "s"}</summary>`,
    "",
  ];
  for (const s of steps) {
    if (s.kind === "tool_use") {
      let line = `- **${stepLabel(s)}**`;
      if (s.detail) line += `\n  - input: \`${s.detail}\``;
      lines.push(line);
    } else {
      let line = `- ↳ ${stepLabel(s)}`;
      if (s.status) line += ` (${s.status})`;
      if (s.detail) line += `: \`${s.detail}\``;
      lines.push(line);
    }
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

/** Render a human-readable "approval required" callout for write operations. */
function renderApprovalRequests(requests: ApprovalRequest[]): string {
  const lines: string[] = [
    "",
    "---",
    "⚠️ **This action requires your approval before it executes.**",
  ];
  for (const r of requests) {
    lines.push("");
    lines.push(`- **Operation:** \`${r.toolName ?? "(unspecified)"}\``);
    lines.push(`  **Approval ID (tool_use_id):** \`${r.toolUseId}\``);
    if (r.parameters && Object.keys(r.parameters).length > 0) {
      lines.push("  **Proposed values:**");
      lines.push("  ```json");
      for (const line of JSON.stringify(r.parameters, null, 2).split("\n")) {
        lines.push(`  ${line}`);
      }
      lines.push("  ```");
    }
  }
  lines.push("");
  lines.push(
    "To proceed, call `partner_central_respond_to_approval` with this `session_id`, the `tool_use_id` above, and decision `approve`, `reject`, or `override`.",
  );
  return lines.join("\n");
}

/**
 * Rendered when status is "requires_approval" but no structured tool request could
 * be obtained — the non-streaming case where the agent only describes the proposal
 * in prose AND reading it back from the session turned up nothing. Since the
 * tool_use_id is genuinely unavailable here, lead with the two routes that do not
 * need one (both verified to work) rather than sending the caller to get_session.
 */
function renderGenericApprovalNote(): string {
  return [
    "",
    "---",
    "⚠️ **This action needs your approval before it runs.** Review the proposed changes above with the user.",
    "To proceed, either reply in this same session with `partner_central_send_message` (\"approve\", \"reject because…\", or \"change X to Y\") — passing this `session_id` — or call `partner_central_respond_to_approval` with this `session_id` and a decision, omitting `tool_use_id` so it re-resolves the pending request.",
  ].join("\n");
}

/** Small leading glyph for the Status line, for quick visual scanning. */
function statusEmoji(status?: string): string {
  switch (status) {
    case "complete":
      return "✅ ";
    case "requires_approval":
      return "⚠️ ";
    case "error":
      return "❌ ";
    default:
      return "";
  }
}

/**
 * @param notice Optional leading remark about how the call was resolved (e.g. that
 *   session_id was inferred). Deliberately applied to markdown ONLY — json mode
 *   returns the raw payload and must stay parseable — and added before the
 *   size-trimming below so it counts against CHARACTER_LIMIT like everything else.
 */
export function formatAgentResponse(
  parsed: NormalizedAgentResponse,
  format: "markdown" | "json",
  showActivity = true,
  catalog?: string,
  notice?: string,
): FormattedToolResult {
  const { text: linkedReply, links } = linkifyOpportunities(parsed.text, catalog);
  const structured = buildStructured(parsed, links);

  let text: string;
  if (format === "json") {
    text = JSON.stringify(parsed.raw, null, 2);
  } else {
    const lines: string[] = [];
    if (notice !== undefined && notice.length > 0) lines.push(notice, "");
    if (parsed.status) lines.push(`**Status:** ${statusEmoji(parsed.status)}${parsed.status}`);
    if (parsed.sessionId) lines.push(`**Session:** \`${parsed.sessionId}\``);
    if (lines.length > 0) lines.push("");
    if (parsed.text) {
      lines.push(linkedReply);
    } else if (!parsed.approvalRequests || parsed.approvalRequests.length === 0) {
      lines.push("_(no text content returned)_");
    }
    if (parsed.approvalRequests && parsed.approvalRequests.length > 0) {
      lines.push(renderApprovalRequests(parsed.approvalRequests));
    } else if (parsed.status === "requires_approval") {
      lines.push(renderGenericApprovalNote());
    }
    if (showActivity && parsed.activity && parsed.activity.length > 0) {
      lines.push(renderActivity(parsed.activity));
    }
    text = lines.join("\n");
  }

  // Keep the COMBINED result (rendered text + serialized structuredContent) under
  // the client's tool-result cap. Over it, the client rejects the result and saves
  // it to a temp file the sandboxed agent can't read. Trim the bulkiest/duplicated
  // parts first; status + approval_requests are small and always preserved.
  const structuredChars = (): number => JSON.stringify(structured).length;

  // 1. structuredContent.text duplicates the reply already in `text` — bound it.
  const halfBudget = Math.floor(CHARACTER_LIMIT / 2);
  if (typeof structured.text === "string" && structured.text.length > halfBudget) {
    structured.text = structured.text.slice(0, halfBudget) + "…";
    structured.truncated = true;
  }
  // 2. events are the next-biggest duplicated payload (also rendered into `text`).
  if (structured.events !== undefined && text.length + structuredChars() > CHARACTER_LIMIT) {
    delete structured.events;
    structured.events_truncated = true;
  }
  // 3. truncate the rendered text to whatever budget remains.
  if (text.length + structuredChars() > CHARACTER_LIMIT) {
    const originalLength = text.length;
    structured.truncated = true;
    structured.original_length = originalLength;
    const notice = (kept: number): string =>
      `\n\n_[Output truncated from ${originalLength.toLocaleString()} to ${kept.toLocaleString()} characters — the full result exceeds the client's tool-result size limit. ` +
      `Narrow the request (ask the agent to summarize, or fetch a specific opportunity/session) to see more; status and pending approvals are preserved above.]_`;
    const reserve = notice(originalLength).length + 300; // notice + safety margin
    const kept = Math.max(2_000, CHARACTER_LIMIT - structuredChars() - reserve);
    text = text.slice(0, kept) + notice(kept);
  }

  return { text, structured };
}
