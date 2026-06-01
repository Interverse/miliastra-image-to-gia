import type protobuf from 'protobufjs'
import { rotatedBBoxSize, rotatePoint } from './utils'
import type { GeneratorConfig, RectPlan } from './types'

const SHAPE_SQUARE = 100001

export interface GiaTypes {
  root: protobuf.Root
  AssetBundle: protobuf.Type
  ResourceEntry: protobuf.Type
  ResourceLocator: protobuf.Type
}

function bytesToPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 24) {
    throw new Error('Template .gia is too small')
  }
  return bytes.slice(20, bytes.length - 4)
}

function withGiaHeader(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + payload.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, 20 + payload.length, false)
  view.setUint32(4, 1, false)
  view.setUint32(8, 0x0326, false)
  view.setUint32(12, 3, false)
  view.setUint32(16, payload.length, false)
  out.set(payload, 20)
  view.setUint32(20 + payload.length, 0x0679, false)
  return out
}

function encodeVarint(value: number): Uint8Array {
  if (value < 0) throw new Error('negative varint not supported')
  const out: number[] = []
  let v = value >>> 0
  while (true) {
    const b = v & 0x7f
    v >>>= 7
    if (v) out.push(b | 0x80)
    else {
      out.push(b)
      return Uint8Array.from(out)
    }
  }
}

function decodeVarint(buf: Uint8Array, offset = 0): { value: number | null; next: number } {
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

function encodeField501Varint(value: number): Uint8Array {
  const tag = encodeVarint((501 << 3) | 0)
  const body = encodeVarint(value)
  const out = new Uint8Array(tag.length + body.length)
  out.set(tag, 0)
  out.set(body, tag.length)
  return out
}

function encodeField501String(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text)
  const tag = encodeVarint((501 << 3) | 2)
  const len = encodeVarint(enc.length)
  const out = new Uint8Array(tag.length + len.length + enc.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(enc, tag.length + len.length)
  return out
}

function decodeField501Varint(raw?: Uint8Array | number[] | null): number | null {
  if (!raw) return null
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
  const tag = decodeVarint(bytes, 0)
  if (tag.value !== ((501 << 3) | 0)) return null
  const val = decodeVarint(bytes, tag.next)
  return val.value
}

function getGuid(resource: any): number {
  return Number(resource.identity?.asset_guid ?? resource.ui?.object?.guid ?? 0)
}

function setGuid(resource: any, guid: number) {
  if (!resource.identity) resource.identity = {}
  resource.identity.asset_guid = guid
  if (resource.ui?.object) resource.ui.object.guid = guid
}

function getHiddenUiId(resource: any): number | null {
  const descriptors = resource.ui?.object?.descriptors ?? []
  for (const prop of descriptors) {
    if (prop.property_id === 2 && prop.property_type === 6 && prop.raw_12) {
      return decodeField501Varint(prop.raw_12)
    }
  }
  return null
}

function findShapeProperty(uiObject: any): any {
  const props = uiObject?.properties ?? []
  const found = props.find((p: any) => p.body?.shape_style)
  if (!found) throw new Error('Could not find shape_style property')
  return found
}

function findTransformProperty(uiObject: any): any {
  const props = uiObject?.properties ?? []
  const found = props.find((p: any) => p.body?.transform)
  if (!found) throw new Error('Could not find transform property')
  return found
}

function setParentName(parent: any, name: string) {
  parent.internal_name = name
  const props = parent.ui?.object?.properties ?? []
  for (const p of props) {
    if (p.property_id === 2 && p.property_type === 15) {
      p.raw_12 = encodeField501String(name)
    }
  }
}

function setUniqueUiIdentityAndName(child: any, uniqueUiId: number, label: string) {
  const obj = child.ui.object
  for (const prop of obj.descriptors ?? []) {
    if (prop.property_id === 2 && prop.property_type === 6) {
      prop.raw_12 = encodeField501Varint(uniqueUiId)
    }
  }
  for (const prop of obj.properties ?? []) {
    if (prop.property_id === 2 && prop.property_type === 15) {
      prop.raw_12 = encodeField501String(label)
    }
  }
  child.internal_name = label
}

function ensureTransformEntryDefaults(entry: any, index: number) {
  if (!entry.fields) entry.fields = {}
  const f = entry.fields
  entry.index = index === 0 ? 0 : index
  if (!f.zoom) f.zoom = {}
  f.zoom.x = 1.0
  f.zoom.y = 1.0
  f.zoom.z = 1.0
  if (!f.anchor_min_or_pivot_a) f.anchor_min_or_pivot_a = {}
  if (!f.anchor_max_or_pivot_b) f.anchor_max_or_pivot_b = {}
  if (!f.pivot_or_alignment) f.pivot_or_alignment = {}
  f.anchor_min_or_pivot_a.x = 0.5
  f.anchor_min_or_pivot_a.y = 0.5
  f.anchor_max_or_pivot_b.x = 0.5
  f.anchor_max_or_pivot_b.y = 0.5
  f.pivot_or_alignment.x = 0.5
  f.pivot_or_alignment.y = 0.5
  if (!f.position) f.position = {}
  if (!f.size) f.size = {}
  if (!f.rotation) f.rotation = {}
}

function setChildTransform(child: any, x: number, y: number, width: number, height: number, rotationDegrees = 0) {
  const prop = findTransformProperty(child.ui.object)
  const arr = prop.body.transform.transform_array
  if (!arr.entries || arr.entries.length === 0) {
    throw new Error('Transform array has no entries')
  }
  if (!arr.unknown_502) arr.unknown_502 = 9
  if (!arr.enabled) arr.enabled = 1

  arr.entries.forEach((entry: any, idx: number) => {
    ensureTransformEntryDefaults(entry, idx)
    const f = entry.fields
    f.position.x = x
    f.position.y = y
    f.size.x = width
    f.size.y = height
    const rot = ((rotationDegrees % 360) + 360) % 360
    if (Math.abs(rot) < 1e-6) {
      delete f.rotation.z_degrees
    } else {
      f.rotation.z_degrees = rot
    }
  })
}

function setSquareValues(child: any, label: string, x: number, y: number, width: number, height: number, colorArgb: number, rotationDegrees = 0) {
  const shapeProp = findShapeProperty(child.ui.object)
  if (!shapeProp.body) shapeProp.body = {}
  if (!shapeProp.body.shape_style) shapeProp.body.shape_style = {}
  shapeProp.body.shape_style.shape_type = SHAPE_SQUARE
  shapeProp.body.shape_style.color_argb = colorArgb >>> 0
  setChildTransform(child, x, y, width, height, rotationDegrees)
  setUniqueUiIdentityAndName(child, getHiddenUiId(child) ?? 0, label)
}

function setParentTransform(parent: any, x: number, y: number, width: number, height: number) {
  try {
    const prop = findTransformProperty(parent.ui.object)
    const arr = prop.body.transform.transform_array
    for (const entry of arr.entries ?? []) {
      ensureTransformEntryDefaults(entry, 0)
      entry.fields.position.x = x
      entry.fields.position.y = y
      entry.fields.size.x = width
      entry.fields.size.y = height
    }
  } catch {
    // ignore
  }
  for (const p of parent.ui?.object?.properties ?? []) {
    if (p.body?.size_component?.size) {
      p.body.size_component.size.x = width
      p.body.size_component.size.y = height
    }
  }
}

function cloneChild(templateChild: any, newGuid: number, parentGuid: number): any {
  const child = structuredClone(templateChild)
  const oldGuid = getGuid(templateChild)
  const oldParent = Number(templateChild.ui?.object?.parent_guid ?? 0)

  setGuid(child, newGuid)
  if (child.ui?.object) child.ui.object.parent_guid = parentGuid

  for (const propListName of ['descriptors', 'properties'] as const) {
    for (const prop of child.ui?.object?.[propListName] ?? []) {
      if (prop.id_ref_11?.guid != null) {
        if (!(prop.property_id === 1 && prop.property_type === 12 && Number(prop.id_ref_11.guid) === 2)) {
          if (Number(prop.id_ref_11.guid) === oldGuid) prop.id_ref_11.guid = newGuid
          if (oldParent && Number(prop.id_ref_11.guid) === oldParent) prop.id_ref_11.guid = parentGuid
        }
      }
      if (prop.binding?.guid != null) {
        if (Number(prop.binding.guid) === oldGuid) prop.binding.guid = newGuid
        if (oldParent && Number(prop.binding.guid) === oldParent) prop.binding.guid = parentGuid
      }
      if (prop.body?.binding?.guid != null) {
        if (Number(prop.body.binding.guid) === oldGuid) prop.body.binding.guid = newGuid
        if (oldParent && Number(prop.body.binding.guid) === oldParent) prop.body.binding.guid = parentGuid
      }
    }
  }

  return child
}

function rebuildParentRefs(parent: any, deps: any[], ResourceLocator: protobuf.Type) {
  if (!parent.ui?.object) throw new Error('Parent missing UI object')
  parent.reference_list = []
  parent.ui.object.child_guids = []
  for (const dep of deps) {
    const guid = getGuid(dep)
    parent.ui.object.child_guids.push(guid)
    const refObj = ResourceLocator.fromObject(dep.identity ?? {})
    parent.reference_list.push(refObj)
  }
}

function patchParentDescriptorNextId(parent: any, nextChildGuid: number) {
  for (const prop of parent.ui?.object?.descriptors ?? []) {
    if (prop.property_id === 4 && prop.property_type === 4 && prop.raw_14) {
      prop.raw_14 = encodeField501Varint(nextChildGuid)
    }
  }
}

export async function buildGiaFromRects(
  templateGiaBytes: Uint8Array,
  rects: RectPlan[],
  imgWidth: number,
  imgHeight: number,
  config: GeneratorConfig,
  types: GiaTypes,
  outputName = 'output.gia'
): Promise<Uint8Array> {
  const payload = bytesToPayload(templateGiaBytes)
  const bundleMessage = types.AssetBundle.decode(payload)
  const bundle = types.AssetBundle.toObject(bundleMessage, {
    longs: Number,
    enums: Number,
    bytes: Uint8Array,
    defaults: true,
  }) as any

  const parent = bundle.primary_resource
  if (!parent?.ui?.object) throw new Error('Template parent UI object not found')
  const parentGuid = getGuid(parent)
  if (!parentGuid) throw new Error('Could not determine parent GUID')

  setParentName(parent, config.parentName)

  const existing = [...(bundle.dependencies ?? [])]
  if (existing.length === 0) throw new Error('Template has no child dependencies')

  bundle.dependencies = bundle.dependencies ?? []
  if (bundle.dependencies.length > rects.length) {
    bundle.dependencies = bundle.dependencies.slice(0, rects.length)
  }

  let maxGuid = Math.max(parentGuid, ...bundle.dependencies.map((d: any) => getGuid(d)))
  let maxUiId = Math.max(0, ...bundle.dependencies.map((d: any) => getHiddenUiId(d) ?? 0))
  let cloneSourceIndex = 0

  while (bundle.dependencies.length < rects.length) {
    maxGuid += 1
    maxUiId += 1
    const source = existing[cloneSourceIndex % existing.length]
    cloneSourceIndex += 1
    const child = cloneChild(source, maxGuid, parentGuid)
    setUniqueUiIdentityAndName(child, maxUiId, `Rect ${bundle.dependencies.length + 1}`)
    bundle.dependencies.push(child)
  }

  for (let idx = 0; idx < rects.length; idx += 1) {
    const dep = bundle.dependencies[idx]
    const rect = rects[idx]

    const visibleWidth = rect.w * config.pixelSize
    const visibleHeight = rect.h * config.pixelSize
    const width = visibleWidth * config.fieldScale
    const height = visibleHeight * config.fieldScale

    const visibleCenterX = (rect.x + rect.w / 2 - imgWidth / 2) * config.pixelSize
    const visibleCenterY = config.yDown
      ? (rect.y + rect.h / 2 - imgHeight / 2) * config.pixelSize
      : (imgHeight / 2 - (rect.y + rect.h / 2)) * config.pixelSize

    const rotated = rotatePoint(visibleCenterX, visibleCenterY, config.imageRotation)
    const centerX = rotated.x * config.fieldScale
    const centerY = rotated.y * config.fieldScale

    const label = `Rect ${idx + 1}`
    let uiId = getHiddenUiId(dep)
    if (uiId == null) {
      maxUiId += 1
      uiId = maxUiId
    }
    setUniqueUiIdentityAndName(dep, uiId, label)
    setSquareValues(dep, label, centerX, centerY, width, height, rect.color, config.imageRotation)
  }

  bundle.internal_name = bundle.internal_name ?? config.parentName
  rebuildParentRefs(parent, bundle.dependencies, types.ResourceLocator)
  patchParentDescriptorNextId(parent, Math.max(parentGuid + 1, ...bundle.dependencies.map((d: any) => getGuid(d) + 1)))

  if (!config.keepParentPosition) {
    const bbox = rotatedBBoxSize(imgWidth * config.pixelSize, imgHeight * config.pixelSize, config.imageRotation)
    setParentTransform(parent, config.parentX, config.parentY, bbox.width * config.fieldScale, bbox.height * config.fieldScale)
  }

  bundle.export_tag = `600489258-0-${parentGuid}-\\${outputName}`
  if (!bundle.engine_version) bundle.engine_version = '6.6.0'

  const verified = types.AssetBundle.verify(bundle)
  if (verified) throw new Error(`Bundle verify failed: ${verified}`)

  const encoded = types.AssetBundle.encode(types.AssetBundle.fromObject(bundle)).finish() as Uint8Array
  return withGiaHeader(encoded)
}
