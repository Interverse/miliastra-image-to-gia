// Pieces shared by the Server and Client `.gia` serializers: the file
// container, the small varint/field-501 helpers both formats use, and the one
// authoritative image-resource ID table.

import type { DeviceScales, ShapeKind } from './types'

// ---------------------------------------------------------------------------
// image resource IDs
// ---------------------------------------------------------------------------

// The engine addresses built-in image primitives by the same numeric ID in
// both Server and Client Control Templates. Only the surrounding record
// differs: Server stores it in UiShapeStyle.shape_type (property 21/type 38),
// Client stores it in the client image style body (property 73/type 96,
// body field 84, sub-field 503). There is deliberately only one table.
export const IMAGE_RESOURCE_IDS: Record<ShapeKind, number> = {
  square: 100001,
  circle: 100002,
  triangle: 100003,
}

export function imageResourceId(shape: ShapeKind | undefined): number {
  return IMAGE_RESOURCE_IDS[shape ?? 'square'] ?? IMAGE_RESOURCE_IDS.square
}

export function shapeKindForImageId(id: number): ShapeKind | undefined {
  return (Object.keys(IMAGE_RESOURCE_IDS) as ShapeKind[]).find((kind) => IMAGE_RESOURCE_IDS[kind] === id)
}

// Container GUID both exporters build their object IDs from, so that a Server
// Image and a Client Image generated from the same source describe the same
// objects under the same identifiers. This is the GUID carried by the bundled
// server `template.gia`; the client serializer renumbers its template onto it.
export const IMAGE_ROOT_GUID = 1073742130

// ---------------------------------------------------------------------------
// resource classes
// ---------------------------------------------------------------------------

/** ResourceEntry.resource_class of a Server Control Template container. */
export const SERVER_CONTAINER_RESOURCE_CLASS = 61
/** ResourceEntry.resource_class of a Client Control Template container. */
export const CLIENT_CONTAINER_RESOURCE_CLASS = 70
/** ResourceEntry.resource_class of a child control, identical in both. */
export const UI_CONTROL_RESOURCE_CLASS = 15

// ---------------------------------------------------------------------------
// device scales
// ---------------------------------------------------------------------------

// Transform arrays carry one entry per device profile, always in this order.
export const DEVICE_SCALE_KEYS: (keyof DeviceScales)[] = ['desktop', 'mobile', 'controller', 'mobileController']

export function scaleForTransformEntry(scales: DeviceScales, index: number): number {
  const key = DEVICE_SCALE_KEYS[index] ?? 'desktop'
  const scale = scales[key]
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

// ---------------------------------------------------------------------------
// .gia container
// ---------------------------------------------------------------------------

const HEADER_BYTES = 20
const FOOTER_BYTES = 4
const HEADER_MAGIC = 0x0326
const FOOTER_MAGIC = 0x0679

/** Strips the fixed 20-byte header and 4-byte footer from a `.gia` file. */
export function bytesToPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length < HEADER_BYTES + FOOTER_BYTES) {
    throw new Error('Template .gia is too small')
  }
  return bytes.slice(HEADER_BYTES, bytes.length - FOOTER_BYTES)
}

/** Wraps encoded AssetBundle bytes back into the `.gia` container. */
export function withGiaHeader(payloadParts: Uint8Array[]): Blob {
  let payloadLength = 0
  for (const part of payloadParts) payloadLength += part.length
  const header = new DataView(new ArrayBuffer(HEADER_BYTES))
  header.setUint32(0, HEADER_BYTES + payloadLength, false)
  header.setUint32(4, 1, false)
  header.setUint32(8, HEADER_MAGIC, false)
  header.setUint32(12, 3, false)
  header.setUint32(16, payloadLength, false)
  const footer = new DataView(new ArrayBuffer(FOOTER_BYTES))
  footer.setUint32(0, FOOTER_MAGIC, false)
  return new Blob([header.buffer, ...(payloadParts as BlobPart[]), footer.buffer], {
    type: 'application/octet-stream',
  })
}

// ---------------------------------------------------------------------------
// field-501 envelopes
// ---------------------------------------------------------------------------

export function encodeVarint(value: number): Uint8Array {
  if (value < 0) throw new Error('negative varint not supported')
  const out: number[] = []
  let v = value >>> 0
  for (;;) {
    const b = v & 0x7f
    v >>>= 7
    if (v) out.push(b | 0x80)
    else {
      out.push(b)
      return Uint8Array.from(out)
    }
  }
}

export function decodeVarint(buf: Uint8Array, offset = 0): { value: number | null; next: number } {
  let shift = 0
  let value = 0
  let i = offset
  while (i < buf.length) {
    const b = buf[i++]
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, next: i }
    shift += 7
  }
  return { value: null, next: i }
}

export function encodeField501Varint(value: number): Uint8Array {
  const tag = encodeVarint((501 << 3) | 0)
  const body = encodeVarint(value)
  const out = new Uint8Array(tag.length + body.length)
  out.set(tag, 0)
  out.set(body, tag.length)
  return out
}

export function encodeField501String(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text)
  const tag = encodeVarint((501 << 3) | 2)
  const len = encodeVarint(enc.length)
  const out = new Uint8Array(tag.length + len.length + enc.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(enc, tag.length + len.length)
  return out
}

export function decodeField501Varint(raw?: Uint8Array | number[] | null): number | null {
  if (!raw) return null
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
  const tag = decodeVarint(bytes, 0)
  if (tag.value !== ((501 << 3) | 0)) return null
  return decodeVarint(bytes, tag.next).value
}

export function decodeField501String(raw?: Uint8Array | number[] | null): string | null {
  if (!raw) return null
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
  const tag = decodeVarint(bytes, 0)
  if (tag.value !== ((501 << 3) | 2)) return null
  const len = decodeVarint(bytes, tag.next)
  if (len.value == null) return null
  return new TextDecoder().decode(bytes.subarray(len.next, len.next + len.value))
}

// ---------------------------------------------------------------------------
// export metadata
// ---------------------------------------------------------------------------

/** AssetBundle.export_tag: `{UID}-{TIME}-{FILE_ID}-\{EXPORT_FILE_NAME}` */
export function buildExportTag(parentGuid: number, outputName: string): string {
  return `600489258-0-${parentGuid}-\\${outputName}`
}
