// Lossless generic protobuf codec.
//
// The Client Control Template carries records whose field numbers are not in
// `gia_with_ui_rotation_v6.proto` (UiProperty 73/74/77/78/83, UiPropertyBody
// 84/85, ...). protobuf.js silently drops undeclared fields on decode, so a
// schema-driven decode/re-encode of the client reference loses data.
//
// This module keeps every field, in its original order, with its original wire
// type. Length-delimited fields are parsed only when something actually walks
// into them; everything else round-trips as the original bytes. Re-serialising
// a message that was never mutated reuses a cached buffer, so patching a few
// leaves of a large record does not re-encode the whole tree.

export const WIRE_VARINT = 0
export const WIRE_FIXED64 = 1
export const WIRE_LENGTH = 2
export const WIRE_FIXED32 = 5

export type PbWireType = 0 | 1 | 2 | 5

export interface PbMessage {
  fields: PbField[]
  /** The length-delimited field this message is the body of, if any. */
  owner?: PbField
  /** Serialized body, valid until an edit invalidates it. */
  cache?: Uint8Array
}

export interface PbField {
  no: number
  wire: PbWireType
  /** wire 0 */
  varint?: bigint
  /** wire 5, stored as the raw 32 bits */
  fixed32?: number
  /** wire 1, stored as the raw 64 bits */
  fixed64?: bigint
  /** wire 2, still unparsed */
  bytes?: Uint8Array
  /** wire 2, parsed on demand; authoritative once present */
  msg?: PbMessage
  /** Containing message, used to invalidate serialization caches upward. */
  parent?: PbMessage
}

const scratch = new DataView(new ArrayBuffer(8))
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let shift = 0n
  let value = 0n
  let i = offset
  while (i < buf.length) {
    const byte = buf[i++]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [value, i]
    shift += 7n
    if (shift > 63n) throw new Error('protobuf: varint too long')
  }
  throw new Error('protobuf: truncated varint')
}

export function parseMessage(buf: Uint8Array, owner?: PbField): PbMessage {
  const message: PbMessage = { fields: [], owner }
  let i = 0
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i)
    i = afterKey
    const no = Number(key >> 3n)
    const wire = Number(key & 7n) as PbWireType
    if (no === 0) throw new Error('protobuf: field number 0')
    const field: PbField = { no, wire, parent: message }
    if (wire === WIRE_VARINT) {
      const [value, next] = readVarint(buf, i)
      field.varint = value
      i = next
    } else if (wire === WIRE_FIXED64) {
      if (i + 8 > buf.length) throw new Error('protobuf: truncated fixed64')
      field.fixed64 =
        BigInt(buf[i]) |
        (BigInt(buf[i + 1]) << 8n) |
        (BigInt(buf[i + 2]) << 16n) |
        (BigInt(buf[i + 3]) << 24n) |
        (BigInt(buf[i + 4]) << 32n) |
        (BigInt(buf[i + 5]) << 40n) |
        (BigInt(buf[i + 6]) << 48n) |
        (BigInt(buf[i + 7]) << 56n)
      i += 8
    } else if (wire === WIRE_FIXED32) {
      if (i + 4 > buf.length) throw new Error('protobuf: truncated fixed32')
      field.fixed32 = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0
      i += 4
    } else if (wire === WIRE_LENGTH) {
      const [len, afterLen] = readVarint(buf, i)
      i = afterLen
      const size = Number(len)
      if (i + size > buf.length) throw new Error('protobuf: truncated length-delimited field')
      field.bytes = buf.subarray(i, i + size)
      i += size
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`)
    }
    message.fields.push(field)
  }
  return message
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Parses a length-delimited field's body on demand and returns it. */
export function asMessage(field: PbField): PbMessage {
  if (field.wire !== WIRE_LENGTH) throw new Error(`protobuf: field ${field.no} is not length-delimited`)
  if (!field.msg) {
    field.msg = parseMessage(field.bytes ?? new Uint8Array(0), field)
    field.msg.cache = field.bytes
  }
  return field.msg
}

export function field(message: PbMessage, no: number): PbField | undefined {
  return message.fields.find((f) => f.no === no)
}

export function fields(message: PbMessage, no: number): PbField[] {
  return message.fields.filter((f) => f.no === no)
}

/** Walks a chain of single-occurrence length-delimited fields. */
export function child(message: PbMessage, ...path: number[]): PbMessage | undefined {
  let current = message
  for (const no of path) {
    const f = field(current, no)
    if (!f || f.wire !== WIRE_LENGTH) return undefined
    current = asMessage(f)
  }
  return current
}

export function varintOf(message: PbMessage, no: number): bigint | undefined {
  const f = field(message, no)
  return f?.wire === WIRE_VARINT ? f.varint : undefined
}

export function numberOf(message: PbMessage, no: number): number | undefined {
  const value = varintOf(message, no)
  return value === undefined ? undefined : Number(value)
}

export function stringOf(message: PbMessage, no: number): string | undefined {
  const f = field(message, no)
  if (!f || f.wire !== WIRE_LENGTH) return undefined
  return textDecoder.decode(bytesOf(f))
}

/** Current bytes of a length-delimited field, re-serialising if it was edited. */
export function bytesOf(f: PbField): Uint8Array {
  if (f.wire !== WIRE_LENGTH) throw new Error(`protobuf: field ${f.no} is not length-delimited`)
  if (f.msg) return serializeMessage(f.msg)
  return f.bytes ?? new Uint8Array(0)
}

export function floatOf(f: PbField): number {
  if (f.wire !== WIRE_FIXED32) throw new Error(`protobuf: field ${f.no} is not fixed32`)
  scratch.setUint32(0, f.fixed32 ?? 0, true)
  return scratch.getFloat32(0, true)
}

/** Reads packed varints out of a length-delimited field. */
export function packedVarints(f: PbField): bigint[] {
  const buf = bytesOf(f)
  const out: bigint[] = []
  let i = 0
  while (i < buf.length) {
    const [value, next] = readVarint(buf, i)
    out.push(value)
    i = next
  }
  return out
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** Drops cached serializations from `message` up to the root. */
export function invalidate(message: PbMessage | undefined): void {
  let current = message
  while (current) {
    current.cache = undefined
    const owner = current.owner
    if (!owner) return
    owner.bytes = undefined
    current = owner.parent
  }
}

export function setVarint(f: PbField, value: number | bigint): void {
  if (f.wire !== WIRE_VARINT) throw new Error(`protobuf: field ${f.no} is not a varint`)
  const next = typeof value === 'bigint' ? value : BigInt(Math.round(value))
  if (f.varint === next) return
  f.varint = next
  invalidate(f.parent)
}

export function setFloat(f: PbField, value: number): void {
  if (f.wire !== WIRE_FIXED32) throw new Error(`protobuf: field ${f.no} is not fixed32`)
  scratch.setFloat32(0, value, true)
  const bits = scratch.getUint32(0, true)
  if (f.fixed32 === bits) return
  f.fixed32 = bits
  invalidate(f.parent)
}

export function setBytes(f: PbField, value: Uint8Array): void {
  if (f.wire !== WIRE_LENGTH) throw new Error(`protobuf: field ${f.no} is not length-delimited`)
  f.bytes = value
  f.msg = undefined
  invalidate(f.parent)
}

export function setString(f: PbField, value: string): void {
  setBytes(f, textEncoder.encode(value))
}

/** Returns field `no`, appending it with a zero value when it is missing. */
export function ensureField(message: PbMessage, no: number, wire: PbWireType): PbField {
  const existing = field(message, no)
  if (existing) {
    if (existing.wire !== wire) throw new Error(`protobuf: field ${no} has wire type ${existing.wire}, expected ${wire}`)
    return existing
  }
  const created: PbField = { no, wire, parent: message }
  if (wire === WIRE_VARINT) created.varint = 0n
  else if (wire === WIRE_FIXED32) created.fixed32 = 0
  else if (wire === WIRE_FIXED64) created.fixed64 = 0n
  else created.bytes = new Uint8Array(0)
  message.fields.push(created)
  invalidate(message)
  return created
}

/** Walks a chain of length-delimited fields, creating empty ones as needed. */
export function ensureChild(message: PbMessage, ...path: number[]): PbMessage {
  let current = message
  for (const no of path) current = asMessage(ensureField(current, no, WIRE_LENGTH))
  return current
}

export function removeField(message: PbMessage, no: number): boolean {
  const index = message.fields.findIndex((f) => f.no === no)
  if (index < 0) return false
  message.fields.splice(index, 1)
  invalidate(message)
  return true
}

/** Replaces every occurrence of field `no` with one field per supplied value. */
export function replaceFields(message: PbMessage, no: number, replacements: PbField[]): void {
  const first = message.fields.findIndex((f) => f.no === no)
  const kept = message.fields.filter((f) => f.no !== no)
  // Insert where the first old occurrence sat, counting only the kept fields
  // before it, so surrounding record order is preserved.
  let at = kept.length
  if (first >= 0) {
    at = 0
    for (let i = 0; i < first; i += 1) if (message.fields[i].no !== no) at += 1
  }
  for (const f of replacements) f.parent = message
  kept.splice(at, 0, ...replacements)
  message.fields = kept
  invalidate(message)
}

export function varintField(no: number, value: number | bigint): PbField {
  return { no, wire: WIRE_VARINT, varint: typeof value === 'bigint' ? value : BigInt(Math.round(value)) }
}

export function bytesField(no: number, value: Uint8Array): PbField {
  return { no, wire: WIRE_LENGTH, bytes: value }
}

export function messageField(no: number, message: PbMessage): PbField {
  const created: PbField = { no, wire: WIRE_LENGTH }
  message.owner = created
  created.msg = message
  return created
}

export function newMessage(fieldList: PbField[] = []): PbMessage {
  const message: PbMessage = { fields: fieldList }
  for (const f of fieldList) f.parent = message
  return message
}

/** Deep structural copy. Unparsed subtrees stay shared as immutable bytes. */
export function cloneMessage(message: PbMessage, owner?: PbField): PbMessage {
  const copy: PbMessage = { fields: [], owner, cache: message.cache }
  copy.fields = message.fields.map((f) => {
    const next: PbField = { no: f.no, wire: f.wire, parent: copy }
    if (f.wire === WIRE_VARINT) next.varint = f.varint
    else if (f.wire === WIRE_FIXED32) next.fixed32 = f.fixed32
    else if (f.wire === WIRE_FIXED64) next.fixed64 = f.fixed64
    else if (f.msg) next.msg = cloneMessage(f.msg, next)
    else next.bytes = f.bytes
    return next
  })
  return copy
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

function varintSize(value: bigint): number {
  let v = value
  let n = 1
  while (v >= 0x80n) {
    v >>= 7n
    n += 1
  }
  return n
}

function writeVarint(out: Uint8Array, offset: number, value: bigint): number {
  let v = value
  let i = offset
  while (v >= 0x80n) {
    out[i++] = Number(v & 0x7fn) | 0x80
    v >>= 7n
  }
  out[i++] = Number(v)
  return i
}

function fieldSize(f: PbField): number {
  const keySize = varintSize(BigInt((f.no << 3) | f.wire))
  if (f.wire === WIRE_VARINT) return keySize + varintSize(f.varint ?? 0n)
  if (f.wire === WIRE_FIXED32) return keySize + 4
  if (f.wire === WIRE_FIXED64) return keySize + 8
  const body = bytesOf(f)
  return keySize + varintSize(BigInt(body.length)) + body.length
}

function writeField(out: Uint8Array, offset: number, f: PbField): number {
  let i = writeVarint(out, offset, BigInt((f.no << 3) | f.wire))
  if (f.wire === WIRE_VARINT) return writeVarint(out, i, f.varint ?? 0n)
  if (f.wire === WIRE_FIXED32) {
    const bits = f.fixed32 ?? 0
    out[i++] = bits & 0xff
    out[i++] = (bits >>> 8) & 0xff
    out[i++] = (bits >>> 16) & 0xff
    out[i++] = (bits >>> 24) & 0xff
    return i
  }
  if (f.wire === WIRE_FIXED64) {
    let bits = f.fixed64 ?? 0n
    for (let b = 0; b < 8; b += 1) {
      out[i++] = Number(bits & 0xffn)
      bits >>= 8n
    }
    return i
  }
  const body = bytesOf(f)
  i = writeVarint(out, i, BigInt(body.length))
  out.set(body, i)
  return i + body.length
}

export function serializeMessage(message: PbMessage): Uint8Array {
  if (message.cache) return message.cache
  let size = 0
  for (const f of message.fields) size += fieldSize(f)
  const out = new Uint8Array(size)
  let offset = 0
  for (const f of message.fields) offset = writeField(out, offset, f)
  message.cache = out
  if (message.owner) message.owner.bytes = out
  return out
}

export function encodeVarintBytes(value: number | bigint): Uint8Array {
  const v = typeof value === 'bigint' ? value : BigInt(Math.round(value))
  if (v < 0n) throw new Error('protobuf: negative varint')
  const out = new Uint8Array(varintSize(v))
  writeVarint(out, 0, v)
  return out
}

export function decodeVarintBytes(buf: Uint8Array, offset = 0): { value: bigint; next: number } {
  const [value, next] = readVarint(buf, offset)
  return { value, next }
}
