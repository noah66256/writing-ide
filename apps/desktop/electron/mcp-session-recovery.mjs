const STATEFUL_RE = /(playwright|browser|word|doc|excel|spreadsheet|workbook|pdf|ssh|terminal|app-server)/i;
const SESSION_ERROR_RE = /(another\s+browser\s+context\s+is\s+being\s+closed|context\s+is\s+being\s+closed|context\s+has\s+been\s+closed|browser\s+has\s+been\s+closed|target\s+page.*has\s+been\s+closed|transport\s+closed|session\s+closed|connection\s+closed)/i;

export function isLikelyStatefulMcpServer(args = {}) {
  const raw = [args.serverId, args.serverName, args.toolName, ...(Array.isArray(args.toolNames) ? args.toolNames : [])]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return STATEFUL_RE.test(raw);
}

export function isRetryableMcpSessionError(errorText) {
  return SESSION_ERROR_RE.test(String(errorText ?? ""));
}

export function shouldAttemptMcpSessionRecovery(args = {}) {
  return isLikelyStatefulMcpServer(args) && isRetryableMcpSessionError(args.errorText);
}
