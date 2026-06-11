/**
 * Library Canvas 의 좌표 변환 / 변환 핸들 수학 / 자동 배치 알고리즘.
 *
 * 컴포넌트(LibraryCanvas.tsx) 에서 분리해 둔 이유:
 *   - 좌표계 변환(스크린 ↔ 캔버스 ↔ 아이템 로컬) 헬퍼들은 단위 테스트가
 *     가능한 순수 함수로 두는 게 디버깅에 결정적이다. 회전된 사각형을
 *     스케일할 때 anchor 보정이 어긋나면 "이미지가 미끄러진다" 는 클래식
 *     버그가 나는데, 이걸 컴포넌트 한 곳에서 잡으려고 하면 지옥.
 *   - 자동 배치(bbox 충돌 + cascade) 도 결정론적 순수 함수라 단독 테스트
 *     하기 좋다.
 *
 * 좌표계 약속:
 *   - "screen"    : viewport DOM 의 client 좌표 (pointer event 가 주는 값)
 *   - "canvas"    : 캔버스(월드) 좌표. 카메라(tx, ty, scale) 가 평면을 화면에
 *                   매핑한다. canvas = (screen - tx) / scale.
 *   - "item-local": 아이템의 회전을 풀고 좌상단 원점으로 평행이동한 좌표.
 *                   변환 핸들 계산에서만 필요.
 */

import type { CanvasCamera, CanvasItemTransform, ConnectionAnchor } from "./canvasLayout";

/* ──────────────────────────────────────────────────────────────
 * Camera / 좌표계 변환
 * ────────────────────────────────────────────────────────────── */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** screen 좌표 (viewport client) → canvas 좌표. viewportRect 는
 *  getBoundingClientRect() 결과로 받는다. */
export function screenToCanvas(
  screen: Point,
  viewportRect: { left: number; top: number },
  camera: CanvasCamera,
): Point {
  return {
    x: (screen.x - viewportRect.left - camera.tx) / camera.scale,
    y: (screen.y - viewportRect.top - camera.ty) / camera.scale,
  };
}

/** canvas 좌표 → screen 좌표. */
export function canvasToScreen(
  canvas: Point,
  viewportRect: { left: number; top: number },
  camera: CanvasCamera,
): Point {
  return {
    x: canvas.x * camera.scale + camera.tx + viewportRect.left,
    y: canvas.y * camera.scale + camera.ty + viewportRect.top,
  };
}

/** 카메라 평면 좌표 → CSS transform string. translate 가 먼저, scale 이 나중.
 *  순서 중요 — scale 이 먼저 오면 translate 가 scale 만큼 늘어난다. */
export function cameraToTransform(camera: CanvasCamera): string {
  return `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})`;
}

/** 휠 zoom — 마우스 커서 아래 캔버스 점이 zoom 후에도 같은 화면 위치에
 *  남도록 카메라를 갱신한다 (포인트-앵커 줌). */
export function zoomAt(
  camera: CanvasCamera,
  anchorScreen: Point,
  viewportRect: { left: number; top: number },
  nextScale: number,
): CanvasCamera {
  const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  if (clamped === camera.scale) return camera;
  const before = screenToCanvas(anchorScreen, viewportRect, camera);
  // canvas 점 before 를 새 scale 로 화면에 다시 그렸을 때 같은 screen 위치가
  // 되도록 tx/ty 를 역산.
  const tx = anchorScreen.x - viewportRect.left - before.x * clamped;
  const ty = anchorScreen.y - viewportRect.top - before.y * clamped;
  return { tx, ty, scale: clamped };
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.1; // 휠 1tick

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ──────────────────────────────────────────────────────────────
 * Item AABB / hit test
 * ────────────────────────────────────────────────────────────── */

/** 회전을 고려한 아이템의 axis-aligned bounding box (canvas 좌표).
 *  flip 은 위치/크기에 영향을 주지 않으므로 무시. */
export function itemAABB(t: CanvasItemTransform): Rect {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  if (!t.rotation) return { x: t.x, y: t.y, w: t.w, h: t.h };
  const cos = Math.abs(Math.cos(t.rotation));
  const sin = Math.abs(Math.sin(t.rotation));
  const W = t.w * cos + t.h * sin;
  const H = t.w * sin + t.h * cos;
  return { x: cx - W / 2, y: cy - H / 2, w: W, h: H };
}

/** *시각적으로 보이는* 영역의 AABB — crop 이 적용된 ref 는 outer box 가 아닌
 *  보이는 부분(=crop 영역) 의 AABB 를 반환. 정렬/분포/타일/fit/focus 등 사용자
 *  체감의 "이 객체의 가장자리는 여기" 라는 의도를 정확히 반영한다.
 *
 *  v2 baked: tr.w/h 가 이미 visible 크기이므로 itemAABB 그대로.
 *  v1 legacy (cropBaked 미설정): tr.w/h 가 외곽, crop 으로 visible 계산.
 *  crop 미적용 → itemAABB 와 동일. rotation 도 정상 반영. */
export function visibleItemAABB(t: CanvasItemTransform): Rect {
  if (!t.crop || t.cropBaked) return itemAABB(t);
  const { l, t: cT, r, b } = t.crop;
  const visW = t.w * (1 - l - r);
  const visH = t.h * (1 - cT - b);
  // 객체 local 좌표계에서 visible 영역의 중심 — outer center 와 다를 수 있음.
  const cxLocal = (t.w * (l - r)) / 2;
  const cyLocal = (t.h * (cT - b)) / 2;
  const itemCx = t.x + t.w / 2;
  const itemCy = t.y + t.h / 2;
  // world center of visible region
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const visCx = itemCx + cxLocal * cos - cyLocal * sin;
  const visCy = itemCy + cxLocal * sin + cyLocal * cos;
  if (!t.rotation) {
    return { x: visCx - visW / 2, y: visCy - visH / 2, w: visW, h: visH };
  }
  const absCos = Math.abs(cos);
  const absSin = Math.abs(sin);
  const aabbW = visW * absCos + visH * absSin;
  const aabbH = visW * absSin + visH * absCos;
  return { x: visCx - aabbW / 2, y: visCy - aabbH / 2, w: aabbW, h: aabbH };
}

/** 두 AABB 가 교차하면 true. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/** 점이 회전된 사각형 안에 있는가. 회전을 풀고 로컬 좌표에서 박스 in/out 만 검사. */
export function pointInItem(p: Point, t: CanvasItemTransform): boolean {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= t.w / 2 && Math.abs(ly) <= t.h / 2;
}

/* ──────────────────────────────────────────────────────────────
 * Connection anchor — 객체 로컬 (u,v) ↔ 캔버스 변환, 가장자리 흡착
 *
 * (u,v) ∈ [0,1] 가 객체 박스 내 비율 좌표. 좌상=0,0, 우하=1,1.
 *   - localX = (u - 0.5) * w, localY = (v - 0.5) * h
 *   - 회전 행렬 적용 후 객체 중심 더해 캔버스 좌표.
 *
 * 회전을 객체 박스 비율 위에서 다루므로 리사이즈/회전에도 anchor 가 자연
 * 추적된다. (예: 우측 중앙 anchor 는 항상 회전된 사각형의 우측 변 중점.)
 * ────────────────────────────────────────────────────────────── */

/** 객체 로컬 (u,v) → 캔버스 좌표. */
export function localToCanvas(t: CanvasItemTransform, a: ConnectionAnchor): Point {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const lx = (a.u - 0.5) * t.w;
  const ly = (a.v - 0.5) * t.h;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
}

/** 캔버스 좌표 → 객체 로컬 (u,v). 회전을 풀고 박스 비율로 환산. */
export function canvasToLocal(t: CanvasItemTransform, p: Point): ConnectionAnchor {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const u = t.w > 0 ? lx / t.w + 0.5 : 0.5;
  const v = t.h > 0 ? ly / t.h + 0.5 : 0.5;
  return { u, v };
}

/** 외부 점에서 *회전된 객체 가장자리* 까지 가장 가까운 점.
 *
 *  - 외부 점을 객체 로컬 좌표로 환산
 *  - axis-aligned 박스 [-w/2, w/2] × [-h/2, h/2] 위 가장자리에 클램프
 *  - 최단거리 = 박스 안이면 가장 가까운 변, 박스 밖이면 박스 경계로 클램프
 *  - 결과를 다시 캔버스 좌표로 변환
 *  - 가장자리 위에 있는 anchor 의 (u,v) 도 함께 반환 → connection 으로 저장 */
export function nearestEdgePoint(
  t: CanvasItemTransform,
  p: Point,
): { canvas: Point; anchor: ConnectionAnchor } {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  // 로컬 좌표 (객체 회전 풀린 상태)
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const hw = t.w / 2;
  const hh = t.h / 2;
  let ex: number;
  let ey: number;
  // 박스 밖이면 박스 경계로 클램프, 안이면 가장 가까운 변으로 push.
  const inside = Math.abs(lx) <= hw && Math.abs(ly) <= hh;
  if (inside) {
    // 4 변까지 거리 비교, 최소인 변으로 push.
    const dl = lx + hw;       // 좌
    const dr = hw - lx;       // 우
    const dt = ly + hh;       // 상
    const db = hh - ly;       // 하
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) { ex = -hw; ey = clamp(ly, -hh, hh); }
    else if (m === dr) { ex = hw; ey = clamp(ly, -hh, hh); }
    else if (m === dt) { ex = clamp(lx, -hw, hw); ey = -hh; }
    else { ex = clamp(lx, -hw, hw); ey = hh; }
  } else {
    ex = clamp(lx, -hw, hw);
    ey = clamp(ly, -hh, hh);
  }
  // 다시 캔버스로 회전.
  const cos2 = Math.cos(t.rotation);
  const sin2 = Math.sin(t.rotation);
  const canvas: Point = { x: cx + ex * cos2 - ey * sin2, y: cy + ex * sin2 + ey * cos2 };
  const anchor: ConnectionAnchor = {
    u: t.w > 0 ? ex / t.w + 0.5 : 0.5,
    v: t.h > 0 ? ey / t.h + 0.5 : 0.5,
  };
  return { canvas, anchor };
}

/** 외부 점 → 객체 중심 직선이 객체 가장자리와 만나는 점 (auto-edge snap).
 *  ConnectionLayer 가 anchor 없는 connection 끝점을 그릴 때 사용 — 화살표가
 *  객체 *중앙* 이 아니라 *가장자리* 에 닿도록.
 *
 *  중심에서 외부 점으로 향하는 ray 가 박스 가장자리와 만나는 t 값을 4면별로
 *  계산해 0 < t ≤ 1 중 최소를 사용. ray 길이가 0(외부=중심)이면 우측 변
 *  중점으로 fallback. */
export function rayEdgeHit(
  t: CanvasItemTransform,
  external: Point,
): { canvas: Point; anchor: ConnectionAnchor } {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const dx = external.x - cx;
  const dy = external.y - cy;
  // 회전을 풀어 로컬 ray 로 변환.
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const hw = t.w / 2;
  const hh = t.h / 2;
  if (lx === 0 && ly === 0) {
    // ray 길이 0 — 우측 변 중점으로 fallback.
    return { canvas: localToCanvas(t, { u: 1, v: 0.5 }), anchor: { u: 1, v: 0.5 } };
  }
  // 4 변별 t 값 (0 < t < ∞ 중 박스 가장자리에 닿는 첫 t).
  const ts: number[] = [];
  if (lx > 0) ts.push(hw / lx);
  if (lx < 0) ts.push(-hw / lx);
  if (ly > 0) ts.push(hh / ly);
  if (ly < 0) ts.push(-hh / ly);
  // 박스 안의 가장 작은 양수 t — 동시에 다른 축 좌표가 박스 내에 있어야 유효.
  let chosen = Number.POSITIVE_INFINITY;
  for (const tv of ts) {
    if (tv <= 0) continue;
    const ex = lx * tv;
    const ey = ly * tv;
    if (Math.abs(ex) <= hw + 1e-6 && Math.abs(ey) <= hh + 1e-6) {
      if (tv < chosen) chosen = tv;
    }
  }
  if (!Number.isFinite(chosen)) {
    // 외부 점이 박스 *내부* 에 있으면 해(t<1) 가 박스 면 위가 아닐 수 있음 —
    // ray 를 *반대 방향* 으로도 시도해서 가장 가까운 가장자리.
    return nearestEdgePoint(t, external);
  }
  const ex = lx * chosen;
  const ey = ly * chosen;
  const cos2 = Math.cos(t.rotation);
  const sin2 = Math.sin(t.rotation);
  return {
    canvas: { x: cx + ex * cos2 - ey * sin2, y: cy + ex * sin2 + ey * cos2 },
    anchor: { u: t.w > 0 ? ex / t.w + 0.5 : 0.5, v: t.h > 0 ? ey / t.h + 0.5 : 0.5 },
  };
}

/* ──────────────────────────────────────────────────────────────
 * Connection anchor 슬롯 — 객체당 *고정 8 anchor* (4 코너 + 4 변 중심).
 * 자유 위치(연속 (u,v)) 대신 슬롯에만 anchor 가 박혀 라인 시작/끝점이
 * 예측 가능. 사용자 이동 시에도 anchor 는 변하지 않고 객체와 함께 이동.
 * ────────────────────────────────────────────────────────────── */

export type AnchorSlot =
  | "TL" | "TC" | "TR"
  | "ML" | "MR"
  | "BL" | "BC" | "BR";

export const SLOT_UV: Readonly<Record<AnchorSlot, ConnectionAnchor>> = Object.freeze({
  TL: { u: 0,   v: 0   },
  TC: { u: 0.5, v: 0   },
  TR: { u: 1,   v: 0   },
  ML: { u: 0,   v: 0.5 },
  MR: { u: 1,   v: 0.5 },
  BL: { u: 0,   v: 1   },
  BC: { u: 0.5, v: 1   },
  BR: { u: 1,   v: 1   },
});

export const ALL_SLOTS: readonly AnchorSlot[] = Object.freeze([
  "TL", "TC", "TR", "ML", "MR", "BL", "BC", "BR",
]);

/** 객체 anchor 의 *바깥 법선* 단위 벡터 (캔버스 좌표계, 회전 반영).
 *  - 변 anchor (TC/BC/ML/MR): 그 변의 outward 방향 (객체 회전 적용 후)
 *  - 코너 anchor (TL/TR/BL/BR): 두 변의 bisector (대각 45°)
 *
 *  Edge-tangent cubic bezier 의 control point 방향으로 사용 — 라인이 변에
 *  *수직으로 빠져나가* 자연스럽게 합류한다. 객체 위치/회전 무관 안정. */
export function anchorOutwardNormal(
  t: CanvasItemTransform,
  a: ConnectionAnchor,
): Point {
  // local (u,v) → centered offset (-1..1). 중앙(0.5,0.5)은 모호하므로 fallback.
  let lx = a.u === 0 ? -1 : a.u === 1 ? 1 : 0;
  let ly = a.v === 0 ? -1 : a.v === 1 ? 1 : 0;
  if (lx === 0 && ly === 0) return { x: 0, y: -1 }; // 중심 anchor 안전 fallback
  const len = Math.hypot(lx, ly);
  lx /= len;
  ly /= len;
  // 객체 회전 적용
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return { x: lx * cos - ly * sin, y: lx * sin + ly * cos };
}

/** anchor 가 8 슬롯 중 어느 위치인지 (가장 가까운). 슬롯 위에 정확히 박힌
 *  데이터를 라벨로 변환할 때 사용. */
export function slotOfAnchor(a: ConnectionAnchor): AnchorSlot {
  let best: AnchorSlot = "TL";
  let bestD = Infinity;
  for (const s of ALL_SLOTS) {
    const t = SLOT_UV[s];
    const d = (t.u - a.u) ** 2 + (t.v - a.v) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** 객체의 8 슬롯 캔버스 좌표 — 슬롯 핸들 렌더링/히트테스트용. */
export function slotPoints(
  t: CanvasItemTransform,
): Array<{ slot: AnchorSlot; canvas: Point; anchor: ConnectionAnchor }> {
  return ALL_SLOTS.map((s) => {
    const a = SLOT_UV[s];
    return { slot: s, anchor: a, canvas: localToCanvas(t, a) };
  });
}

/** 캔버스 점 → 객체의 가장 가까운 슬롯 (anchor + 그 슬롯의 캔버스 좌표). */
export function nearestSlot(
  t: CanvasItemTransform,
  p: Point,
): { slot: AnchorSlot; anchor: ConnectionAnchor; canvas: Point } {
  const pts = slotPoints(t);
  let best = pts[0];
  let bestD = Infinity;
  for (const sp of pts) {
    const d = (sp.canvas.x - p.x) ** 2 + (sp.canvas.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = sp; }
  }
  return best;
}

/** 외부 점에서 *객체의 가장 가까운 슬롯* 까지 — 링크 모드의 자유 시작점이
 *  상대 객체로 향할 때, 도착 측 슬롯 자석 흡착에 사용. */
export function snapAnchorToSlot(
  t: CanvasItemTransform,
  fixed: ConnectionAnchor,
): { slot: AnchorSlot; anchor: ConnectionAnchor } {
  const slot = slotOfAnchor(fixed);
  return { slot, anchor: SLOT_UV[slot] };
}

/** 선택 항목들의 합집합 bbox (canvas 좌표). 빈 입력이면 null. */
export function unionBBox(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** bbox 가 viewport 에 들어가도록 카메라 산출. padding 은 캔버스 좌표 기준이
 *  아닌 *화면 픽셀* 기준으로 일관되게 비워둘 양. */
export function cameraToFit(
  bbox: Rect,
  viewport: { width: number; height: number },
  padding = 48,
): CanvasCamera {
  const vw = Math.max(1, viewport.width - padding * 2);
  const vh = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(Math.min(vw / bbox.w, vh / bbox.h), MIN_SCALE, MAX_SCALE);
  const tx = padding + (vw - bbox.w * scale) / 2 - bbox.x * scale;
  const ty = padding + (vh - bbox.h * scale) / 2 - bbox.y * scale;
  return { tx, ty, scale };
}

/* ──────────────────────────────────────────────────────────────
 * Transform 핸들 수학 — 회전된 사각형의 코너 스케일
 *
 * 사용자가 코너 핸들을 드래그할 때, *반대편 코너(anchor)* 가 화면에서
 * 고정되도록 새 w/h/x/y 를 산출한다. 회전이 0 이 아니면 anchor 점이
 * 캔버스에서 보면 움직이므로 수학이 필요하다.
 * ────────────────────────────────────────────────────────────── */

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface CornerOffsets {
  /** 아이템 로컬 (회전 풀린 좌표) 에서 anchor 의 부호. */
  ax: -1 | 0 | 1;
  ay: -1 | 0 | 1;
  /** 해당 핸들이 영향을 주는 축. */
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
}

export const HANDLES: Record<HandleId, CornerOffsets> = {
  nw: { ax: 1, ay: 1, hx: -1, hy: -1 },
  n:  { ax: 0, ay: 1, hx: 0,  hy: -1 },
  ne: { ax: -1, ay: 1, hx: 1, hy: -1 },
  e:  { ax: -1, ay: 0, hx: 1, hy: 0 },
  se: { ax: -1, ay: -1, hx: 1, hy: 1 },
  s:  { ax: 0, ay: -1, hx: 0, hy: 1 },
  sw: { ax: 1, ay: -1, hx: -1, hy: 1 },
  w:  { ax: 1, ay: 0, hx: -1, hy: 0 },
};

const MIN_SIZE = 24; // 너무 작아지면 핸들을 잡지 못해 복구 불가

/** 코너/엣지 스케일.
 *  start*  : pointer down 시점의 transform / pointer canvas 좌표
 *  cursor  : 현재 pointer 의 canvas 좌표
 *  uniform : 종횡비 유지 모드 (default — 원본 비율 보존, Shift 해제 시 free) */
export function resizeByHandle(
  start: CanvasItemTransform,
  startPointer: Point,
  cursor: Point,
  handle: HandleId,
  uniform: boolean,
): CanvasItemTransform {
  const cfg = HANDLES[handle];
  const cos = Math.cos(start.rotation);
  const sin = Math.sin(start.rotation);
  // 시작 center
  const cx0 = start.x + start.w / 2;
  const cy0 = start.y + start.h / 2;
  // pointer delta 를 *로컬* 축으로 분해 (회전을 푼다)
  const dxScreen = cursor.x - startPointer.x;
  const dyScreen = cursor.y - startPointer.y;
  const dxLocal = dxScreen * cos + dyScreen * sin;
  const dyLocal = -dxScreen * sin + dyScreen * cos;

  // 새 크기 = 기존 크기 + 핸들 부호 * delta
  let newW = Math.max(MIN_SIZE, start.w + cfg.hx * dxLocal);
  let newH = Math.max(MIN_SIZE, start.h + cfg.hy * dyLocal);

  if (uniform) {
    // 종횡비 유지 — 핸들 종류에 따라 *주축* 결정 후 다른 축은 비율로 환산.
    const ratio = start.w / Math.max(1, start.h);
    if (cfg.hx !== 0 && cfg.hy !== 0) {
      // 코너: 더 큰 변화를 따라간다 (자연스러운 직관).
      const wScale = newW / start.w;
      const hScale = newH / start.h;
      if (Math.abs(wScale - 1) > Math.abs(hScale - 1)) {
        newH = newW / ratio;
      } else {
        newW = newH * ratio;
      }
    } else if (cfg.hx !== 0) {
      // 좌/우 엣지: width 가 주, height 은 ratio 로 따라옴.
      newH = newW / ratio;
    } else if (cfg.hy !== 0) {
      // 상/하 엣지: height 가 주, width 가 따라옴.
      newW = newH * ratio;
    }
    newH = Math.max(MIN_SIZE, newH);
    newW = Math.max(MIN_SIZE, newW);
  }

  // anchor (반대편 코너) 의 시작 위치 (canvas 좌표) — 회전 적용
  const ax0Local = (cfg.ax * start.w) / 2;
  const ay0Local = (cfg.ay * start.h) / 2;
  const anchorX = cx0 + ax0Local * cos - ay0Local * sin;
  const anchorY = cy0 + ax0Local * sin + ay0Local * cos;

  // anchor 가 같은 위치에 남도록 새 center 산출
  const axNewLocal = (cfg.ax * newW) / 2;
  const ayNewLocal = (cfg.ay * newH) / 2;
  const newCx = anchorX - axNewLocal * cos + ayNewLocal * sin;
  const newCy = anchorY - axNewLocal * sin - ayNewLocal * cos;

  return {
    ...start,
    x: newCx - newW / 2,
    y: newCy - newH / 2,
    w: newW,
    h: newH,
  };
}

/** 회전 — center 를 중심으로 angle (라디안) 만큼 돌린다.
 *  startPointer / cursor 는 canvas 좌표. snap15 가 true 면 15° 단위로 스냅. */
export function rotateByHandle(
  start: CanvasItemTransform,
  startPointer: Point,
  cursor: Point,
  snap15: boolean,
): CanvasItemTransform {
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const a0 = Math.atan2(startPointer.y - cy, startPointer.x - cx);
  const a1 = Math.atan2(cursor.y - cy, cursor.x - cx);
  let rot = start.rotation + (a1 - a0);
  if (snap15) {
    const step = (15 * Math.PI) / 180;
    rot = Math.round(rot / step) * step;
  }
  return { ...start, rotation: rot };
}

/* ──────────────────────────────────────────────────────────────
 * 자동 배치 — 신규 ref 가 폴더에 들어왔을 때 충돌 회피 cascade
 * ────────────────────────────────────────────────────────────── */

export interface PlacementContext {
  /** 카메라 뷰포트 중심의 캔버스 좌표 — 새 항목이 여기 근처에 떨어진다. */
  viewportCenterCanvas: Point;
  /** 카메라 뷰포트의 캔버스 좌표 폭/높이 — cascade 가 화면 밖으로 새지 않게. */
  viewportSizeCanvas: { width: number; height: number };
  /** 이미 배치된 아이템들의 AABB — 충돌 검사에 사용. */
  existing: Rect[];
}

/** ref 의 자연 해상도(item.width / item.height) 로부터 표시 크기 산출.
 *  긴 변이 maxLong 을 넘으면 비율 유지하며 캡. 둘 중 하나라도 없으면
 *  kind 별 기본 비율로 폴백. */
export function placementSize(
  natural: { width?: number | null; height?: number | null; kind?: string },
  maxLong = 320,
): { w: number; h: number } {
  let w = natural.width ?? 0;
  let h = natural.height ?? 0;
  if (!w || !h) {
    // 폴백 — image/webp/gif/doc 은 4:3, video/youtube/link 는 16:9
    const isWide = natural.kind === "video" || natural.kind === "youtube" || natural.kind === "link";
    w = isWide ? 320 : 240;
    h = isWide ? 180 : 180;
  }
  const long = Math.max(w, h);
  if (long > maxLong) {
    const k = maxLong / long;
    w *= k;
    h *= k;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/** 자동 배치 자리 산출. 카메라 뷰포트 중심에서 시작해 충돌하면 오른쪽으로
 *  STEP 만큼 cascade, 우측 경계 넘어가면 다음 행. 그래도 다 차면 강제로
 *  뷰포트 밖이라도 끝쪽에 박는다 — 미배치보다 어디든 있는 게 나음. */
export function findPlacementSpot(
  ctx: PlacementContext,
  size: { w: number; h: number },
): Point {
  const STEP_X = 24;
  const STEP_Y = 24;
  const left = ctx.viewportCenterCanvas.x - ctx.viewportSizeCanvas.width / 2;
  const right = ctx.viewportCenterCanvas.x + ctx.viewportSizeCanvas.width / 2;
  const top = ctx.viewportCenterCanvas.y - ctx.viewportSizeCanvas.height / 2;

  let x = ctx.viewportCenterCanvas.x - size.w / 2;
  let y = ctx.viewportCenterCanvas.y - size.h / 2;
  // 시작점을 뷰포트 안쪽 좌상단 근처로 조금 보정 — 가운데 한 자리에 첫 항목만
  // 박혀 보이는 것보다 자연스럽게 흐르게.
  if (ctx.existing.length > 0) {
    x = left + 24;
    y = top + 24;
  }

  const fits = (r: Rect): boolean => !ctx.existing.some((e) => rectsIntersect(r, e));

  // 최대 1000 회 시도 — 사실상 항상 그 전에 멈춤
  for (let i = 0; i < 1000; i += 1) {
    const candidate: Rect = { x, y, w: size.w, h: size.h };
    if (fits(candidate)) return { x, y };
    x += STEP_X;
    if (x + size.w > right) {
      x = left + 24;
      y += size.h + STEP_Y;
    }
  }
  return { x, y };
}

/* ──────────────────────────────────────────────────────────────
 * 스냅 — 다른 아이템의 엣지에 가까우면 끌어당김
 * ────────────────────────────────────────────────────────────── */

export interface SnapGuide {
  /** 'v' 는 세로 가이드(특정 x), 'h' 는 가로 가이드(특정 y). */
  axis: "v" | "h";
  pos: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** 드래그 중인 selection bbox 가 다른 아이템들의 좌/우/상/하 엣지 또는 중심
 *  축에 일정 픽셀 이내로 접근하면 잡아당긴다. threshold 는 *화면 픽셀* 이
 *  아니라 *캔버스 좌표* 이므로 호출처에서 6/scale 같은 값으로 넘긴다. */
export function computeSnap(
  movingBBox: Rect,
  others: Rect[],
  threshold: number,
): SnapResult {
  const movingEdges = {
    left: movingBBox.x,
    right: movingBBox.x + movingBBox.w,
    centerX: movingBBox.x + movingBBox.w / 2,
    top: movingBBox.y,
    bottom: movingBBox.y + movingBBox.h,
    centerY: movingBBox.y + movingBBox.h / 2,
  };
  let bestDx = 0;
  let bestAbsX = Infinity;
  let guideX: number | null = null;
  let bestDy = 0;
  let bestAbsY = Infinity;
  let guideY: number | null = null;

  for (const o of others) {
    const oEdges = [o.x, o.x + o.w / 2, o.x + o.w];
    const mEdges = [movingEdges.left, movingEdges.centerX, movingEdges.right];
    for (const me of mEdges) {
      for (const oe of oEdges) {
        const d = oe - me;
        if (Math.abs(d) < threshold && Math.abs(d) < bestAbsX) {
          bestAbsX = Math.abs(d);
          bestDx = d;
          guideX = oe;
        }
      }
    }
    const oVE = [o.y, o.y + o.h / 2, o.y + o.h];
    const mVE = [movingEdges.top, movingEdges.centerY, movingEdges.bottom];
    for (const me of mVE) {
      for (const oe of oVE) {
        const d = oe - me;
        if (Math.abs(d) < threshold && Math.abs(d) < bestAbsY) {
          bestAbsY = Math.abs(d);
          bestDy = d;
          guideY = oe;
        }
      }
    }
  }
  const guides: SnapGuide[] = [];
  if (guideX !== null) guides.push({ axis: "v", pos: guideX });
  if (guideY !== null) guides.push({ axis: "h", pos: guideY });
  return { dx: bestDx, dy: bestDy, guides };
}

/** Grid 스냅 — moving bbox 의 좌상단을 가장 가까운 grid 칸 좌상단에 끌어
 *  당긴다. `computeSnap` 과 동일한 시그니처(dx, dy, guides)로 반환해 caller
 *  가 결과를 단순 합산만 하면 된다. threshold 는 캔버스 좌표 픽셀.
 *
 *  guides 는 *시각 가이드* 를 강조하기 위함이 아니라 (배경 grid 자체가
 *  이미 보이고 있음), 다른 객체 스냅과 동일 인터페이스 유지를 위해 비워서
 *  반환한다. */
export function computeGridSnap(
  movingBBox: Rect,
  gridSize: number,
  threshold: number,
): SnapResult {
  if (gridSize <= 0) return { dx: 0, dy: 0, guides: [] };
  const targetX = Math.round(movingBBox.x / gridSize) * gridSize;
  const targetY = Math.round(movingBBox.y / gridSize) * gridSize;
  const dx = targetX - movingBBox.x;
  const dy = targetY - movingBBox.y;
  return {
    dx: Math.abs(dx) <= threshold ? dx : 0,
    dy: Math.abs(dy) <= threshold ? dy : 0,
    guides: [],
  };
}
