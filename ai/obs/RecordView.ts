import {
  DType,
  HEADER_FIELDS,
  HeaderField,
  RecordLayout,
  TensorSpec,
} from "../spec/spec";

const HEADER_BY_NAME: Record<string, HeaderField> = {};
for (const f of HEADER_FIELDS) HEADER_BY_NAME[f.name] = f;

/**
 * Typed views over one SeatRecord buffer (layout from spec.ts). The buffer
 * must start at a 4-byte aligned offset of its ArrayBuffer (records are
 * 64-byte aligned inside frames, so this always holds).
 */
export class RecordView {
  private dv: DataView;
  private views = new Map<string, ArrayBufferView>();

  constructor(
    readonly layout: RecordLayout,
    readonly buf: Uint8Array,
  ) {
    if (buf.byteLength < layout.recordSize) {
      throw new Error(
        `record buffer too small: ${buf.byteLength} < ${layout.recordSize}`,
      );
    }
    if (buf.byteOffset % 4 !== 0) {
      throw new Error("record buffer must be 4-byte aligned");
    }
    this.dv = new DataView(buf.buffer, buf.byteOffset, layout.recordSize);
  }

  private spec(name: string, dtype: DType): TensorSpec {
    const ts = this.layout.byName[name];
    if (ts === undefined) throw new Error(`unknown tensor ${name}`);
    if (ts.dtype !== dtype) {
      throw new Error(`tensor ${name} is ${ts.dtype}, not ${dtype}`);
    }
    return ts;
  }

  u8(name: string): Uint8Array {
    let v = this.views.get(name) as Uint8Array | undefined;
    if (v === undefined) {
      const ts = this.spec(name, "u8");
      v = new Uint8Array(
        this.buf.buffer,
        this.buf.byteOffset + ts.offset,
        ts.bytes,
      );
      this.views.set(name, v);
    }
    return v;
  }

  i16(name: string): Int16Array {
    let v = this.views.get(name) as Int16Array | undefined;
    if (v === undefined) {
      const ts = this.spec(name, "i16");
      v = new Int16Array(
        this.buf.buffer,
        this.buf.byteOffset + ts.offset,
        ts.bytes / 2,
      );
      this.views.set(name, v);
    }
    return v;
  }

  f32(name: string): Float32Array {
    let v = this.views.get(name) as Float32Array | undefined;
    if (v === undefined) {
      const ts = this.spec(name, "f32");
      v = new Float32Array(
        this.buf.buffer,
        this.buf.byteOffset + ts.offset,
        ts.bytes / 4,
      );
      this.views.set(name, v);
    }
    return v;
  }

  setHeader(field: string, value: number): void {
    const f = HEADER_BY_NAME[field];
    if (f === undefined) throw new Error(`unknown header field ${field}`);
    switch (f.dtype) {
      case "u32":
        this.dv.setUint32(f.offset, value >>> 0, true);
        break;
      case "i32":
        this.dv.setInt32(f.offset, value | 0, true);
        break;
      case "u16":
        this.dv.setUint16(f.offset, Math.min(0xffff, Math.max(0, value)), true);
        break;
      case "i16":
        this.dv.setInt16(f.offset, value, true);
        break;
      case "f32":
        this.dv.setFloat32(f.offset, value, true);
        break;
      case "u8":
        this.dv.setUint8(f.offset, value);
        break;
    }
  }

  getHeader(field: string): number {
    const f = HEADER_BY_NAME[field];
    if (f === undefined) throw new Error(`unknown header field ${field}`);
    switch (f.dtype) {
      case "u32":
        return this.dv.getUint32(f.offset, true);
      case "i32":
        return this.dv.getInt32(f.offset, true);
      case "u16":
        return this.dv.getUint16(f.offset, true);
      case "i16":
        return this.dv.getInt16(f.offset, true);
      case "f32":
        return this.dv.getFloat32(f.offset, true);
      case "u8":
        return this.dv.getUint8(f.offset);
    }
  }

  addFlags(flags: number): void {
    this.setHeader("flags", this.getHeader("flags") | flags);
  }

  hasFlag(flag: number): boolean {
    return (this.getHeader("flags") & flag) !== 0;
  }

  private bitSpec(name: string): TensorSpec {
    const ts = this.layout.byName[name];
    if (ts === undefined || ts.bits === null) {
      throw new Error(`${name} is not a bit-packed tensor`);
    }
    return ts;
  }

  /** Bytes per row of a bit-packed tensor. */
  rowBytes(name: string): number {
    const ts = this.bitSpec(name);
    return ts.shape[ts.shape.length - 1];
  }

  setBit(name: string, row: number, col: number): void {
    const ts = this.bitSpec(name);
    const rb = ts.shape[ts.shape.length - 1];
    const idx = ts.offset + row * rb + (col >> 3);
    this.buf[idx] |= 1 << (col & 7);
  }

  clearBit(name: string, row: number, col: number): void {
    const ts = this.bitSpec(name);
    const rb = ts.shape[ts.shape.length - 1];
    const idx = ts.offset + row * rb + (col >> 3);
    this.buf[idx] &= ~(1 << (col & 7));
  }

  getBit(name: string, row: number, col: number): boolean {
    const ts = this.bitSpec(name);
    const rb = ts.shape[ts.shape.length - 1];
    const idx = ts.offset + row * rb + (col >> 3);
    return (this.buf[idx] & (1 << (col & 7))) !== 0;
  }

  /** True when any bit of the row is set. */
  anyBit(name: string, row: number): boolean {
    const ts = this.bitSpec(name);
    const rb = ts.shape[ts.shape.length - 1];
    const start = ts.offset + row * rb;
    for (let i = 0; i < rb; i++) if (this.buf[start + i] !== 0) return true;
    return false;
  }

  /** Clears every byte of the record. */
  clear(): void {
    this.buf.fill(0, 0, this.layout.recordSize);
  }
}
