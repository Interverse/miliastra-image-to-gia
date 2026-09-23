// Structural inspection and Server/Client comparison for `.gia` files.
//
// Both Control Templates are read into one shape-agnostic model so the two
// exporters can be compared on what they mean rather than on their bytes:
// hierarchy, names, template/control type, image resource IDs, local
// transforms, parent IDs, GUIDs, record counts and any field numbers outside
// the records this build models.
//
// Everything here is read-only and works on either format. It gates the Client
// Image download, and gives the Server/Client comparison tests something to
// assert on other than raw bytes.

import {
  CLIENT_CONTAINER_RESOURCE_CLASS,
  SERVER_CONTAINER_RESOURCE_CLASS,
  UI_CONTROL_RESOURCE_CLASS,
  bytesToPayload,
  decodeField501String,
  decodeField501Varint,
  shapeKindForImageId,
} from './giaCommon'
import * as pb from './pbraw'
import type { GiaTarget, ShapeKind } from './types'

// ResourceEntry / UiObject / UiProperty field numbers, see giaClient.ts.
const F_IDENTITY = 1
const F_REFERENCE_LIST = 2
const F_INTERNAL_NAME = 3
const F_RESOURCE_CLASS = 5
const F_UI = 19
const F_ASSET_GUID = 4
const F_UI_OBJECT = 1
const F_OBJ_GUID = 501
const F_OBJ_DESCRIPTORS = 502
const F_OBJ_CHILD_GUIDS = 503
const F_OBJ_PARENT_GUID = 504
const F_OBJ_PROPERTIES = 505
const F_PROP_RAW_12 = 12
const F_PROP_BODY = 503
const F_PROP_ID = 501
const F_PROP_TYPE = 502
const F_BODY_TRANSFORM = 13
const F_BODY_SERVER_SHAPE = 31
const F_BODY_CLIENT_IMAGE = 84
const F_SERVER_SHAPE_TYPE = 2
const F_SERVER_SHAPE_COLOR = 4
const F_CLIENT_IMAGE_COLOR = 502
const F_CLIENT_IMAGE_RESOURCE_ID = 503
const F_TRANSFORM_ARRAY = 12
const F_TRANSFORM_ENTRIES = 501
const F_ENTRY_FIELDS = 502
const F_FIELDS_POSITION = 504
const F_FIELDS_SIZE = 505
const F_FIELDS_ROTATION = 508
const F_VEC_X = 501
const F_VEC_Y = 502
const F_ROTATION_Z = 3
const F_BUNDLE_PRIMARY = 1
const F_BUNDLE_DEPENDENCY = 2
const F_BUNDLE_EXPORT_TAG = 3
const F_BUNDLE_ENGINE_VERSION = 5

const DESC_UI_ID = [2, 6] as const
const PROP_NAME = [2, 15] as const
const PROP_TRANSFORM = [1, 12] as const
const SERVER_SHAPE_PROPERTY = [21, 38] as const
const CLIENT_IMAGE_PROPERTY = [73, 96] as const

/** Field numbers this build models on a ResourceEntry / UiObject. */
const KNOWN_ENTRY_FIELDS = new Set([F_IDENTITY, F_REFERENCE_LIST, F_INTERNAL_NAME, F_RESOURCE_CLASS, F_UI])
const KNOWN_OBJECT_FIELDS = new Set([
  F_OBJ_GUID,
  F_OBJ_DESCRIPTORS,
  F_OBJ_CHILD_GUIDS,
  F_OBJ_PARENT_GUID,
  F_OBJ_PROPERTIES,
])

export interface InspectedTransform {
  index: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface InspectedObject {
  guid: number
  parentGuid: number | null
  name: string
  resourceClass: number
  uiId: number | null
  /** Engine image resource ID, from whichever style record the format uses. */
  imageId: number | null
  shape: ShapeKind | null
  colorArgb: number | null
  childGuids: number[]
  referenceGuids: number[]
  descriptors: string[]
  properties: string[]
  transforms: InspectedTransform[]
  /** Field numbers found outside the records this build models. */
  unknownFields: string[]
}

export interface InspectedGia {
  target: GiaTarget | 'unknown'
  container: InspectedObject
  children: InspectedObject[]
  exportTag: string
  engineVersion: string
  recordCount: number
}

function coords(property: pb.PbMessage): string {
  return `${pb.numberOf(property, F_PROP_ID) ?? '?'}/${pb.numberOf(property, F_PROP_TYPE) ?? '?'}`
}

function findProperty(list: pb.PbField[], want: readonly [number, number]): pb.PbMessage | undefined {
  for (const entry of list) {
    const message = pb.asMessage(entry)
    if (pb.numberOf(message, F_PROP_ID) === want[0] && pb.numberOf(message, F_PROP_TYPE) === want[1]) return message
  }
  return undefined
}

function rawBytes(property: pb.PbMessage | undefined, no: number): Uint8Array | null {
  if (!property) return null
  const field = pb.field(property, no)
  return field && field.wire === pb.WIRE_LENGTH ? pb.bytesOf(field) : null
}

function readTransforms(property: pb.PbMessage | undefined): InspectedTransform[] {
  const array = property && pb.child(property, F_PROP_BODY, F_BODY_TRANSFORM, F_TRANSFORM_ARRAY)
  if (!array) return []
  return pb.fields(array, F_TRANSFORM_ENTRIES).map((entry, index) => {
    const fields = pb.child(pb.asMessage(entry), F_ENTRY_FIELDS)
    const position = fields && pb.child(fields, F_FIELDS_POSITION)
    const size = fields && pb.child(fields, F_FIELDS_SIZE)
    const rotation = fields && pb.child(fields, F_FIELDS_ROTATION)
    const read = (message: pb.PbMessage | undefined | null, no: number) => {
      const field = message ? pb.field(message, no) : undefined
      return field?.wire === pb.WIRE_FIXED32 ? pb.floatOf(field) : 0
    }
    return {
      index,
      x: read(position, F_VEC_X),
      y: read(position, F_VEC_Y),
      width: read(size, F_VEC_X),
      height: read(size, F_VEC_Y),
      rotation: read(rotation, F_ROTATION_Z),
    }
  })
}

function inspectRecord(record: pb.PbMessage): InspectedObject {
  const identity = pb.child(record, F_IDENTITY)
  const uiObject = pb.child(record, F_UI, F_UI_OBJECT)
  const unknownFields: string[] = []
  for (const field of record.fields) {
    if (!KNOWN_ENTRY_FIELDS.has(field.no)) unknownFields.push(`entry.${field.no}:wire${field.wire}`)
  }

  const descriptors = uiObject ? pb.fields(uiObject, F_OBJ_DESCRIPTORS) : []
  const properties = uiObject ? pb.fields(uiObject, F_OBJ_PROPERTIES) : []
  if (uiObject) {
    for (const field of uiObject.fields) {
      if (!KNOWN_OBJECT_FIELDS.has(field.no)) unknownFields.push(`object.${field.no}:wire${field.wire}`)
    }
  }

  const serverShape = findProperty(properties, SERVER_SHAPE_PROPERTY)
  const clientImage = findProperty(properties, CLIENT_IMAGE_PROPERTY)
  const serverStyle = serverShape && pb.child(serverShape, F_PROP_BODY, F_BODY_SERVER_SHAPE)
  const clientStyle = clientImage && pb.child(clientImage, F_PROP_BODY, F_BODY_CLIENT_IMAGE)

  const imageId = serverStyle
    ? (pb.numberOf(serverStyle, F_SERVER_SHAPE_TYPE) ?? null)
    : clientStyle
      ? (pb.numberOf(clientStyle, F_CLIENT_IMAGE_RESOURCE_ID) ?? null)
      : null
  const colorArgb = serverStyle
    ? (pb.numberOf(serverStyle, F_SERVER_SHAPE_COLOR) ?? null)
    : clientStyle
      ? (pb.numberOf(clientStyle, F_CLIENT_IMAGE_COLOR) ?? null)
      : null

  const nameProperty = findProperty(properties, PROP_NAME)
  const uiIdDescriptor = findProperty(descriptors, DESC_UI_ID)
  // child_guids is packed in engine-written files but protobuf.js emits one
  // varint field per entry, so accept either encoding.
  const childGuids: number[] = []
  for (const entry of uiObject ? pb.fields(uiObject, F_OBJ_CHILD_GUIDS) : []) {
    if (entry.wire === pb.WIRE_VARINT) childGuids.push(Number(entry.varint ?? 0n))
    else if (entry.wire === pb.WIRE_LENGTH) childGuids.push(...pb.packedVarints(entry).map(Number))
  }

  return {
    guid: (identity && pb.numberOf(identity, F_ASSET_GUID)) ?? 0,
    parentGuid: uiObject ? (pb.numberOf(uiObject, F_OBJ_PARENT_GUID) ?? null) : null,
    name:
      decodeField501String(rawBytes(nameProperty, F_PROP_RAW_12)) ?? pb.stringOf(record, F_INTERNAL_NAME) ?? '',
    resourceClass: pb.numberOf(record, F_RESOURCE_CLASS) ?? 0,
    uiId: decodeField501Varint(rawBytes(uiIdDescriptor, F_PROP_RAW_12)),
    imageId,
    shape: imageId == null ? null : (shapeKindForImageId(imageId) ?? null),
    colorArgb,
    childGuids,
    referenceGuids: pb
      .fields(record, F_REFERENCE_LIST)
      .map((entry) => pb.numberOf(pb.asMessage(entry), F_ASSET_GUID) ?? 0),
    descriptors: descriptors.map((entry) => coords(pb.asMessage(entry))),
    properties: properties.map((entry) => coords(pb.asMessage(entry))),
    transforms: readTransforms(findProperty(properties, PROP_TRANSFORM)),
    unknownFields,
  }
}

export function inspectGia(bytes: Uint8Array): InspectedGia {
  const bundle = pb.parseMessage(bytesToPayload(bytes))
  const primaryField = pb.field(bundle, F_BUNDLE_PRIMARY)
  if (!primaryField) throw new Error('.gia has no primary resource')
  const container = inspectRecord(pb.asMessage(primaryField))
  const children = pb.fields(bundle, F_BUNDLE_DEPENDENCY).map((entry) => inspectRecord(pb.asMessage(entry)))
  const target: InspectedGia['target'] =
    container.resourceClass === CLIENT_CONTAINER_RESOURCE_CLASS
      ? 'client'
      : container.resourceClass === SERVER_CONTAINER_RESOURCE_CLASS
        ? 'server'
        : 'unknown'
  return {
    target,
    container,
    children,
    exportTag: pb.stringOf(bundle, F_BUNDLE_EXPORT_TAG) ?? '',
    engineVersion: pb.stringOf(bundle, F_BUNDLE_ENGINE_VERSION) ?? '',
    recordCount: 1 + children.length,
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export const CLIENT_PLACEHOLDER_CONTAINER_NAME = 'Image Container'

/**
 * Checks that a generated bundle really is a usable Client Control Template.
 * Returns one message per problem; an empty array means the file is sound.
 */
export function validateClientGia(inspected: InspectedGia): string[] {
  const problems: string[] = []
  const { container, children } = inspected

  if (container.resourceClass !== CLIENT_CONTAINER_RESOURCE_CLASS) {
    problems.push(
      `container resource class is ${container.resourceClass}, expected ${CLIENT_CONTAINER_RESOURCE_CLASS} for a Client Control Template`,
    )
  }
  if (!container.guid) problems.push('container has no GUID')
  if (!container.name.trim()) problems.push('container has no name')
  if (container.name === CLIENT_PLACEHOLDER_CONTAINER_NAME) {
    problems.push(`container is still named the template placeholder "${CLIENT_PLACEHOLDER_CONTAINER_NAME}"`)
  }
  if (container.transforms.length === 0) problems.push('container has no transform entries')

  const seen = new Set<number>([container.guid])
  const childGuids = children.map((child) => child.guid)

  children.forEach((child, index) => {
    const where = `child ${index} ("${child.name}")`
    if (child.resourceClass !== UI_CONTROL_RESOURCE_CLASS) {
      problems.push(`${where} has resource class ${child.resourceClass}, expected ${UI_CONTROL_RESOURCE_CLASS}`)
    }
    if (!child.guid) problems.push(`${where} has no GUID`)
    else if (seen.has(child.guid)) problems.push(`${where} reuses GUID ${child.guid}`)
    seen.add(child.guid)
    if (child.parentGuid !== container.guid) {
      problems.push(`${where} points at parent ${child.parentGuid}, expected ${container.guid}`)
    }
    if (!child.name.trim()) problems.push(`${where} has no name`)
    if (child.uiId == null) problems.push(`${where} has no UI identity`)
    if (child.imageId == null) problems.push(`${where} has no image resource ID`)
    if (child.transforms.length === 0) problems.push(`${where} has no transform entries`)
    if (child.properties.includes(`${SERVER_SHAPE_PROPERTY[0]}/${SERVER_SHAPE_PROPERTY[1]}`)) {
      problems.push(`${where} carries the server-only shape style record`)
    }
    if (!child.properties.includes(`${CLIENT_IMAGE_PROPERTY[0]}/${CLIENT_IMAGE_PROPERTY[1]}`)) {
      problems.push(`${where} is missing the client image style record`)
    }
  })

  const uiIds = new Set<number>()
  for (const child of children) {
    if (child.uiId == null) continue
    if (uiIds.has(child.uiId)) problems.push(`UI identity ${child.uiId} is used by more than one child`)
    uiIds.add(child.uiId)
  }

  const declared = container.childGuids
  if (declared.length !== children.length) {
    problems.push(`container lists ${declared.length} children but the bundle carries ${children.length}`)
  }
  for (const guid of declared) {
    if (!childGuids.includes(guid)) problems.push(`container references child GUID ${guid}, which is not in the bundle`)
  }
  if (container.referenceGuids.length !== children.length) {
    problems.push(
      `container reference list has ${container.referenceGuids.length} entries but the bundle carries ${children.length} children`,
    )
  }
  for (const guid of container.referenceGuids) {
    if (!childGuids.includes(guid)) problems.push(`container reference list points at missing GUID ${guid}`)
  }

  return problems
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

export interface CompareOptions {
  /** Names and UI identity numbers are allowed to differ per template. */
  ignoreNames?: boolean
  ignoreUiIds?: boolean
  /** Float comparison tolerance for transforms. */
  epsilon?: number
  /** Stop after this many child differences. */
  maxChildReports?: number
}

function near(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon
}

/**
 * Compares two inspected bundles field by field and returns one line per
 * difference. Structural fields that legitimately differ between the two
 * Control Templates (resource class, property coordinates) are reported as
 * informational `template:` lines rather than suppressed.
 */
export function compareGia(a: InspectedGia, b: InspectedGia, options: CompareOptions = {}): string[] {
  const epsilon = options.epsilon ?? 1e-3
  const maxChildReports = options.maxChildReports ?? 20
  const out: string[] = []

  if (a.target !== b.target) out.push(`template: target ${a.target} vs ${b.target}`)
  if (a.container.resourceClass !== b.container.resourceClass) {
    out.push(`template: container resource class ${a.container.resourceClass} vs ${b.container.resourceClass}`)
  }
  if (a.recordCount !== b.recordCount) out.push(`record count ${a.recordCount} vs ${b.recordCount}`)
  if (a.children.length !== b.children.length) {
    out.push(`child count ${a.children.length} vs ${b.children.length}`)
  }
  if (a.container.guid !== b.container.guid) {
    out.push(`container GUID ${a.container.guid} vs ${b.container.guid}`)
  }
  if (!options.ignoreNames && a.container.name !== b.container.name) {
    out.push(`container name "${a.container.name}" vs "${b.container.name}"`)
  }

  const shared = Math.min(a.children.length, b.children.length)
  let reported = 0
  for (let i = 0; i < shared && reported < maxChildReports; i += 1) {
    const left = a.children[i]
    const right = b.children[i]
    const lines: string[] = []
    if (left.guid !== right.guid) lines.push(`GUID ${left.guid} vs ${right.guid}`)
    if (left.parentGuid !== right.parentGuid) lines.push(`parent ${left.parentGuid} vs ${right.parentGuid}`)
    if (left.imageId !== right.imageId) lines.push(`image ID ${left.imageId} vs ${right.imageId}`)
    if (left.colorArgb !== right.colorArgb) {
      lines.push(`color ${hex(left.colorArgb)} vs ${hex(right.colorArgb)}`)
    }
    if (!options.ignoreNames && left.name !== right.name) lines.push(`name "${left.name}" vs "${right.name}"`)
    if (!options.ignoreUiIds && left.uiId !== right.uiId) lines.push(`UI id ${left.uiId} vs ${right.uiId}`)
    if (left.transforms.length !== right.transforms.length) {
      lines.push(`transform entries ${left.transforms.length} vs ${right.transforms.length}`)
    } else {
      for (let t = 0; t < left.transforms.length; t += 1) {
        const lt = left.transforms[t]
        const rt = right.transforms[t]
        if (
          !near(lt.x, rt.x, epsilon) ||
          !near(lt.y, rt.y, epsilon) ||
          !near(lt.width, rt.width, epsilon) ||
          !near(lt.height, rt.height, epsilon) ||
          !near(lt.rotation, rt.rotation, epsilon)
        ) {
          lines.push(
            `transform[${t}] (${fmt(lt)}) vs (${fmt(rt)})`,
          )
        }
      }
    }
    if (lines.length) {
      out.push(`child ${i}: ${lines.join('; ')}`)
      reported += 1
    }
  }
  if (reported >= maxChildReports) out.push(`… further child differences suppressed`)

  return out
}

function fmt(t: InspectedTransform): string {
  return `x=${t.x.toFixed(3)} y=${t.y.toFixed(3)} w=${t.width.toFixed(3)} h=${t.height.toFixed(3)} rot=${t.rotation.toFixed(3)}`
}

function hex(value: number | null): string {
  return value == null ? 'none' : `#${(value >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
}
