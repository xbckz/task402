import type { ToolStatsEvent, ToolStatsRow, ToolStatsSummary, ToolStatsTimelineRow, TrafficStatsEvent, TrafficStatsEventName, TrafficStatsRow } from "./types.js";

export const PRODUCT_TOOLS = new Set([
  "generate_pdf", "get_pdf_job", "download_pdf", "ingest_document", "inspect_pdf", "get_document_map",
  "search_document", "batch_search_document", "prepare_document_context", "extract_document_fields", "read_document", "verify_document_citation", "compare_pdfs", "validate_pdf_text", "render_pdf_page_region",
  "web_evidence", "inspect_openapi", "plan_api_request", "diff_openapi", "get_chain_balance", "get_chain_transaction", "get_erc20_balance",
]);

export const TRAFFIC_EVENTS: ReadonlySet<TrafficStatsEventName> = new Set([
  "overview_request", "docs_request", "pricing_request", "mcp_initialize_request", "mcp_tools_list_request",
  "generation_payment_challenge", "generation_completed", "paid_tool_payment_challenge", "paid_tool_completed", "document_ingest_completed", "document_ingest_resumed",
  "document_tool_completed", "download_completed",
]);

export const STATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_stats_daily (
  day_start INTEGER NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  payment_required INTEGER NOT NULL DEFAULT 0,
  settled_calls INTEGER NOT NULL DEFAULT 0,
  settled_amount_atomic INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  max_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_start, tool)
);
CREATE INDEX IF NOT EXISTS tool_stats_daily_day_idx ON tool_stats_daily(day_start);
CREATE TABLE IF NOT EXISTS traffic_stats_daily (
  day_start INTEGER NOT NULL,
  event TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_start, event)
);
CREATE INDEX IF NOT EXISTS traffic_stats_daily_day_idx ON traffic_stats_daily(day_start);
CREATE TABLE IF NOT EXISTS tool_stats_hourly (
  bucket_start INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  payment_required INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_start)
);
CREATE INDEX IF NOT EXISTS tool_stats_hourly_bucket_idx ON tool_stats_hourly(bucket_start);
`;

export interface RawStatsRow {
  tool: string;
  calls: number | string;
  successes: number | string;
  errors: number | string;
  payment_required: number | string;
  settled_calls: number | string;
  settled_amount_atomic: number | string;
  total_duration_ms: number | string;
  max_duration_ms: number | string;
  last_seen_at: number | string;
}

export function upsertSql(): string {
  return `INSERT INTO tool_stats_daily
    (day_start, tool, calls, successes, errors, payment_required, settled_calls, settled_amount_atomic, total_duration_ms, max_duration_ms, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day_start, tool) DO UPDATE SET
      calls = calls + excluded.calls,
      successes = successes + excluded.successes,
      errors = errors + excluded.errors,
      payment_required = payment_required + excluded.payment_required,
      settled_calls = settled_calls + excluded.settled_calls,
      settled_amount_atomic = settled_amount_atomic + excluded.settled_amount_atomic,
      total_duration_ms = total_duration_ms + excluded.total_duration_ms,
      max_duration_ms = MAX(max_duration_ms, excluded.max_duration_ms),
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`;
}

export function selectSql(sinceMs?: number): string {
  return `SELECT tool, SUM(calls) AS calls, SUM(successes) AS successes, SUM(errors) AS errors,
      SUM(payment_required) AS payment_required, SUM(settled_calls) AS settled_calls,
      CAST(SUM(settled_amount_atomic) AS TEXT) AS settled_amount_atomic, SUM(total_duration_ms) AS total_duration_ms,
      MAX(max_duration_ms) AS max_duration_ms, MAX(last_seen_at) AS last_seen_at
    FROM tool_stats_daily ${sinceMs === undefined ? "" : "WHERE day_start >= ?"}
    GROUP BY tool ORDER BY calls DESC, tool ASC`;
}

export function selectArgs(sinceMs?: number): number[] { return sinceMs === undefined ? [] : [dayStart(sinceMs)]; }

export function trafficUpsertSql(): string {
  return `INSERT INTO traffic_stats_daily (day_start, event, calls, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(day_start, event) DO UPDATE SET
      calls = calls + excluded.calls,
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`;
}

export function trafficSelectSql(sinceMs?: number): string {
  return `SELECT event, SUM(calls) AS calls, MAX(last_seen_at) AS last_seen_at
    FROM traffic_stats_daily ${sinceMs === undefined ? "" : "WHERE day_start >= ?"}
    GROUP BY event ORDER BY calls DESC, event ASC`;
}

export function validateTrafficEvent(event: TrafficStatsEvent): Required<TrafficStatsEvent> {
  if (!TRAFFIC_EVENTS.has(event.event)) throw new Error("Invalid traffic stats event.");
  const createdAt = Number.isFinite(event.createdAt) ? Math.max(0, Math.floor(event.createdAt!)) : Date.now();
  return { event: event.event, createdAt };
}

export function normalizeEvent(event: ToolStatsEvent): Required<ToolStatsEvent> {
  const tool = event.tool.trim();
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(tool)) throw new Error("Invalid stats tool name.");
  const createdAt = Number.isFinite(event.createdAt) ? Math.max(0, Math.floor(event.createdAt!)) : Date.now();
  const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, Math.min(86_400_000, Math.floor(event.durationMs))) : 0;
  const amount = event.settledAmountAtomic ?? "";
  if (amount && (!/^\d+$/.test(amount) || amount.length > 18)) throw new Error("Invalid settled amount.");
  return { tool, outcome: event.outcome, status: event.status, durationMs, settledAmountAtomic: amount, createdAt };
}

export function dayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export interface RawTrafficRow { event: string; calls: number | string; last_seen_at: number | string; }

export interface RawTimelineRow { bucket_start: number | string; calls: number | string; successes: number | string; errors: number | string; payment_required: number | string; }

export function summarizeRows(rows: RawStatsRow[], sinceMs?: number, trafficRows: RawTrafficRow[] = [], timelineRows: RawTimelineRow[] = []): ToolStatsSummary {
  const byTool = rows.filter((row) => PRODUCT_TOOLS.has(row.tool)).map((row): ToolStatsRow => ({
    tool: row.tool, calls: number(row.calls), successes: number(row.successes), errors: number(row.errors),
    paymentRequired: number(row.payment_required), settledCalls: number(row.settled_calls),
    settledAmountAtomic: String(row.settled_amount_atomic ?? "0"), totalDurationMs: number(row.total_duration_ms),
    maxDurationMs: number(row.max_duration_ms), lastSeenAt: number(row.last_seen_at),
  }));
  const totals = byTool.reduce((acc, row) => {
    acc.calls += row.calls; acc.successes += row.successes; acc.errors += row.errors;
    acc.paymentRequired += row.paymentRequired; acc.settledCalls += row.settledCalls;
    acc.duration += row.totalDurationMs; acc.amount = addAtomic(acc.amount, row.settledAmountAtomic);
    return acc;
  }, { calls: 0, successes: 0, errors: 0, paymentRequired: 0, settledCalls: 0, duration: 0, amount: "0" });
  return {
    generatedAt: new Date().toISOString(), since: sinceMs === undefined ? null : new Date(dayStart(sinceMs)).toISOString(),
    totalCalls: totals.calls, totalSuccesses: totals.successes, totalErrors: totals.errors,
    totalPaymentRequired: totals.paymentRequired, totalSettledCalls: totals.settledCalls,
    totalSettledAmountAtomic: totals.amount, averageDurationMs: totals.calls ? Math.round(totals.duration / totals.calls) : 0,
    byTool,
    traffic: trafficRows.filter((row) => TRAFFIC_EVENTS.has(row.event as TrafficStatsEventName)).map((row): TrafficStatsRow => ({
      event: row.event as TrafficStatsEventName,
      calls: number(row.calls),
      lastSeenAt: number(row.last_seen_at),
    })),
    timeline: timelineRows.map((row): ToolStatsTimelineRow => ({
      bucketStart: new Date(number(row.bucket_start)).toISOString(),
      granularity: number(row.bucket_start) % (24 * 60 * 60 * 1000) === 0 ? "day" : "hour",
      calls: number(row.calls),
      successes: number(row.successes),
      errors: number(row.errors),
      paymentRequired: number(row.payment_required),
    })),
  };
}

function number(value: number | string | null | undefined): number { return Number(value ?? 0); }
function addAtomic(left: string, right: string): string { try { return (BigInt(left) + BigInt(right)).toString(); } catch { return left; } }

export function hourStart(timestamp: number): number {
  return Math.floor(timestamp / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

export function hourlyUpsertSql(): string {
  return `INSERT INTO tool_stats_hourly
    (bucket_start, calls, successes, errors, payment_required, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket_start) DO UPDATE SET
      calls = calls + excluded.calls,
      successes = successes + excluded.successes,
      errors = errors + excluded.errors,
      payment_required = payment_required + excluded.payment_required,
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`;
}

export function timelineSelectSql(sinceMs?: number): string {
  return `SELECT bucket_start, calls, successes, errors, payment_required
    FROM tool_stats_hourly ${sinceMs === undefined ? "" : "WHERE bucket_start >= ?"}
    ORDER BY bucket_start ASC`;
}

export function timelineSelectArgs(sinceMs?: number): number[] { return sinceMs === undefined ? [] : [dayStart(sinceMs)]; }
