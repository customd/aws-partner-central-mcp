import { CHARACTER_LIMIT } from "../constants.js";
import type {
  AgentActivityStep,
  ApprovalRequest,
  NormalizedAgentResponse,
} from "../types.js";

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

function buildStructured(parsed: NormalizedAgentResponse): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    text: parsed.text,
  };
  if (parsed.sessionId !== undefined) structured.session_id = parsed.sessionId;
  if (parsed.status !== undefined) structured.status = parsed.status;
  if (parsed.events !== undefined) structured.events = parsed.events;
  if (parsed.approvalRequests !== undefined && parsed.approvalRequests.length > 0) {
    structured.approval_requests = mapApprovalRequests(parsed.approvalRequests);
  }
  if (parsed.activity !== undefined && parsed.activity.length > 0) {
    structured.activity = parsed.activity;
  }
  if (parsed.isError) structured.is_error = true;
  structured.raw = parsed.raw;
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
 * Rendered when status is "requires_approval" but the structured tool request
 * isn't in the response (the non-streaming case — the agent describes the
 * proposal in prose). Tells the agent how to complete the approval.
 */
function renderGenericApprovalNote(): string {
  return [
    "",
    "---",
    "⚠️ **This action needs your approval before it runs.** Review the proposed changes above with the user.",
    "To proceed, either reply in this same session with `partner_central_send_message` (\"approve\", \"reject because…\", or \"change X to Y\"), or call `partner_central_get_session` to fetch the pending action's `tool_use_id` and then `partner_central_respond_to_approval`.",
  ].join("\n");
}

export function formatAgentResponse(
  parsed: NormalizedAgentResponse,
  format: "markdown" | "json",
  showActivity = true,
): FormattedToolResult {
  const structured = buildStructured(parsed);

  let text: string;
  if (format === "json") {
    text = JSON.stringify(parsed.raw, null, 2);
  } else {
    const lines: string[] = [];
    if (parsed.status) lines.push(`**Status:** ${parsed.status}`);
    if (parsed.sessionId) lines.push(`**Session:** \`${parsed.sessionId}\``);
    if (lines.length > 0) lines.push("");
    if (parsed.text) {
      lines.push(parsed.text);
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

  if (text.length > CHARACTER_LIMIT) {
    const originalLength = text.length;
    const kept = text.slice(0, CHARACTER_LIMIT);
    const message =
      `\n\n_[Visible text truncated from ${originalLength.toLocaleString()} to ${CHARACTER_LIMIT.toLocaleString()} characters. ` +
      `The complete payload is in the tool's structuredContent ('raw' field) — read from there for the full data, ` +
      `or call partner_central_get_session with the session_id for individual events.]_`;
    text = kept + message;
    structured.truncated = true;
    structured.original_length = originalLength;
  }

  return { text, structured };
}
