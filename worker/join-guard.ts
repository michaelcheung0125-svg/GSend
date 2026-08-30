import { DurableObject } from "cloudflare:workers";
import { JOIN_ATTEMPT_LIMIT, JOIN_ATTEMPT_WINDOW_MS } from "../shared/protocol";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * One instance per client IP. A 4-digit code is only 10,000 possibilities, so
 * without this an attacker could sweep the whole space inside a code's 60s life.
 */
export class JoinGuard extends DurableObject<Env> {
  async consume(): Promise<boolean> {
    const now = Date.now();
    const bucket = await this.ctx.storage.get<Bucket>("bucket");

    if (!bucket || now >= bucket.resetAt) {
      const resetAt = now + JOIN_ATTEMPT_WINDOW_MS;
      await this.ctx.storage.put("bucket", { count: 1, resetAt });
      // Self-cleanup so idle IP buckets do not accumulate storage forever.
      await this.ctx.storage.setAlarm(resetAt + 1_000);
      return true;
    }

    if (bucket.count >= JOIN_ATTEMPT_LIMIT) return false;

    bucket.count += 1;
    await this.ctx.storage.put("bucket", bucket);
    return true;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
