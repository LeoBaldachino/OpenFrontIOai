// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeSnapshotBlob,
  SnapshotMeta,
  SnapshotPool,
  SnapshotRefusedError,
} from "../env/SnapshotPool";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofrl-snap-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function meta(simHash = "sim-a", tick = 100): SnapshotMeta {
  return {
    simHash,
    specHash: "spec-1",
    gameStartInfo: { gameID: "SNAPTEST1", players: [] },
    episodeSpec: { uid: 7, seed: 3 },
    tick,
    seatControllers: [{ kind: "python", policyId: 0, learn: true }],
    extra: { rng: [1, 2, 3, 4] },
  };
}

/** Byte equality without vitest's slow element-wise deep equal. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

describe("SnapshotPool", () => {
  it("memory LRU keeps the 16 most recently used", () => {
    const pool = new SnapshotPool({ simHash: "sim-a" });
    for (let i = 0; i < 20; i++) pool.put(`k${i}`, bytes(10, i), meta());
    expect(pool.memoryKeys().length).toBe(16);
    expect(pool.get("k0")).toBeUndefined();
    expect(pool.get("k3")).toBeUndefined();
    expect(same(pool.get("k4")!.bytes, bytes(10, 4))).toBe(true);
    // k4 is now the most recent; adding one evicts k5.
    pool.put("k20", bytes(10, 20), meta());
    expect(pool.has("k5")).toBe(false);
    expect(pool.has("k4")).toBe(true);
    expect(() => pool.load("k0")).toThrow(/not found/);
  });

  it("persists gzip + JSON sidecar and reloads after eviction", () => {
    const dir = path.join(tmpRoot, "disk");
    const pool = new SnapshotPool({
      simHash: "sim-a",
      specHash: "spec-1",
      dir,
      capacity: 2,
    });
    const big = bytes(200_000, 9);
    pool.save("ep7_t100", big, meta());
    const base = path.join(dir, "sim-a", "ep7_t100");
    expect(fs.existsSync(`${base}.snap.gz`)).toBe(true);
    const side = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
    expect(side).toEqual(meta());
    expect(fs.statSync(`${base}.snap.gz`).size).toBeLessThan(big.length);
    pool.put("x1", bytes(5, 1), meta());
    pool.put("x2", bytes(5, 2), meta());
    expect(pool.memoryKeys()).not.toContain("ep7_t100");
    // A fresh pool (another process) reads it back.
    const other = new SnapshotPool({ simHash: "sim-a", dir });
    const e = other.load("ep7_t100");
    expect(same(e.bytes, big)).toBe(true);
    expect(e.meta.tick).toBe(100);
    expect(other.diskKeys()).toEqual(["ep7_t100"]);
    expect(other.specMismatch(e.meta)).toBe(false);
    other.delete("ep7_t100");
    expect(other.has("ep7_t100")).toBe(false);
    expect(fs.existsSync(`${base}.json`)).toBe(false);
  });

  it("refuses another simHash", () => {
    const dir = path.join(tmpRoot, "refuse");
    const pool = new SnapshotPool({ simHash: "sim-a", dir });
    expect(() => pool.put("k", bytes(4, 0), meta("sim-b"))).toThrow(
      SnapshotRefusedError,
    );
    // A tampered sidecar on disk is refused too.
    pool.save("k", bytes(4, 0), meta());
    const side = path.join(dir, "sim-a", "k.json");
    fs.writeFileSync(side, JSON.stringify(meta("sim-b")));
    const fresh = new SnapshotPool({ simHash: "sim-a", dir });
    expect(() => fresh.get("k")).toThrow(SnapshotRefusedError);
    // Another simulation does not even see the entry.
    const b = new SnapshotPool({ simHash: "sim-b", dir });
    expect(b.get("k")).toBeUndefined();
  });

  it("export/import round trip as one blob", () => {
    const a = new SnapshotPool({ simHash: "sim-a" });
    const payload = bytes(5000, 5);
    a.put("scenario1", payload, meta("sim-a", 1234));
    const blob = a.export("scenario1");
    const dec = decodeSnapshotBlob(blob);
    expect(same(dec.bytes, payload)).toBe(true);
    expect(dec.meta.tick).toBe(1234);
    const b = new SnapshotPool({ simHash: "sim-a", specHash: "spec-2" });
    const e = b.import("copy", blob);
    expect(same(e.bytes, payload)).toBe(true);
    expect(b.specMismatch(e.meta)).toBe(true);
    const c = new SnapshotPool({ simHash: "sim-z" });
    expect(() => c.import("copy", blob)).toThrow(SnapshotRefusedError);
    expect(() => decodeSnapshotBlob(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("rejects unsafe keys", () => {
    const pool = new SnapshotPool({ simHash: "sim-a" });
    for (const k of ["", "../x", "a/b", ".hidden", "a b"]) {
      expect(() => pool.put(k, bytes(1, 0), meta())).toThrow(
        /bad snapshot key/,
      );
    }
  });
});
