/**
 * Public surface of one environment instance (FINAL_DESIGN §4.2), used by the
 * bridge worker. OpenFrontEnv implements it; tests use lightweight fakes.
 */
import { EpisodeSpec } from "./EpisodeSpec";

export interface RecordSink {
  /** Returns a zeroed Uint8Array of exactly layout.recordSize bytes to fill. */
  alloc(): Uint8Array;
}

export interface SeatSummary {
  seat: number;
  clientID: string;
  controller: string;
  /** Duel: +1 win / -1 loss / 0 draw; FFA: placement score. */
  outcome: number;
  placement: number;
  won: boolean;
  tiles: number;
  share: number;
  alive: boolean;
  forcedSpawn: boolean;
  intentsSent: number;
  rateLimited: number;
  maskMisses: number;
  silentFailures: number;
  byType: Record<string, { sent: number; missed: number; silent: number }>;
  labels?: {
    emitted: number;
    dropped: number;
    unslotted: number;
    invalid: number;
    fidelity: Record<string, number>;
  };
}

export interface EpisodeSummary {
  env: number;
  uid: number;
  gameID: string;
  map: string;
  size: string;
  ticks: number;
  winner: { kind: "seat" | "other"; seat?: number; name?: string } | null;
  truncated: boolean;
  error?: string;
  seats: SeatSummary[];
  perf: {
    steps: number;
    simMs: number;
    obsMs: number;
    maskMs: number;
    decodeMs: number;
    maxTickMs: number;
  };
  recordPath?: string;
}

export interface IEnv {
  /** Builds (or restores) the game and runs the heuristic spawn phase if any. */
  reset(ep: EpisodeSpec): Promise<void>;
  /**
   * Writes the records produced since the last call (FIRST, regular,
   * terminal and demo records) into sink-allocated buffers; returns count.
   */
  writeRecords(sink: RecordSink): number;
  /**
   * actions: seat index → Int16Array(8) = [type, ptr, cell, amount] × 2
   * (-1 inactive). Missing entries for NEEDS_ACTION seats are NOOP.
   * Advances deltaTicks ticks.
   */
  step(actions: ReadonlyMap<number, Int16Array>): void;
  /** No learning/recording seat remains active, or the game ended/truncated. */
  isDone(): boolean;
  /** Episode summary (valid once isDone()). */
  summary(): EpisodeSummary;
  snapshot(): Uint8Array;
}
