import type {
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

/** Extract pending write-approval requests (status "requires_approval"). */
function extractApprovalRequests(content: unknown): ApprovalRequest[] {
  if (!Array.isArray(content)) return [];
  const out: ApprovalRequest[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_approval_request") continue;
    const toolUseId = asString(b.toolUseId);
    if (!toolUseId) continue;
    const parameters =
      b.parameters && typeof b.parameters === "object"
        ? (b.parameters as Record<string, unknown>)
        : undefined;
    out.push({ toolUseId, toolName: asString(b.toolName), parameters });
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

  const approvalRequests = extractApprovalRequests(blocks);

  let text = extractAssistantText(blocks).join("\n\n");

  let events: SessionEvent[] | undefined;
  const eventSource = inner?.events ?? envelope.events;
  if (Array.isArray(eventSource)) {
    events = eventSource as SessionEvent[];
    if (!text) text = renderEvents(events);
  }

  if (!text) {
    const fallback = asString(inner?.text) ?? asString(envelope.text);
    if (fallback) text = fallback;
  }
  // Last resort: a non-JSON single text block (e.g. plain error string).
  if (!text && inner === undefined && firstText) {
    text = firstText.text;
  }

  return {
    sessionId,
    status,
    text,
    events,
    approvalRequests: approvalRequests.length > 0 ? approvalRequests : undefined,
    isError,
    raw: inner ?? envelope,
  };
}
