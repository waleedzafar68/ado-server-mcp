export interface AuditEvent {
  event: 'tool_call' | 'session_open' | 'session_close' | 'admission_denied';
  [field: string]: unknown;
}

export type AuditSink = (event: AuditEvent) => void;

export const NO_AUDIT: AuditSink = () => undefined;

// One JSON object per line on stderr; stdout carries the MCP protocol in stdio mode.
export function stderrAudit(): AuditSink {
  return (event) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  };
}