// Client Control Template `.gia` serializer.
//
//   Image Processing -> ImagePlan -> this module
//
// Reverse-engineered from the supplied `Client Image.gia`, which contains a
// container named "Image Container" holding two children, "Square" and
// "Circle", where Circle sits exactly +100 on X. See docs/client-gia-format.md
// for the field-by-field findings.
//
// Differences from the Server Control Template that this file encodes:
//
//   * container ResourceEntry.resource_class is 70, not 61
//   * the image primitive lives in property 73 / type 96, body field 84,
//     as { 502 = ARGB color, 503 = image resource ID } - the server's
//     UiShapeStyle (property 21 / type 38) must not appear
//   * children carry client-only marker properties 63/83, 74/97 and 67/90;
//     the container carries 63/83, 68/91, 67/90 and no size component
//   * the server-only properties 4/23, 38/56 and descriptor 6/55 are absent
//   * transform_array.unknown_502 is 23 on children and 25 on the container
//     (the server template uses 9 and omits it on the container)
//   * the hierarchy composites the other way round: a Client Control Template
//     renders its first child first, so later siblings cover earlier ones.
//     The children are therefore emitted back to front, the reverse of the
//     Server hierarchy - see the `compositing` option in imagePlan.ts.
//
// Everything else in the template - including fields whose purpose is still
// unknown - is carried through byte for byte. Generation works by parsing the
// supplied reference with the lossless codec in pbraw.ts, taking the container
// and one child as prototypes, and patching only the values that describe the
// converted image.

import {
  CLIENT_CONTAINER_RESOURCE_CLASS,
  UI_CONTROL_RESOURCE_CLASS,
  buildExportTag,
  bytesToPayload,
  encodeField501String,
  encodeField501Varint,
  encodeVarint,
  scaleForTransformEntry,
  withGiaHeader,
} from './giaCommon'
import { buildImagePlan, emptyPlannedShape, type ImagePlan, type PlannedShape } from './imagePlan'
import * as pb from './pbraw'
import type { GeneratorConfig, RectPlan } from './types'

/** Placeholder container name in the supplied reference. Never emitted. */
export const CLIENT_TEMPLATE_CONTAINER_NAME = 'Image Container'

// --- field numbers ---------------------------------------------------------

// ResourceEntry
const F_IDENTITY = 1
const F_REFERENCE_LIST = 2
const F_INTERNAL_NAME = 3
const F_RESOURCE_CLASS = 5
const F_UI = 19
// ResourceLocator
const F_ASSET_GUID = 4
// UiControlGroup
const F_UI_OBJECT = 1
// UiObject
const F_OBJ_GUID = 501
const F_OBJ_DESCRIPTORS = 502
const F_OBJ_CHILD_GUIDS = 503
const F_OBJ_PARENT_GUID = 504
const F_OBJ_PROPERTIES = 505
// UiProperty
const F_PROP_ID_REF = 11
const F_PROP_RAW_12 = 12
const F_PROP_RAW_14 = 14
const F_PROP_BODY = 503
const F_PROP_BINDING = 504
const F_PROP_ID = 501
const F_PROP_TYPE = 502
// Payload of the polymorphic raw_12 / raw_14 envelopes, and of UiIdRef.
const F_ENVELOPE_VALUE = 501
// UiPropertyBody
const F_BODY_TRANSFORM = 13
const F_BODY_IMAGE_STYLE = 84
// Client image style, body field 84
const F_IMAGE_COLOR = 502
const F_IMAGE_RESOURCE_ID = 503
// UiTransformComponent / array / entry / fields
const F_TRANSFORM_ARRAY = 12
const F_TRANSFORM_ENTRIES = 501
const F_ENTRY_FIELDS = 502
const F_FIELDS_POSITION = 504
const F_FIELDS_SIZE = 505
const F_FIELDS_ROTATION = 508
const F_VEC_X = 501
const F_VEC_Y = 502
const F_ROTATION_Z = 3
// AssetBundle
const F_BUNDLE_PRIMARY = 1
const F_BUNDLE_DEPENDENCY = 2
const F_BUNDLE_EXPORT_TAG = 3
const F_BUNDLE_ENGINE_VERSION = 5

// Property/descriptor coordinates, as (property_id, property_type).
const DESC_SELF_REF = [1, 5] as const
const DESC_UI_ID = [2, 6] as const
const DESC_NEXT_GUID = [4, 4] as const
const PROP_NAME = [2, 15] as const
const PROP_TRANSFORM = [1, 12] as const
const PROP_IMAGE_STYLE = [73, 96] as const

/** Records that only exist in Server Control Templates. */
const SERVER_ONLY_RECORDS: ReadonlyArray<readonly [number, number, string]> = [
  [21, 38, 'server shape style'],
  [4, 23, 'server layout component'],
  [38, 56, 'server size component'],
  [6, 55, 'server container descriptor'],
]

// Keeps memory flat on images that optimize down to very many rectangles.
const ENCODE_BATCH_SIZE = 1000

type PbMessage = pb.PbMessage
type PbField = pb.PbField

// --- record helpers --------------------------------------------------------

function propertyAt(list: PbField[], id: number, type: number): PbMessage | undefined {
  for (const entry of list) {
    const message = pb.asMessage(entry)
    if (pb.numberOf(message, F_PROP_ID) === id && pb.numberOf(message, F_PROP_TYPE) === type) return message
  }
  return undefined
}

function requireProperty(list: PbField[], coords: readonly [number, number], what: string): PbMessage {
  const found = propertyAt(list, coords[0], coords[1])
  if (!found) throw new Error(`Client template is missing the ${what} record (${coords[0]}/${coords[1]})`)
  return found
}

function assertNoServerOnlyRecords(uiObject: PbMessage, what: string): void {
  const lists = [pb.fields(uiObject, F_OBJ_DESCRIPTORS), pb.fields(uiObject, F_OBJ_PROPERTIES)]
  for (const [id, type, label] of SERVER_ONLY_RECORDS) {
    for (const list of lists) {
      if (propertyAt(list, id, type)) {
        throw new Error(`Client template ${what} carries the ${label} record (${id}/${type}), which is server-only`)
      }
    }
  }
}

/** Every GUID-bearing field reachable from one UI property record. */
function collectGuidFields(property: PbMessage, out: PbField[]): void {
  const idRef = pb.child(property, F_PROP_ID_REF)
  if (idRef) {
    // The transform's id_ref holds the constant 2 in valid exports, not a
    // GUID; rewriting it makes the editor ignore the transform entirely.
    const guid = pb.field(idRef, F_ENVELOPE_VALUE)
    if (guid?.wire === pb.WIRE_VARINT && (guid.varint ?? 0n) > 0xffffn) out.push(guid)
  }
  for (const path of [[F_PROP_BINDING], [F_PROP_BODY, F_PROP_BINDING]]) {
    const binding = pb.child(property, ...path)
    if (!binding) continue
    const guid = pb.field(binding, F_ASSET_GUID)
    if (guid?.wire === pb.WIRE_VARINT) out.push(guid)
  }
}

/**
 * Guards the GUID rewrite. Every reference to the template's own GUID has to
 * be in the collected field list; one hiding inside a record this build does
 * not model yet would leave the generated file pointing at a missing object.
 */
function assertNoStaleGuid(record: PbMessage, templateGuid: number, what: string): void {
  const probe = encodeVarint(templateGuid)
  const bytes = pb.serializeMessage(record)
  outer: for (let i = 0; i + probe.length <= bytes.length; i += 1) {
    for (let j = 0; j < probe.length; j += 1) if (bytes[i + j] !== probe[j]) continue outer
    throw new Error(
      `Client template ${what} still references GUID ${templateGuid} through a record this build does not understand`,
    )
  }
}

// --- transforms ------------------------------------------------------------

interface TransformHandles {
  positionX: PbField
  positionY: PbField
  sizeX: PbField
  sizeY: PbField
  rotation: PbMessage
  deviceScale: number
}

function transformHandles(property: PbMessage, what: string): TransformHandles[] {
  const array = pb.child(property, F_PROP_BODY, F_BODY_TRANSFORM, F_TRANSFORM_ARRAY)
  if (!array) throw new Error(`Client template ${what} has no transform array`)
  const entries = pb.fields(array, F_TRANSFORM_ENTRIES)
  if (entries.length === 0) throw new Error(`Client template ${what} transform array has no entries`)
  return entries.map((entry, index) => {
    const fields = pb.child(pb.asMessage(entry), F_ENTRY_FIELDS)
    if (!fields) throw new Error(`Client template ${what} transform entry ${index} has no fields`)
    const position = pb.ensureChild(fields, F_FIELDS_POSITION)
    const size = pb.ensureChild(fields, F_FIELDS_SIZE)
    return {
      positionX: pb.ensureField(position, F_VEC_X, pb.WIRE_FIXED32),
      positionY: pb.ensureField(position, F_VEC_Y, pb.WIRE_FIXED32),
      sizeX: pb.ensureField(size, F_VEC_X, pb.WIRE_FIXED32),
      sizeY: pb.ensureField(size, F_VEC_Y, pb.WIRE_FIXED32),
      rotation: pb.ensureChild(fields, F_FIELDS_ROTATION),
      deviceScale: 1,
    }
  })
}

function applyTransform(
  handles: TransformHandles[],
  x: number,
  y: number,
  width: number,
  height: number,
  rotationDegrees: number,
) {
  for (const handle of handles) {
    const scale = handle.deviceScale
    pb.setFloat(handle.positionX, x * scale)
    pb.setFloat(handle.positionY, y * scale)
    pb.setFloat(handle.sizeX, width * scale)
    pb.setFloat(handle.sizeY, height * scale)
    if (Math.abs(rotationDegrees) < 1e-6) {
      pb.removeField(handle.rotation, F_ROTATION_Z)
    } else {
      pb.setFloat(pb.ensureField(handle.rotation, F_ROTATION_Z, pb.WIRE_FIXED32), rotationDegrees)
    }
  }
}

// --- child prototype -------------------------------------------------------

/** Mutable handles into the child prototype, resolved once. */
interface ChildHandles {
  record: PbMessage
  templateGuid: number
  guidFields: PbField[]
  parentGuidField: PbField
  internalNameField: PbField
  nameEnvelopeField: PbField
  uiIdField: PbField
  colorField: PbField
  imageIdField: PbField
  transforms: TransformHandles[]
}

function prepareChild(record: PbMessage, templateGuid: number): ChildHandles {
  const identity = pb.child(record, F_IDENTITY)
  if (!identity) throw new Error('Client template child has no identity')
  const uiObject = pb.child(record, F_UI, F_UI_OBJECT)
  if (!uiObject) throw new Error('Client template child has no UI object')
  assertNoServerOnlyRecords(uiObject, 'child')

  const guidFields: PbField[] = [
    pb.ensureField(identity, F_ASSET_GUID, pb.WIRE_VARINT),
    pb.ensureField(uiObject, F_OBJ_GUID, pb.WIRE_VARINT),
  ]

  const descriptors = pb.fields(uiObject, F_OBJ_DESCRIPTORS)
  const properties = pb.fields(uiObject, F_OBJ_PROPERTIES)

  collectGuidFields(requireProperty(descriptors, DESC_SELF_REF, 'child self-reference descriptor'), guidFields)
  for (const property of properties) collectGuidFields(pb.asMessage(property), guidFields)

  const uiIdDescriptor = requireProperty(descriptors, DESC_UI_ID, 'child UI identity descriptor')
  const nameProperty = requireProperty(properties, PROP_NAME, 'child name')
  const imageStyle = requireProperty(properties, PROP_IMAGE_STYLE, 'child image style')
  const imageBody = pb.child(imageStyle, F_PROP_BODY, F_BODY_IMAGE_STYLE)
  if (!imageBody) throw new Error('Client template child image style has no value body (503/84)')
  const transformProperty = requireProperty(properties, PROP_TRANSFORM, 'child transform')

  return {
    record,
    templateGuid,
    guidFields,
    parentGuidField: pb.ensureField(uiObject, F_OBJ_PARENT_GUID, pb.WIRE_VARINT),
    internalNameField: pb.ensureField(record, F_INTERNAL_NAME, pb.WIRE_LENGTH),
    nameEnvelopeField: pb.ensureField(nameProperty, F_PROP_RAW_12, pb.WIRE_LENGTH),
    uiIdField: pb.ensureField(uiIdDescriptor, F_PROP_RAW_12, pb.WIRE_LENGTH),
    colorField: pb.ensureField(imageBody, F_IMAGE_COLOR, pb.WIRE_VARINT),
    imageIdField: pb.ensureField(imageBody, F_IMAGE_RESOURCE_ID, pb.WIRE_VARINT),
    transforms: transformHandles(transformProperty, 'child'),
  }
}

function applyShape(handles: ChildHandles, shape: PlannedShape, parentGuid: number, scales: number[]) {
  for (const field of handles.guidFields) pb.setVarint(field, shape.guid)
  pb.setVarint(handles.parentGuidField, parentGuid)
  pb.setString(handles.internalNameField, shape.label)
  pb.setBytes(handles.nameEnvelopeField, encodeField501String(shape.label))
  pb.setBytes(handles.uiIdField, encodeField501Varint(shape.uiId))
  pb.setVarint(handles.colorField, shape.colorArgb >>> 0)
  pb.setVarint(handles.imageIdField, shape.imageId)
  for (let i = 0; i < handles.transforms.length; i += 1) handles.transforms[i].deviceScale = scales[i] ?? 1
  applyTransform(handles.transforms, shape.x, shape.y, shape.width, shape.height, shape.rotationDegrees)
}

// --- template ---------------------------------------------------------------

export interface ClientTemplate {
  bundle: PbMessage
  container: PbMessage
  /** Child records keyed by their template name, e.g. Square and Circle. */
  childrenByName: Map<string, PbMessage>
  containerGuid: number
  containerUiId: number
  engineVersion: string
}

export function parseClientTemplate(templateGiaBytes: Uint8Array): ClientTemplate {
  const bundle = pb.parseMessage(bytesToPayload(templateGiaBytes))
  const primary = pb.child(bundle, F_BUNDLE_PRIMARY)
  if (!primary) throw new Error('Client template has no primary resource')

  const containerClass = pb.numberOf(primary, F_RESOURCE_CLASS)
  if (containerClass !== CLIENT_CONTAINER_RESOURCE_CLASS) {
    throw new Error(
      `Client template container has resource class ${containerClass}, expected ${CLIENT_CONTAINER_RESOURCE_CLASS}`,
    )
  }

  const identity = pb.child(primary, F_IDENTITY)
  if (!identity) throw new Error('Client template container has no identity')
  const uiObject = pb.child(primary, F_UI, F_UI_OBJECT)
  if (!uiObject) throw new Error('Client template container has no UI object')
  assertNoServerOnlyRecords(uiObject, 'container')

  const containerGuid = pb.numberOf(identity, F_ASSET_GUID) ?? 0
  if (containerGuid === 0) throw new Error('Could not determine the client container GUID')

  const uiIdDescriptor = requireProperty(
    pb.fields(uiObject, F_OBJ_DESCRIPTORS),
    DESC_UI_ID,
    'container UI identity descriptor',
  )
  const uiIdRaw = pb.field(uiIdDescriptor, F_PROP_RAW_12)
  const containerUiId = uiIdRaw ? (pb.numberOf(pb.asMessage(uiIdRaw), F_ENVELOPE_VALUE) ?? 0) : 0

  const childrenByName = new Map<string, PbMessage>()
  for (const dependency of pb.fields(bundle, F_BUNDLE_DEPENDENCY)) {
    const record = pb.asMessage(dependency)
    const name = pb.stringOf(record, F_INTERNAL_NAME)
    if (name) childrenByName.set(name, record)
  }
  if (childrenByName.size === 0) throw new Error('Client template has no child controls')

  return {
    bundle,
    container: primary,
    childrenByName,
    containerGuid,
    containerUiId,
    engineVersion: pb.stringOf(bundle, F_BUNDLE_ENGINE_VERSION) ?? '7.1.0',
  }
}

/** Container identity, so callers can build a matching ImagePlan. */
export function readClientTemplateIdentity(templateGiaBytes: Uint8Array): { rootGuid: number; rootUiId: number } {
  const template = parseClientTemplate(templateGiaBytes)
  return { rootGuid: template.containerGuid, rootUiId: template.containerUiId }
}

// --- container --------------------------------------------------------------

function prepareContainer(template: ClientTemplate, plan: ImagePlan): PbMessage {
  const record = template.container
  const identity = pb.child(record, F_IDENTITY)!
  const uiObject = pb.child(record, F_UI, F_UI_OBJECT)!

  const guid = plan.container.guid
  const guidFields: PbField[] = [
    pb.ensureField(identity, F_ASSET_GUID, pb.WIRE_VARINT),
    pb.ensureField(uiObject, F_OBJ_GUID, pb.WIRE_VARINT),
  ]

  const descriptors = pb.fields(uiObject, F_OBJ_DESCRIPTORS)
  const properties = pb.fields(uiObject, F_OBJ_PROPERTIES)
  collectGuidFields(requireProperty(descriptors, DESC_SELF_REF, 'container self-reference descriptor'), guidFields)
  for (const property of properties) collectGuidFields(pb.asMessage(property), guidFields)
  for (const field of guidFields) pb.setVarint(field, guid)

  // The generated container must not keep the reference file's placeholder.
  const name = plan.container.name
  if (!name.trim() || name === CLIENT_TEMPLATE_CONTAINER_NAME) {
    throw new Error(
      `Client image container needs a generated name; refusing to export with the placeholder "${CLIENT_TEMPLATE_CONTAINER_NAME}"`,
    )
  }
  pb.setString(pb.ensureField(record, F_INTERNAL_NAME, pb.WIRE_LENGTH), name)
  pb.setBytes(
    pb.ensureField(requireProperty(properties, PROP_NAME, 'container name'), F_PROP_RAW_12, pb.WIRE_LENGTH),
    encodeField501String(name),
  )

  const uiIdDescriptor = requireProperty(descriptors, DESC_UI_ID, 'container UI identity descriptor')
  pb.setBytes(pb.ensureField(uiIdDescriptor, F_PROP_RAW_12, pb.WIRE_LENGTH), encodeField501Varint(plan.container.uiId))

  const nextGuidDescriptor = propertyAt(descriptors, DESC_NEXT_GUID[0], DESC_NEXT_GUID[1])
  if (nextGuidDescriptor) {
    const marker = pb.ensureChild(nextGuidDescriptor, F_PROP_RAW_14)
    pb.setBytes(pb.ensureField(marker, F_ENVELOPE_VALUE, pb.WIRE_LENGTH), encodeVarint(plan.nextFreeGuid()))
  }

  // reference_list holds one locator per child; child_guids is packed varints.
  const locatorTemplate = pb.fields(record, F_REFERENCE_LIST)[0]
  if (!locatorTemplate) throw new Error('Client template container has no reference list')
  const locators: PbField[] = []
  const childGuidBytes: Uint8Array[] = []
  let childGuidLength = 0
  for (let idx = 0; idx < plan.count; idx += 1) {
    const childGuid = plan.guidAt(idx)
    const encoded = encodeVarint(childGuid)
    childGuidBytes.push(encoded)
    childGuidLength += encoded.length
    const locator = pb.cloneMessage(pb.asMessage(locatorTemplate))
    pb.setVarint(pb.ensureField(locator, F_ASSET_GUID, pb.WIRE_VARINT), childGuid)
    locators.push(pb.bytesField(F_REFERENCE_LIST, pb.serializeMessage(locator)))
  }
  pb.replaceFields(record, F_REFERENCE_LIST, locators)

  const packed = new Uint8Array(childGuidLength)
  let offset = 0
  for (const part of childGuidBytes) {
    packed.set(part, offset)
    offset += part.length
  }
  pb.replaceFields(uiObject, F_OBJ_CHILD_GUIDS, [pb.bytesField(F_OBJ_CHILD_GUIDS, packed)])

  if (plan.container.applyTransform) {
    const handles = transformHandles(requireProperty(properties, PROP_TRANSFORM, 'container transform'), 'container')
    for (let i = 0; i < handles.length; i += 1) handles[i].deviceScale = scaleForTransformEntry(plan.deviceScales, i)
    applyTransform(handles, plan.container.x, plan.container.y, plan.container.width, plan.container.height, 0)
  }

  if (guid !== template.containerGuid) assertNoStaleGuid(record, template.containerGuid, 'container')
  return record
}

// --- bundle -----------------------------------------------------------------

/** Writes one `AssetBundle` field header plus body into a growing part list. */
function writeTagged(parts: Uint8Array[], fieldNo: number, body: Uint8Array): void {
  const tag = encodeVarint((fieldNo << 3) | pb.WIRE_LENGTH)
  const len = encodeVarint(body.length)
  const out = new Uint8Array(tag.length + len.length + body.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(body, tag.length + len.length)
  parts.push(out)
}

/**
 * Serializes an ImagePlan as a Client Control Template `.gia`, using the
 * supplied client reference as the structural template.
 */
export function serializeClientGia(
  plan: ImagePlan,
  templateGiaBytes: Uint8Array,
  outputName = 'output.gia',
  onProgress?: (encoded: number, total: number) => void,
): Blob {
  const template = parseClientTemplate(templateGiaBytes)

  const prototypeName = template.childrenByName.has('Square')
    ? 'Square'
    : [...template.childrenByName.keys()][0]
  const prototypeRecord = template.childrenByName.get(prototypeName)
  if (!prototypeRecord) throw new Error('Client template has no usable child control')

  const childClass = pb.numberOf(prototypeRecord, F_RESOURCE_CLASS)
  if (childClass !== UI_CONTROL_RESOURCE_CLASS) {
    throw new Error(`Client template child has resource class ${childClass}, expected ${UI_CONTROL_RESOURCE_CLASS}`)
  }
  const prototypeGuid = pb.numberOf(pb.child(prototypeRecord, F_IDENTITY)!, F_ASSET_GUID) ?? 0

  const parts: Uint8Array[] = []
  writeTagged(parts, F_BUNDLE_PRIMARY, pb.serializeMessage(prepareContainer(template, plan)))

  if (plan.count > 0) {
    const child = prepareChild(prototypeRecord, prototypeGuid)
    const scales = [0, 1, 2, 3].map((index) => scaleForTransformEntry(plan.deviceScales, index))
    const shape = emptyPlannedShape()
    for (let idx = 0; idx < plan.count; idx += 1) {
      plan.shapeAt(idx, shape)
      applyShape(child, shape, plan.container.guid, scales)
      const body = pb.serializeMessage(child.record)
      if (idx === 0 && shape.guid !== prototypeGuid) assertNoStaleGuid(child.record, prototypeGuid, 'child')
      writeTagged(parts, F_BUNDLE_DEPENDENCY, body)
      if ((idx + 1) % ENCODE_BATCH_SIZE === 0) onProgress?.(idx + 1, plan.count)
    }
  }

  const encoder = new TextEncoder()
  writeTagged(parts, F_BUNDLE_EXPORT_TAG, encoder.encode(buildExportTag(plan.container.guid, outputName)))
  writeTagged(parts, F_BUNDLE_ENGINE_VERSION, encoder.encode(template.engineVersion))

  return withGiaHeader(parts)
}

export async function buildClientGiaFromRects(
  templateGiaBytes: Uint8Array,
  rects: RectPlan[],
  imgWidth: number,
  imgHeight: number,
  config: GeneratorConfig,
  outputName = 'output.gia',
  onProgress?: (encoded: number, total: number) => void,
): Promise<Blob> {
  const identity = readClientTemplateIdentity(templateGiaBytes)
  const plan = buildImagePlan(rects, imgWidth, imgHeight, config, {
    // Object GUIDs come from the shared IMAGE_ROOT_GUID so a Client Image and
    // a Server Image of the same picture describe the same objects; only the
    // UI identity sequence is template-local.
    rootUiId: identity.rootUiId,
    // Earlier in the hierarchy renders first and is covered by later
    // siblings, so overlapping primitives have to be emitted back to front.
    compositing: 'first-behind',
  })
  return serializeClientGia(plan, templateGiaBytes, outputName, onProgress)
}
