import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolStatsEvent, ToolStatsStore, TrafficStatsEvent } from "./types.js";
import { STATS_SCHEMA, dayStart, hourStart, hourlyUpsertSql, normalizeEvent, selectArgs, selectSql, summarizeRows, timelineSelectArgs, timelineSelectSql, trafficSelectSql, trafficUpsertSql, validateTrafficEvent, upsertSql, type RawStatsRow, type RawTimelineRow, type RawTrafficRow } from "./stats-core.js";

export class SqliteToolStatsStore implements ToolStatsStore {
  private readonly db: DatabaseSync;
  constructor(path = ".data/stats.sqlite") {
    const absolute = resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(path === ":memory:" ? path : absolute);
    this.db.exec("PRAGMA journal_mode = WAL;"); this.db.exec("PRAGMA busy_timeout = 5000;"); this.db.exec(STATS_SCHEMA);
  }
  async record(event: ToolStatsEvent): Promise<void> {
    const value = normalizeEvent(event);
    this.db.prepare(upsertSql()).run(dayStart(value.createdAt), value.tool, 1, value.outcome === "success" ? 1 : 0, value.outcome === "error" ? 1 : 0, value.outcome === "payment_required" ? 1 : 0, value.settledAmountAtomic ? 1 : 0, value.settledAmountAtomic ? value.settledAmountAtomic : 0, value.durationMs, value.durationMs, value.createdAt);
    this.db.prepare(hourlyUpsertSql()).run(hourStart(value.createdAt), 1, value.outcome === "success" ? 1 : 0, value.outcome === "error" ? 1 : 0, value.outcome === "payment_required" ? 1 : 0, value.createdAt);
  }
  async recordTraffic(event: TrafficStatsEvent): Promise<void> {
    const value = validateTrafficEvent(event);
    this.db.prepare(trafficUpsertSql()).run(dayStart(value.createdAt), value.event, 1, value.createdAt);
  }
  async summarize(sinceMs?: number) {
    const rows = this.db.prepare(selectSql(sinceMs)).all(...selectArgs(sinceMs)) as unknown as RawStatsRow[];
    const trafficRows = this.db.prepare(trafficSelectSql(sinceMs)).all(...selectArgs(sinceMs)) as unknown as RawTrafficRow[];
    const timelineRows = this.db.prepare(timelineSelectSql(sinceMs)).all(...timelineSelectArgs(sinceMs)) as unknown as RawTimelineRow[];
    return summarizeRows(rows, sinceMs, trafficRows, timelineRows);
  }
  close(): void { this.db.close(); }
}
