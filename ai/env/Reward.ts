/**
 * Reward (FINAL_DESIGN §4.6) and terminal outcomes (§4.5).
 *
 * Per seat, written in the record that ends the transition s → s′:
 *
 *   reward          = reward_terminal + α·(γ_step·Φ(s′) − Φ(s)) + aux·A
 *   reward_terminal = outcome if s′ is TERMINATED else 0
 *   Φ(s)  = wShare·share + wLead·lead + wCap·cap ;  Φ(s′) := 0 if TERMINATED
 *   share = tiles_me / max(1, totalLandTiles)
 *   lead  = clip((tiles_me − max_{alive non-bot j ≠ me} tiles_j) / max(1, totalLand), −1, 1)
 *           (0 when there is no such j)
 *   cap   = clip(ln(M / 121411) / ln(100), 0, 1.5)
 *   A     = −0.01·clip((T/M − 0.9)/0.1, 0, 1)·[no own outgoing attack and no own transport]
 *           −0.002·(mask_misses + silent_failures)          (last step)
 *   γ_step = gammaTick^Δ
 *
 * Everything below takes plain numbers; `phiInputsFor` / `auxInputsFor`
 * gather them from a live Game with read-only calls (query-neutral, §4.9).
 * Φ is potential-based: with aux = 0 the optimal policy is unchanged, and
 * with γ = 1 the shaping of a terminated episode sums to −Φ(s₀) (test T11).
 */
import { Game, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { RewardConfig } from "./EpisodeSpec";

/** maxTroops of a human with 52 tiles (the spawn size) and no cities. */
export const CAP_REF_TROOPS = 121_411;
const LN_100 = Math.log(100);

function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Plain inputs of Φ for one seat. */
export interface PhiInputs {
  /** My tiles (non-fallout land I own). */
  tiles: number;
  /** Max tiles over alive non-bot players other than me; null if none. */
  maxOtherTiles: number | null;
  /** game.totalLandTiles() (non-fallout land = the win metric). */
  totalLandTiles: number;
  /** config.maxTroops(me) (M). */
  maxTroops: number;
}

export function phiShare(tiles: number, totalLandTiles: number): number {
  return tiles / Math.max(1, totalLandTiles);
}

export function phiLead(
  tiles: number,
  maxOtherTiles: number | null,
  totalLandTiles: number,
): number {
  if (maxOtherTiles === null) return 0;
  return clip((tiles - maxOtherTiles) / Math.max(1, totalLandTiles), -1, 1);
}

export function phiCap(maxTroops: number): number {
  if (!(maxTroops > 0)) return 0;
  return clip(Math.log(maxTroops / CAP_REF_TROOPS) / LN_100, 0, 1.5);
}

/** Φ(s) for one seat. */
export function potential(
  cfg: Pick<RewardConfig, "wShare" | "wLead" | "wCap">,
  x: PhiInputs,
): number {
  return (
    cfg.wShare * phiShare(x.tiles, x.totalLandTiles) +
    cfg.wLead * phiLead(x.tiles, x.maxOtherTiles, x.totalLandTiles) +
    cfg.wCap * phiCap(x.maxTroops)
  );
}

/** γ_step = gammaTick^deltaTicks. */
export function stepGamma(gammaTick: number, deltaTicks: number): number {
  return Math.pow(gammaTick, deltaTicks);
}

/** Plain inputs of the aux term A for one seat and step. */
export interface AuxInputs {
  /** My troop pool (T). */
  troops: number;
  /** config.maxTroops(me) (M). */
  maxTroops: number;
  /** I have an outgoing attack or a transport ship in flight. */
  attackingOrBoating: boolean;
  /** Last step's decoder drops (lazy validation / ledger). */
  maskMisses: number;
  /** Last step's sent-but-ignored intents. */
  silentFailures: number;
}

/** A (≤ 0): idle-at-cap penalty plus wasted-action penalty. */
export function auxPenalty(x: AuxInputs): number {
  let a = 0;
  if (!x.attackingOrBoating && x.maxTroops > 0) {
    a -= 0.01 * clip((x.troops / x.maxTroops - 0.9) / 0.1, 0, 1);
  }
  a -= 0.002 * (x.maskMisses + x.silentFailures);
  return a;
}

export interface RewardParts {
  /** Total reward of the transition. */
  reward: number;
  /** reward_terminal (outcome when terminated, else 0). */
  terminal: number;
  /** α·(γ_step·Φ(s′) − Φ(s)). */
  shaping: number;
  /** aux·A. */
  aux: number;
  /** Φ(s′) as used (0 when terminated) — the next step's Φ(s). */
  phi: number;
  /** Φ(s′) before the terminal zeroing (logging). */
  phiRaw: number;
}

/** One transition's reward from plain numbers. */
export function stepReward(args: {
  phiPrev: number;
  phiNextRaw: number;
  terminated: boolean;
  outcome: number;
  gammaStep: number;
  alpha: number;
  auxWeight: number;
  auxValue: number;
}): RewardParts {
  const phi = args.terminated ? 0 : args.phiNextRaw;
  const terminal = args.terminated ? args.outcome : 0;
  const shaping = args.alpha * (args.gammaStep * phi - args.phiPrev);
  const aux = args.auxWeight === 0 ? 0 : args.auxWeight * args.auxValue;
  return {
    reward: terminal + shaping + aux,
    terminal,
    shaping,
    aux,
    phi,
    phiRaw: args.phiNextRaw,
  };
}

/**
 * Tracks Φ(s) of one seat between its records.
 *
 *   const r = new SeatRewardState(ep.reward, ep.deltaTicks);
 *   header.phi = r.start(phiInputsFor(game, me));             // FIRST record
 *   const p = r.step(phiInputsFor(game, me), { terminated, outcome, aux });
 *   header.reward = p.reward; header.reward_terminal = p.terminal; header.phi = p.phi;
 */
export class SeatRewardState {
  readonly gammaStep: number;
  /** Φ(s) of the last record (0 after a terminal record). */
  phi = 0;
  started = false;
  done = false;
  /** Running sums for logging. */
  readonly totals = { reward: 0, terminal: 0, shaping: 0, aux: 0, steps: 0 };

  constructor(
    readonly cfg: RewardConfig,
    deltaTicks: number,
  ) {
    this.gammaStep = stepGamma(cfg.gammaTick, deltaTicks);
  }

  /** Sets Φ(s₀) at the seat's first record; returns it. */
  start(x: PhiInputs): number {
    this.phi = potential(this.cfg, x);
    this.started = true;
    this.done = false;
    return this.phi;
  }

  /**
   * Reward of the transition ending at this record. `aux` is either A itself
   * or its inputs; it is scaled by cfg.aux. `outcome` counts only when
   * `terminated` (TERMINATED, not TRUNCATED).
   */
  step(
    x: PhiInputs,
    o: { terminated: boolean; outcome?: number; aux?: number | AuxInputs },
  ): RewardParts {
    if (!this.started) throw new Error("SeatRewardState.step before start");
    if (this.done) throw new Error("SeatRewardState.step after terminal");
    const auxValue =
      o.aux === undefined || this.cfg.aux === 0
        ? 0
        : typeof o.aux === "number"
          ? o.aux
          : auxPenalty(o.aux);
    const parts = stepReward({
      phiPrev: this.phi,
      phiNextRaw: potential(this.cfg, x),
      terminated: o.terminated,
      outcome: o.outcome ?? 0,
      gammaStep: this.gammaStep,
      alpha: this.cfg.alpha,
      auxWeight: this.cfg.aux,
      auxValue,
    });
    this.phi = parts.phi;
    this.done = o.terminated;
    const t = this.totals;
    t.reward += parts.reward;
    t.terminal += parts.terminal;
    t.shaping += parts.shaping;
    t.aux += parts.aux;
    t.steps++;
    return parts;
  }
}

// ---------------------------------------------------------------------------
// Gathering inputs from the game (read-only calls only)
// ---------------------------------------------------------------------------

/** Φ inputs of `me` (others = alive players that are not tribes). */
export function phiInputsFor(game: Game, me: Player): PhiInputs {
  let maxOther: number | null = null;
  for (const p of game.players()) {
    if (p === me || p.type() === PlayerType.Bot) continue;
    const t = p.numTilesOwned();
    if (maxOther === null || t > maxOther) maxOther = t;
  }
  return {
    tiles: me.numTilesOwned(),
    maxOtherTiles: maxOther,
    totalLandTiles: game.totalLandTiles(),
    maxTroops: game.config().maxTroops(me),
  };
}

/** A's inputs for `me`; the env passes last step's decoder counters. */
export function auxInputsFor(
  game: Game,
  me: Player,
  maskMisses: number,
  silentFailures: number,
): AuxInputs {
  return {
    troops: me.troops(),
    maxTroops: game.config().maxTroops(me),
    attackingOrBoating:
      me.outgoingAttacks().length > 0 ||
      me.unitCount(UnitType.TransportShip) > 0,
    maskMisses,
    silentFailures,
  };
}

// ---------------------------------------------------------------------------
// Outcomes (§4.5)
// ---------------------------------------------------------------------------

/**
 * Duel outcomes [seat A, seat B]. `winner`: 0 or 1 = that seat won; "other"
 * = a non-seat won (the seat with more tiles gets +1, equal tiles = draw);
 * "none" = draw.
 */
export function duelOutcomes(
  tilesA: number,
  tilesB: number,
  winner: 0 | 1 | "other" | "none",
): [number, number] {
  if (winner === 0) return [1, -1];
  if (winner === 1) return [-1, 1];
  if (winner === "none" || tilesA === tilesB) return [0, 0];
  return tilesA > tilesB ? [1, -1] : [-1, 1];
}

/** FFA placement score 1 − 2·(rank − 1)/(N − 1) (rank 1 = best). */
export function placementScore(rank: number, n: number): number {
  if (n <= 1) return 1;
  // = 1 − 2·(rank − 1)/(N − 1), written so integer inputs round once.
  return (n + 1 - 2 * rank) / (n - 1);
}

/** One of the N non-bot players counted at spawn end. */
export interface PlacementEntry {
  alive: boolean;
  tiles: number;
  /** Finishing place stamped by the engine at death (stats), null if unknown. */
  deathPosition: number | null;
}

/**
 * Ranks (1 = best) of the given non-bot players: alive players first, by
 * tiles (desc); then dead ones by deathPosition (asc, unknown last). Ties
 * share the better rank (competition ranking "1224").
 */
export function placementRanks(entries: readonly PlacementEntry[]): number[] {
  const order = entries.map((_, i) => i);
  const key = (e: PlacementEntry): [number, number] =>
    e.alive ? [0, -e.tiles] : [1, e.deathPosition ?? Infinity];
  const cmp = (a: number, b: number): number => {
    const ka = key(entries[a]);
    const kb = key(entries[b]);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
    return 0;
  };
  order.sort((a, b) => cmp(a, b) || a - b);
  const ranks = new Array<number>(entries.length);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    ranks[i] =
      k > 0 && cmp(order[k - 1], i) === 0 ? ranks[order[k - 1]] : k + 1;
  }
  return ranks;
}

/** Placement scores of the given non-bot players (same order). */
export function placementScores(entries: readonly PlacementEntry[]): number[] {
  const n = entries.length;
  return placementRanks(entries).map((r) => placementScore(r, n));
}
