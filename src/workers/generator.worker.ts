/// <reference lib="webworker" />
import { buildGiaFromRects } from '../lib/gia'
import { buildClientGiaFromRects } from '../lib/giaClient'
import { inspectGia, validateClientGia } from '../lib/giaInspect'
import { createJsonExport } from '../lib/json'
import { optimizeImage } from '../lib/optimizer'
import { loadGiaTypes } from '../lib/proto'
import type { GeneratorConfig, GenerationStats, GiaTarget, JsonExportMode } from '../lib/types'

export interface WorkerRequest {
  imageData: ImageData
  config: GeneratorConfig
  assetBase: string
  fileName: string
  output: 'gia' | 'json'
  jsonMode?: JsonExportMode
}

export interface GiaResult {
  target: GiaTarget
  blob: Blob
  downloadName: string
}

export type WorkerResponse =
  | { type: 'progress'; message: string; params?: Record<string, string | number> }
  | {
      type: 'gia-done'
      results: GiaResult[]
      /** Set when one target failed while the other still produced a file. */
      partialError?: string
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

// Re-reading a finished bundle costs roughly as much as writing it, so the
// full Client Image structure check runs only while that stays cheap. Larger
// exports are still covered by the checks the serializer performs on the
// container and the first child before any record is written.
const MAX_VALIDATION_SHAPES = 20_000

async function fetchAsset(assetBase: string, name: string): Promise<Uint8Array> {
  const response = await fetch(new URL(name, assetBase).toString())
  if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const started = performance.now()
    const { imageData, config, assetBase, fileName, output, jsonMode = 'raw' } = event.data

    const send = (message: string, params?: Record<string, string | number>) => {
      ctx.postMessage({ type: 'progress', message, params } satisfies WorkerResponse)
    }

    // One optimizer pass feeds both exporters, so the Server Image and the
    // Client Image can never describe different pixels.
    send('Optimizing rectangles')
    const rects = optimizeImage(imageData, config, (message) => send(message))
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
    const [types, serverTemplate, clientTemplate] = await Promise.all([
      loadGiaTypes(assetBase),
      fetchAsset(assetBase, 'template.gia'),
      fetchAsset(assetBase, 'client-template.gia'),
    ])

    send('Image elements to encode', { count: rects.length })
    const results: GiaResult[] = []

    // The Server Image keeps the historical name so its bytes, including the
    // export tag, are unchanged; the Client Image gets its own name so the two
    // downloads never collide.
    const serverName = `${baseName}.gia`
    const clientName = `${baseName}_client.gia`

    const serverBlob = await buildGiaFromRects(
      serverTemplate,
      rects,
      imageData.width,
      imageData.height,
      config,
      types,
      serverName,
      (done, total) => send('Encoding server image elements', { done, total }),
    )
    results.push({ target: 'server', blob: serverBlob, downloadName: serverName })

    // A Client Image failure must not throw away the Server Image, and a
    // malformed Client Image must never be offered for download.
    let partialError: string | undefined
    try {
      const clientBlob = await buildClientGiaFromRects(
        clientTemplate,
        rects,
        imageData.width,
        imageData.height,
        config,
        clientName,
        (done, total) => send('Encoding client image elements', { done, total }),
      )
      if (rects.length <= MAX_VALIDATION_SHAPES) {
        send('Validating client structure')
        const problems = validateClientGia(inspectGia(new Uint8Array(await clientBlob.arrayBuffer())))
        if (problems.length) throw new Error(problems.slice(0, 5).join('; '))
      }
      results.push({ target: 'client', blob: clientBlob, downloadName: clientName })
    } catch (error) {
      partialError = error instanceof Error ? error.message : String(error)
    }

    ctx.postMessage({
      type: 'gia-done',
      results,
      partialError,
      stats: stats(),
    } satisfies WorkerResponse)
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse)
  }
}
