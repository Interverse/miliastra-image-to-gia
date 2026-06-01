import type { GeneratorConfig, RectPlan } from "./types";

export interface ProgressSink {
  (message: string): void;
}

interface Candidate {
  name: string;
  rects: RectPlan[];
}

function colorAt(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number
): number {
  const i = (y * width + x) * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const a = data[i + 3];
  if (a === 0) return 0;
  return (
    (((a & 0xff) << 24) |
      ((r & 0xff) << 16) |
      ((g & 0xff) << 8) |
      (b & 0xff)) >>>
    0
  );
}

function buildGrid(imageData: ImageData) {
  const { width, height, data } = imageData;
  const grid = Array.from({ length: height }, () => new Uint32Array(width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      grid[y][x] = colorAt(data, width, x, y);
    }
  }
  return grid;
}

function exactGreedyRectangles(
  grid: Uint32Array[],
  progress?: ProgressSink
): RectPlan[] {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const used = Array.from({ length: h }, () => new Uint8Array(w));
  const rects: RectPlan[] = [];

  for (let y = 0; y < h; y += 1) {
    if (progress && y % 32 === 0) progress(`Exact scan row ${y + 1}/${h}`);
    for (let x = 0; x < w; x += 1) {
      const color = grid[y][x];
      if (color === 0 || used[y][x]) continue;

      let maxW = 0;
      while (x + maxW < w && grid[y][x + maxW] === color && !used[y][x + maxW])
        maxW += 1;

      let bestW = 1;
      let bestH = 1;
      let bestArea = 1;
      let widthHere = maxW;
      let yy = y;

      while (yy < h && widthHere > 0) {
        let rowW = 0;
        while (
          rowW < widthHere &&
          x + rowW < w &&
          grid[yy][x + rowW] === color &&
          !used[yy][x + rowW]
        )
          rowW += 1;
        widthHere = Math.min(widthHere, rowW);
        if (widthHere === 0) break;
        const heightHere = yy - y + 1;
        const area = widthHere * heightHere;
        if (area > bestArea) {
          bestArea = area;
          bestW = widthHere;
          bestH = heightHere;
        }
        yy += 1;
      }

      for (let ry = y; ry < y + bestH; ry += 1) {
        for (let rx = x; rx < x + bestW; rx += 1) {
          used[ry][rx] = 1;
        }
      }
      rects.push({ x, y, w: bestW, h: bestH, color });
    }
  }

  return rects;
}

function bbox(a: RectPlan, b: RectPlan) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlaps(a: RectPlan, b: RectPlan) {
  return !(
    a.x + a.w <= b.x ||
    a.x >= b.x + b.w ||
    a.y + a.h <= b.y ||
    a.y >= b.y + b.h
  );
}

function bboxContainsTransparency(
  grid: Uint32Array[],
  r: { x: number; y: number; w: number; h: number }
) {
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      if (grid[y][x] === 0) return true;
    }
  }
  return false;
}

function mergedRectOverdraw(a: RectPlan, b: RectPlan, grid: Uint32Array[]) {
  if (a.color !== b.color) return null;
  const r = bbox(a, b);
  if (bboxContainsTransparency(grid, r)) return null;
  const newArea = r.w * r.h;
  const oldArea = a.w * a.h + b.w * b.h;
  return {
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    color: a.color,
    extraArea: newArea - oldArea,
    ratio: newArea / Math.max(1, oldArea),
    newArea,
  };
}

function mergeByOverdraw(
  baseRects: RectPlan[],
  grid: Uint32Array[],
  maxPasses: number,
  ratioLimit: number,
  progress?: ProgressSink
): RectPlan[] {
  const rects = [...baseRects];
  let pass = 0;
  while (pass < maxPasses) {
    pass += 1;
    let bestI = -1;
    let bestJ = -1;
    let best: ReturnType<typeof mergedRectOverdraw> = null;

    for (let i = 0; i < rects.length; i += 1) {
      const a = rects[i];
      for (let j = i + 1; j < rects.length; j += 1) {
        const b = rects[j];
        if (a.color !== b.color) continue;
        const candidate = mergedRectOverdraw(a, b, grid);
        if (!candidate) continue;
        if (candidate.ratio > ratioLimit) continue;

        if (
          !best ||
          candidate.extraArea < best.extraArea ||
          (candidate.extraArea === best.extraArea &&
            candidate.newArea > best.newArea)
        ) {
          best = candidate;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (!best || bestI < 0 || bestJ < 0) break;
    if (progress && pass % 20 === 0)
      progress(
        `Overdraw merge pass ${pass}/${maxPasses} · ${rects.length} rects`
      );
    rects.splice(bestJ, 1);
    rects.splice(bestI, 1, {
      x: best.x,
      y: best.y,
      w: best.w,
      h: best.h,
      color: best.color,
    });
  }
  return rects;
}

function deriveLayerOrder(
  rects: RectPlan[],
  grid: Uint32Array[]
): number[] | null {
  const n = rects.length;
  const after = Array.from({ length: n }, () => new Set<number>());
  const indeg = new Int32Array(n);

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a.color === b.color || !overlaps(a, b)) continue;

      const x0 = Math.max(a.x, b.x);
      const y0 = Math.max(a.y, b.y);
      const x1 = Math.min(a.x + a.w, b.x + b.w);
      const y1 = Math.min(a.y + a.h, b.y + b.h);

      let needAAbove = false;
      let needBAbove = false;
      for (let y = y0; y < y1 && !(needAAbove && needBAbove); y += 1) {
        for (let x = x0; x < x1 && !(needAAbove && needBAbove); x += 1) {
          const src = grid[y][x];
          if (src === 0 || (src === a.color && src === b.color)) continue;
          if (src === a.color) needAAbove = true;
          else if (src === b.color) needBAbove = true;
        }
      }

      if (needAAbove && !needBAbove) {
        if (!after[j].has(i)) {
          after[j].add(i);
          indeg[i] += 1;
        }
      } else if (needBAbove && !needAAbove) {
        if (!after[i].has(j)) {
          after[i].add(j);
          indeg[j] += 1;
        }
      } else if (needAAbove && needBAbove) {
        return null;
      }
    }
  }

  const q: number[] = [];
  for (let i = 0; i < n; i += 1) if (indeg[i] === 0) q.push(i);
  const out: number[] = [];
  while (q.length) {
    const cur = q.shift()!;
    out.push(cur);
    for (const next of after[cur]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) q.push(next);
    }
  }
  if (out.length !== n) return null;
  return out;
}

function validateCoverage(rects: RectPlan[], grid: Uint32Array[]) {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = grid[y][x];
      if (src === 0) continue;
      let found = false;
      for (const r of rects) {
        if (
          r.color === src &&
          x >= r.x &&
          x < r.x + r.w &&
          y >= r.y &&
          y < r.y + r.h
        ) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
  }
  return true;
}

function orderRects(
  rects: RectPlan[],
  grid: Uint32Array[],
  order: "front-to-back" | "back-to-front"
) {
  if (!validateCoverage(rects, grid)) return null;
  const layer = deriveLayerOrder(rects, grid);
  if (!layer) return null;
  const backToFront = layer.map((i) => rects[i]);
  return order === "back-to-front" ? backToFront : [...backToFront].reverse();
}

function tryCandidate(
  name: string,
  rects: RectPlan[],
  grid: Uint32Array[],
  order: "front-to-back" | "back-to-front"
): Candidate | null {
  const ordered = orderRects(rects, grid, order);
  if (!ordered) return null;
  return { name, rects: ordered };
}

function twoStageMerge(
  exact: RectPlan[],
  grid: Uint32Array[],
  config: GeneratorConfig,
  progress?: ProgressSink
): RectPlan[] {
  progress?.("Running safe two-stage overdraw");
  const stage1 = mergeByOverdraw(
    exact,
    grid,
    config.stage1Passes,
    config.stage1Ratio,
    progress
  );

  const stage2 = mergeByOverdraw(
    stage1,
    grid,
    config.stage2Passes,
    config.stage2Ratio,
    progress
  );

  return stage2;
}

export function optimizeImage(
  imageData: ImageData,
  config: GeneratorConfig,
  progress?: ProgressSink
): RectPlan[] {
  const grid = buildGrid(imageData);

  progress?.("Building exact rectangle cover");
  const exact = exactGreedyRectangles(grid, progress);

  // exact mode
  if (config.optimization === "exact") {
    const exactCandidate = tryCandidate(
      "exact",
      exact,
      grid,
      config.exportLayerOrder
    );
    if (!exactCandidate) {
      throw new Error("Could not produce a valid exact rectangle plan");
    }
    progress?.(`Chosen plan: exact (${exactCandidate.rects.length} shapes)`);
    return exactCandidate.rects;
  }

  // fast-overdraw mode
  if (config.optimization === "fast-overdraw") {
    progress?.("Trying fast overdraw");
    const fastMerged = mergeByOverdraw(
      exact,
      grid,
      config.maxMergePasses,
      config.stage1Ratio,
      progress
    );

    const fastCandidate = tryCandidate(
      "fast-overdraw",
      fastMerged,
      grid,
      config.exportLayerOrder
    );

    if (fastCandidate) {
      progress?.(
        `Chosen plan: fast-overdraw (${fastCandidate.rects.length} shapes)`
      );
      return fastCandidate.rects;
    }

    const exactCandidate = tryCandidate(
      "exact",
      exact,
      grid,
      config.exportLayerOrder
    );
    if (!exactCandidate) {
      throw new Error("Could not produce a valid rectangle plan");
    }
    progress?.(
      `Fast overdraw invalid, falling back to exact (${exactCandidate.rects.length} shapes)`
    );
    return exactCandidate.rects;
  }

  // safe-overdraw mode:
  // only two-stage + exact fallback
  const twoStageRects = twoStageMerge(exact, grid, config, progress);
  const twoStageCandidate = tryCandidate(
    "safe-two-stage",
    twoStageRects,
    grid,
    config.exportLayerOrder
  );

  if (twoStageCandidate) {
    progress?.(
      `Chosen plan: safe-two-stage (${twoStageCandidate.rects.length} shapes)`
    );
    return twoStageCandidate.rects;
  }

  const exactCandidate = tryCandidate(
    "exact",
    exact,
    grid,
    config.exportLayerOrder
  );
  if (!exactCandidate) {
    throw new Error("Could not produce a valid rectangle plan");
  }

  progress?.(
    `Safe overdraw fallback: exact (${exactCandidate.rects.length} shapes)`
  );
  return exactCandidate.rects;
}
