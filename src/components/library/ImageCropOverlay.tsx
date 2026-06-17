import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import type { RegionRect } from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

/* ImageCropOverlay — 정지 이미지 위 *파괴적 크롭* 영역 선택 UI (프리뷰 전용).
 *
 * RegionOverlay 와 동일한 좌표 모델(letterbox content box + pan/zoom)을 쓰되,
 * 목적이 다르다:
 *   - region 주석: 여러 박스를 그려 코멘트를 단다 → 텍스트 popover.
 *   - crop: *하나의* 사각형을 8핸들로 조정 → 확정 시 픽셀을 잘라 파일 저장.
 *
 * 캔버스 모드(CanvasCropEditor)는 비파괴 + 원본 밖 확장이 가능한 반면, 여기선
 * 잘라 저장하는 파괴적 동작이라 영역을 이미지 경계 [0,1] 안으로 제한한다.
 *
 * 좌표계: 컨테이너(containerRef) 픽셀 공간. 오버레이는 transform 밖에 있으므로
 * pan/scale 을 받아 visible content box 를 직접 계산해 핸들/마스크를 그린다.
 */

interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeContentBox(
  containerW: number,
  containerH: number,
  naturalW: number | null,
  naturalH: number | null,
): ContentBox {
  if (!naturalW || !naturalH || containerW <= 0 || containerH <= 0) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  const naturalAspect = naturalW / naturalH;
  const containerAspect = containerW / containerH;
  if (Math.abs(naturalAspect - containerAspect) < 0.001) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  if (naturalAspect > containerAspect) {
    const contentH = containerW / naturalAspect;
    return { x: 0, y: (containerH - contentH) / 2, w: containerW, h: contentH };
  }
  const contentW = containerH * naturalAspect;
  return { x: (containerW - contentW) / 2, y: 0, w: contentW, h: containerH };
}

/** 크롭 사각형의 최소 크기(정규화). 너무 작은 크롭으로 1px 이미지가 나오는
 *  것을 막는다. */
const MIN_SIZE = 0.02;

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type DragKind = HandleId | "move";

interface DragState {
  kind: DragKind;
  startRegion: RegionRect;
  startNormX: number;
  startNormY: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 핸들별 위치(컨테이너 기준 px). corner/edge 8개. */
const HANDLES: { id: HandleId; cx: number; cy: number; cursor: string }[] = [
  { id: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { id: "n", cx: 0.5, cy: 0, cursor: "ns-resize" },
  { id: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { id: "e", cx: 1, cy: 0.5, cursor: "ew-resize" },
  { id: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  { id: "s", cx: 0.5, cy: 1, cursor: "ns-resize" },
  { id: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { id: "w", cx: 0, cy: 0.5, cursor: "ew-resize" },
];

export interface ImageCropOverlayProps {
  containerRef: RefObject<HTMLElement>;
  naturalWidth: number | null;
  naturalHeight: number | null;
  panX?: number;
  panY?: number;
  scale?: number;
  /** 현재 크롭 사각형 (정규화 [0,1], content box 기준). */
  value: RegionRect;
  onChange: (next: RegionRect) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export function ImageCropOverlay({
  containerRef,
  naturalWidth,
  naturalHeight,
  panX = 0,
  panY = 0,
  scale = 1,
  value,
  onChange,
  onConfirm,
  onCancel,
  onReset,
}: ImageCropOverlayProps) {
  const t = useT();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const baseContentBox = useMemo(
    () => computeContentBox(containerSize.w, containerSize.h, naturalWidth, naturalHeight),
    [containerSize.w, containerSize.h, naturalWidth, naturalHeight],
  );

  const contentBox = useMemo(
    () => ({
      x: panX + baseContentBox.x * scale,
      y: panY + baseContentBox.y * scale,
      w: baseContentBox.w * scale,
      h: baseContentBox.h * scale,
    }),
    [baseContentBox.x, baseContentBox.y, baseContentBox.w, baseContentBox.h, panX, panY, scale],
  );

  const regionToPixels = useCallback(
    (r: RegionRect) => ({
      left: contentBox.x + r.x * contentBox.w,
      top: contentBox.y + r.y * contentBox.h,
      width: r.w * contentBox.w,
      height: r.h * contentBox.h,
    }),
    [contentBox],
  );

  /* 컨테이너 px → content box 기준 정규화 좌표 [0,1]. */
  const pixelToNorm = useCallback(
    (px: number, py: number) => {
      if (contentBox.w <= 0 || contentBox.h <= 0) return { nx: 0, ny: 0 };
      return {
        nx: clamp01((px - contentBox.x) / contentBox.w),
        ny: clamp01((py - contentBox.y) / contentBox.h),
      };
    },
    [contentBox],
  );

  const dragRef = useRef<DragState | null>(null);

  const applyDrag = useCallback(
    (kind: DragKind, start: RegionRect, nx: number, ny: number, startNX: number, startNY: number) => {
      if (kind === "move") {
        const dx = nx - startNX;
        const dy = ny - startNY;
        const x = Math.max(0, Math.min(1 - start.w, start.x + dx));
        const y = Math.max(0, Math.min(1 - start.h, start.y + dy));
        onChange({ x, y, w: start.w, h: start.h });
        return;
      }
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (kind.includes("w")) left = Math.min(nx, right - MIN_SIZE);
      if (kind.includes("e")) right = Math.max(nx, left + MIN_SIZE);
      if (kind.includes("n")) top = Math.min(ny, bottom - MIN_SIZE);
      if (kind.includes("s")) bottom = Math.max(ny, top + MIN_SIZE);
      onChange({ x: left, y: top, w: right - left, h: bottom - top });
    },
    [onChange],
  );

  /* mousedown 으로 시작 — RegionOverlay 와 동일하게 *마우스 이벤트* 로 통일한다.
     pointerdown 에서 preventDefault 를 호출하면 브라우저가 호환 mouseup 을
     억제해 window mouseup 이 오지 않고 드래그가 안 풀리는 버그가 있어,
     down/move/up 을 모두 mouse 이벤트로 맞춘다. */
  const startDrag = useCallback(
    (kind: DragKind) => (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const { nx, ny } = pixelToNorm(event.clientX - rect.left, event.clientY - rect.top);
      dragRef.current = { kind, startRegion: value, startNormX: nx, startNormY: ny };
    },
    [pixelToNorm, value],
  );

  /* 드래그 추적 — window 레벨로 등록해 오버레이 밖으로 나가도 끊기지 않게.
     dragRef 가 있을 때만 등록되어 idle 시 비용 0. */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = overlay.getBoundingClientRect();
      const { nx, ny } = pixelToNorm(event.clientX - rect.left, event.clientY - rect.top);
      applyDrag(drag.kind, drag.startRegion, nx, ny, drag.startNormX, drag.startNormY);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [applyDrag, pixelToNorm]);

  /* Enter → 확정, Esc → 취소. capture 단계로 다른 전역 단축키보다 우선. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);

  const px = regionToPixels(value);

  /* 마스크 — 크롭 사각형 *바깥* 을 어둡게. 컨테이너 전체를 4개의 띠로 덮는다. */
  const masks = [
    { left: 0, top: 0, width: containerSize.w, height: px.top },
    { left: 0, top: px.top + px.height, width: containerSize.w, height: Math.max(0, containerSize.h - (px.top + px.height)) },
    { left: 0, top: px.top, width: px.left, height: px.height },
    { left: px.left + px.width, top: px.top, width: Math.max(0, containerSize.w - (px.left + px.width)), height: px.height },
  ];

  return (
    <div ref={overlayRef} className="absolute inset-0" style={{ pointerEvents: "auto" }}>
      {/* 바깥 어둡게 */}
      {masks.map((m, i) => (
        <div
          key={i}
          className="absolute bg-black/55"
          style={{ left: m.left, top: m.top, width: m.width, height: m.height, pointerEvents: "none" }}
        />
      ))}

      {/* 크롭 사각형 — 내부 드래그로 이동. */}
      <div
        className="absolute border-2 border-primary"
        style={{ left: px.left, top: px.top, width: px.width, height: px.height, cursor: "move", borderRadius: 0 }}
        onMouseDown={startDrag("move")}
      >
        {/* 3x3 그리드 가이드 */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
        </div>

        {/* 8 핸들 */}
        {HANDLES.map((h) => (
          <div
            key={h.id}
            onMouseDown={startDrag(h.id)}
            className="absolute h-3 w-3 border border-background bg-primary"
            style={{
              left: `calc(${h.cx * 100}% - 6px)`,
              top: `calc(${h.cy * 100}% - 6px)`,
              cursor: h.cursor,
              borderRadius: 0,
            }}
          />
        ))}
      </div>

      {/* 확정/취소 툴바 — 크롭 사각형 아래(공간 부족하면 위)에 붙인다. */}
      <CropToolbar
        anchor={px}
        containerSize={containerSize}
        confirmLabel={t("library.preview.cropConfirm")}
        cancelLabel={t("library.preview.cropCancel")}
        resetLabel={t("library.preview.cropReset")}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onReset={onReset}
      />
    </div>
  );
}

interface CropToolbarProps {
  anchor: { left: number; top: number; width: number; height: number };
  containerSize: { w: number; h: number };
  confirmLabel: string;
  cancelLabel: string;
  resetLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  onReset: () => void;
}

const TOOLBAR_H = 40;
const GAP = 10;

function CropToolbar({
  anchor,
  containerSize,
  confirmLabel,
  cancelLabel,
  resetLabel,
  onConfirm,
  onCancel,
  onReset,
}: CropToolbarProps) {
  const belowTop = anchor.top + anchor.height + GAP;
  const fitsBelow = belowTop + TOOLBAR_H < containerSize.h;
  const top = fitsBelow ? belowTop : Math.max(GAP, anchor.top - TOOLBAR_H - GAP);
  const left = Math.max(GAP, Math.min(anchor.left, containerSize.w - 220));

  return (
    <div
      className="absolute z-30 flex items-center gap-1.5 border border-border-subtle bg-surface-panel p-1.5 shadow-xl"
      style={{ top, left, borderRadius: 0, pointerEvents: "auto" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onConfirm}
        className="flex h-7 items-center gap-1.5 bg-primary px-2.5 text-caption font-semibold text-primary-foreground transition-colors hover:opacity-90"
        style={{ borderRadius: 0 }}
      >
        <Check className="h-3.5 w-3.5" />
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onReset}
        title={resetLabel}
        aria-label={resetLabel}
        className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        style={{ borderRadius: 0 }}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        title={cancelLabel}
        aria-label={cancelLabel}
        className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        style={{ borderRadius: 0 }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
