// Logical Image Representation.
//
//   Image Processing -> ImagePlan -> Server .gia serializer
//   Image Processing -> ImagePlan -> Client .gia serializer
//
// Everything that depends on the source pixels, the conversion settings and
// the optimizer output lives here: object identity, names, image resource IDs,
// colors and transforms. Neither serializer recomputes any of it; they only
// decide how to write it into their own container format.
//
// Shapes are produced on demand rather than materialised as an array. A large
// image can optimize down to hundreds of thousands of rectangles, and holding
// one object per rectangle is what used to exhaust memory during export.
//
// The plan also owns the mapping from hierarchy position to rectangle, because
// the two Control Templates composite their children in opposite directions.

import { IMAGE_ROOT_GUID, imageResourceId } from './giaCommon'
import type { DeviceScales, GeneratorConfig, RectPlan, ShapeKind } from './types'
import { rotatePoint, rotatedBBoxSize } from './utils'

/**
 * How a Control Template turns hierarchy position into draw order.
 *
 * - `first-on-top`: the first child is drawn last, so it covers its later
 *   siblings. Server Control Templates behave this way, which is why the
 *   converter's default export layer order is front-to-back.
 * - `first-behind`: the first child is drawn first, so later siblings are
 *   painted on top of it. Client Control Templates behave this way.
 */
export type HierarchyCompositing = 'first-on-top' | 'first-behind'

export interface PlannedShape {
  /** Position among the container's children, top of the hierarchy first. */
  index: number
  /** Object GUID. Shared by both exporters. */
  guid: number
  /** Per-object UI identity number, unique within the bundle. */
  uiId: number
  /** Display / internal name. */
  label: string
  /** Built-in image primitive, e.g. square or circle. */
  shape: ShapeKind
  /** Engine image resource ID for `shape`. Shared by both exporters. */
  imageId: number
  /** AARRGGBB. */
  colorArgb: number
  /** Local position relative to the container, before device scaling. */
  x: number
  y: number
  width: number
  height: number
  rotationDegrees: number
}

export interface PlannedContainer {
  guid: number
  uiId: number
  name: string
  x: number
  y: number
  width: number
  height: number
  /** False when the caller asked to keep the template's own placement. */
  applyTransform: boolean
}

export interface ImagePlan {
  container: PlannedContainer
  count: number
  deviceScales: DeviceScales
  sourceWidth: number
  sourceHeight: number
  compositing: HierarchyCompositing
  /** GUID of the child at hierarchy position `index`. */
  guidAt(index: number): number
  /** First GUID after the container and all of its children. */
  nextFreeGuid(): number
  /** Fills and returns `out`, avoiding an allocation per child. */
  shapeAt(index: number, out: PlannedShape): PlannedShape
}

export interface ImagePlanOptions {
  /** Container GUID. Defaults to the shared `IMAGE_ROOT_GUID`. */
  rootGuid?: number
  /** UI identity number of the container. Children follow sequentially. */
  rootUiId?: number
  /** Names children `${labelPrefix} ${n}`, numbered by rectangle. */
  labelPrefix?: string
  /** Draw order of the target Control Template. Defaults to `first-on-top`. */
  compositing?: HierarchyCompositing
}

export function emptyPlannedShape(): PlannedShape {
  return {
    index: 0,
    guid: 0,
    uiId: 0,
    label: '',
    shape: 'square',
    imageId: imageResourceId('square'),
    colorArgb: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotationDegrees: 0,
  }
}

export function buildImagePlan(
  rects: RectPlan[],
  imgWidth: number,
  imgHeight: number,
  config: GeneratorConfig,
  options: ImagePlanOptions = {},
): ImagePlan {
  const rootGuid = options.rootGuid ?? IMAGE_ROOT_GUID
  const rootUiId = options.rootUiId ?? 0
  const labelPrefix = options.labelPrefix ?? 'Rect'
  const compositing = options.compositing ?? 'first-on-top'

  // `optimizeImage` hands over its rectangles ordered for a `first-on-top`
  // hierarchy: `exportLayerOrder` decides whether index 0 is the topmost
  // rectangle (front-to-back, the default) or the backmost one. A template
  // that composites the other way round has to walk the same list backwards,
  // or the background rectangles would be painted over the foreground.
  //
  // Object identity stays attached to the rectangle rather than to the
  // hierarchy slot, so a given rectangle keeps one GUID, UI identity and name
  // across both exports even though the two hierarchies run opposite ways.
  const flip = compositing === 'first-behind'
  const rectIndexAt = (position: number) => (flip ? rects.length - 1 - position : position)

  const bbox = rotatedBBoxSize(imgWidth * config.pixelSize, imgHeight * config.pixelSize, config.imageRotation)
  const rotation = ((config.imageRotation % 360) + 360) % 360

  const container: PlannedContainer = {
    guid: rootGuid,
    uiId: rootUiId,
    name: config.parentName,
    x: config.parentX,
    y: config.parentY,
    width: bbox.width * config.fieldScale,
    height: bbox.height * config.fieldScale,
    applyTransform: !config.keepParentPosition,
  }

  return {
    container,
    count: rects.length,
    deviceScales: config.deviceScales,
    sourceWidth: imgWidth,
    sourceHeight: imgHeight,
    compositing,
    guidAt(index) {
      return rootGuid + 1 + rectIndexAt(index)
    },
    nextFreeGuid() {
      return rootGuid + 1 + rects.length
    },
    shapeAt(index, out) {
      const rectIndex = rectIndexAt(index)
      const rect = rects[rectIndex]
      if (!rect) throw new Error(`No rectangle at hierarchy position ${index}`)

      const visibleWidth = rect.w * config.pixelSize
      const visibleHeight = rect.h * config.pixelSize
      const visibleCenterX = (rect.x + rect.w / 2 - imgWidth / 2) * config.pixelSize
      const visibleCenterY = config.yDown
        ? (rect.y + rect.h / 2 - imgHeight / 2) * config.pixelSize
        : (imgHeight / 2 - (rect.y + rect.h / 2)) * config.pixelSize
      const rotated = rotatePoint(visibleCenterX, visibleCenterY, config.imageRotation)

      out.index = index
      out.guid = rootGuid + 1 + rectIndex
      out.uiId = rootUiId + 1 + rectIndex
      out.label = `${labelPrefix} ${rectIndex + 1}`
      out.shape = rect.shape ?? 'square'
      out.imageId = imageResourceId(out.shape)
      out.colorArgb = rect.color >>> 0
      out.x = rotated.x * config.fieldScale
      out.y = rotated.y * config.fieldScale
      out.width = visibleWidth * config.fieldScale
      out.height = visibleHeight * config.fieldScale
      out.rotationDegrees = rotation
      return out
    },
  }
}
