/**
 * Remembers the most recent Partner Central session id per catalog, so a tool
 * call that arrives WITHOUT a session_id can still target the conversation the
 * user obviously means.
 *
 * Why this exists (hard-won — see CLAUDE.md gotcha #12): MCP hosts normalize the
 * advertised JSON Schema under a size budget and can drop the `required` array
 * (observed: Claude Desktop / the remote-devices bridge strip `required`,
 * `pattern`, `minLength`, and some `description`s). With `required` gone,
 * `session_id` reads as optional to the calling model, which then omits it —
 * and every session-scoped tool dead-ends. Sessions are catalog-scoped upstream,
 * so the memory is keyed by catalog and never mixes them.
 *
 * In-memory and per-process only: it is a convenience fallback, not persistence.
 */
export class SessionMemory {
  private readonly latest = new Map<string, string>();

  /** Record the session id most recently seen for `catalog`. */
  remember(catalog: string, sessionId: string): void {
    if (sessionId.length > 0) this.latest.set(catalog, sessionId);
  }

  /** The session id most recently seen for `catalog`, if any. */
  latestFor(catalog: string): string | undefined {
    return this.latest.get(catalog);
  }
}
