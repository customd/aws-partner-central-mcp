import type {
  AgentActivityStep,
  ApprovalRequest,
  NormalizedAgentResponse,
  SessionEvent,
} from "../types.js";

/**
 * The AWS endpoint returns a standard MCP tool-result envelope:
 *   { content: [ ...blocks ], isError?: boolean, sessionId?, status? }
 *
 * Two payload shapes are observed in practice:
 *   1. "Stringified" form (live sendMessage, and getSession): the agent payload
 *      is JSON-encoded into the first text block's `text` field — so
 *      content[0].text parses to an object with sessionId/status/content/events.
 *   2. "Inline" form (as documented in the Tools Reference): sessionId/status sit
 *      at the envelope top level and content[] holds plain text + structured
 *      blocks (e.g. tool_approval_request) directly.
 *
 * This parser handles both.
 */

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asRecordOrUndef(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Extract human-readable text from agent content blocks. Partner Central uses
 * "ASSISTANT_RESPONSE" blocks where prose is nested at block.content.text;
 * plain "text"-typed blocks carry it at block.text.
 */
function extractAssistantText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // Skip structured control blocks — their text is handled elsewhere.
    if (b.type === "tool_approval_request" || b.type === "tool_approval_response") {
      continue;
    }
    const nested = b.content;
    if (nested && typeof nested === "object") {
      const t = (nested as Record<string, unknown>).text;
      if (typeof t === "string") {
        out.push(t);
        continue;
      }
    }
    const directText = b.text;
    if (typeof directText === "string") out.push(directText);
  }
  return out;
}

/**
 * Recursively collect pending write-approval requests from the latest-turn
 * content. Handles two shapes:
 *   1. Documented: a block { type: "tool_approval_request", toolUseId, toolName, parameters }.
 *   2. Live (observed): a pending tool-use request { tool_use_id, name, input }
 *      surfaced when status is "requires_approval" — snake_case, no special type,
 *      and distinct from completed results (which carry output / status:"success").
 * Live-shape extraction is gated on `needsApproval` so that internal read-tool
 * activity in a normal "complete" response is not mistaken for an approval.
 */
function collectApprovalRequests(
  node: unknown,
  needsApproval: boolean,
  out: ApprovalRequest[],
  seen: Set<string>,
  depth = 0,
): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectApprovalRequests(item, needsApproval, out, seen, depth + 1);
    }
    return;
  }
  const b = node as Record<string, unknown>;

  if (b.type === "tool_approval_request") {
    const id = asString(b.toolUseId) ?? asString(b.tool_use_id);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({
        toolUseId: id,
        toolName: asString(b.toolName) ?? asString(b.name),
        parameters: asRecordOrUndef(b.parameters) ?? asRecordOrUndef(b.input),
      });
    }
  } else if (needsApproval) {
    const id = asString(b.tool_use_id) ?? asString(b.toolUseId);
    const input = asRecordOrUndef(b.input) ?? asRecordOrUndef(b.parameters);
    const isResult =
      b.output !== undefined ||
      b.status === "success" ||
      b.type === "serverToolResult" ||
      b.type === "tool_result";
    if (id && input && !isResult && !seen.has(id)) {
      seen.add(id);
      out.push({
        toolUseId: id,
        toolName: asString(b.name) ?? asString(b.toolName),
        parameters: input,
      });
    }
  }

  for (const v of Object.values(b)) {
    if (v && typeof v === "object") {
      collectApprovalRequests(v, needsApproval, out, seen, depth + 1);
    }
  }
}

function previewValue(v: unknown, max = 160): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s || s === "{}") return undefined;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Extract the agent's internal activity trace (serverToolUse / serverToolResult,
 * including "thinking" steps) from the latest-turn content blocks, in order.
 * For these block types the fields are nested under `block.content`.
 */
function extractActivity(content: unknown): AgentActivityStep[] {
  if (!Array.isArray(content)) return [];
  const out: AgentActivityStep[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const c = asRecord(b.content);
    if (b.type === "serverToolUse") {
      out.push({
        kind: "tool_use",
        name: asString(c.name) ?? asString(b.name),
        activity: asString(c.displayToolActivity),
        detail: previewValue(c.input),
      });
    } else if (b.type === "serverToolResult") {
      out.push({
        kind: "tool_result",
        name: asString(c.name) ?? asString(b.name),
        status: asString(c.status),
        detail: previewValue(c.output),
      });
    }
  }
  return out;
}

/**
 * Render a `getSession` events array as markdown-friendly text. Each event
 * has `data.role` and `data.content`; content can be a string or an array
 * of `{ text, type }` blocks.
 */
function renderEvents(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const data = ev.data;
    if (!data || typeof data !== "object") continue;
    const role = asString((data as { role?: unknown }).role) ?? "?";
    const c = (data as { content?: unknown }).content;
    if (typeof c === "string") {
      lines.push(`**${role}:** ${c}`);
      continue;
    }
    if (Array.isArray(c)) {
      const pieces: string[] = [];
      for (const block of c) {
        if (block && typeof block === "object") {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string") pieces.push(t);
        }
      }
      if (pieces.length > 0) lines.push(`**${role}:** ${pieces.join(" ")}`);
    }
  }
  return lines.join("\n\n");
}

export function parseAgentResponse(rawResult: unknown): NormalizedAgentResponse {
  const envelope = asRecord(rawResult);
  const isError = envelope.isError === true;
  const topContent = Array.isArray(envelope.content) ? envelope.content : [];

  // Attempt to decode the "stringified" payload from the first text block.
  let inner: Record<string, unknown> | undefined;
  const firstText = topContent.find(
    (b) => b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string",
  ) as { text: string } | undefined;
  if (firstText) {
    try {
      const decoded = JSON.parse(firstText.text);
      if (decoded && typeof decoded === "object") {
        inner = decoded as Record<string, unknown>;
      }
    } catch {
      /* not JSON — inline form */
    }
  }

  // Blocks to scan: inner.content for the stringified form, otherwise the
  // envelope's own content (inline form).
  const blocks =
    inner !== undefined
      ? Array.isArray(inner.content)
        ? inner.content
        : []
      : topContent;

  const sessionId = asString(inner?.sessionId) ?? asString(envelope.sessionId);
  const status =
    asString(inner?.status) ??
    asString(inner?.stateType) ??
    asString(envelope.status);

  let text = extractAssistantText(blocks).join("\n\n");

  let events: SessionEvent[] | undefined;
  const eventSource = inner?.events ?? envelope.events;
  if (Array.isArray(eventSource)) {
    events = eventSource as SessionEvent[];
    if (!text) text = renderEvents(events);
  }

  const needsApproval = status === "requires_approval" || status === "TOOL_REQUEST";
  const seen = new Set<string>();
  const approvalRequests: ApprovalRequest[] = [];
  collectApprovalRequests(blocks, needsApproval, approvalRequests, seen);
  // A non-streaming sendMessage "requires_approval" response carries only the
  // proposal prose (the structured tool request arrives via SSE). But a
  // getSession in TOOL_REQUEST state exposes it as an event — recover the most
  // recent pending request so respond_to_approval can target it.
  if (approvalRequests.length === 0 && needsApproval && events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      collectApprovalRequests(events[i]?.data, true, approvalRequests, seen);
      if (approvalRequests.length > 0) break;
    }
  }

  if (!text) {
    const fallback = asString(inner?.text) ?? asString(envelope.text);
    if (fallback) text = fallback;
  }
  // Last resort: a non-JSON single text block (e.g. plain error string).
  if (!text && inner === undefined && firstText) {
    text = firstText.text;
  }

  const activity = extractActivity(blocks);

  return {
    sessionId,
    status,
    text,
    events,
    approvalRequests: approvalRequests.length > 0 ? approvalRequests : undefined,
    activity: activity.length > 0 ? activity : undefined,
    isError,
    raw: inner ?? envelope,
  };
}
