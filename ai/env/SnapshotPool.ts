/**
 * Snapshot store (FINAL_DESIGN §4.8): in-memory LRU plus optional disk.
 *
 * Generic on purpose: it stores opaque engine snapshot bytes
 * (`GameSession.snapshot()`) with a JSON sidecar and hands both back; the env
 * restores them (`GameSession.fromSnapshot`, NationTap re-attach, encoder
 * rebuild, fresh rate limiters, FROM_SNAPSHOT on the first record).
 *
 * Disk layout: `<dir>/<simHash>/<key>.snap.gz` (zlib gzip level 1) next to
 * `<dir>/<simHash>/<key>.json` (the sidecar, `SnapshotMeta`). An entry whose
 * sidecar carries another simHash is refused (the bytes only restore on the
 * exact simulation they came from); a specHash mismatch is allowed (the
 * snapshot holds engine state only) and reported by `specMismatch`.
 *
 * `export(key)` / `import(key, blob)` move one entry as a single
 * self-contained blob: gzip("OFSNAP01" | u32 metaLen | meta JSON | bytes).
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

export interface SnapshotMeta {
  /** Simulation fingerprint the bytes were produced with (must match). */
  simHash: string;
  /** Contract fingerprint (informational). */
  specHash: string;
  /** GameStartInfo the game was created from (JSON). */
  gameStartInfo: unknown;
  /** EpisodeSpec of the episode (JSON). */
  episodeSpec: unknown;
  /** game.ticks() at the snapshot. */
  tick: number;
  /** Controller of each seat, in seat order (JSON). */
  seatControllers: unknown[];
  /** Env extras (PRNG state, pending turns, labels…), JSON. */
  extra?: Record<string, unknown>;
}

export interface SnapshotEntry {
  key: string;
  bytes: Uint8Array;
  meta: SnapshotMeta;
}

export interface SnapshotPoolOptions {
  /** simHash of the running simulation; entries with another are refused. */
  simHash: string;
  /** specHash of the running contract (only compared, never enforced). */
  specHash?: string;
  /** Root for disk persistence (e.g. runs/<run>/snapshots); none = memory only. */
  dir?: string | null;
  /** In-memory LRU capacity (default 16). */
  capacity?: number;
  /** gzip level for disk files and exports (default 1). */
  gzipLevel?: number;
}

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const BLOB_MAGIC = "OFSNAP01";

export class SnapshotRefusedError extends Error {}

export class SnapshotPool {
  readonly simHash: string;
  readonly specHash: string | null;
  readonly dir: string | null;
  readonly capacity: number;
  private readonly level: number;
  /** Insertion order = recency (oldest first). */
  private readonly lru = new Map<string, SnapshotEntry>();

  constructor(opts: SnapshotPoolOptions) {
    if (!opts.simHash) throw new Error("SnapshotPool: simHash required");
    this.simHash = opts.simHash;
    this.specHash = opts.specHash ?? null;
    this.dir = opts.dir ?? null;
    this.capacity = Math.max(1, opts.capacity ?? 16);
    this.level = opts.gzipLevel ?? 1;
  }

  /** Stores in memory only (evicts the least recently used beyond capacity). */
  put(key: string, bytes: Uint8Array, meta: SnapshotMeta): SnapshotEntry {
    checkKey(key);
    this.checkMeta(meta, `put(${key})`);
    const entry: SnapshotEntry = { key, bytes, meta };
    this.lru.delete(key);
    this.lru.set(key, entry);
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value as string;
      this.lru.delete(oldest);
    }
    return entry;
  }

  /** Stores in memory and, when a dir is configured, on disk. */
  save(key: string, bytes: Uint8Array, meta: SnapshotMeta): SnapshotEntry {
    const entry = this.put(key, bytes, meta);
    if (this.dir !== null) {
      const base = this.basePath(key);
      fs.mkdirSync(path.dirname(base), { recursive: true });
      writeAtomic(
        `${base}.snap.gz`,
        zlib.gzipSync(bytes, { level: this.level }),
      );
      writeAtomic(`${base}.json`, Buffer.from(JSON.stringify(meta), "utf8"));
    }
    return entry;
  }

  /** Memory first (refreshing recency), then disk; undefined if absent. */
  get(key: string): SnapshotEntry | undefined {
    checkKey(key);
    const hit = this.lru.get(key);
    if (hit !== undefined) {
      this.lru.delete(key);
      this.lru.set(key, hit);
      return hit;
    }
    if (this.dir === null) return undefined;
    const base = this.basePath(key);
    if (!fs.existsSync(`${base}.json`) || !fs.existsSync(`${base}.snap.gz`)) {
      return undefined;
    }
    const meta = JSON.parse(
      fs.readFileSync(`${base}.json`, "utf8"),
    ) as SnapshotMeta;
    this.checkMeta(meta, `${base}.json`);
    const bytes = new Uint8Array(
      zlib.gunzipSync(fs.readFileSync(`${base}.snap.gz`)),
    );
    return this.put(key, bytes, meta);
  }

  /** Like get() but throws when the key is unknown. */
  load(key: string): SnapshotEntry {
    const e = this.get(key);
    if (e === undefined) throw new Error(`snapshot not found: ${key}`);
    return e;
  }

  has(key: string): boolean {
    checkKey(key);
    if (this.lru.has(key)) return true;
    return this.dir !== null && fs.existsSync(`${this.basePath(key)}.json`);
  }

  /** Removes from memory and disk. */
  delete(key: string): void {
    checkKey(key);
    this.lru.delete(key);
    if (this.dir !== null) {
      const base = this.basePath(key);
      fs.rmSync(`${base}.snap.gz`, { force: true });
      fs.rmSync(`${base}.json`, { force: true });
    }
  }

  /** Keys held in memory, least recently used first. */
  memoryKeys(): string[] {
    return [...this.lru.keys()];
  }

  /** Keys on disk for this simHash (sorted). */
  diskKeys(): string[] {
    if (this.dir === null) return [];
    const d = path.join(this.dir, this.simHash);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  /** True when the entry was produced under another contract. */
  specMismatch(meta: SnapshotMeta): boolean {
    return this.specHash !== null && meta.specHash !== this.specHash;
  }

  /** One self-contained blob for an entry (throws if absent). */
  export(key: string): Uint8Array {
    const e = this.load(key);
    return encodeSnapshotBlob(e.bytes, e.meta, this.level);
  }

  /** Stores a blob made by export() (memory + disk if configured). */
  import(key: string, blob: Uint8Array): SnapshotEntry {
    const { bytes, meta } = decodeSnapshotBlob(blob);
    return this.save(key, bytes, meta);
  }

  private basePath(key: string): string {
    return path.join(this.dir!, this.simHash, key);
  }

  private checkMeta(meta: SnapshotMeta, where: string): void {
    if (meta === null || typeof meta !== "object") {
      throw new SnapshotRefusedError(`${where}: missing snapshot meta`);
    }
    if (meta.simHash !== this.simHash) {
      throw new SnapshotRefusedError(
        `${where}: simHash ${String(meta.simHash)} ≠ running ${this.simHash}`,
      );
    }
  }
}

function checkKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`bad snapshot key: ${key}`);
}

function writeAtomic(file: string, data: Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function encodeSnapshotBlob(
  bytes: Uint8Array,
  meta: SnapshotMeta,
  level = 1,
): Uint8Array {
  const magic = Buffer.from(BLOB_MAGIC, "ascii");
  const json = Buffer.from(JSON.stringify(meta), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  const raw = Buffer.concat([magic, len, json, bytes]);
  return new Uint8Array(zlib.gzipSync(raw, { level }));
}

export function decodeSnapshotBlob(blob: Uint8Array): {
  bytes: Uint8Array;
  meta: SnapshotMeta;
} {
  const raw = zlib.gunzipSync(blob);
  if (
    raw.length < BLOB_MAGIC.length + 4 ||
    raw.subarray(0, BLOB_MAGIC.length).toString("ascii") !== BLOB_MAGIC
  ) {
    throw new Error("not a snapshot blob");
  }
  const len = raw.readUInt32LE(BLOB_MAGIC.length);
  const start = BLOB_MAGIC.length + 4;
  if (start + len > raw.length) throw new Error("truncated snapshot blob");
  const meta = JSON.parse(
    raw.subarray(start, start + len).toString("utf8"),
  ) as SnapshotMeta;
  const bytes = new Uint8Array(raw.subarray(start + len));
  return { bytes, meta };
}
