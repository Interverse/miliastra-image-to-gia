// The Server Image exporter is the pre-existing implementation. Refactoring it
// onto the shared ImagePlan must not change a single byte it produces, so this
// compares it against the implementation as it stood before the split.

import { describe, expect, it } from 'vitest'
import { buildGiaFromRects, readServerTemplateIdentity } from '../src/lib/gia'
import { buildGiaFromRects as legacyBuildGiaFromRects } from './fixtures/legacyGia'
import { IMAGE_RESOURCE_IDS, IMAGE_ROOT_GUID } from '../src/lib/giaCommon'
import { optimizeImage } from '../src/lib/optimizer'
import { blobBytes, giaTypes, gradientImage, imageData, rect, serverTemplateBytes, testConfig } from './helpers'
import type { RectPlan } from '../src/lib/types'

const cases: { name: string; rects: RectPlan[]; width: number; height: number }[] = [
  { name: '1x1', rects: [rect(0, 0, 1, 1, 0xff112233)], width: 1, height: 1 },
  {
    name: 'small multicolour',
    rects: [
      rect(0, 0, 1, 1, 0xffff0000),
      rect(1, 0, 1, 1, 0xff00ff00),
      rect(0, 1, 2, 1, 0xff0000ff),
    ],
    width: 2,
    height: 2,
  },
  {
    name: 'more rectangles than template children',
    rects: Array.from({ length: 23 }, (_, i) => rect(i % 5, Math.floor(i / 5), 1, 1, 0xff000000 | (i * 7919))),
    width: 5,
    height: 5,
  },
]

describe('server exporter', () => {
  it('builds object IDs from the shared container GUID', () => {
    const identity = readServerTemplateIdentity(serverTemplateBytes(), giaTypes())
    expect(identity.rootGuid).toBe(IMAGE_ROOT_GUID)
  })

  for (const testCase of cases) {
    it(`produces byte-identical output to the previous implementation: ${testCase.name}`, async () => {
      const config = testConfig()
      const types = giaTypes()
      const [next, previous] = await Promise.all([
        buildGiaFromRects(
          serverTemplateBytes(),
          testCase.rects,
          testCase.width,
          testCase.height,
          config,
          types,
          'Mario.gia',
        ),
        legacyBuildGiaFromRects(
          serverTemplateBytes(),
          testCase.rects,
          testCase.width,
          testCase.height,
          config,
          types,
          'Mario.gia',
        ),
      ])
      const [a, b] = await Promise.all([blobBytes(next), blobBytes(previous)])
      expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
    })
  }

  it('is unchanged for rotated, scaled and y-down configurations', async () => {
    const config = testConfig({
      imageRotation: 37.5,
      pixelSize: 3.25,
      fieldScale: 0.75,
      yDown: true,
      parentX: -40,
      parentY: 12,
      deviceScales: { desktop: 1, mobile: 0.5, controller: 1.25, mobileController: 2 },
    })
    const rects = optimizeImage(gradientImage(12, 9), config)
    const types = giaTypes()
    const [next, previous] = await Promise.all([
      buildGiaFromRects(serverTemplateBytes(), rects, 12, 9, config, types, 'Mario.gia'),
      legacyBuildGiaFromRects(serverTemplateBytes(), rects, 12, 9, config, types, 'Mario.gia'),
    ])
    const [a, b] = await Promise.all([blobBytes(next), blobBytes(previous)])
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
  })

  it('is unchanged when the parent position is kept', async () => {
    const config = testConfig({ keepParentPosition: true })
    const rects = optimizeImage(imageData(3, 3, Array.from({ length: 9 }, (_, i) => [i * 20, 40, 60, 255])), config)
    const types = giaTypes()
    const [next, previous] = await Promise.all([
      buildGiaFromRects(serverTemplateBytes(), rects, 3, 3, config, types, 'Mario.gia'),
      legacyBuildGiaFromRects(serverTemplateBytes(), rects, 3, 3, config, types, 'Mario.gia'),
    ])
    const [a, b] = await Promise.all([blobBytes(next), blobBytes(previous)])
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
  })

  it('still defaults every rectangle to the square image resource', async () => {
    const { inspectGia } = await import('../src/lib/giaInspect')
    const config = testConfig()
    const blob = await buildGiaFromRects(
      serverTemplateBytes(),
      [rect(0, 0, 1, 1, 0xff123456)],
      1,
      1,
      config,
      giaTypes(),
      'Mario.gia',
    )
    const inspected = inspectGia(await blobBytes(blob))
    expect(inspected.target).toBe('server')
    expect(inspected.children[0].imageId).toBe(IMAGE_RESOURCE_IDS.square)
    expect(inspected.children[0].colorArgb).toBe(0xff123456)
  })
})
