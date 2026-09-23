import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'
import type { GeneratorConfig, RectPlan } from '../src/lib/types'
import type { GiaTypes } from '../src/lib/gia'

const root = new URL('../', import.meta.url)

export function assetBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`public/${name}`, root))))
}

export const serverTemplateBytes = (): Uint8Array => assetBytes('template.gia')
export const clientTemplateBytes = (): Uint8Array => assetBytes('client-template.gia')

let cachedTypes: GiaTypes | null = null

export function giaTypes(): GiaTypes {
  if (!cachedTypes) {
    const protoText = readFileSync(fileURLToPath(new URL('public/gia_with_ui_rotation_v6.proto', root)), 'utf8')
    const parsed = protobuf.parse(protoText, { keepCase: true }).root
    cachedTypes = {
      root: parsed,
      AssetBundle: parsed.lookupType('AssetBundle'),
      ResourceEntry: parsed.lookupType('ResourceEntry'),
      ResourceLocator: parsed.lookupType('ResourceLocator'),
    }
  }
  return cachedTypes
}

export function testConfig(overrides: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return {
    optimization: 'exact',
    pixelSize: 10,
    imageRotation: 0,
    parentName: 'Mario',
    parentX: 0,
    parentY: 0,
    fieldScale: 0.5,
    deviceScales: { desktop: 1, mobile: 1, controller: 1, mobileController: 1 },
    keepParentPosition: false,
    yDown: false,
    exportLayerOrder: 'front-to-back',
    maxMergePasses: 200,
    maxOverdrawRatio: 2.5,
    safeTimeSeconds: 10,
    underpaintMaxBBoxRatio: 6,
    underpaintMinComponentPixels: 8,
    underpaintMinSavings: 2,
    underpaintBeamWidth: 64,
    underpaintBeamCandidates: 256,
    stage1Passes: 1200,
    stage1Ratio: 3,
    stage2Passes: 2000,
    stage2Ratio: 10,
    ...overrides,
  }
}

/** Minimal stand-in for the browser's ImageData. */
export function imageData(width: number, height: number, pixels: number[][]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b, a] = pixels[i] ?? [0, 0, 0, 0]
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData
}

/** Solid-colour image, handy for size/perf cases. */
export function gradientImage(width: number, height: number): ImageData {
  const pixels: number[][] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.push([(x * 7) % 256, (y * 11) % 256, (x * y) % 256, 255])
    }
  }
  return imageData(width, height, pixels)
}

export function rect(x: number, y: number, w: number, h: number, color: number, shape?: RectPlan['shape']): RectPlan {
  return shape ? { x, y, w, h, color, shape } : { x, y, w, h, color }
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
