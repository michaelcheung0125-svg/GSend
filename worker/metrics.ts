import { DurableObject } from "cloudflare:workers";
import {
  EMPTY_DAY,
  type ConnectionOutcome,
  type ConnectionPath,
  type DayCounts,
} from "../shared/protocol";

const RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Counts how often a direct connection works, and nothing else. There is no IP, no
 * timestamp beyond the day, no session identifier and no way to tie a count back to
 * a person — the point is a single ratio that decides whether TURN is worth paying
 * for, not analytics.
 */
export class Metrics extends DurableObject<Env> {
  async record(outcome: ConnectionOutcome, path: ConnectionPath): Promise<void> {
    const day = today();
    const counts = (await this.ctx.storage.get<DayCounts>(day)) ?? { ...EMPTY_DAY };

    if (outcome === "failed") counts.failed += 1;
    else if (path === "lan") counts.connectedLan += 1;
    else if (path === "internet") counts.connectedInternet += 1;
    else counts.connectedUnknown += 1;

    await this.ctx.storage.put(day, counts);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }

  async summary(): Promise<{ totals: DayCounts; days: Record<string, DayCounts> }> {
    const stored = await this.ctx.storage.list<DayCounts>();
    const days: Record<string, DayCounts> = {};
    const totals: DayCounts = { ...EMPTY_DAY };

    for (const [day, counts] of stored) {
      days[day] = counts;
      totals.connectedLan += counts.connectedLan;
      totals.connectedInternet += counts.connectedInternet;
      totals.connectedUnknown += counts.connectedUnknown;
      totals.failed += counts.failed;
    }

    return { totals, days };
  }

  async alarm(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const stored = await this.ctx.storage.list<DayCounts>({ end: cutoff });
    for (const day of stored.keys()) await this.ctx.storage.delete(day);

    if (stored.size > 0 || (await this.ctx.storage.list({ limit: 1 })).size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
