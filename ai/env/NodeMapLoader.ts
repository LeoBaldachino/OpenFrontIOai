import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GameMapType } from "../../src/core/game/Game";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import { MapManifest } from "../../src/core/game/TerrainMapLoader";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Enum key (e.g. "Australia") for a GameMapType value. */
export function mapKey(map: GameMapType): string {
  const key = Object.keys(GameMapType).find(
    (k) => GameMapType[k as keyof typeof GameMapType] === map,
  );
  if (key === undefined) throw new Error(`unknown map: ${map}`);
  return key;
}

/** Parses a map name case-insensitively from either its enum key or value. */
export function parseMap(name: string): GameMapType {
  const lower = name.toLowerCase().replace(/[\s_-]/g, "");
  for (const [k, v] of Object.entries(GameMapType)) {
    if (
      k.toLowerCase() === lower ||
      String(v)
        .toLowerCase()
        .replace(/[\s_-]/g, "") === lower
    ) {
      return v as GameMapType;
    }
  }
  throw new Error(`unknown map: ${name}`);
}

/**
 * Loads production maps from resources/maps/ on the filesystem (same layout
 * the CDN serves). File reads are cached per process: training workers reset
 * the same few maps thousands of times.
 */
export class NodeMapLoader implements GameMapLoader {
  private cache = new Map<string, Uint8Array>();
  private manifests = new Map<string, MapManifest>();

  constructor(
    private mapsDir: string = path.join(REPO_ROOT, "resources", "maps"),
  ) {}

  private read(file: string): Uint8Array {
    let data = this.cache.get(file);
    if (data === undefined) {
      data = new Uint8Array(fs.readFileSync(file));
      this.cache.set(file, data);
    }
    // loadTerrainMap may keep the buffer; hand out a copy so cached bytes
    // stay pristine.
    return data.slice();
  }

  manifest(map: GameMapType): MapManifest {
    const dir = path.join(this.mapsDir, mapKey(map).toLowerCase());
    let m = this.manifests.get(dir);
    if (m === undefined) {
      m = JSON.parse(
        fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
      ) as MapManifest;
      this.manifests.set(dir, m);
    }
    return m;
  }

  getMapData(map: GameMapType): MapData {
    const dir = path.join(this.mapsDir, mapKey(map).toLowerCase());
    const readBin = (name: string) => async () =>
      this.read(path.join(dir, name));
    return {
      mapBin: readBin("map.bin"),
      map4xBin: readBin("map4x.bin"),
      map16xBin: readBin("map16x.bin"),
      manifest: async () => this.manifest(map),
      webpPath: path.join(dir, "thumbnail.webp"),
      layerPng: async (_layerId: string) => {
        throw new Error("Layer PNGs are not supported in NodeMapLoader");
      },
    };
  }
}
