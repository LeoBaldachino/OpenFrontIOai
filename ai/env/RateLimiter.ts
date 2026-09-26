/**
 * Exact mirror of the server's intent rate limit (FINAL_DESIGN §4.7).
 *
 * The server (src/server/ClientMsgRateLimiter.ts) keeps, per client, two
 * `limiter@3` RateLimiters — 10 per "second" and 150 per "minute" — and
 * drops an intent unless
 *
 *     perSecond.tryRemoveTokens(1) && perMinute.tryRemoveTokens(1)
 *
 * (short-circuit: when the per-minute check fails, the per-second token is
 * already spent). A limiter@3 RateLimiter is a token bucket (starts full,
 * drips N tokens per interval, capacity N) PLUS a fixed window that allows at
 * most N removals per interval, where the window restarts at the first call
 * made ≥ interval after the previous window start (not aligned to a grid).
 * So 10 intents at t = 0 s and 5 more at t = 0.5 s pass the bucket (5 tokens
 * dripped back) but are refused by the window.
 *
 * `WindowedBucket` reproduces node_modules/limiter/dist/esm/RateLimiter.js +
 * TokenBucket.js operation by operation, including the floating-point
 * expression order of the drip (`deltaMs * (N / interval)`) and the fact that
 * the bucket only drips when the window check passes, so the accept/reject
 * sequences are identical for identical millisecond timestamps (test T7).
 *
 * Time: limiter@3 reads `performance.now()` and truncates it to whole
 * milliseconds through an hrtime-style split (`limiterMilliseconds`), which
 * returns v−1 for many integer v because of float rounding. The env uses an
 * exact integer clock (decision tick × 100 ms) — an idealised server arrival
 * time; `WallClock` applies the same truncation as the package, so a live
 * agent mirrors the server bit for bit given equal timestamps.
 */

/** One simulation tick / server turn, in ms. */
export const TICK_MS = 100;

export interface Clock {
  /** Current time in whole milliseconds (the value limiter@3 would read). */
  nowMs(): number;
}

/** limiter@3's `getMilliseconds()` applied to a `performance.now()` value. */
export function limiterMilliseconds(perfNowMs: number): number {
  const clocktime = perfNowMs * 1e-3;
  const seconds = Math.floor(clocktime);
  const nanoseconds = Math.floor((clocktime % 1) * 1e9);
  return seconds * 1e3 + Math.floor(nanoseconds / 1e6);
}

/** Settable clock. The env sets it to `tick * TICK_MS` at each decision. */
export class ManualClock implements Clock {
  constructor(private ms: number = 0) {}
  nowMs(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  /** Sets the clock to the start of `tick` (tick × 100 ms). */
  setTick(tick: number): void {
    this.ms = tick * TICK_MS;
  }
}

/** Wall clock with limiter@3's exact millisecond truncation (live play). */
export class WallClock implements Clock {
  nowMs(): number {
    return limiterMilliseconds(performance.now());
  }
}

/** Clock reading a tick counter (e.g. `() => session.ticks()`). */
export function tickClock(ticks: () => number): Clock {
  return { nowMs: () => ticks() * TICK_MS };
}

/** One limiter@3 `RateLimiter` (token bucket + fixed window), 1 token per call. */
export class WindowedBucket {
  /** Tokens in the bucket (fractional, ≤ N). */
  private content: number;
  private lastDrip: number;
  private windowStart: number;
  private usedThisWindow = 0;

  constructor(
    private readonly clock: Clock,
    readonly tokensPerInterval: number,
    readonly intervalMs: number,
  ) {
    // TokenBucket's constructor reads the clock first (lastDrip), then
    // RateLimiter's (curIntervalStart); both read the same ms here.
    const now = clock.nowMs();
    this.lastDrip = now;
    this.content = tokensPerInterval; // "Fill the token bucket to start"
    this.windowStart = now;
  }

  /** RateLimiter.tryRemoveTokens(1). */
  tryRemove(): boolean {
    const n = this.tokensPerInterval;
    if (1 > n) return false; // count > bucketSize
    const now = this.clock.nowMs();
    if (now < this.windowStart || now - this.windowStart >= this.intervalMs) {
      this.windowStart = now;
      this.usedThisWindow = 0;
    }
    if (1 > n - this.usedThisWindow) return false;
    // TokenBucket.tryRemoveTokens(1): drip, check, remove.
    this.drip(now);
    if (1 > this.content) return false;
    this.content -= 1;
    this.usedThisWindow += 1;
    return true;
  }

  /** Would `k` back-to-back tryRemove() calls at the current time all succeed? (pure) */
  preview(k: number = 1): boolean {
    if (k <= 0) return true;
    return this.available() >= k;
  }

  /**
   * Removals that would succeed right now if made back to back (pure):
   * min(floor(content after drip), N − used this window), with the window
   * restart applied virtually. Exact because `x − 1` is exact in float.
   */
  available(): number {
    const n = this.tokensPerInterval;
    if (1 > n) return 0;
    const now = this.clock.nowMs();
    const used =
      now < this.windowStart || now - this.windowStart >= this.intervalMs
        ? 0
        : this.usedThisWindow;
    const content = this.drippedContent(now);
    return Math.max(0, Math.min(Math.floor(content), n - used));
  }

  /** Raw state for tests / debugging. */
  state(): {
    content: number;
    lastDrip: number;
    windowStart: number;
    used: number;
  } {
    return {
      content: this.content,
      lastDrip: this.lastDrip,
      windowStart: this.windowStart,
      used: this.usedThisWindow,
    };
  }

  private drippedContent(now: number): number {
    if (this.tokensPerInterval === 0) return this.tokensPerInterval;
    const deltaMs = Math.max(now - this.lastDrip, 0);
    const dripAmount = deltaMs * (this.tokensPerInterval / this.intervalMs);
    return Math.min(this.content + dripAmount, this.tokensPerInterval);
  }

  private drip(now: number): void {
    // TokenBucket.drip(): content, then lastDrip = now (even if delta < 0).
    this.content = this.drippedContent(now);
    this.lastDrip = now;
  }
}

/**
 * The server's per-client intent limit. Construct it when the seat's client
 * would first talk to the server (env: at reset; buckets start full).
 */
export class RateLimiter {
  readonly perSecond: WindowedBucket;
  readonly perMinute: WindowedBucket;
  /** Intents accepted / rejected so far (metrics). */
  accepted = 0;
  rejected = 0;

  constructor(
    readonly clock: Clock,
    perSecond: number = 10,
    perMinute: number = 150,
  ) {
    this.perSecond = new WindowedBucket(clock, perSecond, 1000);
    this.perMinute = new WindowedBucket(clock, perMinute, 60_000);
  }

  /**
   * Sends one intent through the limiter. False = the server would drop it
   * ("limit"). A per-second token is spent even when the per-minute check
   * fails, exactly as on the server.
   */
  tryConsume(): boolean {
    const ok = this.perSecond.tryRemove() && this.perMinute.tryRemove();
    if (ok) this.accepted++;
    else this.rejected++;
    return ok;
  }

  /** Would `n` intents sent now all be accepted? (pure; used by masks) */
  canAccept(n: number): boolean {
    if (n <= 0) return true;
    return this.perSecond.available() >= n && this.perMinute.available() >= n;
  }

  /** Whole tokens usable right now per limiter (pure). */
  tokens(): { second: number; minute: number } {
    return {
      second: this.perSecond.available(),
      minute: this.perMinute.available(),
    };
  }
}
