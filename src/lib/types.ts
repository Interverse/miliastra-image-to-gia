export type Optimization = 'exact' | 'fast-overdraw' | 'safe-overdraw'

export interface GeneratorConfig {
  optimization: Optimization
  pixelSize: number
  imageRotation: number
  parentName: string
  parentX: number
  parentY: number
  fieldScale: number
  keepParentPosition: boolean
  yDown: boolean
  exportLayerOrder: 'front-to-back' | 'back-to-front'
  maxMergePasses: number
  safeTimeSeconds: number
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
}

export interface GenerationStats {
  width: number
  height: number
  shapeCount: number
  optimization: Optimization
  elapsedMs: number
}
