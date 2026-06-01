/// <reference lib="webworker" />
import { buildGiaFromRects } from '../lib/gia'
import { optimizeImage } from '../lib/optimizer'
import { loadGiaTypes } from '../lib/proto'
import type { GeneratorConfig, GenerationStats } from '../lib/types'

export interface WorkerRequest {
  imageData: ImageData
  config: GeneratorConfig
  assetBase: string
  fileName: string
}

export type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'done'; giaBytes: ArrayBuffer; downloadName: string; stats: GenerationStats }
  | { type: 'error'; error: string }

const ctx: DedicatedWorkerGlobalScope = self as never

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const started = performance.now()
    const { imageData, config, assetBase, fileName } = event.data

    const send = (message: string) => {
      ctx.postMessage({ type: 'progress', message } satisfies WorkerResponse)
    }

    send('Loading schema and template')
    const [types, templateGia] = await Promise.all([
      loadGiaTypes(assetBase),
      fetch(new URL('template.gia', assetBase).toString()).then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load template.gia: ${r.status}`)
        return new Uint8Array(await r.arrayBuffer())
      }),
    ])

    send('Optimizing rectangles')
    const rects = optimizeImage(imageData, config, send)

    send('Encoding .gia file')
    const outputName = `${fileName.replace(/\.[^.]+$/, '') || 'image'}.gia`
    const giaBytes = await buildGiaFromRects(
      templateGia,
      rects,
      imageData.width,
      imageData.height,
      config,
      types,
      outputName,
    )

    const stats: GenerationStats = {
      width: imageData.width,
      height: imageData.height,
      shapeCount: rects.length,
      optimization: config.optimization,
      elapsedMs: performance.now() - started,
    }

    ctx.postMessage({
      type: 'done',
      giaBytes: giaBytes.buffer as ArrayBuffer,
      downloadName: outputName,
      stats,
    } satisfies WorkerResponse, [giaBytes.buffer])
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse)
  }
}
