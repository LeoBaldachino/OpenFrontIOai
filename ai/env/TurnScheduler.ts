/**
 * Latency model and per-turn intent queues (FINAL_DESIGN §4.3 step 2, D5).
 *
 * A seat's intents decided at the boundary `now` (state after tick `now`)
 * are delayed by ℓ ~ Categorical(latencyProbs) turns and executed in turn
 * `now + ℓ`, i.e. during the (ℓ+1)-th upcoming tick — `GameSession.step`
 * stamps the intents it is given with turnNumber = game.ticks() = turnTick.
 * One ℓ is drawn per seat per step (only when the seat sent something), so
 * both intents of a step travel together, in order.
 *
 * Within one turn the seats are permuted with the env PRNG (Fisher–Yates over
 * the seats present, sorted by seat index first) while each seat keeps its
 * own order: intent order is game state (attack merges, 1:1 cancellation).
 *
 * Per-seat FIFO (default on): a seat's batch never executes before a batch
 * that seat scheduled earlier — the tick is clamped up to the seat's last
 * scheduled tick, like messages on one WebSocket. It only binds when
 * deltaTicks < 3 (ℓ ≤ 2); the ℓ draw happens regardless, so PRNG
 * consumption does not depend on the clamp. Forced entries (ℓ = 0, no draw)
 * bypass the clamp: they exist to land a spawn before the phase ends.
 */
import { ClientID, Intent } from "../../src/core/Schemas";
import { Rng } from "./Rng";

export interface ScheduledBatch {
  /** Seat index in EpisodeSpec.seats. */
  seat: number;
  clientID: ClientID;
  intents: Intent[];
  /** Decision boundary (game.ticks() when decided). */
  decidedAt: number;
  /** Turn in which the intents execute (the tick they are fed to). */
  tick: number;
  /** tick − decidedAt (after the FIFO clamp). */
  latency: number;
  /** Env-forced (spawn at the deadline), ℓ = 0 without a draw. */
  forced: boolean;
}

export interface TurnSchedulerOptions {
  /** Keep each seat's batches in scheduling order (default true). */
  fifoPerSeat?: boolean;
}

export class TurnScheduler {
  private readonly probs: number[];
  private readonly fifo: boolean;
  private readonly queue = new Map<number, ScheduledBatch[]>();
  private readonly lastTick = new Map<number, number>();
  private pending = 0;

  constructor(
    private readonly rng: Rng,
    latencyProbs: readonly number[],
    opts: TurnSchedulerOptions = {},
  ) {
    if (
      latencyProbs.length === 0 ||
      latencyProbs.some((p) => !(p >= 0)) ||
      !latencyProbs.some((p) => p > 0)
    ) {
      throw new Error(`bad latencyProbs: ${latencyProbs.join(",")}`);
    }
    this.probs = [...latencyProbs];
    this.fifo = opts.fifoPerSeat ?? true;
  }

  /** Draws ℓ (one PRNG draw). */
  sampleLatency(): number {
    return this.rng.categorical(this.probs);
  }

  /**
   * Queues a seat's decoded intents of this step for turn `now + ℓ`.
   * Returns the batch, or null (and draws nothing) when `intents` is empty.
   */
  schedule(
    now: number,
    seat: number,
    clientID: ClientID,
    intents: readonly Intent[],
  ): ScheduledBatch | null {
    if (intents.length === 0) return null;
    const l = this.sampleLatency();
    let tick = now + l;
    if (this.fifo) tick = Math.max(tick, this.lastTick.get(seat) ?? tick);
    return this.push(now, seat, clientID, intents, tick, false);
  }

  /** Queues intents with ℓ = 0 and no PRNG draw (forced spawn). */
  scheduleForced(
    now: number,
    seat: number,
    clientID: ClientID,
    intents: readonly Intent[],
  ): ScheduledBatch | null {
    if (intents.length === 0) return null;
    return this.push(now, seat, clientID, intents, now, true);
  }

  /**
   * Removes every batch due at or before `tick` (earlier ones only if a tick
   * was skipped) and returns them with the seats shuffled; per seat, batches
   * stay in (tick, scheduling) order. One shuffle per call with ≥ 2 seats.
   */
  takeBatches(tick: number): ScheduledBatch[] {
    if (this.pending === 0) return [];
    let due: ScheduledBatch[] | undefined;
    if (this.onlyKey(tick)) {
      due = this.queue.get(tick);
      if (due === undefined) return [];
      this.queue.delete(tick);
    } else {
      const keys = [...this.queue.keys()]
        .filter((k) => k <= tick)
        .sort((a, b) => a - b);
      if (keys.length === 0) return [];
      due = [];
      for (const k of keys) {
        for (const b of this.queue.get(k)!) due.push(b);
        this.queue.delete(k);
      }
    }
    for (const b of due) this.pending -= b.intents.length;

    // Group by seat (stable), canonical seat order, then shuffle the seats.
    const bySeat = new Map<number, ScheduledBatch[]>();
    for (const b of due) {
      const list = bySeat.get(b.seat);
      if (list === undefined) bySeat.set(b.seat, [b]);
      else list.push(b);
    }
    if (bySeat.size === 1) return due;
    const seats = [...bySeat.keys()].sort((a, b) => a - b);
    this.rng.shuffleInPlace(seats);
    const out: ScheduledBatch[] = [];
    for (const s of seats) for (const b of bySeat.get(s)!) out.push(b);
    return out;
  }

  /** `takeBatches` flattened to `GameSession.step` input. */
  take(tick: number): Array<[ClientID, Intent]> {
    const out: Array<[ClientID, Intent]> = [];
    for (const b of this.takeBatches(tick)) {
      for (const intent of b.intents) out.push([b.clientID, intent]);
    }
    return out;
  }

  /** Intents queued and not yet taken. */
  pendingCount(): number {
    return this.pending;
  }

  /** Queued batches of one seat (not removed). */
  pendingFor(seat: number): ScheduledBatch[] {
    const out: ScheduledBatch[] = [];
    const keys = [...this.queue.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      for (const b of this.queue.get(k)!) if (b.seat === seat) out.push(b);
    }
    return out;
  }

  /** Drops everything (episode end / reset). */
  clear(): void {
    this.queue.clear();
    this.lastTick.clear();
    this.pending = 0;
  }

  private onlyKey(tick: number): boolean {
    // True when no queued key is < tick (the common case: nothing stale).
    for (const k of this.queue.keys()) if (k < tick) return false;
    return true;
  }

  private push(
    now: number,
    seat: number,
    clientID: ClientID,
    intents: readonly Intent[],
    tick: number,
    forced: boolean,
  ): ScheduledBatch {
    const batch: ScheduledBatch = {
      seat,
      clientID,
      intents: [...intents],
      decidedAt: now,
      tick,
      latency: tick - now,
      forced,
    };
    const list = this.queue.get(tick);
    if (list === undefined) this.queue.set(tick, [batch]);
    else list.push(batch);
    this.pending += batch.intents.length;
    if (!forced) this.lastTick.set(seat, tick);
    return batch;
  }
}
