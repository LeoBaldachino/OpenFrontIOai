/**
 * Interfaces shared by the observation encoder (ai/obs), the action layer
 * (ai/act) and the environment (ai/env). See FINAL_DESIGN §5.
 */
import { Game, Player } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { Preset } from "../spec/spec";
import { RecordView } from "./RecordView";

/** Map rectangle in (untransposed) map coordinates, half-open [x0,x1)×[y0,y1). */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Isotropic canvas over the map (§5.1). If H > W the map is transposed so the
 * canvas is landscape; cell side s = max(ceil(W'/GW), ceil(H'/GH)); the used
 * gw×gh grid sits at the top-left of the GH×GW canvas.
 */
export interface ICanvas {
  readonly preset: Preset;
  /** Map width/height (untransposed). */
  readonly W: number;
  readonly H: number;
  readonly s: number;
  readonly gw: number;
  readonly gh: number;
  readonly transposed: boolean;
  /** tileRef → canvas cell index (r·GW + c). */
  readonly cellOf: Uint16Array;
  /** Cell inside the used grid. */
  isValidCell(cell: number): boolean;
  cellRect(cell: number): CellRect;
  /** A tile near the cell centre (clamped to the map). */
  cellCenter(cell: number): TileRef;
  /** Map (x, y) → fractional canvas (col, row). */
  toCanvasXY(x: number, y: number): [number, number];
}

/** Static per-map data, built once per (map, size, preset) per process (§5.2). */
export interface MapCache {
  key: string;
  canvas: ICanvas;
  /** Per cell: passable land tiles / in-map tiles. */
  land: Uint16Array;
  tiles: Uint16Array;
  /** Channels 0..5 of §5.3, [6, GH, GW] u8. */
  staticPlanes: Uint8Array;
  /** Land tiles with a water 4-neighbour. */
  shoreTiles: Uint32Array;
  /** Water component of that neighbour (-1 if none). */
  shoreComp: Int32Array;
  /** Canvas cell of each shore tile. */
  shoreCell: Uint16Array;
  /** Canvas cell → water components present in it (sampled). */
  cellWaterComps: Map<number, Int32Array>;
  /** Mean land magnitude per cell. */
  cellMag: Uint8Array;
  /** game.map().waterVersion() the cache was built at. */
  waterVersion: number;
}

export interface MapCacheStoreLike {
  get(game: Game, mapKey: string, size: string, preset: Preset): MapCache;
}

/** Player classes relative to one seat. */
export const CLASS_ME = 0;
export const CLASS_FRIENDLY = 1;
export const CLASS_HOSTILE = 2;
export const CLASS_BOT = 3;
export const CLASS_NONE = 4;

export interface BorderScanResult {
  /** smallID → number of my border tiles 4-adjacent to that player's land. */
  neighbors: Map<number, number>;
  /** Some border tile touches unowned passable land. */
  touchesTN: boolean;
  /** Water components adjacent to my shore tiles. */
  myWaterComps: Set<number>;
  borderTiles: number;
  shoreTiles: number;
}

/** Sticky player slots of one seat, frozen with the observation (§5.6). */
export interface SlotTable {
  /** Length K+1; [0] = null (TN). */
  players: (Player | null)[];
  /** smallID → slot index, -1 if not slotted. */
  slotOfSmallID: Int16Array;
}

/** Per-cell tile counts by class for one seat (non-fallout land only for TN). */
export interface ClassCounts {
  me: Uint16Array;
  friendly: Uint16Array;
  hostile: Uint16Array;
  bot: Uint16Array;
  tn: Uint16Array;
}

/** Values the encoder cannot know by itself; supplied by the env each step. */
export interface SeatObsExtras {
  deltaTicks: number;
  tokensSecond: number;
  tokensMinute: number;
  lastSilentFailures: number;
  lastMaskMisses: number;
  /** [type, ptr, cell, amount] × 2 of the previous step, -1 = inactive. */
  prevAction: Int16Array;
}

export interface TileChangeSink {
  /** Pairs [tileRef, state | terrain << 16] drained after one tick. */
  onTileChanges(packed: Uint32Array): void;
}

export interface IObsEncoder extends TileChangeSink {
  /** Full rebuild from the game state; seats[i] is the Player of seat i. */
  attach(game: Game, seats: Player[]): void;
  /** Per-step aggregation (heat decay, class grids, border scans, slots, units). */
  beginStep(): void;
  /** Writes planes, slot_own, scalars, slots and prev_action of seat i. */
  writeObs(seatIdx: number, rec: RecordView, extras: SeatObsExtras): void;
  slotTable(seatIdx: number): SlotTable;
  border(seatIdx: number): BorderScanResult;
  /** smallID → CLASS_* relative to seat i. */
  classOf(seatIdx: number): Uint8Array;
  classCounts(seatIdx: number): ClassCounts;
  /** Per cell hostile pressure (§5.3 channel 16, unquantised). */
  hostilePressure(seatIdx: number): Float32Array;
  /** Per cell BFS distance (in cells) to my contested frontier; 0xFFFF = unreachable. */
  frontDist(seatIdx: number): Uint16Array;
  mapCache(): MapCache;
}
