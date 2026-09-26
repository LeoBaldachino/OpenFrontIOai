// @vitest-environment node
/**
 * T7: the RateLimiter mirror makes exactly the accept/reject decisions of
 * the server's limiter@3 pair (src/server/ClientMsgRateLimiter.ts) under
 * injected time. limiter@3 reads `performance.now()`, which is stubbed here.
 */
import { RateLimiter as LimiterRateLimiter } from "limiter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientMsgRateLimiter } from "../../src/server/ClientMsgRateLimiter";
import {
  limiterMilliseconds,
  ManualClock,
  RateLimiter,
  tickClock,
  WallClock,
  WindowedBucket,
} from "../env/RateLimiter";
import { Rng } from "../env/Rng";

let perfNow = 0;

// A plain function (not vi.fn, which would record millions of calls).
beforeEach(() => {
  perfNow = 0;
  Object.defineProperty(performance, "now", {
    value: () => perfNow,
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  delete (performance as unknown as { now?: unknown }).now;
});

/** The server's check for one intent (ClientMsgRateLimiter.check). */
class ServerPair {
  perSecond = new LimiterRateLimiter({
    tokensPerInterval: 10,
    interval: "second",
  });
  perMinute = new LimiterRateLimiter({
    tokensPerInterval: 150,
    interval: "minute",
  });
  check(): boolean {
    return (
      this.perSecond.tryRemoveTokens(1) && this.perMinute.tryRemoveTokens(1)
    );
  }
}

/** Clock returning what limiter@3 reads from the stubbed performance.now(). */
const mirroredClock = { nowMs: () => limiterMilliseconds(perfNow) };

type Schedule = number[]; // performance.now() value of each intent

/** Random schedules mixing bursts, sub-second gaps, env ticks and long idles. */
function randomSchedule(rng: Rng, fractional: boolean): Schedule {
  const n = 20 + rng.int(0, 300);
  const out: number[] = [];
  let t = rng.int(0, 5000) + (fractional ? rng.next() : 0);
  const style = rng.int(0, 4);
  for (let i = 0; i < n; i++) {
    let gap: number;
    const r = rng.next();
    switch (style) {
      case 0: // bursty sub-second
        gap = r < 0.5 ? 0 : r < 0.9 ? rng.int(1, 150) : rng.int(150, 3000);
        break;
      case 1: // env decisions: tick × 100 ms, 0–3 intents per decision
        gap = r < 0.6 ? 0 : 100 * rng.int(1, 11);
        break;
      case 2: // around the window edges
        gap = r < 0.3 ? 0 : r < 0.6 ? rng.int(995, 1006) : rng.int(1, 60);
        break;
      default: // sustained pressure on the minute window, some long idles
        gap = r < 0.95 ? rng.int(0, 500) : rng.int(20_000, 70_000);
    }
    t += gap + (fractional && gap > 0 ? rng.next() : 0);
    out.push(t);
  }
  return out;
}

function runBoth(schedule: Schedule, startAt: number): [boolean[], boolean[]] {
  perfNow = startAt;
  const server = new ServerPair();
  const mirror = new RateLimiter(mirroredClock);
  const a: boolean[] = [];
  const b: boolean[] = [];
  for (const t of schedule) {
    perfNow = t;
    a.push(server.check());
    const canBefore = mirror.canAccept(1);
    const ok = mirror.tryConsume();
    // The pure preview agrees with the mutating call.
    if (canBefore !== ok) throw new Error(`canAccept(1) ≠ tryConsume at ${t}`);
    b.push(ok);
  }
  return [a, b];
}

describe("RateLimiter mirror vs limiter@3 (T7)", () => {
  it("limiterMilliseconds reproduces limiter's clock", () => {
    for (const v of [0, 0.5, 999.9999, 1200, 2400, 123456.789, 1e7 + 0.25]) {
      perfNow = v;
      // WallClock reads the (stubbed) performance.now().
      expect(new WallClock().nowMs()).toBe(limiterMilliseconds(v));
    }
    // The truncation is not plain floor for integer inputs.
    expect(limiterMilliseconds(1200)).toBe(1199);
    expect(limiterMilliseconds(1200.5)).toBe(1200);
  });

  it("identical decisions on 10 000 random schedules", () => {
    const rng = new Rng(12345);
    let accepted = 0;
    let rejected = 0;
    for (let s = 0; s < 10_000; s++) {
      const fractional = s % 2 === 1;
      const sched = randomSchedule(rng, fractional);
      const [server, mirror] = runBoth(sched, sched[0] - rng.int(0, 2000));
      if (server.join() !== mirror.join()) {
        const i = server.findIndex((v, k) => v !== mirror[k]);
        throw new Error(
          `schedule ${s}: first divergence at ${i} (t=${sched[i]}): server=${server[i]} mirror=${mirror[i]}`,
        );
      }
      for (const v of server) {
        if (v) accepted++;
        else rejected++;
      }
    }
    // Both outcomes are well represented.
    expect(accepted).toBeGreaterThan(100_000);
    expect(rejected).toBeGreaterThan(100_000);
  });

  it("identical decisions to ClientMsgRateLimiter.check itself", () => {
    const rng = new Rng(777);
    for (let s = 0; s < 2000; s++) {
      const sched = randomSchedule(rng, s % 2 === 1);
      const server = new ClientMsgRateLimiter();
      // The server creates a client's buckets at its first message.
      perfNow = sched[0];
      const mirror = new RateLimiter(mirroredClock);
      for (let i = 0; i < sched.length; i++) {
        perfNow = sched[i];
        const a = server.check("AGSEAT00", "intent", 64) === "ok";
        const b = mirror.tryConsume();
        if (a !== b) {
          throw new Error(`schedule ${s} event ${i}: server=${a} mirror=${b}`);
        }
      }
    }
  });

  it("drip content matches the package's token bucket", () => {
    const rng = new Rng(7);
    perfNow = 1000.5;
    const server = new ServerPair();
    const mirror = new RateLimiter(mirroredClock);
    for (let i = 0; i < 5000; i++) {
      perfNow += rng.next() < 0.5 ? 0 : rng.int(1, 400) + rng.next();
      expect(mirror.tryConsume()).toBe(server.check());
      const sb = server.perSecond as unknown as {
        tokenBucket: { content: number };
        tokensThisInterval: number;
      };
      const mb = mirror.perSecond.state();
      expect(mb.content).toBe(sb.tokenBucket.content);
      expect(mb.used).toBe(sb.tokensThisInterval);
      const sm = server.perMinute as unknown as {
        tokenBucket: { content: number };
        tokensThisInterval: number;
      };
      const mm = mirror.perMinute.state();
      expect(mm.content).toBe(sm.tokenBucket.content);
      expect(mm.used).toBe(sm.tokensThisInterval);
    }
  });
});

describe("RateLimiter semantics", () => {
  it("the fixed window drops a burst the bucket would allow", () => {
    const clock = new ManualClock(0);
    const rl = new RateLimiter(clock);
    for (let i = 0; i < 10; i++) expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
    clock.set(500); // 5 tokens dripped back, but the 1-s window is spent
    expect(rl.tokens().second).toBe(0);
    expect(rl.canAccept(1)).toBe(false);
    for (let i = 0; i < 5; i++) expect(rl.tryConsume()).toBe(false);
    clock.set(1000); // new window, bucket refilled to 10
    expect(rl.tokens().second).toBe(10);
    expect(rl.canAccept(10)).toBe(true);
    expect(rl.canAccept(11)).toBe(false);
  });

  it("spends a per-second token when the per-minute check fails", () => {
    const clock = new ManualClock(0);
    const rl = new RateLimiter(clock);
    // 150 intents in 15 s (10 per second) exhaust the minute window.
    for (let s = 0; s < 15; s++) {
      clock.setTick(10 * s);
      for (let i = 0; i < 10; i++) expect(rl.tryConsume()).toBe(true);
    }
    clock.set(15_000);
    expect(rl.tokens()).toEqual({ second: 10, minute: 0 });
    expect(rl.tryConsume()).toBe(false);
    // The per-second limiter lost a token although nothing was accepted.
    expect(rl.tokens().second).toBe(9);
    expect(rl.perSecond.state().used).toBe(1);
    expect(rl.accepted).toBe(150);
    expect(rl.rejected).toBe(1);
  });

  it("env cadence: 2 intents per 10-tick step never binds", () => {
    let tick = 0;
    const rl = new RateLimiter(tickClock(() => tick));
    for (let step = 0; step < 2000; step++, tick += 10) {
      expect(rl.canAccept(2)).toBe(true);
      expect(rl.tryConsume()).toBe(true);
      expect(rl.tryConsume()).toBe(true);
    }
  });

  it("canAccept(n) ⇔ n back-to-back tryConsume succeed", () => {
    const rng = new Rng(99);
    const clock = new ManualClock(0);
    for (let trial = 0; trial < 300; trial++) {
      const rl = new RateLimiter(clock);
      for (let i = 0; i < 60; i++) {
        clock.advance(rng.next() < 0.5 ? 0 : rng.int(1, 700));
        const n = rng.int(1, 5);
        const can = rl.canAccept(n);
        const tok = rl.tokens();
        expect(can).toBe(tok.second >= n && tok.minute >= n);
        let all = true;
        for (let k = 0; k < n; k++) all = rl.tryConsume() && all;
        if (can) expect(all).toBe(true);
        else expect(all).toBe(false);
      }
    }
  });

  it("WindowedBucket is non-mutating in preview/available", () => {
    const clock = new ManualClock(0);
    const b = new WindowedBucket(clock, 10, 1000);
    for (let i = 0; i < 7; i++) b.tryRemove();
    clock.set(333);
    const before = b.state();
    expect(b.available()).toBe(3);
    expect(b.preview(3)).toBe(true);
    expect(b.preview(4)).toBe(false);
    expect(b.state()).toEqual(before);
  });
});
