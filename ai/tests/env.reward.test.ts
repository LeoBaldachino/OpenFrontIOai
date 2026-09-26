// @vitest-environment node
/** T11: potential-based shaping telescopes; FFA placement values. */
import { describe, expect, it } from "vitest";
import { DEFAULT_REWARD, RewardConfig } from "../env/EpisodeSpec";
import {
  auxPenalty,
  CAP_REF_TROOPS,
  duelOutcomes,
  phiCap,
  PhiInputs,
  phiLead,
  placementRanks,
  placementScore,
  placementScores,
  potential,
  SeatRewardState,
  stepGamma,
} from "../env/Reward";
import { Rng } from "../env/Rng";

function randomInputs(rng: Rng): PhiInputs {
  const total = 1000 + rng.int(0, 500_000);
  const tiles = rng.int(0, total);
  return {
    tiles,
    maxOtherTiles: rng.next() < 0.1 ? null : rng.int(0, total - tiles + 1),
    totalLandTiles: total,
    maxTroops: 50_000 + rng.int(0, 20_000_000),
  };
}

describe("Φ components", () => {
  it("share, lead, cap", () => {
    expect(phiCap(CAP_REF_TROOPS)).toBe(0);
    expect(phiCap(CAP_REF_TROOPS * 10)).toBeCloseTo(0.5, 12);
    expect(phiCap(CAP_REF_TROOPS * 100)).toBeCloseTo(1, 12);
    expect(phiCap(CAP_REF_TROOPS * 1e6)).toBe(1.5);
    expect(phiCap(1000)).toBe(0);
    expect(phiLead(100, null, 1000)).toBe(0);
    expect(phiLead(300, 100, 1000)).toBeCloseTo(0.2, 12);
    expect(phiLead(0, 5000, 1000)).toBe(-1);
    const phi = potential(DEFAULT_REWARD, {
      tiles: 250,
      maxOtherTiles: 100,
      totalLandTiles: 1000,
      maxTroops: CAP_REF_TROOPS * 10,
    });
    expect(phi).toBeCloseTo(0.25 + 0.15 + 0.25 * 0.5, 12);
    expect(stepGamma(0.9997, 10)).toBeCloseTo(0.997004, 6);
  });

  it("aux penalty", () => {
    const base = {
      troops: 95,
      maxTroops: 100,
      attackingOrBoating: false,
      maskMisses: 0,
      silentFailures: 0,
    };
    expect(auxPenalty(base)).toBeCloseTo(-0.005, 12);
    expect(auxPenalty({ ...base, troops: 100 })).toBeCloseTo(-0.01, 12);
    expect(auxPenalty({ ...base, troops: 80 })).toBe(0);
    expect(auxPenalty({ ...base, attackingOrBoating: true })).toBe(0);
    expect(
      auxPenalty({ ...base, troops: 0, maskMisses: 2, silentFailures: 1 }),
    ).toBeCloseTo(-0.006, 12);
  });
});

describe("shaping telescopes (T11)", () => {
  const cfg: RewardConfig = {
    ...DEFAULT_REWARD,
    alpha: 1,
    aux: 0,
    gammaTick: 1,
  };

  it("γ = 1, α = 1, aux = 0: Σ shaping = −Φ(s₀) on terminated episodes", () => {
    const rng = new Rng(2024);
    for (let ep = 0; ep < 500; ep++) {
      const st = new SeatRewardState(cfg, 10);
      const s0 = randomInputs(rng);
      const phi0 = st.start(s0);
      expect(phi0).toBe(potential(cfg, s0));
      const len = 1 + rng.int(0, 200);
      const outcome = rng.next() < 0.5 ? 1 : -1;
      let shaping = 0;
      let total = 0;
      for (let t = 1; t <= len; t++) {
        const terminated = t === len;
        const p = st.step(randomInputs(rng), {
          terminated,
          outcome,
          aux: -123, // ignored: aux weight 0
        });
        shaping += p.shaping;
        total += p.reward;
        // Plain checks: expect() in this hot loop costs seconds.
        const ok =
          p.aux === 0 &&
          (terminated
            ? p.phi === 0 && p.terminal === outcome
            : p.terminal === 0);
        if (!ok) throw new Error(`bad parts at ep ${ep} t ${t}`);
      }
      expect(shaping).toBeCloseTo(-phi0, 9);
      expect(total).toBeCloseTo(outcome - phi0, 9);
      expect(st.totals.shaping).toBeCloseTo(-phi0, 9);
      expect(() => st.step(s0, { terminated: false })).toThrow();
    }
  });

  it("γ < 1: Σ γ^t·shaping = γ^T·Φ(s_T) − Φ(s₀) (truncated), −Φ(s₀) (terminated)", () => {
    const rng = new Rng(77);
    const g: RewardConfig = { ...cfg, gammaTick: 0.9997 };
    for (let ep = 0; ep < 200; ep++) {
      const st = new SeatRewardState(g, 10);
      const phi0 = st.start(randomInputs(rng));
      const len = 1 + rng.int(0, 300);
      const terminatedEnd = ep % 2 === 0;
      let disc = 0;
      let gt = 1;
      let lastPhi = 0;
      for (let t = 1; t <= len; t++) {
        const terminated = terminatedEnd && t === len;
        const p = st.step(randomInputs(rng), { terminated, outcome: 0 });
        disc += gt * p.shaping;
        gt *= st.gammaStep;
        lastPhi = p.phi;
      }
      const expected = terminatedEnd ? -phi0 : gt * lastPhi - phi0;
      expect(disc).toBeCloseTo(expected, 9);
    }
  });

  it("α and aux weights scale their terms", () => {
    const c: RewardConfig = { ...DEFAULT_REWARD, alpha: 0.5, aux: 2 };
    const st = new SeatRewardState(c, 10);
    const s: PhiInputs = {
      tiles: 100,
      maxOtherTiles: 50,
      totalLandTiles: 1000,
      maxTroops: 200_000,
    };
    const phi0 = st.start(s);
    const p = st.step(s, {
      terminated: false,
      aux: {
        troops: 200_000,
        maxTroops: 200_000,
        attackingOrBoating: false,
        maskMisses: 1,
        silentFailures: 0,
      },
    });
    expect(p.shaping).toBeCloseTo(0.5 * (st.gammaStep * phi0 - phi0), 12);
    expect(p.aux).toBeCloseTo(2 * (-0.01 - 0.002), 12);
    expect(p.reward).toBeCloseTo(p.shaping + p.aux, 12);
  });
});

describe("outcomes", () => {
  it("duel", () => {
    expect(duelOutcomes(10, 20, 0)).toEqual([1, -1]);
    expect(duelOutcomes(10, 20, 1)).toEqual([-1, 1]);
    expect(duelOutcomes(30, 20, "other")).toEqual([1, -1]);
    expect(duelOutcomes(10, 20, "other")).toEqual([-1, 1]);
    expect(duelOutcomes(20, 20, "other")).toEqual([0, 0]);
    expect(duelOutcomes(10, 20, "none")).toEqual([0, 0]);
  });

  it("FFA placement values", () => {
    expect([1, 2, 3, 4].map((r) => placementScore(r, 4))).toEqual([
      1,
      1 / 3,
      -1 / 3,
      -1,
    ]);
    expect(placementScore(1, 1)).toBe(1);
    expect(placementScore(2, 2)).toBe(-1);
    // Alive by tiles, then dead by deathPosition (unknown last).
    const entries = [
      { alive: false, tiles: 0, deathPosition: 4 },
      { alive: true, tiles: 500, deathPosition: null },
      { alive: false, tiles: 0, deathPosition: null },
      { alive: true, tiles: 900, deathPosition: null },
      { alive: false, tiles: 0, deathPosition: 3 },
    ];
    expect(placementRanks(entries)).toEqual([4, 2, 5, 1, 3]);
    expect(placementScores(entries)).toEqual([-0.5, 0.5, -1, 1, 0]);
    // Ties share the better rank.
    expect(
      placementRanks([
        { alive: true, tiles: 10, deathPosition: null },
        { alive: true, tiles: 10, deathPosition: null },
        { alive: true, tiles: 5, deathPosition: null },
      ]),
    ).toEqual([1, 1, 3]);
  });
});
