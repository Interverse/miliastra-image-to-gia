import { rotatePoint } from './utils'
import type { GeneratorConfig, JsonExportMode, RectPlan } from './types'

const DEVICE_SCALE_KEYS = ['desktop', 'mobile', 'controller', 'mobileController'] as const

function colorValue(argbValue: unknown) {
  const argb = Number(argbValue ?? 0) >>> 0
  return { argb, hex: `#${argb.toString(16).padStart(8, '0').toUpperCase()}` }
}

function cleanNormalizedNumber(value: number): number {
  if (Object.is(value, -0)) return 0
  const nearestInteger = Math.round(value)
  return Math.abs(value - nearestInteger) < 1e-10 ? nearestInteger : value
}

function deviceScale(config: GeneratorConfig, key: (typeof DEVICE_SCALE_KEYS)[number]) {
  const value = config.deviceScales[key]
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function createJsonExport(
  mode: JsonExportMode,
  rects: RectPlan[],
  imageWidth: number,
  imageHeight: number,
  config: GeneratorConfig,
): unknown {
  if (mode === 'raw') return {
    primitives: rects.map((rect) => {
      const visibleCenterX = (rect.x + rect.w / 2 - imageWidth / 2) * config.pixelSize
      const visibleCenterY = config.yDown
        ? (rect.y + rect.h / 2 - imageHeight / 2) * config.pixelSize
        : (imageHeight / 2 - (rect.y + rect.h / 2)) * config.pixelSize
      const rotated = rotatePoint(visibleCenterX, visibleCenterY, config.imageRotation)
      const centerX = rotated.x * config.fieldScale
      const centerY = rotated.y * config.fieldScale
      const width = rect.w * config.pixelSize * config.fieldScale
      const height = rect.h * config.pixelSize * config.fieldScale
      return {
        color: colorValue(rect.color),
        transforms: DEVICE_SCALE_KEYS.map((key) => {
          const scale = deviceScale(config, key)
          return {
            position: { x: centerX * scale, y: centerY * scale },
            size: { x: width * scale, y: height * scale },
          }
        }),
      }
    }),
  }

  return {
    squares: rects.map((rect) => {
      const unrotatedX = rect.x + rect.w / 2 - imageWidth / 2
      const unrotatedY = config.yDown
        ? rect.y + rect.h / 2 - imageHeight / 2
        : imageHeight / 2 - (rect.y + rect.h / 2)
      const position = rotatePoint(unrotatedX, unrotatedY, config.imageRotation)
      return {
        position: {
          x: cleanNormalizedNumber(position.x),
          y: cleanNormalizedNumber(position.y),
        },
        size: { x: rect.w, y: rect.h },
        color: colorValue(rect.color),
      }
    }),
  }
}
