/**
 * Shared contract between the TypeScript environment and the Python learner.
 *
 * Everything both languages must agree on (presets, action table, amount
 * bins, feature lists, record layout, protocol codes) is defined here and
 * emitted to spec.v1.json by gen-spec.ts. Python never hard-codes a size or
 * an offset: it reads the JSON. specHash() fingerprints the contract.
 */
import { createHash } from "crypto";

export const SPEC_VERSION = 1;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type PresetName = "S" | "M" | "L";

export interface Preset {
  name: PresetName;
  /** Canvas rows × cols (after transpose, GW ≥ GH). */
  GH: number;
  GW: number;
  /** Player slots, excluding terra nullius (slot 0 = TN, 1..K players). */
  K: number;
  /** Plane channels. */
  C: number;
  /** Scalar features. */
  NS: number;
  /** Features per player slot. */
  FS: number;
}

export const PRESETS: Record<PresetName, Preset> = {
  S: { name: "S", GH: 24, GW: 32, K: 8, C: 24, NS: 64, FS: 32 },
  M: { name: "M", GH: 48, GW: 64, K: 16, C: 24, NS: 64, FS: 32 },
  L: { name: "L", GH: 96, GW: 128, K: 16, C: 24, NS: 64, FS: 32 },
};

export function cellsOf(p: Preset): number {
  return p.GH * p.GW;
}

// ---------------------------------------------------------------------------
// Action space
// ---------------------------------------------------------------------------

export enum ActionType {
  NOOP = 0,
  SPAWN,
  ATTACK,
  BOAT,
  RETREAT,
  CANCEL_BOAT,
  BUILD_CITY,
  BUILD_PORT,
  BUILD_FACTORY,
  BUILD_DEFENSE_POST,
  BUILD_SAM,
  BUILD_SILO,
  UPGRADE_CITY,
  UPGRADE_PORT,
  UPGRADE_FACTORY,
  UPGRADE_SAM,
  UPGRADE_SILO,
  BUILD_WARSHIP,
  MOVE_WARSHIPS,
  NUKE_ATOM,
  NUKE_HYDROGEN,
  MIRV,
  ALLY_REQUEST,
  ALLY_REJECT,
  ALLY_BREAK,
  ALLY_EXTEND,
  EMBARGO_START,
  EMBARGO_STOP,
  TARGET,
  DONATE_TROOPS,
  DONATE_GOLD,
}

export const NUM_TYPES = 31;
export const NUM_AMOUNT = 12;
export const NUM_CELL_GROUPS = 16;
/** Intents per decision step. */
export const INTENTS_PER_STEP = 2;
/** Factored heads per intent: [type, ptr, cell, amount]. */
export const HEADS_PER_INTENT = 4;

export type AmountKind = "none" | "troops" | "count" | "gold";

/** cellGroup: -1 = no cell head, -2 = boat rows (indexed by ptr), 0..15 = mask_cell row. */
export const CELL_NONE = -1;
export const CELL_BOAT = -2;

export interface TypeInfo {
  id: ActionType;
  name: string;
  usesPtr: boolean;
  ptrAllowsTN: boolean;
  cellGroup: number;
  amount: AmountKind;
}

function t(
  id: ActionType,
  usesPtr: boolean,
  ptrAllowsTN: boolean,
  cellGroup: number,
  amount: AmountKind,
): TypeInfo {
  return { id, name: ActionType[id], usesPtr, ptrAllowsTN, cellGroup, amount };
}

export const TYPES: readonly TypeInfo[] = [
  t(ActionType.NOOP, false, false, CELL_NONE, "none"),
  t(ActionType.SPAWN, false, false, 0, "none"),
  t(ActionType.ATTACK, true, true, CELL_NONE, "troops"),
  t(ActionType.BOAT, true, true, CELL_BOAT, "troops"),
  t(ActionType.RETREAT, true, true, CELL_NONE, "none"),
  t(ActionType.CANCEL_BOAT, true, true, CELL_NONE, "none"),
  t(ActionType.BUILD_CITY, false, false, 1, "none"),
  t(ActionType.BUILD_PORT, false, false, 2, "none"),
  t(ActionType.BUILD_FACTORY, false, false, 3, "none"),
  t(ActionType.BUILD_DEFENSE_POST, false, false, 4, "none"),
  t(ActionType.BUILD_SAM, false, false, 5, "none"),
  t(ActionType.BUILD_SILO, false, false, 6, "none"),
  t(ActionType.UPGRADE_CITY, false, false, 7, "count"),
  t(ActionType.UPGRADE_PORT, false, false, 8, "count"),
  t(ActionType.UPGRADE_FACTORY, false, false, 9, "count"),
  t(ActionType.UPGRADE_SAM, false, false, 10, "count"),
  t(ActionType.UPGRADE_SILO, false, false, 11, "count"),
  t(ActionType.BUILD_WARSHIP, false, false, 12, "none"),
  t(ActionType.MOVE_WARSHIPS, false, false, 13, "none"),
  t(ActionType.NUKE_ATOM, false, false, 14, "count"),
  t(ActionType.NUKE_HYDROGEN, false, false, 15, "count"),
  t(ActionType.MIRV, true, false, CELL_NONE, "none"),
  t(ActionType.ALLY_REQUEST, true, false, CELL_NONE, "none"),
  t(ActionType.ALLY_REJECT, true, false, CELL_NONE, "none"),
  t(ActionType.ALLY_BREAK, true, false, CELL_NONE, "none"),
  t(ActionType.ALLY_EXTEND, true, false, CELL_NONE, "none"),
  t(ActionType.EMBARGO_START, true, false, CELL_NONE, "none"),
  t(ActionType.EMBARGO_STOP, true, false, CELL_NONE, "none"),
  t(ActionType.TARGET, true, false, CELL_NONE, "none"),
  t(ActionType.DONATE_TROOPS, true, false, CELL_NONE, "troops"),
  t(ActionType.DONATE_GOLD, true, false, CELL_NONE, "gold"),
];

/** Action type owning each cell-mask group (group index → ActionType). */
export const CELL_GROUP_TYPES: readonly ActionType[] = TYPES.filter(
  (ti) => ti.cellGroup >= 0,
)
  .sort((a, b) => a.cellGroup - b.cellGroup)
  .map((ti) => ti.id);

export type TroopBinKind = "one" | "frac" | "excess" | "match";

export interface TroopBin {
  name: string;
  kind: TroopBinKind;
  v: number;
}

/**
 * Troop amount bins (ATTACK, BOAT; DONATE_TROOPS uses bins 1..7 only).
 * T = floor(me.troops()), M = maxTroops(me), D = target troops. Emitted
 * troops = floor(x); a bin is valid iff it yields ≥ 1.
 */
export const TROOP_BINS: readonly TroopBin[] = [
  { name: "ONE", kind: "one", v: 1 },
  { name: "F05", kind: "frac", v: 0.05 },
  { name: "F10", kind: "frac", v: 0.1 },
  { name: "F20", kind: "frac", v: 0.2 },
  { name: "F33", kind: "frac", v: 0.33 },
  { name: "F50", kind: "frac", v: 0.5 },
  { name: "F75", kind: "frac", v: 0.75 },
  { name: "F100", kind: "frac", v: 1.0 },
  // T − v·M: send the excess above the expansion / growth-optimal band.
  { name: "EX30", kind: "excess", v: 0.3 },
  { name: "EX42", kind: "excess", v: 0.42 },
  // min(T, v·D + 1): speed saturation / loss clamp against a player.
  { name: "M125", kind: "match", v: 1.25 },
  { name: "M167", kind: "match", v: 1.67 },
];
export const DONATE_TROOP_BINS = [1, 2, 3, 4, 5, 6, 7] as const;
/** "Up to n" counts for UPGRADE_* and NUKE_*; bins 6..11 are invalid. */
export const COUNT_BINS = [1, 2, 3, 5, 10, 50] as const;
/** Fractions of gold for DONATE_GOLD; bins 4..11 are invalid. */
export const GOLD_BINS = [0.1, 0.25, 0.5, 1.0] as const;

/** Troops a troop bin sends (before floor); NaN when D is required but absent. */
export function troopBinAmount(
  bin: number,
  T: number,
  M: number,
  D: number | null,
): number {
  const b = TROOP_BINS[bin];
  switch (b.kind) {
    case "one":
      return 1;
    case "frac":
      return b.v * T;
    case "excess":
      return T - b.v * M;
    case "match":
      return D === null ? NaN : Math.min(T, b.v * D + 1);
  }
}

// ---------------------------------------------------------------------------
// Observation features
// ---------------------------------------------------------------------------

export const PLANE_CHANNELS: readonly string[] = [
  "valid",
  "land",
  "water",
  "shore",
  "relief",
  "impassable",
  "tn",
  "me",
  "friendly",
  "hostile",
  "bots",
  "fallout",
  "frontier",
  "heat_gain",
  "heat_loss",
  "heat_churn",
  "pressure",
  "threat",
  "own_econ",
  "own_mil",
  "hostile_econ",
  "hostile_mil",
  "own_ships",
  "hostile_ships",
];
/** Channels 0..5 depend only on the map. */
export const NUM_STATIC_CHANNELS = 6;

export const SCALAR_FEATURES: readonly string[] = [
  "tick",
  "in_spawn_phase",
  "spawn_ticks_left",
  "immunity_ticks_left",
  "timer_ticks_left",
  "has_timer",
  "win_threshold",
  "delta",
  "my_share",
  "top_share",
  "second_share",
  "my_rank",
  "alive_players",
  "tn_share",
  "log_troops",
  "troop_fill",
  "log_max_troops",
  "growth_rel_peak",
  "troops_attacking",
  "troops_boats",
  "incoming_troops",
  "incoming_attacks",
  "outgoing_attacks",
  "log_gold",
  "log_gold_income",
  "tribe_gold_on_table",
  "afford_city",
  "afford_port",
  "afford_factory",
  "afford_defense_post",
  "afford_sam",
  "afford_silo",
  "afford_warship",
  "afford_atom",
  "afford_hydrogen",
  "afford_mirv",
  "own_city_levels",
  "own_port_levels",
  "own_factory_levels",
  "own_defense_posts",
  "own_sam_levels",
  "own_silo_levels",
  "own_warships",
  "ready_tubes",
  "transports_in_flight",
  "transport_available",
  "num_allies",
  "incoming_alliance_requests",
  "outgoing_alliance_requests",
  "is_traitor",
  "traitor_ticks_left",
  "rate_tokens_second",
  "rate_tokens_minute",
  "compact_map",
  "log_land_tiles",
  "tribes_at_start",
  "nations_at_start",
  "difficulty",
  "alliances_enabled",
  "row_hostile_share",
  "row_tribe_share",
  "row_max_hostile_troops",
  "last_silent_failures",
  "last_mask_misses",
];

export const SLOT_FEATURES: readonly string[] = [
  "valid",
  "is_tn",
  "human",
  "nation",
  "bot",
  "alive",
  "disconnected",
  "friendly",
  "allied",
  "shares_border",
  "boat_reachable",
  "rel_tiles",
  "tile_share",
  "rel_troops",
  "troop_fill",
  "rel_density",
  "rel_gold",
  "shared_border_frac",
  "distracted",
  "victim",
  "attacking_me",
  "my_attack_on_them",
  "annexable",
  "immune_to_me",
  "traitor",
  "embargo_me_them",
  "embargo_them_me",
  "alliance_ticks_left",
  "alliance_request_pending",
  "nation_relation",
  "centroid_dx",
  "centroid_dy",
];

// ---------------------------------------------------------------------------
// Record layout
// ---------------------------------------------------------------------------

export type DType = "u8" | "i16" | "u16" | "i32" | "u32" | "f32";

export const DTYPE_BYTES: Record<DType, number> = {
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
};

export interface HeaderField {
  name: string;
  dtype: DType;
  offset: number;
}

export const HEADER_SIZE = 64;

export const HEADER_FIELDS: readonly HeaderField[] = [
  { name: "env", dtype: "u32", offset: 0 },
  { name: "seat", dtype: "u32", offset: 4 },
  { name: "episode_uid", dtype: "u32", offset: 8 },
  { name: "step", dtype: "u32", offset: 12 },
  { name: "tick", dtype: "u32", offset: 16 },
  { name: "flags", dtype: "u32", offset: 20 },
  { name: "reward", dtype: "f32", offset: 24 },
  { name: "reward_terminal", dtype: "f32", offset: 28 },
  { name: "phi", dtype: "f32", offset: 32 },
  { name: "policy_id", dtype: "u32", offset: 36 },
  { name: "intents_sent", dtype: "u16", offset: 40 },
  { name: "rate_limited", dtype: "u16", offset: 42 },
  { name: "silent_failures", dtype: "u16", offset: 44 },
  { name: "mask_misses", dtype: "u16", offset: 46 },
  { name: "outcome", dtype: "f32", offset: 48 },
  { name: "label_weight", dtype: "f32", offset: 52 },
  { name: "worker", dtype: "u32", offset: 56 },
  { name: "reserved", dtype: "u32", offset: 60 },
];

export enum RecFlag {
  FIRST = 1,
  TERMINATED = 2,
  TRUNCATED = 4,
  NEEDS_ACTION = 8,
  SPAWN_PHASE = 16,
  FROM_SNAPSHOT = 32,
  FORCED_SPAWN = 64,
  SEAT_DEAD = 128,
  LABEL_VALID = 256,
  WON = 512,
  ENV_ERROR = 1024,
}

export interface TensorSpec {
  name: string;
  dtype: DType;
  /** Byte shape for bit-packed tensors: [rows, ceil(bits/8)] (mask_type: [ceil(bits/8)]). */
  shape: number[];
  offset: number;
  bytes: number;
  /** Logical row length when bit-packed, else null. */
  bits: number | null;
}

export interface RecordLayout {
  preset: Preset;
  recordSize: number;
  tensors: TensorSpec[];
  byName: Record<string, TensorSpec>;
}

const ALIGN = 64;

function alignUp(n: number, a: number = ALIGN): number {
  return Math.ceil(n / a) * a;
}

export function bitRowBytes(bits: number): number {
  return Math.ceil(bits / 8);
}

export function buildLayout(p: Preset): RecordLayout {
  const cells = cellsOf(p);
  const slots = p.K + 1;
  const defs: Array<Omit<TensorSpec, "offset" | "bytes">> = [
    { name: "planes", dtype: "u8", shape: [p.C, p.GH, p.GW], bits: null },
    { name: "slot_own", dtype: "u8", shape: [slots, p.GH, p.GW], bits: null },
    { name: "scalars", dtype: "f32", shape: [p.NS], bits: null },
    { name: "slots", dtype: "f32", shape: [slots, p.FS], bits: null },
    {
      name: "prev_action",
      dtype: "i16",
      shape: [INTENTS_PER_STEP, HEADS_PER_INTENT],
      bits: null,
    },
    {
      name: "label",
      dtype: "i16",
      shape: [INTENTS_PER_STEP, HEADS_PER_INTENT],
      bits: null,
    },
    { name: "type_cost", dtype: "f32", shape: [NUM_TYPES], bits: null },
    {
      name: "mask_type",
      dtype: "u8",
      shape: [bitRowBytes(NUM_TYPES)],
      bits: NUM_TYPES,
    },
    {
      name: "mask_ptr",
      dtype: "u8",
      shape: [NUM_TYPES, bitRowBytes(slots)],
      bits: slots,
    },
    {
      name: "mask_amount",
      dtype: "u8",
      shape: [NUM_TYPES, bitRowBytes(NUM_AMOUNT)],
      bits: NUM_AMOUNT,
    },
    {
      name: "mask_cell",
      dtype: "u8",
      shape: [NUM_CELL_GROUPS, bitRowBytes(1 + cells)],
      bits: 1 + cells,
    },
    {
      name: "mask_boat_cell",
      dtype: "u8",
      shape: [slots, bitRowBytes(1 + cells)],
      bits: 1 + cells,
    },
  ];
  let off = HEADER_SIZE;
  const tensors: TensorSpec[] = [];
  for (const d of defs) {
    off = alignUp(off);
    const bytes = d.shape.reduce((a, b) => a * b, 1) * DTYPE_BYTES[d.dtype];
    tensors.push({ ...d, offset: off, bytes });
    off += bytes;
  }
  const byName: Record<string, TensorSpec> = {};
  for (const ts of tensors) byName[ts.name] = ts;
  return { preset: p, recordSize: alignUp(off), tensors, byName };
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** "OFRL" read as a little-endian u32. */
export const PROTOCOL_MAGIC = 0x4c52464f;
export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_SIZE = 16;
export const MAX_PAYLOAD = 64 * 1024 * 1024;

export enum Msg {
  HELLO = 1,
  CONFIG = 2,
  READY = 3,
  RESET = 4,
  STEP = 5,
  OBS = 6,
  EPISODE_END = 7,
  SNAPSHOT_REQ = 8,
  SNAPSHOT = 9,
  PING = 10,
  PONG = 11,
  ERROR = 12,
  CLOSE = 13,
}

/** STEP sub-header {u32 group, u32 policy_version, u32 n, u32 reserved}. */
export const STEP_SUBHEADER_SIZE = 16;
/** ActionRecord {u16 env, u16 seat, i16 act[8]}. */
export const ACTION_RECORD_SIZE = 20;
/** OBS sub-header {u32 group, u32 n, u32 record_size, u32 policy_version, u32 reserved[8]}. */
export const OBS_SUBHEADER_SIZE = 48;

// ---------------------------------------------------------------------------
// JSON emission and hash
// ---------------------------------------------------------------------------

export function specJson(): Record<string, unknown> {
  const layouts: Record<string, unknown> = {};
  for (const p of Object.values(PRESETS)) {
    const l = buildLayout(p);
    layouts[p.name] = {
      record_size: l.recordSize,
      tensors: l.tensors.map((ts) => ({
        name: ts.name,
        dtype: ts.dtype,
        shape: ts.shape,
        offset: ts.offset,
        bytes: ts.bytes,
        bits: ts.bits,
      })),
    };
  }
  const flags: Record<string, number> = {};
  for (const [k, v] of Object.entries(RecFlag)) {
    if (typeof v === "number") flags[k] = v;
  }
  const messages: Record<string, number> = {};
  for (const [k, v] of Object.entries(Msg)) {
    if (typeof v === "number") messages[k] = v;
  }
  return {
    version: SPEC_VERSION,
    presets: PRESETS,
    num_types: NUM_TYPES,
    num_amount: NUM_AMOUNT,
    num_cell_groups: NUM_CELL_GROUPS,
    intents_per_step: INTENTS_PER_STEP,
    action_types: TYPES.map((ti) => ({
      id: ti.id,
      name: ti.name,
      ptr: ti.usesPtr,
      tn: ti.ptrAllowsTN,
      cell_group: ti.cellGroup,
      amount: ti.amount,
    })),
    cell_groups: CELL_GROUP_TYPES.map((x) => x as number),
    amount_bins: {
      troops: TROOP_BINS.map((b) => ({ name: b.name, kind: b.kind, v: b.v })),
      donate_troops: [...DONATE_TROOP_BINS],
      count: [...COUNT_BINS],
      gold: [...GOLD_BINS],
    },
    plane_channels: PLANE_CHANNELS,
    num_static_channels: NUM_STATIC_CHANNELS,
    scalar_features: SCALAR_FEATURES,
    slot_features: SLOT_FEATURES,
    header_size: HEADER_SIZE,
    header: HEADER_FIELDS,
    flags,
    layouts,
    protocol: {
      magic: PROTOCOL_MAGIC,
      version: PROTOCOL_VERSION,
      frame_header_size: FRAME_HEADER_SIZE,
      max_payload: MAX_PAYLOAD,
      step_subheader_size: STEP_SUBHEADER_SIZE,
      action_record_size: ACTION_RECORD_SIZE,
      obs_subheader_size: OBS_SUBHEADER_SIZE,
      messages,
    },
  };
}

/** JSON with keys sorted recursively and no whitespace (Python: sort_keys, separators=(",", ":")). */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonicalJson).join(",") + "]";
  if (x !== null && typeof x === "object") {
    const keys = Object.keys(x as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalJson((x as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(x);
}

let cachedHash: string | null = null;

export function specHash(): string {
  cachedHash ??= createHash("sha256")
    .update(canonicalJson(specJson()))
    .digest("hex");
  return cachedHash;
}
