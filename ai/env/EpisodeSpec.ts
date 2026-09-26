import { Difficulty, GameMapSize, GameMode } from "../../src/core/game/Game";
import { GameConfig } from "../../src/core/Schemas";
import { SessionOptions } from "./GameSession";
import { parseMap } from "./NodeMapLoader";

/** Who plays a seat (FINAL_DESIGN §4.1). */
export type Controller =
  /** Actions come from Python (learner or frozen opponent). */
  | { kind: "python"; policyId: number; learn: boolean }
  /**
   * NationExecution attached to this Human seat. direct: acts via
   * addExecution as in the engine. projected: NationTap intercepts every
   * action, maps it to our action space and replays it through the decoder.
   * record (projected only): emit LABEL_VALID records for BC.
   */
  | { kind: "nationbot"; mode: "direct" | "projected"; record: boolean }
  /** Scripted baseline acting through our action space. */
  | { kind: "expandbot" }
  /** Heuristic spawn, then nothing. */
  | { kind: "idle" };

export interface EpisodeSeat {
  clientID: string;
  username: string;
  controller: Controller;
}

export interface RewardConfig {
  /** Potential-shaping weight (stage-annealed). */
  alpha: number;
  wShare: number;
  wLead: number;
  wCap: number;
  /** Weight of the non-potential aux terms. */
  aux: number;
  /** Per-tick discount; γ_step = gammaTick^deltaTicks must equal PPO γ. */
  gammaTick: number;
  terminal: "duel" | "ffa" | "team";
}

export interface EpisodeSpec {
  uid: number;
  gameID: string;
  seed: number;
  map: string;
  size: "Normal" | "Compact";
  mode: "FFA" | "Team";
  playerTeams?: number;
  rankedType?: "1v1" | "2v2";
  bots: number;
  nations: "default" | "disabled" | number;
  difficulty: "Easy" | "Medium" | "Hard" | "Impossible";
  timerMinutes: number | null;
  immunityTicks: number | null;
  donate: boolean;
  seats: EpisodeSeat[];
  spawn: "learned" | "heuristic";
  snapshotKey?: string;
  maxTicks: number;
  deltaTicks: number;
  /** P(latency = 0, 1, 2 ticks). */
  latencyProbs: [number, number, number];
  /** Allowed ActionType ids (curriculum). */
  actionGates: number[];
  reward: RewardConfig;
  record: boolean;
  configOverrides?: Record<string, unknown>;
}

export const DEFAULT_REWARD: RewardConfig = {
  alpha: 1.0,
  wShare: 1.0,
  wLead: 1.0,
  wCap: 0.25,
  aux: 0,
  gammaTick: 0.9997,
  terminal: "duel",
};

/** Seat i's fixed clientID / username (valid ID and UsernameSchema). */
export function seatClientID(i: number): string {
  return `AGSEAT${String(i).padStart(2, "0")}`;
}
export function seatUsername(i: number): string {
  return `Seat${String(i).padStart(2, "0")}`;
}

const GAME_ID_RE = /^[A-Za-z0-9]{8,10}$/;

function fail(msg: string): never {
  throw new Error(`invalid EpisodeSpec: ${msg}`);
}

function num(
  o: Record<string, unknown>,
  k: string,
  min = -Infinity,
  max = Infinity,
): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v))
    fail(`${k} must be a finite number`);
  if (v < min || v > max) fail(`${k}=${v} out of [${min}, ${max}]`);
  return v;
}

function oneOf<T extends string>(
  o: Record<string, unknown>,
  k: string,
  values: readonly T[],
): T {
  const v = o[k];
  if (typeof v !== "string" || !values.includes(v as T)) {
    fail(`${k} must be one of ${values.join("|")}, got ${String(v)}`);
  }
  return v as T;
}

function validateController(c: unknown, where: string): Controller {
  if (c === null || typeof c !== "object")
    fail(`${where}.controller must be an object`);
  const o = c as Record<string, unknown>;
  switch (o.kind) {
    case "python":
      return {
        kind: "python",
        policyId: num(o, "policyId", 0, 0xffffffff),
        learn: o.learn === true,
      };
    case "nationbot": {
      const mode = oneOf(o, "mode", ["direct", "projected"] as const);
      if (o.record === true && mode !== "projected") {
        fail(`${where}: record requires mode "projected"`);
      }
      return { kind: "nationbot", mode, record: o.record === true };
    }
    case "expandbot":
      return { kind: "expandbot" };
    case "idle":
      return { kind: "idle" };
    default:
      return fail(`${where}.controller.kind unknown: ${String(o.kind)}`);
  }
}

/** Parses and validates an EpisodeSpec (e.g. the JSON of a RESET message). */
export function validateEpisodeSpec(x: unknown): EpisodeSpec {
  if (x === null || typeof x !== "object") fail("not an object");
  const o = x as Record<string, unknown>;
  const gameID = o.gameID;
  if (typeof gameID !== "string" || !GAME_ID_RE.test(gameID)) {
    fail(`gameID must match ${GAME_ID_RE}`);
  }
  if (typeof o.map !== "string") fail("map must be a string");
  parseMap(o.map);
  const seatsRaw = o.seats;
  if (!Array.isArray(seatsRaw) || seatsRaw.length < 1 || seatsRaw.length > 16) {
    fail("seats must be an array of 1..16 seats");
  }
  const seats: EpisodeSeat[] = seatsRaw.map((s, i) => {
    if (s === null || typeof s !== "object")
      fail(`seats[${i}] must be an object`);
    const so = s as Record<string, unknown>;
    const clientID = so.clientID ?? seatClientID(i);
    const username = so.username ?? seatUsername(i);
    if (typeof clientID !== "string" || !GAME_ID_RE.test(clientID)) {
      fail(`seats[${i}].clientID invalid`);
    }
    if (
      typeof username !== "string" ||
      username.length < 3 ||
      username.length > 27
    ) {
      fail(`seats[${i}].username invalid`);
    }
    return {
      clientID,
      username,
      controller: validateController(so.controller, `seats[${i}]`),
    };
  });
  const ids = new Set(seats.map((s) => s.clientID));
  if (ids.size !== seats.length) fail("duplicate seat clientIDs");
  const rankedType =
    o.rankedType === undefined || o.rankedType === null
      ? undefined
      : oneOf(o, "rankedType", ["1v1", "2v2"] as const);
  if (rankedType === "1v1" && seats.length !== 2) {
    fail("rankedType 1v1 requires exactly 2 seats (1 seat wins instantly)");
  }
  const nationsRaw = o.nations;
  let nations: EpisodeSpec["nations"];
  if (nationsRaw === "default" || nationsRaw === "disabled")
    nations = nationsRaw;
  else if (
    typeof nationsRaw === "number" &&
    Number.isInteger(nationsRaw) &&
    nationsRaw >= 1 &&
    nationsRaw <= 400
  ) {
    nations = nationsRaw;
  } else fail(`nations must be "default" | "disabled" | 1..400`);
  const lp = o.latencyProbs;
  if (
    !Array.isArray(lp) ||
    lp.length !== 3 ||
    lp.some((p) => typeof p !== "number" || p < 0)
  ) {
    fail("latencyProbs must be 3 non-negative numbers");
  }
  const lpSum = (lp as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(lpSum - 1) > 1e-6)
    fail(`latencyProbs must sum to 1, got ${lpSum}`);
  const gates = o.actionGates;
  if (
    !Array.isArray(gates) ||
    gates.some((g) => !Number.isInteger(g) || g < 0 || g > 30)
  ) {
    fail("actionGates must be an array of ActionType ids (0..30)");
  }
  const r = (o.reward ?? {}) as Record<string, unknown>;
  const reward: RewardConfig = {
    alpha: typeof r.alpha === "number" ? r.alpha : DEFAULT_REWARD.alpha,
    wShare: typeof r.wShare === "number" ? r.wShare : DEFAULT_REWARD.wShare,
    wLead: typeof r.wLead === "number" ? r.wLead : DEFAULT_REWARD.wLead,
    wCap: typeof r.wCap === "number" ? r.wCap : DEFAULT_REWARD.wCap,
    aux: typeof r.aux === "number" ? r.aux : DEFAULT_REWARD.aux,
    gammaTick:
      typeof r.gammaTick === "number" ? r.gammaTick : DEFAULT_REWARD.gammaTick,
    terminal:
      r.terminal === "ffa" || r.terminal === "team" || r.terminal === "duel"
        ? r.terminal
        : seats.length === 2
          ? "duel"
          : "ffa",
  };
  const timer = o.timerMinutes;
  if (
    timer !== null &&
    timer !== undefined &&
    (typeof timer !== "number" || timer < 1 || timer > 120)
  ) {
    fail("timerMinutes must be null or 1..120");
  }
  const immunity = o.immunityTicks;
  if (
    immunity !== null &&
    immunity !== undefined &&
    (typeof immunity !== "number" || immunity < 0)
  ) {
    fail("immunityTicks must be null or ≥ 0");
  }
  const cfg = o.configOverrides;
  if (cfg !== undefined && (cfg === null || typeof cfg !== "object")) {
    fail("configOverrides must be an object");
  }
  return {
    uid: num(o, "uid", 0, 0xffffffff),
    gameID,
    seed: num(o, "seed", 0, 0xffffffff),
    map: o.map,
    size: oneOf(o, "size", ["Normal", "Compact"] as const),
    mode: oneOf(o, "mode", ["FFA", "Team"] as const),
    playerTeams: typeof o.playerTeams === "number" ? o.playerTeams : undefined,
    rankedType,
    bots: num(o, "bots", 0, 400),
    nations,
    difficulty: oneOf(o, "difficulty", [
      "Easy",
      "Medium",
      "Hard",
      "Impossible",
    ] as const),
    timerMinutes: (timer as number | null | undefined) ?? null,
    immunityTicks: (immunity as number | null | undefined) ?? null,
    donate: o.donate === true,
    seats,
    spawn: oneOf(o, "spawn", ["learned", "heuristic"] as const),
    snapshotKey: typeof o.snapshotKey === "string" ? o.snapshotKey : undefined,
    maxTicks: num(o, "maxTicks", 1),
    deltaTicks: num(o, "deltaTicks", 1, 100),
    latencyProbs: lp as [number, number, number],
    actionGates: gates as number[],
    reward,
    record: o.record === true,
    configOverrides: cfg as Record<string, unknown> | undefined,
  };
}

/** Maps an EpisodeSpec to GameSession options (nation AIs are attached by the env). */
export function toSessionOptions(ep: EpisodeSpec): SessionOptions {
  const overrides: Partial<GameConfig> = {
    donateGold: ep.donate,
    donateTroops: ep.donate,
    ...(ep.rankedType !== undefined ? { rankedType: ep.rankedType } : {}),
    ...(ep.mode === "Team" && ep.playerTeams !== undefined
      ? { playerTeams: ep.playerTeams }
      : {}),
    ...(ep.configOverrides as Partial<GameConfig> | undefined),
  } as Partial<GameConfig>;
  return {
    gameID: ep.gameID,
    map: parseMap(ep.map),
    mapSize: ep.size === "Compact" ? GameMapSize.Compact : GameMapSize.Normal,
    mode: ep.mode === "Team" ? GameMode.Team : GameMode.FFA,
    difficulty: ep.difficulty as Difficulty,
    nations: ep.nations,
    bots: ep.bots,
    seats: ep.seats.map((s) => ({
      clientID: s.clientID,
      username: s.username,
    })),
    maxTimerMinutes: ep.timerMinutes,
    spawnImmunityTicks: ep.immunityTicks,
    configOverrides: overrides,
  };
}
