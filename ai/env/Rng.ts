/**
 * The environment's own random stream (FINAL_DESIGN §4.9.1).
 *
 * All env-side randomness — latency sampling, turn shuffles, executor
 * sampling, spawn sampling — draws from ONE `Rng` per env, seeded from
 * `EpisodeSpec.seed`, and never from the game's PRNGs. That keeps the
 * simulation independent of how often the env rolls dice and makes the env
 * reproducible: same EpisodeSpec + same action stream ⇒ same draws.
 *
 * Thin wrapper around src/core/PseudoRandom (sfc32, 32-bit integer ops only,
 * identical on every platform). Draw-order conventions, relied on by tests:
 * - `categorical(p)` consumes exactly one `next()`.
 * - `shuffleInPlace(a)` consumes `a.length - 1` draws (none for length ≤ 1)
 *   in the same order as `PseudoRandom.shuffleArray` (Fisher–Yates from the
 *   back), so both produce the same permutation from the same state.
 */
import { PseudoRandom } from "../../src/core/PseudoRandom";

export class Rng {
  readonly prng: PseudoRandom;

  constructor(seedOrPrng: number | PseudoRandom) {
    this.prng =
      typeof seedOrPrng === "number"
        ? new PseudoRandom(seedOrPrng)
        : seedOrPrng;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.prng.next();
  }

  /** Uniform integer in [lo, hi). */
  int(lo: number, hi: number): number {
    return this.prng.nextInt(lo, hi);
  }

  /**
   * Index drawn from unnormalised non-negative weights (one draw). Entries
   * with weight 0 are never returned. Throws when no weight is positive.
   */
  categorical(weights: readonly number[]): number {
    let total = 0;
    let last = -1;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (!(w >= 0)) throw new Error(`categorical: bad weight ${w} at ${i}`);
      total += w;
      if (w > 0) last = i;
    }
    if (last < 0) throw new Error("categorical: no positive weight");
    const u = this.prng.next() * total;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      acc += w;
      if (u < acc) return i;
    }
    // Rounding left u ≥ the running sum: the last positive entry.
    return last;
  }

  /** Fisher–Yates in place (same permutation as PseudoRandom.shuffleArray). */
  shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.prng.nextInt(0, i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** Uniform element of a non-empty array (one draw). */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick: empty array");
    return arr[this.prng.nextInt(0, arr.length)];
  }

  /** The PRNG state words (for env snapshots / repro bundles). */
  getState(): [number, number, number, number] {
    return this.prng.getState();
  }

  static fromState(state: readonly number[]): Rng {
    return new Rng(PseudoRandom.fromState(state));
  }
}
