export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function rgbaBytesToArgbInt(r: number, g: number, b: number, a: number): number {
  return (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0
}

export function argbIntToCss(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255
  const r = (argb >>> 16) & 0xff
  const g = (argb >>> 8) & 0xff
  const b = argb & 0xff
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(4)})`
}

export function rotatePoint(x: number, y: number, degrees: number) {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  }
}

export function rotatedBBoxSize(width: number, height: number, degrees: number) {
  const rad = (degrees * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  return {
    width: width * c + height * s,
    height: width * s + height * c,
  }
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
