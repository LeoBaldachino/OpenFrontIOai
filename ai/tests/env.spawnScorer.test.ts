// @vitest-environment node
/**
 * SpawnScorer on real maps (production Config): candidates are valid spawn
 * discs, ordering is deterministic, and spawns sampled from it and sent as
 * `spawn` intents through GameSession give each seat its 52-tile disc.
 */
import { describe, expect, it } from "vitest";
import { getSpawnTiles } from "../../src/core/execution/Util";
import { GameMapSize } from "../../src/core/game/Game";
import { GameSession } from "../env/GameSession";
import { NodeMapLoader, parseMap } from "../env/NodeMapLoader";
import { Rng } from "../env/Rng";
import { SPAWN_DISC_TILES, SpawnScorer } from "../env/SpawnScorer";

const loader = new NodeMapLoader();
const SEATS = [
  { clientID: "AGSEAT00", username: "Seat00" },
  { clientID: "AGSEAT01", username: "Seat01" },
];

async function session(map: string, bots = 0): Promise<GameSession> {
  return GameSession.create(
    {
      gameID: "SPAWNTST1",
      map: parseMap(map),
      mapSize: GameMapSize.Compact,
      seats: SEATS,
      bots,
      nations: "disabled",
    },
    loader,
  );
}

describe("SpawnScorer", () => {
  for (const [map, bots] of [
    ["Onion", 0],
    ["Australia", 40],
  ] as const) {
    it(`${map} Compact: valid, sorted, deterministic candidates`, async () => {
      const s = await session(map, bots);
      if (bots > 0) s.step([], 1); // tribes spawn on the first tick
      const scorer = new SpawnScorer(s.game);
      const t0 = performance.now();
      const ranked = scorer.rank();
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(500);
      expect(ranked.length).toBeGreaterThanOrEqual(20);
      for (let i = 0; i < ranked.length; i++) {
        const c = ranked[i];
        const disc = getSpawnTiles(s.game.map(), c.tile, true);
        expect(disc).not.toBeNull();
        expect(disc!.length).toBe(SPAWN_DISC_TILES);
        if (i > 0) expect(c.score).toBeLessThanOrEqual(ranked[i - 1].score);
      }
      // Pure and deterministic.
      expect(new SpawnScorer(s.game).rank()).toEqual(ranked);
      expect(scorer.best()).toBe(ranked[0].tile);
      // Uncrowded plains-rich spots win on an empty map.
      expect(ranked[0].f.crowded).toBe(false);
      const rng = new Rng(1);
      const top3 = new Set(ranked.slice(0, 3).map((c) => c.tile));
      for (let i = 0; i < 20; i++)
        expect(top3.has(scorer.sample(rng)!)).toBe(true);
    });
  }

  it("sampled spawns sent as intents give each seat its 52-tile disc", async () => {
    for (const map of ["Onion", "Australia"]) {
      for (const seed of [1, 2]) {
        const s = await session(map);
        const scorer = new SpawnScorer(s.game);
        const rng = new Rng(seed);
        const p0 = s.seatPlayer("AGSEAT00");
        const p1 = s.seatPlayer("AGSEAT01");
        const a = scorer.sample(rng, { opponents: [p1] })!;
        const b = scorer.sample(rng, { opponents: [p0], reserved: [a] })!;
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        // The reserved disc is respected (discs cannot overlap).
        const dx = s.game.x(a) - s.game.x(b);
        const dy = s.game.y(a) - s.game.y(b);
        expect(dx * dx + dy * dy).toBeGreaterThan(81);
        s.step([
          ["AGSEAT00", { type: "spawn", tile: a }],
          ["AGSEAT01", { type: "spawn", tile: b }],
        ]);
        const phase = s.game.config().numSpawnPhaseTurns();
        while (s.inSpawnPhase() && s.ticks() < phase + 5) s.step([], 1);
        expect(s.inSpawnPhase()).toBe(false);
        expect(p0.numTilesOwned()).toBe(SPAWN_DISC_TILES);
        expect(p1.numTilesOwned()).toBe(SPAWN_DISC_TILES);
        expect(p0.spawnTile()).toBe(a);
        expect(p1.spawnTile()).toBe(b);
      }
    }
  });

  it("best() after another seat spawned avoids it and scores distance", async () => {
    const s = await session("Onion");
    const scorer = new SpawnScorer(s.game);
    const p0 = s.seatPlayer("AGSEAT00");
    const p1 = s.seatPlayer("AGSEAT01");
    const a = scorer.best()!;
    s.step([["AGSEAT00", { type: "spawn", tile: a }]], 3);
    expect(p0.numTilesOwned()).toBe(SPAWN_DISC_TILES);
    const ranked = scorer.rank({ opponents: [p0] });
    const b = ranked[0];
    expect(b.tile).not.toBe(a);
    expect(b.f.crowded).toBe(false);
    expect(b.f.dOpp).toBeGreaterThan(20);
    // Late spawn by the second seat (forced-spawn style) still gets 52.
    s.step([["AGSEAT01", { type: "spawn", tile: b.tile }]], 3);
    expect(p1.numTilesOwned()).toBe(SPAWN_DISC_TILES);
  });
});
