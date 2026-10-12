import type { ToolStatsEvent, ToolStatsStore, TrafficStatsEvent } from "./types.js";
import { dayStart, hourStart, hourlyUpsertSql, normalizeEvent, selectArgs, selectSql, summarizeRows, timelineSelectArgs, timelineSelectSql, trafficSelectSql, trafficUpsertSql, validateTrafficEvent, upsertSql, type RawStatsRow, type RawTimelineRow, type RawTrafficRow } from "./stats-core.js";

export class D1ToolStatsStore implements ToolStatsStore {
  constructor(private readonly db: D1Database) {}
  async record(event: ToolStatsEvent): Promise<void> {
    const value = normalizeEvent(event);
    await this.db.batch([
      this.db.prepare(upsertSql()).bind(dayStart(value.createdAt), value.tool, 1, value.outcome === "success" ? 1 : 0, value.outcome === "error" ? 1 : 0, value.outcome === "payment_required" ? 1 : 0, value.settledAmountAtomic ? 1 : 0, value.settledAmountAtomic ? value.settledAmountAtomic : 0, value.durationMs, value.durationMs, value.createdAt),
      this.db.prepare(hourlyUpsertSql()).bind(hourStart(value.createdAt), 1, value.outcome === "success" ? 1 : 0, value.outcome === "error" ? 1 : 0, value.outcome === "payment_required" ? 1 : 0, value.createdAt),
    ]);
  }
  async recordTraffic(event: TrafficStatsEvent): Promise<void> {
    const value = validateTrafficEvent(event);
    await this.db.prepare(trafficUpsertSql()).bind(dayStart(value.createdAt), value.event, 1, value.createdAt).run();
  }
  async summarize(sinceMs?: number) {
    const result = await this.db.prepare(selectSql(sinceMs)).bind(...selectArgs(sinceMs)).all<RawStatsRow>();
    const traffic = await this.db.prepare(trafficSelectSql(sinceMs)).bind(...selectArgs(sinceMs)).all<RawTrafficRow>();
    const timeline = await this.db.prepare(timelineSelectSql(sinceMs)).bind(...timelineSelectArgs(sinceMs)).all<RawTimelineRow>();
    return summarizeRows(result.results ?? [], sinceMs, traffic.results ?? [], timeline.results ?? []);
  }
}
