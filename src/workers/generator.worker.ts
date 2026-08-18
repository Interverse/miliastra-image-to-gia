/// <reference lib="webworker" />
import { buildGiaFromRects } from '../lib/gia'
import { createJsonExport } from '../lib/json'
import { optimizeImage } from '../lib/optimizer'
import { loadGiaTypes } from '../lib/proto'
import type { GeneratorConfig, GenerationStats, JsonExportMode } from '../lib/types'

export interface WorkerRequest {
  imageData: ImageData
  config: GeneratorConfig
  assetBase: string
  fileName: string
  output: 'gia' | 'json'
  jsonMode?: JsonExportMode
}

export type WorkerResponse =
  | { type: 'progress'; message: string }
  | {
      type: 'gia-done'
      giaBytes: ArrayBuffer
      downloadName: string
      stats: GenerationStats
    }
  | {
      type: 'json-done'
      json: string
      downloadName: string
      stats: GenerationStats
    }
  | { type: 'error'; error: string }

const ctx: DedicatedWorkerGlobalScope = self as never

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const started = performance.now()
    const { imageData, config, assetBase, fileName, output, jsonMode = 'raw' } = event.data

    const send = (message: string) => {
      ctx.postMessage({ type: 'progress', message } satisfies WorkerResponse)
    }

    send('Optimizing rectangles')
    const rects = optimizeImage(imageData, config, send)
    const baseName = fileName.replace(/\.[^.]+$/, '') || 'image'
    const stats = (): GenerationStats => ({
      width: imageData.width,
      height: imageData.height,
      shapeCount: rects.length,
      optimization: config.optimization,
      elapsedMs: performance.now() - started,
    })

    if (output === 'json') {
      const jsonExport = createJsonExport(jsonMode, rects, imageData.width, imageData.height, config)
      ctx.postMessage({
        type: 'json-done',
        json: JSON.stringify(jsonExport),
        downloadName: `${baseName}_${jsonMode}.json`,
        stats: stats(),
      } satisfies WorkerResponse)
      return
    }

    send('Loading schema and template')
    const [types, templateGia] = await Promise.all([
      loadGiaTypes(assetBase),
      fetch(new URL('template.gia', assetBase).toString()).then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load template.gia: ${r.status}`)
        return new Uint8Array(await r.arrayBuffer())
      }),
    ])

    send('Encoding .gia file')
    const outputName = `${baseName}.gia`
    const giaBytes = await buildGiaFromRects(
      templateGia,
      rects,
      imageData.width,
      imageData.height,
      config,
      types,
      outputName,
    )

    ctx.postMessage({
      type: 'gia-done',
      giaBytes: giaBytes.buffer as ArrayBuffer,
      downloadName: outputName,
      stats: stats(),
    } satisfies WorkerResponse, [giaBytes.buffer])
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse)
  }
}
