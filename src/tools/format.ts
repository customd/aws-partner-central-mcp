import { CHARACTER_LIMIT } from "../constants.js";
import type { ApprovalRequest, NormalizedAgentResponse } from "../types.js";

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
  if (parsed.isError) structured.is_error = true;
  structured.raw = parsed.raw;
  return structured;
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

export function formatAgentResponse(
  parsed: NormalizedAgentResponse,
  format: "markdown" | "json",
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
