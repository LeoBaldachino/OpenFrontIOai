import { Game, Player, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";

/**
 * Cheap re-implementations of engine validity checks, for action masks.
 *
 * Invalid intents are silent no-ops in the simulation, so the agent needs
 * masks; but some engine predicates are far too slow to evaluate for every
 * candidate every decision (Player.canAttack on unowned land runs an eager
 * radius-200 BFS, ~10-25 ms; canBuild(TransportShip) runs water A*, ~10 ms).
 * These helpers answer the same questions from one scan of the border.
 */

const NB: TileRef[] = [0, 0, 0, 0];

export interface BorderInfo {
  /** smallIDs of players sharing a 4-neighbour land border with us. */
  neighbors: Set<number>;
  /** True when some border tile touches unowned passable land. */
  touchesTerraNullius: boolean;
  /** Water components adjacent to our shore tiles. */
  waterComponents: Set<number>;
  /** Our shore (land next to water) tile count, a proxy for naval reach. */
  shoreTiles: number;
}

export function borderInfo(game: Game, player: Player): BorderInfo {
  const map = game.map();
  const me = player.smallID();
  const neighbors = new Set<number>();
  const waterComponents = new Set<number>();
  let touchesTerraNullius = false;
  let shoreTiles = 0;
  for (const t of player.borderTiles()) {
    const n = map.neighbors4(t, NB);
    let shore = false;
    for (let i = 0; i < n; i++) {
      const nb = NB[i];
      if (map.isLand(nb)) {
        const owner = map.ownerID(nb);
        if (owner === 0) {
          if (!map.isImpassable(nb)) touchesTerraNullius = true;
        } else if (owner !== me) {
          neighbors.add(owner);
        }
      } else {
        shore = true;
        const c = game.getWaterComponent(nb);
        if (c !== null) waterComponents.add(c);
      }
    }
    if (shore) shoreTiles++;
  }
  return { neighbors, touchesTerraNullius, waterComponents, shoreTiles };
}

/** Water components adjacent to a player's shore (scan of its border). */
export function playerWaterComponents(game: Game, player: Player): Set<number> {
  const map = game.map();
  const out = new Set<number>();
  for (const t of player.borderTiles()) {
    const n = map.neighbors4(t, NB);
    for (let i = 0; i < n; i++) {
      if (!map.isLand(NB[i])) {
        const c = game.getWaterComponent(NB[i]);
        if (c !== null) out.add(c);
      }
    }
  }
  return out;
}

export function intersects(a: Set<number>, b: Set<number>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) return true;
  return false;
}

/** Silo tubes ready to fire right now (same rule as PlayerView). */
export function readyNukeTubes(player: Player): number {
  let ready = 0;
  for (const silo of player.units(UnitType.MissileSilo)) {
    if (silo.isUnderConstruction()) continue;
    ready += Math.max(0, silo.level() - silo.missileTimerQueue().length);
  }
  return ready;
}

export function boatsInFlight(player: Player): number {
  return player.unitCount(UnitType.TransportShip);
}

export function maxBoats(game: Game): number {
  return game.config().boatMaxNumber();
}
