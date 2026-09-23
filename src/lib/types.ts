export type Optimization = 'exact' | 'fast-overdraw' | 'safe-overdraw'

/** Built-in engine image primitive. Resolved to a resource ID in giaCommon. */
export type ShapeKind = 'square' | 'circle' | 'triangle'

/**
 * Which Control Template the `.gia` is written for. Both targets describe the
 * same converted image with the same image resource IDs; only the surrounding
 * `.gia` structure differs.
 */
export type GiaTarget = 'server' | 'client'

export type DeviceScaleKey = 'desktop' | 'mobile' | 'controller' | 'mobileController'

export interface DeviceScales {
  desktop: number
  mobile: number
  controller: number
  mobileController: number
}

export interface GeneratorConfig {
  optimization: Optimization
  pixelSize: number
  imageRotation: number
  parentName: string
  parentX: number
  parentY: number
  fieldScale: number
  deviceScales: DeviceScales
  keepParentPosition: boolean
  yDown: boolean
  exportLayerOrder: 'front-to-back' | 'back-to-front'
  maxMergePasses: number
  maxOverdrawRatio: number
  safeTimeSeconds: number
  underpaintMaxBBoxRatio: number
  underpaintMinComponentPixels: number
  underpaintMinSavings: number
  underpaintBeamWidth: number
  underpaintBeamCandidates: number
  stage1Passes: number
  stage1Ratio: number
  stage2Passes: number
  stage2Ratio: number
}

export interface RectPlan {
  x: number
  y: number
  w: number
  h: number
  color: number
  /** Defaults to 'square' when the optimizer does not choose a primitive. */
  shape?: ShapeKind
}

export interface GenerationStats {
  width: number
  height: number
  shapeCount: number
  optimization: Optimization
  elapsedMs: number
}

export type JsonExportMode = 'raw' | 'normalized'
