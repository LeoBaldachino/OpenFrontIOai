/**
 * Heuristic spawn site selection (FINAL_DESIGN §4.4): AUTO spawn, the forced
 * spawn at the deadline, `spawn: "heuristic"` episodes and the C0 stage.
 *
 * Candidates: the map is cut into a coarse grid of square cells (by default
 * the S-preset canvas cell side, `max(ceil(max(W,H)/32), ceil(min(W,H)/24))`,
 * computed here so this file does not depend on ai/obs). The 20 best cells by
 * `tn · (1 − mountainShare)` (tn = unowned non-fallout passable land / s²,
 * mountainShare = mountain land / passable land) each contribute up to 4
 * tiles: the centres of the cell's 2×2 quarters, or — when a centre's spawn
 * disc is not free — the nearest tile of that quarter (stride 2) whose disc
 * is. A candidate is valid iff `getSpawnTiles(map, t, true)` returns the full
 * 52-tile disc (all in the map, land, passable, unowned). More cells are
 * visited while fewer than 3 valid candidates were found.
 *
 * score(t) = P60 + 0.5·H60 + 0.2·Mt60 + 0.2·coast30 + 0.3·min(dOpp, 300)/300
 *            − 1.0·[any player tile within 20]
 *
 * P60/H60/Mt60: fractions of the stride-4 lattice points within Euclidean 60
 * of t (all lattice points of the disc, off-map ones count as nothing) that
 * are unowned non-fallout plains (mag < 10) / highland (10–19) / mountain
 * (≥ 20, not impassable) land. coast30: an ocean-shore tile within 30.
 * dOpp: Euclidean distance to the nearest tile of another human seat (or of a
 * reserved spawn disc), 300 if none.
 *
 * `reserved` spawn centres (chosen for other seats but not executed yet, e.g.
 * all heuristic spawns are scheduled at tick 0) count as occupied discs:
 * candidates whose disc would overlap one are dropped, and they count for the
 * within-20 penalty and for dOpp.
 *
 * best() = argmax (ties: lower tile ref); sample(rng) = uniform among the
 * top 3 (one env-PRNG draw). All game access is read-only (§4.9).
 */
import { getSpawnTiles } from "../../src/core/execution/Util";
import { Game, Player } from "../../src/core/game/Game";
import { GameMap, TileRef } from "../../src/core/game/GameMap";
import { Rng } from "./Rng";

/** Tiles of a full spawn disc (radius 4 around a pixel corner). */
export const SPAWN_DISC_TILES = 52;

export interface SpawnFeatures {
  plains: number;
  highland: number;
  mountain: number;
  coast: boolean;
  dOpp: number;
  crowded: boolean;
}

export interface SpawnCandidate {
  tile: TileRef;
  score: number;
  f: SpawnFeatures;
}

export interface SpawnScorerOptions {
  /** Coarse grid cell side in tiles (default: S-canvas cell side). */
  cellSize?: number;
  /** Best cells to take candidates from (default 20). */
  topCells?: number;
  /** Minimum valid candidates before stopping the cell walk (default 3). */
  minCandidates?: number;
  /** sample() picks uniformly among this many best (default 3). */
  sampleTop?: number;
}

export interface SpawnContext {
  /** Other human seats (their territory sets dOpp). */
  opponents?: readonly Player[];
  /** Spawn centres chosen for other seats but not yet executed. */
  reserved?: readonly TileRef[];
}

const LATTICE_STRIDE = 4;
const LATTICE_RADIUS = 60;
const COAST_RADIUS = 30;
const CROWD_RADIUS = 20;
const DOPP_CAP = 300;
/** Reserved disc "radius" used for overlap / penalty / distance. */
const DISC_R = 4;

/** Disc offsets of getSpawnTiles (euclDistFN(tile, 4, center = true)). */
function spawnDiscOffsets(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const fx = dx + 0.5;
      const fy = dy + 0.5;
      if (fx * fx + fy * fy <= 16) out.push([dx, dy]);
    }
  }
  return out;
}

function latticeOffsets(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const r2 = LATTICE_RADIUS * LATTICE_RADIUS;
  const k = Math.floor(LATTICE_RADIUS / LATTICE_STRIDE);
  for (let j = -k; j <= k; j++) {
    for (let i = -k; i <= k; i++) {
      const dx = i * LATTICE_STRIDE;
      const dy = j * LATTICE_STRIDE;
      if (dx * dx + dy * dy <= r2) out.push([dx, dy]);
    }
  }
  return out;
}

const DISC = spawnDiscOffsets();
const LATTICE = latticeOffsets();

export class SpawnScorer {
  readonly map: GameMap;
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly gw: number;
  readonly gh: number;
  private readonly topCells: number;
  private readonly minCandidates: number;
  private readonly sampleTop: number;
  /** Static per cell: passable land, mountain land, ocean-shore tiles. */
  private readonly landCnt: Int32Array;
  private readonly mountCnt: Int32Array;
  private readonly shoreCnt: Int32Array;
  /** Static per tile: land next to ocean. */
  private readonly oceanShore: Uint8Array;

  constructor(
    readonly game: Game,
    opts: SpawnScorerOptions = {},
  ) {
    const map = game.map();
    this.map = map;
    const W = map.width();
    const H = map.height();
    this.width = W;
    this.height = H;
    this.cellSize =
      opts.cellSize ??
      Math.max(Math.ceil(Math.max(W, H) / 32), Math.ceil(Math.min(W, H) / 24));
    const s = this.cellSize;
    this.gw = Math.ceil(W / s);
    this.gh = Math.ceil(H / s);
    this.topCells = opts.topCells ?? 20;
    this.minCandidates = opts.minCandidates ?? 3;
    this.sampleTop = opts.sampleTop ?? 3;

    const n = this.gw * this.gh;
    this.landCnt = new Int32Array(n);
    this.mountCnt = new Int32Array(n);
    this.shoreCnt = new Int32Array(n);
    this.oceanShore = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / s) * this.gw;
      for (let x = 0; x < W; x++) {
        const t = map.ref(x, y);
        if (!map.isLand(t) || map.isImpassable(t)) continue;
        const c = row + Math.floor(x / s);
        this.landCnt[c]++;
        if (map.magnitude(t) >= 20) this.mountCnt[c]++;
        if (map.isOceanShore(t)) {
          this.oceanShore[t] = 1;
          this.shoreCnt[c]++;
        }
      }
    }
  }

  /** True when a spawn on `t` would get the full 52-tile disc. */
  isValidSpawn(t: TileRef): boolean {
    if (!this.discFree(t)) return false;
    const tiles = getSpawnTiles(this.map, t, true);
    return tiles !== null && tiles.length === SPAWN_DISC_TILES;
  }

  /** Valid candidates, best first. */
  rank(ctx: SpawnContext = {}): SpawnCandidate[] {
    const map = this.map;
    const s = this.cellSize;
    const reserved = ctx.reserved ?? [];

    // Dynamic per cell: unowned (non-fallout) passable land, owned tiles.
    const n = this.gw * this.gh;
    const tnCnt = new Int32Array(n);
    const ownedCnt = new Int32Array(n);
    if (map.numTilesWithFallout() === 0) {
      // Owned tiles are few during the spawn phase: walk the players.
      tnCnt.set(this.landCnt);
      for (const p of this.game.allPlayers()) {
        for (const t of p.tiles()) {
          const c = this.cellOf(t);
          ownedCnt[c]++;
          if (map.isLand(t) && !map.isImpassable(t)) tnCnt[c]--;
        }
      }
    } else {
      for (let y = 0; y < this.height; y++) {
        const row = Math.floor(y / s) * this.gw;
        for (let x = 0; x < this.width; x++) {
          const t = map.ref(x, y);
          if (map.hasOwner(t)) {
            ownedCnt[row + Math.floor(x / s)]++;
          } else if (
            map.isLand(t) &&
            !map.isImpassable(t) &&
            !map.hasFallout(t)
          ) {
            tnCnt[row + Math.floor(x / s)]++;
          }
        }
      }
    }
    const cellScore = new Float64Array(n);
    const cells: number[] = [];
    for (let c = 0; c < n; c++) {
      if (tnCnt[c] === 0) continue;
      const mShare = this.mountCnt[c] / Math.max(1, this.landCnt[c]);
      cellScore[c] = (tnCnt[c] / (s * s)) * (1 - mShare);
      if (cellScore[c] > 0) cells.push(c);
    }
    cells.sort((a, b) => cellScore[b] - cellScore[a] || a - b);

    const opp = this.opponentTiles(ctx.opponents ?? []);
    const out: SpawnCandidate[] = [];
    for (let k = 0; k < cells.length; k++) {
      if (k >= this.topCells && out.length >= this.minCandidates) break;
      const c = cells[k];
      const cx0 = (c % this.gw) * s;
      const cy0 = Math.floor(c / this.gw) * s;
      const half = Math.max(1, Math.floor(s / 2));
      for (let q = 0; q < 4; q++) {
        const qx0 = cx0 + (q & 1) * half;
        const qy0 = cy0 + (q >> 1) * half;
        const qx1 = Math.min(this.width, q & 1 ? cx0 + s : cx0 + half);
        const qy1 = Math.min(this.height, q >> 1 ? cy0 + s : cy0 + half);
        if (qx0 >= qx1 || qy0 >= qy1) continue;
        const t = this.findInQuarter(qx0, qy0, qx1, qy1, reserved);
        if (t === null) continue;
        out.push(this.score(t, opp, reserved, ownedCnt));
      }
    }
    out.sort((a, b) => b.score - a.score || a.tile - b.tile);
    return out;
  }

  /** Best valid spawn tile, or null when none exists. */
  best(ctx: SpawnContext = {}): TileRef | null {
    const r = this.rank(ctx);
    return r.length > 0 ? r[0].tile : null;
  }

  /** Uniform among the top `sampleTop` (one draw), or null (no draw). */
  sample(rng: Rng, ctx: SpawnContext = {}): TileRef | null {
    const r = this.rank(ctx);
    if (r.length === 0) return null;
    const k = Math.min(this.sampleTop, r.length);
    return r[rng.int(0, k)].tile;
  }

  // -------------------------------------------------------------------------

  private cellOf(t: TileRef): number {
    const s = this.cellSize;
    return (
      Math.floor(this.map.y(t) / s) * this.gw + Math.floor(this.map.x(t) / s)
    );
  }

  /**
   * Quarter centre if valid, else the nearest (then lowest y, x) stride-2
   * tile of the quarter that is valid.
   */
  private findInQuarter(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    reserved: readonly TileRef[],
  ): TileRef | null {
    const map = this.map;
    const mx = Math.floor((x0 + x1) / 2);
    const my = Math.floor((y0 + y1) / 2);
    const pts: Array<[number, number, number]> = [];
    for (let y = y0 + ((my - y0) & 1); y < y1; y += 2) {
      for (let x = x0 + ((mx - x0) & 1); x < x1; x += 2) {
        pts.push([(x - mx) * (x - mx) + (y - my) * (y - my), y, x]);
      }
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [, y, x] of pts) {
      const t = map.ref(x, y);
      if (
        !this.nearReserved(x, y, reserved, 2 * DISC_R + 1) &&
        this.isValidSpawn(t)
      ) {
        return t;
      }
    }
    return null;
  }

  /** Fast disc check (same disc as getSpawnTiles, all tiles in the map). */
  private discFree(t: TileRef): boolean {
    const map = this.map;
    const x = map.x(t);
    const y = map.y(t);
    // The disc spans x−4..x+3 × y−4..y+3 and must lie inside the map.
    if (x < 4 || y < 4 || x + 3 >= this.width || y + 3 >= this.height)
      return false;
    for (const [dx, dy] of DISC) {
      const u = map.ref(x + dx, y + dy);
      if (!map.isLand(u) || map.isImpassable(u) || map.hasOwner(u))
        return false;
    }
    return true;
  }

  private nearReserved(
    x: number,
    y: number,
    reserved: readonly TileRef[],
    r: number,
  ): boolean {
    const r2 = r * r;
    for (const c of reserved) {
      const dx = this.map.x(c) - x;
      const dy = this.map.y(c) - y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /** Border tiles of the opponents (the nearest territory tile is one). */
  private opponentTiles(opponents: readonly Player[]): TileRef[] {
    const out: TileRef[] = [];
    for (const p of opponents) {
      if (!p.isAlive()) continue;
      for (const t of p.borderTiles()) out.push(t);
    }
    return out;
  }

  private score(
    t: TileRef,
    oppTiles: readonly TileRef[],
    reserved: readonly TileRef[],
    ownedCnt: Int32Array,
  ): SpawnCandidate {
    const map = this.map;
    const x = map.x(t);
    const y = map.y(t);

    // Lattice fractions within 60.
    let plains = 0;
    let highland = 0;
    let mountain = 0;
    for (const [dx, dy] of LATTICE) {
      const lx = x + dx;
      const ly = y + dy;
      if (lx < 0 || ly < 0 || lx >= this.width || ly >= this.height) continue;
      const u = map.ref(lx, ly);
      if (!map.isLand(u) || map.isImpassable(u)) continue;
      if (map.hasOwner(u) || map.hasFallout(u)) continue;
      const mag = map.magnitude(u);
      if (mag < 10) plains++;
      else if (mag < 20) highland++;
      else mountain++;
    }
    const nl = LATTICE.length;
    const f: SpawnFeatures = {
      plains: plains / nl,
      highland: highland / nl,
      mountain: mountain / nl,
      coast: this.anyInRadius(
        x,
        y,
        COAST_RADIUS,
        (u) => this.oceanShore[u] === 1,
        this.shoreCnt,
      ),
      dOpp: this.oppDistance(x, y, oppTiles, reserved),
      crowded:
        this.nearReserved(x, y, reserved, CROWD_RADIUS + DISC_R) ||
        this.anyInRadius(x, y, CROWD_RADIUS, (u) => map.hasOwner(u), ownedCnt),
    };
    const score =
      f.plains +
      0.5 * f.highland +
      0.2 * f.mountain +
      0.2 * (f.coast ? 1 : 0) +
      (0.3 * Math.min(f.dOpp, DOPP_CAP)) / DOPP_CAP -
      (f.crowded ? 1 : 0);
    return { tile: t, score, f };
  }

  private oppDistance(
    x: number,
    y: number,
    oppTiles: readonly TileRef[],
    reserved: readonly TileRef[],
  ): number {
    let best2 = Infinity;
    for (const u of oppTiles) {
      const dx = this.map.x(u) - x;
      const dy = this.map.y(u) - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best2) best2 = d2;
    }
    let best = Math.sqrt(best2);
    for (const c of reserved) {
      const dx = this.map.x(c) - x;
      const dy = this.map.y(c) - y;
      best = Math.min(best, Math.max(0, Math.sqrt(dx * dx + dy * dy) - DISC_R));
    }
    return Number.isFinite(best) ? best : DOPP_CAP;
  }

  /**
   * Any tile within Euclidean `r` of (x, y) matching `pred`; coarse cells
   * whose `cellCnt` is 0 hold no match and are skipped.
   */
  private anyInRadius(
    x: number,
    y: number,
    r: number,
    pred: (u: TileRef) => boolean,
    cellCnt: Int32Array,
  ): boolean {
    const s = this.cellSize;
    const x0 = Math.max(0, x - r);
    const x1 = Math.min(this.width - 1, x + r);
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(this.height - 1, y + r);
    const r2 = r * r;
    for (let cy = Math.floor(y0 / s); cy <= Math.floor(y1 / s); cy++) {
      for (let cx = Math.floor(x0 / s); cx <= Math.floor(x1 / s); cx++) {
        if (cellCnt[cy * this.gw + cx] === 0) continue;
        const ya = Math.max(y0, cy * s);
        const yb = Math.min(y1, cy * s + s - 1);
        const xa = Math.max(x0, cx * s);
        const xb = Math.min(x1, cx * s + s - 1);
        for (let yy = ya; yy <= yb; yy++) {
          const dy = yy - y;
          for (let xx = xa; xx <= xb; xx++) {
            const dx = xx - x;
            if (dx * dx + dy * dy > r2) continue;
            if (pred(this.map.ref(xx, yy))) return true;
          }
        }
      }
    }
    return false;
  }
}
