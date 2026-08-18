import type { GeneratorConfig, RectPlan } from "./types";

export interface ProgressSink {
  (message: string): void;
}

interface Grid {
  width: number;
  height: number;
  rows: Uint32Array[];
}

interface RectPlanResult {
  rects: RectPlan[];
  width: number;
  height: number;
}

interface UnderpaintCandidate {
  color: number;
  bbox: BBox;
  savings: number;
  count: number;
  area: number;
  corrections: RectPlan[];
}

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
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

function buildGrid(imageData: ImageData): Grid {
  const { width, height, data } = imageData;
  const rows = Array.from({ length: height }, () => new Uint32Array(width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows[y][x] = colorAt(data, width, x, y);
    }
  }
  return { width, height, rows };
}

function makeGrid(width: number, height: number): Grid {
  return {
    width,
    height,
    rows: Array.from({ length: height }, () => new Uint32Array(width)),
  };
}

function subGridWithRemovedColor(
  grid: Grid,
  bbox: BBox,
  removeColor?: number
): Grid {
  const width = bbox.x1 - bbox.x0;
  const height = bbox.y1 - bbox.y0;
  const out = makeGrid(width, height);
  for (let y = bbox.y0; y < bbox.y1; y += 1) {
    const outRow = out.rows[y - bbox.y0];
    const srcRow = grid.rows[y];
    for (let x = bbox.x0; x < bbox.x1; x += 1) {
      const color = srcRow[x];
      outRow[x - bbox.x0] = color !== 0 && color !== removeColor ? color : 0;
    }
  }
  return out;
}

function offsetRects(rects: RectPlan[], dx: number, dy: number): RectPlan[] {
  return rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
}

function rectArea(r: RectPlan) {
  return r.w * r.h;
}

function rectBBox(a: RectPlan, b: RectPlan): BBox {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x + a.w, b.x + b.w),
    y1: Math.max(a.y + a.h, b.y + b.h),
  };
}

function rectIntersectsBBox(rect: RectPlan, bbox: BBox) {
  return !(
    rect.x + rect.w <= bbox.x0 ||
    rect.x >= bbox.x1 ||
    rect.y + rect.h <= bbox.y0 ||
    rect.y >= bbox.y1
  );
}

function bboxesOverlap(a: BBox, b: BBox) {
  return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
}

function buildTransparencyPrefix(grid: Grid): number[][] {
  const prefix = Array.from({ length: grid.height + 1 }, () =>
    new Array<number>(grid.width + 1).fill(0)
  );
  for (let y = 0; y < grid.height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < grid.width; x += 1) {
      rowSum += grid.rows[y][x] === 0 ? 1 : 0;
      prefix[y + 1][x + 1] = prefix[y][x + 1] + rowSum;
    }
  }
  return prefix;
}

function bboxHasTransparencyFast(prefix: number[][], bbox: BBox) {
  return (
    prefix[bbox.y1][bbox.x1] -
      prefix[bbox.y0][bbox.x1] -
      prefix[bbox.y1][bbox.x0] +
      prefix[bbox.y0][bbox.x0] >
    0
  );
}

function bboxHasTransparency(grid: Grid, bbox: BBox) {
  for (let y = bbox.y0; y < bbox.y1; y += 1) {
    for (let x = bbox.x0; x < bbox.x1; x += 1) {
      if (grid.rows[y][x] === 0) return true;
    }
  }
  return false;
}

function exactNonoverlapRects(
  grid: Grid,
  progress?: ProgressSink
): RectPlanResult {
  const used = Array.from(
    { length: grid.height },
    () => new Uint8Array(grid.width)
  );
  const rects: RectPlan[] = [];
  let processed = 0;
  const total = grid.width * grid.height;

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (used[y][x]) {
        processed += 1;
        continue;
      }

      const color = grid.rows[y][x];
      if (color === 0) {
        used[y][x] = 1;
        processed += 1;
        continue;
      }

      const widths: number[] = [];
      let yy = y;
      while (yy < grid.height && !used[yy][x] && grid.rows[yy][x] === color) {
        let runW = 0;
        while (
          x + runW < grid.width &&
          !used[yy][x + runW] &&
          grid.rows[yy][x + runW] === color
        ) {
          runW += 1;
        }
        widths.push(runW);
        yy += 1;
      }

      let bestW = 1;
      let bestH = 1;
      let bestArea = 1;
      let minW: number | null = null;
      for (let i = 0; i < widths.length; i += 1) {
        const rowW = widths[i];
        minW = minW == null ? rowW : Math.min(minW, rowW);
        const h = i + 1;
        const area = minW * h;
        if (
          area > bestArea ||
          (area === bestArea && (h > bestH || (h === bestH && minW > bestW)))
        ) {
          bestArea = area;
          bestW = minW;
          bestH = h;
        }
      }

      for (let yy2 = y; yy2 < y + bestH; yy2 += 1) {
        for (let xx2 = x; xx2 < x + bestW; xx2 += 1) used[yy2][xx2] = 1;
      }
      processed += bestW * bestH;
      if (progress && rects.length % 200 === 0)
        progress(`exact-cover ${Math.min(processed, total)}/${total} pixels`);
      rects.push({ x, y, w: bestW, h: bestH, color });
    }
  }

  return { rects, width: grid.width, height: grid.height };
}

function greedyMeshingRects(
  grid: Grid,
  progress?: ProgressSink
): RectPlanResult {
  const covered = Array.from(
    { length: grid.height },
    () => new Uint8Array(grid.width)
  );
  const rects: RectPlan[] = [];
  let opaqueTotal = 0;
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1)
      if (grid.rows[y][x] !== 0) opaqueTotal += 1;
  }
  let coveredOpaque = 0;

  for (let y = 0; y < grid.height; y += 1) {
    let x = 0;
    while (x < grid.width) {
      const color = grid.rows[y][x];
      if (color === 0 || covered[y][x]) {
        x += 1;
        continue;
      }

      let w = 1;
      while (x + w < grid.width) {
        const c = grid.rows[y][x + w];
        if (c === 0 || covered[y][x + w] || c !== color) break;
        w += 1;
      }

      let h = 1;
      while (y + h < grid.height) {
        let ok = true;
        for (let xx = x; xx < x + w; xx += 1) {
          const c = grid.rows[y + h][xx];
          if (c === 0 || covered[y + h][xx] || c !== color) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        h += 1;
      }

      for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) covered[yy][xx] = 1;
      }
      rects.push({ x, y, w, h, color });
      coveredOpaque += w * h;
      if (progress && rects.length % 200 === 0)
        progress(
          `greedy-meshing ${coveredOpaque}/${opaqueTotal} opaque pixels`
        );
      x += w;
    }
  }

  return { rects, width: grid.width, height: grid.height };
}

function renderBBox(rects: RectPlan[], bbox: BBox): Uint32Array[] {
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  const canvas = Array.from({ length: bh }, () => new Uint32Array(bw));
  for (const rect of rects) {
    const ox0 = Math.max(bbox.x0, rect.x);
    const oy0 = Math.max(bbox.y0, rect.y);
    const ox1 = Math.min(bbox.x1, rect.x + rect.w);
    const oy1 = Math.min(bbox.y1, rect.y + rect.h);
    if (ox0 >= ox1 || oy0 >= oy1) continue;
    for (let y = oy0; y < oy1; y += 1) {
      const row = canvas[y - bbox.y0];
      for (let x = ox0; x < ox1; x += 1) row[x - bbox.x0] = rect.color;
    }
  }
  return canvas;
}

function targetBBox(grid: Grid, bbox: BBox): Uint32Array[] {
  const out: Uint32Array[] = [];
  for (let y = bbox.y0; y < bbox.y1; y += 1)
    out.push(grid.rows[y].slice(bbox.x0, bbox.x1));
  return out;
}

function gridsEqual(a: Uint32Array[], b: Uint32Array[]) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y += 1) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x += 1)
      if (a[y][x] !== b[y][x]) return false;
  }
  return true;
}

function candidatePreservesBBox(rects: RectPlan[], grid: Grid, bbox: BBox) {
  return gridsEqual(renderBBox(rects, bbox), targetBBox(grid, bbox));
}

class MinHeap<T> {
  private data: T[] = [];
  constructor(private less: (a: T, b: T) => boolean) {}
  get length() {
    return this.data.length;
  }
  push(item: T) {
    const data = this.data;
    data.push(item);
    let i = data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(data[i], data[p])) break;
      [data[i], data[p]] = [data[p], data[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const data = this.data;
    if (data.length === 0) return undefined;
    const root = data[0];
    const last = data.pop()!;
    if (data.length > 0) {
      data[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < data.length && this.less(data[l], data[best])) best = l;
        if (r < data.length && this.less(data[r], data[best])) best = r;
        if (best === i) break;
        [data[i], data[best]] = [data[best], data[i]];
        i = best;
      }
    }
    return root;
  }
}

interface MergeCandidate {
  extraArea: number;
  negMergedArea: number;
  counter: number;
  i: number;
  j: number;
}

function fastMergeOverdrawFromSeed(
  grid: Grid,
  seedRects: RectPlan[],
  progress?: ProgressSink,
  maxPasses = 200,
  maxOverdrawRatio: number | null = 2.5,
  stageName = "fast-overdraw-seeded"
): RectPlanResult {
  const prefix = buildTransparencyPrefix(grid);
  const rectsById = new Map<number, RectPlan>();
  seedRects.forEach((r, i) => rectsById.set(i, r));
  const active = new Set<number>(rectsById.keys());
  let order = Array.from(active);
  let nextId = seedRects.length;
  let counter = 0;

  const heap = new MinHeap<MergeCandidate>((a, b) => {
    if (a.extraArea !== b.extraArea) return a.extraArea < b.extraArea;
    if (a.negMergedArea !== b.negMergedArea)
      return a.negMergedArea < b.negMergedArea;
    return a.counter < b.counter;
  });

  function pushCandidate(i: number, j: number) {
    if (i === j || !active.has(i) || !active.has(j)) return;
    const a = rectsById.get(i)!;
    const b = rectsById.get(j)!;
    if (a.color !== b.color) return;
    const bbox = rectBBox(a, b);
    if (bboxHasTransparencyFast(prefix, bbox)) return;
    const mergedArea = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);
    const oldArea = rectArea(a) + rectArea(b);
    if (maxOverdrawRatio != null && mergedArea > oldArea * maxOverdrawRatio)
      return;
    counter += 1;
    heap.push({
      extraArea: mergedArea - oldArea,
      negMergedArea: -mergedArea,
      counter,
      i,
      j,
    });
  }

  const byColor = new Map<number, number[]>();
  for (const [id, rect] of rectsById) {
    if (!byColor.has(rect.color)) byColor.set(rect.color, []);
    byColor.get(rect.color)!.push(id);
  }
  for (const ids of byColor.values()) {
    for (let a = 0; a < ids.length; a += 1)
      for (let b = a + 1; b < ids.length; b += 1) pushCandidate(ids[a], ids[b]);
  }

  let accepted = 0;
  let checked = 0;
  while (heap.length && accepted < maxPasses) {
    const cand = heap.pop()!;
    checked += 1;
    const { i, j } = cand;
    if (!active.has(i) || !active.has(j)) continue;
    const a = rectsById.get(i)!;
    const b = rectsById.get(j)!;
    if (a.color !== b.color) continue;
    const bbox = rectBBox(a, b);
    if (bboxHasTransparencyFast(prefix, bbox)) continue;
    const merged: RectPlan = {
      x: bbox.x0,
      y: bbox.y0,
      w: bbox.x1 - bbox.x0,
      h: bbox.y1 - bbox.y0,
      color: a.color,
    };
    const oldArea = rectArea(a) + rectArea(b);
    const newArea = rectArea(merged);
    if (maxOverdrawRatio != null && newArea > oldArea * maxOverdrawRatio)
      continue;

    const candidateOrder = order.filter((rid) => rid !== i && rid !== j);
    let insertAt = 0;
    for (let pos = 0; pos < candidateOrder.length; pos += 1) {
      const rid = candidateOrder[pos];
      if (rectIntersectsBBox(rectsById.get(rid)!, bbox)) {
        insertAt = pos;
        break;
      }
    }
    const mergedId = nextId;
    rectsById.set(mergedId, merged);
    candidateOrder.splice(insertAt, 0, mergedId);
    const candidateRects: RectPlan[] = [];
    for (const rid of candidateOrder) {
      const rect = rectsById.get(rid)!;
      if (rectIntersectsBBox(rect, bbox)) candidateRects.push(rect);
    }
    if (!candidatePreservesBBox(candidateRects, grid, bbox)) {
      rectsById.delete(mergedId);
      continue;
    }

    nextId += 1;
    active.delete(i);
    active.delete(j);
    active.add(mergedId);
    order = candidateOrder;
    accepted += 1;
    for (const rid of Array.from(active))
      if (rid !== mergedId && rectsById.get(rid)!.color === merged.color)
        pushCandidate(mergedId, rid);
    if (progress && (accepted === 1 || accepted % 100 === 0))
      progress(
        `${stageName}: ${accepted}/${maxPasses} merges · ${order.length} rects · checked ${checked}`
      );
  }

  return {
    rects: order.map((rid) => rectsById.get(rid)!),
    width: grid.width,
    height: grid.height,
  };
}

function fastMergeOverdrawRects(
  grid: Grid,
  progress?: ProgressSink,
  maxPasses = 200,
  maxOverdrawRatio: number | null = 2.5
): RectPlanResult {
  const seed = exactNonoverlapRects(grid, progress);
  return fastMergeOverdrawFromSeed(
    grid,
    seed.rects,
    progress,
    maxPasses,
    maxOverdrawRatio,
    "fast-overdraw"
  );
}

function colorComponents(
  grid: Grid
): Array<{ color: number; count: number; bbox: BBox }> {
  const visited = Array.from(
    { length: grid.height },
    () => new Uint8Array(grid.width)
  );
  const comps: Array<{ color: number; count: number; bbox: BBox }> = [];

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (visited[y][x]) continue;
      const color = grid.rows[y][x];
      visited[y][x] = 1;
      if (color === 0) continue;
      const stack: Array<[number, number]> = [[x, y]];
      let count = 0;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        count += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neigh: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neigh) {
          if (
            nx < 0 ||
            nx >= grid.width ||
            ny < 0 ||
            ny >= grid.height ||
            visited[ny][nx]
          )
            continue;
          if (grid.rows[ny][nx] === color) {
            visited[ny][nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push({
        color,
        count,
        bbox: { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 },
      });
    }
  }
  return comps;
}

function collectUnderpaintCandidates(
  grid: Grid,
  progress?: ProgressSink,
  maxBBoxRatio = 6.0,
  minComponentPixels = 8,
  minSavings = 2
): UnderpaintCandidate[] {
  const prefix = buildTransparencyPrefix(grid);
  const comps = colorComponents(grid);
  const candidates: UnderpaintCandidate[] = [];
  for (let index = 0; index < comps.length; index += 1) {
    const { color, count, bbox } = comps[index];
    const bw = bbox.x1 - bbox.x0;
    const bh = bbox.y1 - bbox.y0;
    const area = bw * bh;
    if (
      count < minComponentPixels ||
      area <= 1 ||
      area / Math.max(count, 1) > maxBBoxRatio
    )
      continue;
    if (bboxHasTransparencyFast(prefix, bbox)) continue;

    const patchFull = subGridWithRemovedColor(grid, bbox);
    const baseline = greedyMeshingRects(patchFull).rects.length;
    const patchResidual = subGridWithRemovedColor(grid, bbox, color);
    const corrections = greedyMeshingRects(patchResidual).rects;
    const underpaintN = 1 + corrections.length;
    const savings = baseline - underpaintN;
    if (savings >= minSavings)
      candidates.push({ color, bbox, savings, count, area, corrections });
    if (progress && index % 200 === 0)
      progress(`underpaint candidates ${index + 1}/${comps.length}`);
  }
  candidates.sort(
    (a, b) => b.savings - a.savings || b.count - a.count || a.area - b.area
  );
  return candidates;
}

function selectUnderpaintCandidatesGreedy(
  candidates: UnderpaintCandidate[],
  width: number,
  height: number
) {
  const occupied = Array.from({ length: height }, () => new Uint8Array(width));
  const accepted: UnderpaintCandidate[] = [];
  function clear(bbox: BBox) {
    for (let y = bbox.y0; y < bbox.y1; y += 1)
      for (let x = bbox.x0; x < bbox.x1; x += 1)
        if (occupied[y][x]) return false;
    return true;
  }
  function mark(bbox: BBox) {
    for (let y = bbox.y0; y < bbox.y1; y += 1)
      for (let x = bbox.x0; x < bbox.x1; x += 1) occupied[y][x] = 1;
  }
  for (const cand of candidates)
    if (clear(cand.bbox)) {
      accepted.push(cand);
      mark(cand.bbox);
    }
  return accepted;
}

function bitCount(v: bigint) {
  let n = 0;
  while (v) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

function selectUnderpaintCandidatesBeam(
  candidates: UnderpaintCandidate[],
  beamWidth = 64,
  maxCandidates = 256,
  progress?: ProgressSink
) {
  const cand = candidates.slice(0, maxCandidates);
  const n = cand.length;
  if (!n) return [];
  const conflict = new Array<bigint>(n).fill(0n);
  for (let i = 0; i < n; i += 1) {
    let mask = 1n << BigInt(i);
    for (let j = i + 1; j < n; j += 1) {
      if (bboxesOverlap(cand[i].bbox, cand[j].bbox)) {
        mask |= 1n << BigInt(j);
        conflict[j] |= 1n << BigInt(i);
      }
    }
    conflict[i] |= mask;
  }
  let states: Array<{ score: number; selected: bigint; forbidden: bigint }> = [
    { score: 0, selected: 0n, forbidden: 0n },
  ];
  for (let i = 0; i < n; i += 1) {
    const bit = 1n << BigInt(i);
    const next: Array<{ score: number; selected: bigint; forbidden: bigint }> =
      [];
    for (const state of states) {
      next.push(state);
      if ((state.forbidden & bit) === 0n)
        next.push({
          score: state.score + cand[i].savings,
          selected: state.selected | bit,
          forbidden: state.forbidden | conflict[i],
        });
    }
    const best = new Map<
      string,
      { score: number; selected: bigint; forbidden: bigint }
    >();
    for (const state of next) {
      const key = state.selected.toString();
      const prev = best.get(key);
      if (!prev || state.score > prev.score) best.set(key, state);
    }
    states = Array.from(best.values())
      .sort(
        (a, b) =>
          b.score - a.score || bitCount(b.selected) - bitCount(a.selected)
      )
      .slice(0, beamWidth);
    if (progress && i % 50 === 0) progress(`underpaint beam ${i + 1}/${n}`);
  }
  const best = states.reduce((a, b) => (b.score > a.score ? b : a), states[0]);
  const accepted: UnderpaintCandidate[] = [];
  for (let i = 0; i < n; i += 1)
    if (best.selected & (1n << BigInt(i))) accepted.push(cand[i]);
  return accepted;
}

function assembleUnderpaintSolution(
  grid: Grid,
  accepted: UnderpaintCandidate[]
): RectPlanResult {
  const occupied = Array.from(
    { length: grid.height },
    () => new Uint8Array(grid.width)
  );
  function mark(bbox: BBox) {
    for (let y = bbox.y0; y < bbox.y1; y += 1)
      for (let x = bbox.x0; x < bbox.x1; x += 1) occupied[y][x] = 1;
  }
  accepted.forEach((c) => mark(c.bbox));
  const rects: RectPlan[] = [];
  for (const c of accepted)
    rects.push({
      x: c.bbox.x0,
      y: c.bbox.y0,
      w: c.bbox.x1 - c.bbox.x0,
      h: c.bbox.y1 - c.bbox.y0,
      color: c.color,
    });
  for (const c of accepted) {
    const corrections = offsetRects(c.corrections, c.bbox.x0, c.bbox.y0);
    for (const correction of corrections) rects.push(correction);
  }

  const residual = makeGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y += 1)
    for (let x = 0; x < grid.width; x += 1)
      if (!occupied[y][x]) residual.rows[y][x] = grid.rows[y][x];
  const residualRects = greedyMeshingRects(residual).rects;
  for (const rect of residualRects) rects.push(rect);
  return { rects, width: grid.width, height: grid.height };
}

function componentUnderpaintRects(
  grid: Grid,
  progress?: ProgressSink,
  maxBBoxRatio = 6.0,
  minComponentPixels = 8,
  minSavings = 2
): RectPlanResult {
  const candidates = collectUnderpaintCandidates(
    grid,
    progress,
    maxBBoxRatio,
    minComponentPixels,
    minSavings
  );
  const accepted = selectUnderpaintCandidatesGreedy(
    candidates,
    grid.width,
    grid.height
  );
  return assembleUnderpaintSolution(grid, accepted);
}

function componentUnderpaintBeamRects(
  grid: Grid,
  progress?: ProgressSink,
  maxBBoxRatio = 6.0,
  minComponentPixels = 8,
  minSavings = 2,
  beamWidth = 64,
  maxCandidates = 256
): RectPlanResult {
  const candidates = collectUnderpaintCandidates(
    grid,
    progress,
    maxBBoxRatio,
    minComponentPixels,
    minSavings
  );
  const accepted = selectUnderpaintCandidatesBeam(
    candidates,
    beamWidth,
    maxCandidates,
    progress
  );
  return assembleUnderpaintSolution(grid, accepted);
}

function twoStageOverdrawRects(
  grid: Grid,
  progress?: ProgressSink,
  stage1Passes = 1200,
  stage1Ratio = 3.0,
  stage2Passes = 2000,
  stage2Ratio = 10.0
): RectPlanResult {
  progress?.(
    `two-stage-overdraw stage 1: passes=${stage1Passes}, ratio=${stage1Ratio}`
  );
  const seed = fastMergeOverdrawRects(
    grid,
    undefined,
    stage1Passes,
    stage1Ratio
  );
  progress?.(`two-stage-overdraw stage 1 result: ${seed.rects.length} shapes`);
  progress?.(
    `two-stage-overdraw stage 2: passes=${stage2Passes}, ratio=${stage2Ratio}`
  );
  const result = fastMergeOverdrawFromSeed(
    grid,
    seed.rects,
    undefined,
    stage2Passes,
    stage2Ratio,
    "two-stage-overdraw-stage2"
  );
  progress?.(`two-stage-overdraw final result: ${result.rects.length} shapes`);
  return result;
}

function bestFastRects(
  grid: Grid,
  config: GeneratorConfig,
  progress?: ProgressSink
): RectPlanResult {
  const start = nowMs();
  const candidates: Array<{ name: string; result: RectPlanResult }> = [];
  let beamSeed: RectPlan[] | null = null;
  const maxOverdrawRatio = config.maxOverdrawRatio ?? 2.5;
  const withinBudget = () => nowMs() - start < config.safeTimeSeconds * 1000;
  const record = (name: string, result: RectPlanResult) => {
    candidates.push({ name, result });
    progress?.(`${name}: ${result.rects.length} shapes`);
  };

  record("greedy-meshing", greedyMeshingRects(grid));
  if (withinBudget())
    record(
      "component-underpaint",
      componentUnderpaintRects(
        grid,
        progress,
        config.underpaintMaxBBoxRatio,
        config.underpaintMinComponentPixels,
        config.underpaintMinSavings
      )
    );
  if (withinBudget()) {
    const result = componentUnderpaintBeamRects(
      grid,
      progress,
      config.underpaintMaxBBoxRatio,
      config.underpaintMinComponentPixels,
      config.underpaintMinSavings,
      config.underpaintBeamWidth,
      config.underpaintBeamCandidates
    );
    beamSeed = result.rects;
    record("component-underpaint-beam", result);
  }

  const ladder: Array<[number, number]> = [
    [Math.min(config.maxMergePasses, 400), maxOverdrawRatio],
    [Math.max(config.maxMergePasses, 800), Math.max(2.5, maxOverdrawRatio)],
    [Math.max(config.maxMergePasses, 1200), Math.max(3.0, maxOverdrawRatio)],
  ];
  const seen = new Set<string>();
  for (const [passes, ratio] of ladder) {
    const key = `${passes}/${ratio}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!withinBudget()) break;
    progress?.(`trying fast-overdraw passes=${passes}, ratio=${ratio}`);
    record(
      `fast-overdraw(${passes},${ratio})`,
      fastMergeOverdrawRects(grid, undefined, passes, ratio)
    );
  }

  if (beamSeed && withinBudget()) {
    const passes = Math.max(config.maxMergePasses, 800);
    const ratio = Math.max(3.0, maxOverdrawRatio);
    progress?.(`trying seeded fast-overdraw passes=${passes}, ratio=${ratio}`);
    record(
      `fast-overdraw-seeded(${passes},${ratio})`,
      fastMergeOverdrawFromSeed(
        grid,
        beamSeed,
        undefined,
        passes,
        ratio,
        "fast-overdraw-seeded"
      )
    );
  }

  if (withinBudget()) {
    record(
      `two-stage-overdraw(${config.stage1Passes}/${config.stage1Ratio},${config.stage2Passes}/${config.stage2Ratio})`,
      twoStageOverdrawRects(
        grid,
        progress,
        config.stage1Passes,
        config.stage1Ratio,
        config.stage2Passes,
        config.stage2Ratio
      )
    );
  }

  candidates.sort((a, b) => a.result.rects.length - b.result.rects.length);
  progress?.(
    `safe-overdraw chose ${candidates[0].name}: ${candidates[0].result.rects.length} shapes`
  );
  return candidates[0].result;
}

function orderRectsBackToFront(
  rects: RectPlan[],
  grid: Grid
): RectPlan[] | null {
  const pixelCount = grid.width * grid.height;
  const blockedByPixel = new Array<number[] | undefined>(pixelCount);
  const blockersRemaining = new Uint32Array(rects.length);
  const frontCovered = Array.from(
    { length: grid.height },
    () => new Uint8Array(grid.width)
  );
  const selected = new Uint8Array(rects.length);
  const frontToBack: RectPlan[] = [];

  // A rectangle is ready when every pixel where it differs from the target
  // has already been covered by a rectangle placed in front of it. Index the
  // inverse relationship once instead of rescanning and sorting all remaining
  // rectangles after every selection.
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (grid.rows[y][x] === rect.color) continue;
        blockersRemaining[index] += 1;
        const pixel = y * grid.width + x;
        const blocked = blockedByPixel[pixel];
        if (blocked) blocked.push(index);
        else blockedByPixel[pixel] = [index];
      }
    }
  }

  const ready = new MinHeap<number>((a, b) => {
    const areaA = rectArea(rects[a]);
    const areaB = rectArea(rects[b]);
    return areaA !== areaB ? areaA < areaB : a < b;
  });
  for (let index = 0; index < rects.length; index += 1) {
    if (blockersRemaining[index] === 0) ready.push(index);
  }

  while (ready.length) {
    const index = ready.pop()!;
    if (selected[index] || blockersRemaining[index] !== 0) continue;
    selected[index] = 1;
    const rect = rects[index];
    frontToBack.push(rect);

    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (frontCovered[y][x]) continue;
        frontCovered[y][x] = 1;
        const blocked = blockedByPixel[y * grid.width + x];
        if (!blocked) continue;
        for (const blockedIndex of blocked) {
          if (selected[blockedIndex] || blockersRemaining[blockedIndex] === 0)
            continue;
          blockersRemaining[blockedIndex] -= 1;
          if (blockersRemaining[blockedIndex] === 0) ready.push(blockedIndex);
        }
      }
    }
  }

  if (frontToBack.length !== rects.length) return null;
  return frontToBack.reverse();
}

function renderRectsToGrid(
  rects: RectPlan[],
  width: number,
  height: number
): Uint32Array[] {
  const canvas = Array.from({ length: height }, () => new Uint32Array(width));
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1)
      for (let x = rect.x; x < rect.x + rect.w; x += 1)
        canvas[y][x] = rect.color;
  }
  return canvas;
}

function rectOrderMatchesTarget(rectsBackToFront: RectPlan[], grid: Grid) {
  return gridsEqual(
    renderRectsToGrid(rectsBackToFront, grid.width, grid.height),
    grid.rows
  );
}

export function optimizeImage(
  imageData: ImageData,
  config: GeneratorConfig,
  progress?: ProgressSink
): RectPlan[] {
  const grid = buildGrid(imageData);
  let result: RectPlanResult;
  let isExactCover = config.optimization === "exact";

  if (isExactCover) {
    progress?.("optimization: exact");
    result = exactNonoverlapRects(grid, progress);
  } else if (config.optimization === "fast-overdraw") {
    progress?.("optimization: fast-overdraw");
    result = fastMergeOverdrawRects(
      grid,
      progress,
      config.maxMergePasses,
      config.maxOverdrawRatio ?? 2.5
    );
  } else {
    progress?.("optimization: safe-overdraw");
    result = bestFastRects(grid, config, progress);
  }

  // Exact-cover rectangles never overlap, so any layer order is valid. Avoid
  // the general overlap sorter, which is quadratic for pixel-per-rect images.
  let orderedBackToFront = isExactCover
    ? result.rects.slice()
    : orderRectsBackToFront(result.rects, grid);
  if (
    !orderedBackToFront ||
    !rectOrderMatchesTarget(orderedBackToFront, grid)
  ) {
    progress?.("layer-order invalid; falling back to exact cover");
    result = exactNonoverlapRects(grid, progress);
    isExactCover = true;
    orderedBackToFront = result.rects.slice();
  }
  if (!orderedBackToFront)
    throw new Error("Could not produce a valid rectangle plan");

  const output =
    config.exportLayerOrder === "back-to-front"
      ? orderedBackToFront
      : [...orderedBackToFront].reverse();
  progress?.(`Chosen plan: ${output.length} shapes`);
  return output;
}
