// Both exporters must describe the same converted image: same pixel layout,
// colours, dimensions and — above all — the same image resource IDs. Only the
// surrounding Control Template structure may differ.
//
// The two templates composite their children in opposite directions, so the
// hierarchies are deliberately mirror images of each other:
//
//   Server: first child drawn last  -> first child is on top
//   Client: first child drawn first -> later children cover earlier ones
//
// The decisive check is therefore not "same order" but "same picture": each
// bundle is decoded back to rectangles, repainted under its own draw order,
// and compared against the source pixels.
//
// The current converter has no animation/sprite mode, so the closest existing
// capabilities are covered instead: rotation, pixel size, field scale and the
// four per-device transform entries.

import { describe, expect, it } from 'vitest'
import { buildGiaFromRects } from '../src/lib/gia'
import { buildClientGiaFromRects } from '../src/lib/giaClient'
import { IMAGE_RESOURCE_IDS } from '../src/lib/giaCommon'
import { compareGia, inspectGia, validateClientGia, type InspectedGia } from '../src/lib/giaInspect'
import { optimizeImage } from '../src/lib/optimizer'
import type { GeneratorConfig, RectPlan } from '../src/lib/types'
import {
  blobBytes,
  clientTemplateBytes,
  giaTypes,
  gradientImage,
  imageData,
  rect,
  serverTemplateBytes,
  testConfig,
} from './helpers'

async function exportBoth(rects: RectPlan[], width: number, height: number, config: GeneratorConfig) {
  const [serverBlob, clientBlob] = await Promise.all([
    buildGiaFromRects(serverTemplateBytes(), rects, width, height, config, giaTypes(), 'Mario.gia'),
    buildClientGiaFromRects(clientTemplateBytes(), rects, width, height, config, 'Mario.gia'),
  ])
  const [serverBytes, clientBytes] = await Promise.all([blobBytes(serverBlob), blobBytes(clientBlob)])
  return { server: inspectGia(serverBytes), client: inspectGia(clientBytes) }
}

// --- rasterizing a decoded bundle -------------------------------------------

/**
 * Config whose transforms map straight back to source pixels: one field unit
 * per pixel, no rotation, no per-device scaling, Y increasing downwards.
 */
function pixelPerfectConfig(overrides: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return testConfig({ pixelSize: 1, fieldScale: 1, yDown: true, imageRotation: 0, ...overrides })
}

interface DecodedRect {
  x: number
  y: number
  w: number
  h: number
  color: number
}

/** Turns a decoded bundle back into pixel rectangles, in hierarchy order. */
function decodeRects(bundle: InspectedGia, width: number, height: number): DecodedRect[] {
  return bundle.children.map((child) => {
    const t = child.transforms[0]
    return {
      x: Math.round(t.x + width / 2 - t.width / 2),
      y: Math.round(t.y + height / 2 - t.height / 2),
      w: Math.round(t.width),
      h: Math.round(t.height),
      color: (child.colorArgb ?? 0) >>> 0,
    }
  })
}

/**
 * Paints a decoded bundle the way its own template would: a Server hierarchy
 * back to front is the reverse of the child list, a Client hierarchy is the
 * child list as it stands.
 */
function rasterize(bundle: InspectedGia, width: number, height: number): Uint32Array {
  const decoded = decodeRects(bundle, width, height)
  const drawOrder = bundle.target === 'client' ? decoded : [...decoded].reverse()
  const canvas = new Uint32Array(width * height)
  for (const r of drawOrder) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        canvas[y * width + x] = r.color
      }
    }
  }
  return canvas
}

/** The source pixels as ARGB, matching the optimizer's own convention. */
function sourceCanvas(source: ImageData): Uint32Array {
  const canvas = new Uint32Array(source.width * source.height)
  for (let i = 0; i < canvas.length; i += 1) {
    const [r, g, b, a] = [source.data[i * 4], source.data[i * 4 + 1], source.data[i * 4 + 2], source.data[i * 4 + 3]]
    canvas[i] = a === 0 ? 0 : (((a << 24) | (r << 16) | (g << 8) | b) >>> 0)
  }
  return canvas
}

function hex(canvas: Uint32Array, width: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < canvas.length / width; y += 1) {
    rows.push(
      Array.from(canvas.subarray(y * width, (y + 1) * width))
        .map((value) => value.toString(16).padStart(8, '0'))
        .join(' '),
    )
  }
  return rows
}

// --- structural equivalence --------------------------------------------------

const scenarios: {
  name: string
  rects: RectPlan[]
  width: number
  height: number
  config?: Partial<GeneratorConfig>
}[] = [
  { name: '1x1 image', rects: [rect(0, 0, 1, 1, 0xff3366cc)], width: 1, height: 1 },
  {
    name: 'small multicolour image',
    rects: [
      rect(0, 0, 1, 1, 0xffff0000),
      rect(1, 0, 1, 1, 0xff00ff00),
      rect(2, 0, 1, 1, 0xff0000ff),
      rect(0, 1, 3, 1, 0xffffff00),
    ],
    width: 3,
    height: 2,
  },
  {
    name: 'transparent pixels',
    rects: [rect(0, 0, 1, 1, 0x00000000), rect(1, 0, 1, 1, 0x80ff00ff), rect(0, 1, 2, 1, 0xffffffff)],
    width: 2,
    height: 2,
  },
  {
    name: 'merged regions',
    rects: [rect(2, 1, 4, 2, 0xffe0e0e0), rect(0, 0, 8, 4, 0xff202020)],
    width: 8,
    height: 4,
  },
  {
    name: 'square resource only',
    rects: [rect(0, 0, 1, 1, 0xffffffff, 'square'), rect(1, 0, 1, 1, 0xff888888, 'square')],
    width: 2,
    height: 1,
  },
  {
    name: 'circle resource only',
    rects: [rect(0, 0, 1, 1, 0xffffffff, 'circle'), rect(1, 0, 1, 1, 0xff888888, 'circle')],
    width: 2,
    height: 1,
  },
  {
    name: 'mixed square and circle resources',
    rects: [
      rect(0, 0, 1, 1, 0xffff0000, 'square'),
      rect(1, 0, 1, 1, 0xff00ff00, 'circle'),
      rect(2, 0, 1, 1, 0xff0000ff, 'square'),
      rect(3, 0, 1, 1, 0xffffff00, 'circle'),
    ],
    width: 4,
    height: 1,
  },
  {
    name: 'rotated and per-device scaled',
    rects: [rect(0, 0, 2, 1, 0xff112233), rect(0, 1, 1, 2, 0xff445566)],
    width: 2,
    height: 3,
    config: {
      imageRotation: 42.5,
      pixelSize: 6.5,
      fieldScale: 0.75,
      deviceScales: { desktop: 1, mobile: 0.5, controller: 1.25, mobileController: 2 },
    },
  },
  {
    name: 'y-down coordinates',
    rects: [rect(0, 0, 1, 1, 0xff010203), rect(0, 1, 1, 1, 0xff040506)],
    width: 1,
    height: 2,
    config: { yDown: true },
  },
]

describe('server image vs client image', () => {
  for (const scenario of scenarios) {
    it(`describes the same picture: ${scenario.name}`, async () => {
      const config = testConfig(scenario.config)
      const { server, client } = await exportBoth(scenario.rects, scenario.width, scenario.height, config)

      // Structure is allowed to differ; meaning is not.
      expect(server.target).toBe('server')
      expect(client.target).toBe('client')
      expect(validateClientGia(client)).toEqual([])

      expect(client.children).toHaveLength(server.children.length)
      expect(client.children).toHaveLength(scenario.rects.length)

      // The Client hierarchy is the Server hierarchy back to front, because
      // the first Client child renders first instead of last.
      const serverBackToFront = [...server.children].reverse()

      // Image resource IDs must match exactly — one authoritative table.
      expect(client.children.map((child) => child.imageId)).toEqual(
        serverBackToFront.map((child) => child.imageId),
      )
      expect(client.children.map((child) => child.colorArgb)).toEqual(
        serverBackToFront.map((child) => child.colorArgb),
      )
      // Identity follows the rectangle, not the hierarchy slot, so the same
      // rectangle keeps one GUID and one name across both exports.
      expect(client.children.map((child) => child.guid)).toEqual(serverBackToFront.map((child) => child.guid))
      expect(client.children.map((child) => child.name)).toEqual(serverBackToFront.map((child) => child.name))
      expect(client.container.guid).toBe(server.container.guid)

      // Pixel layout, dimensions and rotation, per device profile.
      for (let i = 0; i < server.children.length; i += 1) {
        expect(client.children[i].transforms).toHaveLength(serverBackToFront[i].transforms.length)
        for (let t = 0; t < serverBackToFront[i].transforms.length; t += 1) {
          const left = serverBackToFront[i].transforms[t]
          const right = client.children[i].transforms[t]
          expect(right.x).toBeCloseTo(left.x, 3)
          expect(right.y).toBeCloseTo(left.y, 3)
          expect(right.width).toBeCloseTo(left.width, 3)
          expect(right.height).toBeCloseTo(left.height, 3)
          expect(right.rotation).toBeCloseTo(left.rotation, 3)
        }
      }

      // Container placement and size match too.
      expect(client.container.transforms[0].x).toBeCloseTo(server.container.transforms[0].x, 3)
      expect(client.container.transforms[0].y).toBeCloseTo(server.container.transforms[0].y, 3)
      expect(client.container.transforms[0].width).toBeCloseTo(server.container.transforms[0].width, 3)
      expect(client.container.transforms[0].height).toBeCloseTo(server.container.transforms[0].height, 3)

      // Comparing the Client against the reversed Server should leave only the
      // differences inherent to the two templates plus the UI id sequence.
      const mirrored: InspectedGia = { ...server, children: serverBackToFront }
      const differences = compareGia(mirrored, client, { ignoreNames: true })
      expect(differences.filter((line) => !line.startsWith('template:') && !line.includes('UI id'))).toEqual([])

      // Client structure follows the supplied reference's conventions.
      const referenceChildProperties = inspectGia(clientTemplateBytes()).children[0].properties
      for (const child of client.children) expect(child.properties).toEqual(referenceChildProperties)
      expect(client.container.name).not.toBe('Image Container')
      expect(client.container.name).toBe(config.parentName)
    })
  }

  it('keeps image IDs identical on a large optimized image', async () => {
    const config = testConfig({ optimization: 'exact' })
    const source = gradientImage(48, 36)
    const rects = optimizeImage(source, config)
    expect(rects.length).toBeGreaterThan(100)

    const { server, client } = await exportBoth(rects, 48, 36, config)
    expect(validateClientGia(client)).toEqual([])
    const serverBackToFront = [...server.children].reverse()
    expect(client.children.map((child) => child.imageId)).toEqual(serverBackToFront.map((child) => child.imageId))
    expect(client.children.map((child) => child.colorArgb)).toEqual(serverBackToFront.map((child) => child.colorArgb))
    expect(new Set(client.children.map((child) => child.guid)).size).toBe(rects.length)
    expect(new Set(client.children.map((child) => child.uiId)).size).toBe(rects.length)
  })

  it('uses one image resource table for both formats', async () => {
    const rects = [rect(0, 0, 1, 1, 0xffffffff, 'circle'), rect(1, 0, 1, 1, 0xffffffff, 'square')]
    const { server, client } = await exportBoth(rects, 2, 1, testConfig())
    expect(server.children.map((child) => child.imageId)).toEqual([
      IMAGE_RESOURCE_IDS.circle,
      IMAGE_RESOURCE_IDS.square,
    ])
    expect(client.children.map((child) => child.imageId)).toEqual(
      [...server.children].reverse().map((child) => child.imageId),
    )
    expect(client.children.map((child) => child.shape)).toEqual(['square', 'circle'])
  })

  it('keeps the optimizer output identical for both exports', () => {
    const config = testConfig({ optimization: 'safe-overdraw' })
    const source = imageData(
      6,
      6,
      Array.from({ length: 36 }, (_, i) => [(i * 13) % 256, (i * 29) % 256, 0, i % 5 === 0 ? 0 : 255]),
    )
    // One pipeline, one rectangle plan; the exporters only serialize it.
    const first = optimizeImage(source, config)
    const second = optimizeImage(source, config)
    expect(second).toEqual(first)
  })
})

// --- hierarchy ordering ------------------------------------------------------

describe('client hierarchy ordering', () => {
  it('puts a background primitive before the foreground that covers it', async () => {
    // A 8x4 dark background with a light patch painted over its middle. The
    // optimizer emits front to back, so the foreground comes first.
    const background = rect(0, 0, 8, 4, 0xff202020)
    const foreground = rect(2, 1, 4, 2, 0xffe0e0e0)
    const { server, client } = await exportBoth([foreground, background], 8, 4, pixelPerfectConfig())

    // Server: first child is on top, so the foreground leads.
    expect(server.children.map((child) => child.colorArgb)).toEqual([0xffe0e0e0, 0xff202020])
    // Client: first child renders first, so the background has to lead or it
    // would be painted over the foreground.
    expect(client.children.map((child) => child.colorArgb)).toEqual([0xff202020, 0xffe0e0e0])

    const decoded = decodeRects(client, 8, 4)
    expect(decoded[0]).toMatchObject({ x: 0, y: 0, w: 8, h: 4, color: 0xff202020 })
    expect(decoded[1]).toMatchObject({ x: 2, y: 1, w: 4, h: 2, color: 0xffe0e0e0 })
  })

  it('declares child GUIDs and references in hierarchy order', async () => {
    const rects = [rect(0, 0, 1, 1, 0xff111111), rect(1, 0, 1, 1, 0xff222222), rect(2, 0, 1, 1, 0xff333333)]
    const { server, client } = await exportBoth(rects, 3, 1, pixelPerfectConfig())

    const clientGuids = client.children.map((child) => child.guid)
    expect(client.container.childGuids).toEqual(clientGuids)
    expect(client.container.referenceGuids).toEqual(clientGuids)
    // The mirrored hierarchy means the Client's declared GUID list descends.
    expect(clientGuids).toEqual([...server.children.map((child) => child.guid)].reverse())
    expect(validateClientGia(client)).toEqual([])
  })

  it('mirrors the Server hierarchy for either export layer order', async () => {
    const rects = [rect(2, 1, 4, 2, 0xffe0e0e0), rect(0, 0, 8, 4, 0xff202020)]
    for (const exportLayerOrder of ['front-to-back', 'back-to-front'] as const) {
      const { server, client } = await exportBoth(rects, 8, 4, pixelPerfectConfig({ exportLayerOrder }))
      expect(client.children.map((child) => child.guid)).toEqual(
        [...server.children.map((child) => child.guid)].reverse(),
      )
      // Both bundles always resolve to the same picture, whichever way the
      // user asked the Server hierarchy to be laid out.
      expect(hex(rasterize(client, 8, 4), 8)).toEqual(hex(rasterize(server, 8, 4), 8))
    }
  })
})

// --- compositing fidelity ----------------------------------------------------

describe('rendering the exported bundles', () => {
  const pictures: { name: string; source: ImageData; optimization: GeneratorConfig['optimization'] }[] = []
  for (const optimization of ['exact', 'fast-overdraw', 'safe-overdraw'] as const) {
    pictures.push(
      { name: `1x1 (${optimization})`, source: imageData(1, 1, [[0x33, 0x66, 0xcc, 255]]), optimization },
      {
        name: `small multicolour (${optimization})`,
        source: imageData(3, 3, [
          [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
          [255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255],
          [255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255],
        ]),
        optimization,
      },
      {
        name: `transparency (${optimization})`,
        source: imageData(4, 3, [
          [0, 0, 0, 0], [10, 20, 30, 255], [10, 20, 30, 255], [0, 0, 0, 0],
          [0, 0, 0, 0], [10, 20, 30, 255], [90, 90, 90, 255], [0, 0, 0, 0],
          [40, 50, 60, 128], [10, 20, 30, 255], [10, 20, 30, 255], [0, 0, 0, 0],
        ]),
        optimization,
      },
      {
        name: `nested regions, heavy overlap (${optimization})`,
        source: imageData(
          10,
          8,
          Array.from({ length: 80 }, (_, i) => {
            const x = i % 10
            const y = Math.floor(i / 10)
            if (x >= 3 && x <= 6 && y >= 2 && y <= 5) return [230, 230, 230, 255]
            if (x >= 1 && x <= 8 && y >= 1 && y <= 6) return [120, 60, 160, 255]
            return [20, 20, 20, 255]
          }),
        ),
        optimization,
      },
      { name: `large gradient (${optimization})`, source: gradientImage(24, 18), optimization },
    )
  }

  for (const picture of pictures) {
    it(`reproduces the source pixels in both formats: ${picture.name}`, async () => {
      const config = pixelPerfectConfig({ optimization: picture.optimization })
      const { width, height } = picture.source
      const rects = optimizeImage(picture.source, config)
      const { server, client } = await exportBoth(rects, width, height, config)

      expect(validateClientGia(client)).toEqual([])

      const expected = hex(sourceCanvas(picture.source), width)
      // Each bundle is repainted under its own draw order. If the Client
      // children were emitted front to back, the background rectangles would
      // cover the foreground and this would fail.
      expect(hex(rasterize(client, width, height), width)).toEqual(expected)
      expect(hex(rasterize(server, width, height), width)).toEqual(expected)
    })
  }

  it('would not reproduce the picture if the client hierarchy were not mirrored', async () => {
    // Guards the fix itself: painting the Client children in Server order has
    // to visibly break an overlapping picture, otherwise these tests would
    // pass no matter which direction the exporter chose.
    const source = imageData(
      6,
      4,
      Array.from({ length: 24 }, (_, i) => {
        const x = i % 6
        const y = Math.floor(i / 6)
        return x >= 2 && x <= 3 && y >= 1 && y <= 2 ? [230, 230, 230, 255] : [20, 20, 20, 255]
      }),
    )
    const config = pixelPerfectConfig({ optimization: 'safe-overdraw' })
    const rects = optimizeImage(source, config)
    const { client } = await exportBoth(rects, 6, 4, config)

    const wrongWayRound: InspectedGia = { ...client, children: [...client.children].reverse() }
    const expected = hex(sourceCanvas(source), 6)
    expect(hex(rasterize(client, 6, 4), 6)).toEqual(expected)
    expect(hex(rasterize(wrongWayRound, 6, 4), 6)).not.toEqual(expected)
  })
})
