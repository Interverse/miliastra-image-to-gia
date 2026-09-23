// The Client container is an image covering the source image rectangle.
//
// Two properties have to hold, and both are about geometry rather than about
// the records themselves:
//
//   * the container rect is the SOURCE IMAGE rect, never a content bounding
//     box, so switching the in-game mask on reproduces what the source shows
//   * child offsets are relative to that rect's centre, so an element at the
//     image centre lands on the container's centre, and
//     childOffset + containerOffset == the element's position in the group
//
// This project already expressed child positions relative to the image centre
// and already sized the container to the source image, so switching to an
// image parent did not need an offset-compensation pass. These tests pin that
// down rather than assume it.

import { describe, expect, it } from 'vitest'
import { buildClientGiaFromRects } from '../src/lib/giaClient'
import { CLIENT_CONTAINER_COLOR_ARGB, IMAGE_RESOURCE_IDS } from '../src/lib/giaCommon'
import { inspectGia, validateClientGia } from '../src/lib/giaInspect'
import { optimizeImage } from '../src/lib/optimizer'
import type { GeneratorConfig } from '../src/lib/types'
import { blobBytes, clientTemplateBytes, imageData, rect, testConfig } from './helpers'

async function clientImage(
  rects: Parameters<typeof buildClientGiaFromRects>[1],
  width: number,
  height: number,
  config: GeneratorConfig,
) {
  const blob = await buildClientGiaFromRects(clientTemplateBytes(), rects, width, height, config, 'Mario.gia')
  return inspectGia(await blobBytes(blob))
}

describe('client image container', () => {
  it('is an image with the rectangle resource, fully transparent, mask off', async () => {
    const generated = await clientImage([rect(0, 0, 1, 1, 0xff112233)], 1, 1, testConfig())
    expect(validateClientGia(generated)).toEqual([])
    expect(generated.container.imageId).toBe(IMAGE_RESOURCE_IDS.square)
    expect(generated.container.colorArgb).toBe(CLIENT_CONTAINER_COLOR_ARGB)
    // Alpha 0, so the parent is never drawn over its children.
    expect((generated.container.colorArgb ?? 0) >>> 24).toBe(0)
    expect(generated.container.maskEnabled).toBe(false)
    expect(generated.container.properties).toContain('73/96')
    expect(generated.container.properties).toContain('74/97')
    expect(generated.container.properties).not.toContain('68/91')
  })

  it('sizes the rect to the source image, in the same units as the children', async () => {
    // 20x12 source at 4 field units per pixel.
    const config = testConfig({ pixelSize: 4, fieldScale: 1 })
    const generated = await clientImage([rect(0, 0, 20, 12, 0xff112233)], 20, 12, config)
    for (const t of generated.container.transforms) {
      expect(t.width).toBeCloseTo(20 * 4, 3)
      expect(t.height).toBeCloseTo(12 * 4, 3)
    }
    // A child covering the whole image is exactly the same size as the rect.
    expect(generated.children[0].transforms[0].width).toBeCloseTo(20 * 4, 3)
    expect(generated.children[0].transforms[0].height).toBeCloseTo(12 * 4, 3)
  })

  it('uses the source image rect, not a content bounding box', async () => {
    // A 16x16 canvas with a single opaque pixel in one corner. A content
    // bounding box would be 1x1; the source rect is 16x16.
    const pixels = Array.from({ length: 256 }, (_, i) => (i === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
    const source = imageData(16, 16, pixels)
    const config = testConfig({ pixelSize: 1, fieldScale: 1 })
    const rects = optimizeImage(source, config)
    expect(rects).toHaveLength(1)

    const generated = await clientImage(rects, 16, 16, config)
    expect(generated.container.transforms[0].width).toBeCloseTo(16, 3)
    expect(generated.container.transforms[0].height).toBeCloseTo(16, 3)
    // The lone child is still just one pixel, so the rect cannot have been
    // derived from the content.
    expect(generated.children[0].transforms[0].width).toBeCloseTo(1, 3)
  })

  it('is emitted for a fully transparent export too', async () => {
    // Nothing to draw at all: the parent image is structural, so it must not
    // depend on the fitting result.
    const source = imageData(4, 4, Array.from({ length: 16 }, () => [0, 0, 0, 0]))
    const config = testConfig({ pixelSize: 1, fieldScale: 1 })
    const rects = optimizeImage(source, config)
    expect(rects).toHaveLength(0)

    const generated = await clientImage(rects, 4, 4, config)
    expect(generated.children).toHaveLength(0)
    expect(generated.container.imageId).toBe(IMAGE_RESOURCE_IDS.square)
    expect(generated.container.maskEnabled).toBe(false)
    expect(generated.container.transforms[0].width).toBeCloseTo(4, 3)
    expect(generated.container.transforms[0].height).toBeCloseTo(4, 3)
    expect(validateClientGia(generated)).toEqual([])
  })
})

describe('child offsets relative to the container rect', () => {
  it('puts an element at the image centre on the container centre', async () => {
    // Odd dimensions so there is a single centre pixel.
    const config = testConfig({ pixelSize: 10, fieldScale: 1 })
    const generated = await clientImage([rect(2, 2, 1, 1, 0xff112233)], 5, 5, config)
    const centre = generated.children[0].transforms[0]
    expect(centre.x).toBeCloseTo(0, 6)
    expect(centre.y).toBeCloseTo(0, 6)
  })

  it('keeps childOffset + containerOffset equal to the element position', async () => {
    // The container is placed away from the origin; children must not be
    // shifted a second time to compensate.
    const parentX = 137.5
    const parentY = -42.25
    const rects = [
      rect(0, 0, 1, 1, 0xff111111),
      rect(3, 1, 2, 2, 0xff222222),
      rect(5, 3, 1, 1, 0xff333333),
    ]
    const width = 6
    const height = 4
    const pixelSize = 8
    const base = testConfig({ pixelSize, fieldScale: 1, parentX: 0, parentY: 0 })
    const moved = testConfig({ pixelSize, fieldScale: 1, parentX, parentY })

    const atOrigin = await clientImage(rects, width, height, base)
    const displaced = await clientImage(rects, width, height, moved)

    // Only the container moved.
    expect(displaced.container.transforms[0].x).toBeCloseTo(parentX, 4)
    expect(displaced.container.transforms[0].y).toBeCloseTo(parentY, 4)
    expect(atOrigin.container.transforms[0].x).toBeCloseTo(0, 4)

    for (let i = 0; i < rects.length; i += 1) {
      const child = displaced.children[i].transforms[0]
      const unmoved = atOrigin.children[i].transforms[0]
      // Child offsets are unchanged: they are relative to the container rect,
      // so the whole group moves with the parent and the content does not
      // shift inside it.
      expect(child.x).toBeCloseTo(unmoved.x, 4)
      expect(child.y).toBeCloseTo(unmoved.y, 4)

      // childOffset + containerOffset == the element's position in the group.
      const absoluteX = displaced.container.transforms[0].x + child.x
      const absoluteY = displaced.container.transforms[0].y + child.y
      expect(absoluteX).toBeCloseTo(parentX + unmoved.x, 4)
      expect(absoluteY).toBeCloseTo(parentY + unmoved.y, 4)
    }
  })

  it('places every child inside the container rect for a full-coverage image', async () => {
    const config = testConfig({ pixelSize: 1, fieldScale: 1 })
    const source = imageData(
      8,
      6,
      Array.from({ length: 48 }, (_, i) => [(i * 17) % 256, (i * 31) % 256, 64, 255]),
    )
    const rects = optimizeImage(source, config)
    const generated = await clientImage(rects, 8, 6, config)

    const container = generated.container.transforms[0]
    const halfW = container.width / 2
    const halfH = container.height / 2
    for (const child of generated.children) {
      const t = child.transforms[0]
      expect(t.x - t.width / 2).toBeGreaterThanOrEqual(-halfW - 1e-3)
      expect(t.x + t.width / 2).toBeLessThanOrEqual(halfW + 1e-3)
      expect(t.y - t.height / 2).toBeGreaterThanOrEqual(-halfH - 1e-3)
      expect(t.y + t.height / 2).toBeLessThanOrEqual(halfH + 1e-3)
    }
  })

  it('follows the reference sign convention: +Y is up', async () => {
    // Top row and bottom row of a 1x2 image.
    const config = testConfig({ pixelSize: 10, fieldScale: 1, yDown: false })
    const generated = await clientImage([rect(0, 0, 1, 1, 0xff111111), rect(0, 1, 1, 1, 0xff222222)], 1, 2, config)
    const byColor = new Map(generated.children.map((child) => [child.colorArgb, child.transforms[0]]))
    // The reference has Square flush to the container's top at a positive Y,
    // so the source image's top row must also land at a positive Y.
    expect(byColor.get(0xff111111)!.y).toBeGreaterThan(0)
    expect(byColor.get(0xff222222)!.y).toBeLessThan(0)
  })
})
