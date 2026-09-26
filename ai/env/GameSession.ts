import { Executor } from "../../src/core/execution/ExecutionManager";
import { NationExecution } from "../../src/core/execution/NationExecution";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  Team,
} from "../../src/core/game/Game";
import {
  createGameRunner,
  createGameRunnerFromSnapshot,
  GameRunner,
} from "../../src/core/GameRunner";
import {
  ClientID,
  GameConfig,
  GameStartInfo,
  Intent,
  StampedIntent,
} from "../../src/core/Schemas";
import { NodeMapLoader } from "./NodeMapLoader";

/** A human-typed player slot controlled from outside the simulation. */
export interface SeatSpec {
  clientID: ClientID;
  username: string;
  /**
   * Drive this seat with the built-in nation AI (a NationExecution attached
   * to the Human player) instead of external intents. Used to record
   * demonstrations and as a scripted opponent that plays under human rules.
   */
  scripted?: boolean;
}

export interface SessionOptions {
  gameID: string;
  map: GameMapType;
  mapSize?: GameMapSize;
  mode?: GameMode;
  difficulty?: Difficulty;
  /** "default" = manifest nations, "disabled" = none, number = exact count. */
  nations?: "default" | "disabled" | number;
  bots?: number;
  seats: SeatSpec[];
  /** Game timer in minutes; the largest player wins when it runs out. */
  maxTimerMinutes?: number | null;
  spawnImmunityTicks?: number | null;
  /** Extra GameConfig fields (teams, disabled units, modifiers...). */
  configOverrides?: Partial<GameConfig>;
}

const GAME_ID_RE = /^[A-Za-z0-9]{8,10}$/;

export function buildStartInfo(opts: SessionOptions): GameStartInfo {
  if (!GAME_ID_RE.test(opts.gameID)) {
    throw new Error(`gameID must match ${GAME_ID_RE}: ${opts.gameID}`);
  }
  const config: GameConfig = {
    gameMap: opts.map,
    gameMapSize: opts.mapSize ?? GameMapSize.Normal,
    gameMode: opts.mode ?? GameMode.FFA,
    // Private: no public-lobby modifiers, spawn phase driven by the timer.
    gameType: GameType.Private,
    difficulty: opts.difficulty ?? Difficulty.Medium,
    nations: opts.nations ?? "disabled",
    bots: opts.bots ?? 0,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    maxTimerValue: opts.maxTimerMinutes ?? null,
    spawnImmunityDuration: opts.spawnImmunityTicks ?? null,
    ...opts.configOverrides,
  } as GameConfig;
  return {
    gameID: opts.gameID,
    lobbyCreatedAt: 0,
    config,
    players: opts.seats.map((s) => ({
      clientID: s.clientID,
      username: s.username,
      clanTag: null,
    })),
  };
}

/** Packed tile change: [tileRef, state | terrain << 16] pairs. */
export type PackedTileChanges = Uint32Array;

/**
 * One headless game on the production rules (real Config, real maps).
 *
 * Mirrors GameRunner.executeNextTick minus client-only work (name placement,
 * update packing for the renderer): intents are stamped with a seat's
 * clientID and fed through the same Executor the live client uses, so
 * whatever an agent learns here transfers 1:1 to a live game.
 */
export class GameSession {
  readonly game: Game;
  private executor: Executor;
  private turn: number;
  private tileChanges: number[] = [];
  private seatPlayers = new Map<ClientID, Player>();

  private constructor(
    readonly start: GameStartInfo,
    readonly runner: GameRunner,
    readonly seats: SeatSpec[],
  ) {
    this.game = runner.game;
    this.executor = new Executor(
      this.game,
      start.gameID,
      undefined,
      start.tribes?.map((t) => t.name),
    );
    // After a restore the first turn is the snapshot's tick.
    this.turn = this.game.ticks();
  }

  static async create(
    opts: SessionOptions,
    loader: NodeMapLoader,
  ): Promise<GameSession> {
    const start = buildStartInfo(opts);
    const runner = await createGameRunner(start, undefined, loader, (gu) => {
      if ("errMsg" in gu) throw new Error(gu.errMsg);
    });
    const session = new GameSession(start, runner, opts.seats);
    for (const seat of opts.seats) {
      if (seat.scripted) session.attachNationAI(seat.clientID);
    }
    return session;
  }

  static async fromSnapshot(
    start: GameStartInfo,
    seats: SeatSpec[],
    snapshot: Uint8Array,
    loader: NodeMapLoader,
  ): Promise<GameSession> {
    const runner = await createGameRunnerFromSnapshot(
      start,
      snapshot,
      undefined,
      loader,
      (gu) => {
        if ("errMsg" in gu) throw new Error(gu.errMsg);
      },
    );
    // Scripted seats' NationExecutions are part of the snapshot.
    return new GameSession(start, runner, seats);
  }

  /** Lets the built-in nation AI play this seat (demos / scripted rivals). */
  attachNationAI(clientID: ClientID): void {
    const player = this.seatPlayer(clientID);
    this.game.addExecution(
      new NationExecution(
        this.start.gameID,
        new Nation(undefined, player.info()),
      ),
    );
  }

  seatPlayer(clientID: ClientID): Player {
    let p = this.seatPlayers.get(clientID);
    if (p === undefined) {
      const found = this.game.playerByClientID(clientID);
      if (found === null) throw new Error(`no player for seat ${clientID}`);
      p = found;
      this.seatPlayers.set(clientID, p);
    }
    return p;
  }

  ticks(): number {
    return this.game.ticks();
  }

  /**
   * Applies `intents` (keyed by seat clientID) on the next tick, then runs
   * `ticks` ticks in total. Intents run in the given order within the tick.
   */
  step(intents: Array<[ClientID, Intent]>, ticks: number = 1): void {
    for (let i = 0; i < ticks; i++) {
      const stamped: StampedIntent[] =
        i === 0
          ? intents.map(
              ([clientID, intent]) =>
                ({ ...intent, clientID }) as StampedIntent,
            )
          : [];
      this.game.addExecution(
        ...this.executor.createExecs({
          turnNumber: this.turn++,
          intents: stamped,
        }),
      );
      this.game.executeNextTick();
      const packed = this.game.drainPackedTileUpdates();
      for (let j = 0; j < packed.length; j++) this.tileChanges.push(packed[j]);
      // Drain the renderer feeds or they grow without bound.
      this.game.drainPackedMotionPlans();
      this.game.drainPackedPlayerUpdates();
      this.game.drainPackedAttackUpdates();
      this.game.drainNukeImpacts();
      if (this.isOver()) break;
    }
  }

  /** Tile changes accumulated since the previous call. */
  drainTileChanges(): PackedTileChanges {
    const out = Uint32Array.from(this.tileChanges);
    this.tileChanges.length = 0;
    return out;
  }

  inSpawnPhase(): boolean {
    return this.game.inSpawnPhase();
  }

  isOver(): boolean {
    return this.game.getWinner() !== null;
  }

  winner(): Player | Team | null {
    return this.game.getWinner();
  }

  /** True when the seat won (as a player, or as a member of the winning team). */
  seatWon(clientID: ClientID): boolean {
    const w = this.game.getWinner();
    if (w === null) return false;
    const p = this.seatPlayer(clientID);
    if (typeof w === "string") return p.team() === w;
    return w.id() === p.id();
  }

  snapshot(): Uint8Array {
    return this.runner.snapshot();
  }
}
