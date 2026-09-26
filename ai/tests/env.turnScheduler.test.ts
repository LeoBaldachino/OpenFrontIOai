// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import { Intent } from "../../src/core/Schemas";
import { Rng } from "../env/Rng";
import { TurnScheduler } from "../env/TurnScheduler";

const spawn = (tile: number): Intent => ({ type: "spawn", tile });
const P: [number, number, number] = [0.5, 0.4, 0.1];

describe("Rng", () => {
  it("shuffleInPlace matches PseudoRandom.shuffleArray", () => {
    for (let seed = 0; seed < 50; seed++) {
      const arr = Array.from({ length: seed % 9 }, (_, i) => i);
      const a = new Rng(seed).shuffleInPlace([...arr]);
      const b = new PseudoRandom(seed).shuffleArray(arr);
      expect(a).toEqual(b);
    }
  });

  it("categorical follows the weights and never returns a zero weight", () => {
    const rng = new Rng(3);
    const counts = [0, 0, 0, 0];
    const n = 40_000;
    for (let i = 0; i < n; i++) counts[rng.categorical([0.5, 0, 0.4, 0.1])]++;
    expect(counts[1]).toBe(0);
    expect(counts[0] / n).toBeCloseTo(0.5, 1);
    expect(counts[2] / n).toBeCloseTo(0.4, 1);
    expect(counts[3] / n).toBeCloseTo(0.1, 1);
    expect(() => rng.categorical([0, 0])).toThrow();
  });

  it("state round trip continues the same stream", () => {
    const a = new Rng(11);
    for (let i = 0; i < 10; i++) a.next();
    const b = Rng.fromState(a.getState());
    for (let i = 0; i < 10; i++) expect(b.next()).toBe(a.next());
  });
});

describe("TurnScheduler", () => {
  it("queues a step's intents at now + ℓ, in order, one draw per seat-step", () => {
    const rng = new Rng(1);
    const ref = new Rng(1);
    const ts = new TurnScheduler(rng, P);
    const b = ts.schedule(100, 0, "AGSEAT00", [spawn(1), spawn(2)])!;
    const l = ref.categorical(P);
    expect(b.latency).toBe(l);
    expect(b.tick).toBe(100 + l);
    expect(ts.pendingCount()).toBe(2);
    // No draw for an empty batch.
    expect(ts.schedule(100, 1, "AGSEAT01", [])).toBeNull();
    expect(rng.getState()).toEqual(ref.getState());
    for (let t = 100; t < b.tick; t++) expect(ts.take(t)).toEqual([]);
    expect(ts.take(b.tick)).toEqual([
      ["AGSEAT00", spawn(1)],
      ["AGSEAT00", spawn(2)],
    ]);
    expect(ts.pendingCount()).toBe(0);
  });

  it("latency distribution follows latencyProbs", () => {
    const ts = new TurnScheduler(new Rng(5), P);
    const counts = [0, 0, 0];
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      const b = ts.schedule(i * 10, 0, "AGSEAT00", [spawn(i)])!;
      counts[b.latency]++;
      ts.take(b.tick);
    }
    expect(counts[0] / n).toBeCloseTo(0.5, 1);
    expect(counts[1] / n).toBeCloseTo(0.4, 1);
    expect(counts[2] / n).toBeCloseTo(0.1, 1);
  });

  it("shuffles seats per turn, keeps each seat's order, is deterministic", () => {
    const run = (seed: number) => {
      const ts = new TurnScheduler(new Rng(seed), [1, 0, 0]);
      const out: string[] = [];
      for (let step = 0; step < 200; step++) {
        for (let seat = 0; seat < 4; seat++) {
          ts.schedule(step, seat, `AGSEAT0${seat}`, [
            spawn(seat * 10 + 1),
            spawn(seat * 10 + 2),
          ]);
        }
        const turn = ts.take(step);
        // Per-seat order kept and contiguous.
        for (let k = 0; k < turn.length; k += 2) {
          expect(turn[k][0]).toBe(turn[k + 1][0]);
          expect((turn[k][1] as { tile: number }).tile % 10).toBe(1);
          expect((turn[k + 1][1] as { tile: number }).tile % 10).toBe(2);
        }
        out.push(turn.map(([c]) => c.slice(-1)).join(""));
      }
      return out;
    };
    const a = run(42);
    expect(run(42)).toEqual(a);
    expect(run(43)).not.toEqual(a);
    // All 24 seat orders show up.
    expect(new Set(a.map((s) => s.replace(/(.)\1/g, "$1"))).size).toBe(24);
  });

  it("forced entries use ℓ = 0 without a draw", () => {
    const rng = new Rng(9);
    const before = rng.getState();
    const ts = new TurnScheduler(rng, P);
    const b = ts.scheduleForced(190, 1, "AGSEAT01", [spawn(7)])!;
    expect(b.forced).toBe(true);
    expect(b.tick).toBe(190);
    expect(rng.getState()).toEqual(before);
    expect(ts.take(190)).toEqual([["AGSEAT01", spawn(7)]]);
  });

  it("per-seat FIFO: a later decision never overtakes an earlier one", () => {
    const ts = new TurnScheduler(new Rng(2), P);
    let last = -1;
    for (let now = 0; now < 5000; now++) {
      const b = ts.schedule(now, 0, "AGSEAT00", [spawn(now)])!;
      expect(b.tick).toBeGreaterThanOrEqual(Math.max(now, last));
      expect(b.tick).toBeLessThanOrEqual(now + 2);
      last = b.tick;
    }
    // Taking tick by tick yields the intents in decision order.
    const seen: number[] = [];
    for (let t = 0; t <= 5002; t++) {
      for (const [, i] of ts.take(t)) seen.push((i as { tile: number }).tile);
    }
    expect(seen).toEqual(Array.from({ length: 5000 }, (_, i) => i));
  });

  it("take(tick) also delivers entries of skipped ticks", () => {
    const ts = new TurnScheduler(new Rng(4), [0, 0, 1]);
    ts.schedule(0, 0, "AGSEAT00", [spawn(1)]); // tick 2
    ts.schedule(1, 0, "AGSEAT00", [spawn(2)]); // tick 3
    expect(ts.take(5)).toEqual([
      ["AGSEAT00", spawn(1)],
      ["AGSEAT00", spawn(2)],
    ]);
    expect(ts.pendingCount()).toBe(0);
  });
});
