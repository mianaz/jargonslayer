// Short, dependency-free request ids attached to API-route error
// responses (see app/api/{detect,define,summarize}/route.ts) so a
// user's diag ref (log.ts) can chain to a server-side log line for
// that same request. crypto.randomUUID ships in both the Node route
// runtime and every browser this app targets — same fallback pattern
// as types.ts's newId().

export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
