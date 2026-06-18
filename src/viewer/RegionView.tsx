import { useEffect, useMemo, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { RegionRect, TimestampNote } from "./types";

/* Read-only region overlay for viewer.
 *
 * 메인 앱 src/components/library/RegionOverlay.tsx 의 letterbox content-box
 * 산출 로직만 가져오고, 드래그-to-draw / 편집 popover / 삭제는 모두 제거.
 * 박스에 hover 하면 코멘트를 작은 라벨로 보여주는 것까지가 viewer 의 책임.
 *
 * Inspector 행 클릭 → seek 가 통합 UX 이므로 박스 클릭 = seek 같은 추가
 * 액션은 일부러 제공하지 않는다(노트 패널 클릭 한 곳에서만 시각 이동).
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

function clampRegion(r: RegionRect): RegionRect {
  const x = Math.max(0, Math.min(1, r.x));
  const y = Math.max(0, Math.min(1, r.y));
  const w = Math.max(0, Math.min(1 - x, r.w));
  const h = Math.max(0, Math.min(1 - y, r.h));
  return { x, y, w, h };
}

export interface RegionViewProps {
  containerRef: RefObject<HTMLElement>;
  naturalWidth: number | null;
  naturalHeight: number | null;
  /** 부모가 이미 anchor 시점/프레임으로 필터링한 region 노트들. */
  visibleNotes: TimestampNote[];
  /** 자료가 transform 으로 자유 줌·팬 되는 경우, 오버레이는 transform 밖에
   *  두고 여기로 transform 값을 전달한다. 메인 앱 RegionOverlay 와 동일한
   *  패턴 — 자세한 설명은 그 컴포넌트 참고. 미전달 = 변환 없음. */
  panX?: number;
  panY?: number;
  scale?: number;
}

export function RegionView({
  containerRef,
  naturalWidth,
  naturalHeight,
  visibleNotes,
  panX = 0,
  panY = 0,
  scale = 1,
}: RegionViewProps) {
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

  /* 정규화 region → px (컨테이너 기준). */
  const regionToPixels = (r: RegionRect) => {
    const c = clampRegion(r);
    return {
      left: contentBox.x + c.x * contentBox.w,
      top: contentBox.y + c.y * contentBox.h,
      width: c.w * contentBox.w,
      height: c.h * contentBox.h,
    };
  };

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="pointer-events-none absolute inset-0">
      {visibleNotes.map((note) => {
        if (!note.region) return null;
        const px = regionToPixels(note.region);
        const isHovered = hoveredId === note.id;
        /* 박스 자체는 pointer-events:auto 로 hover/title 가능. 빈 공간은
         *  none 이라 영상 클릭(=play/pause) 이 자연 통과.
         *  메인 앱 RegionOverlay 와 동일한 Tailwind primary 톤(빨강) — 이전엔
         *  inline `hsla(var(--primary), 0.7)` 를 썼는데 `hsla` 는 h/s/l/a 네
         *  인자를 요구하기 때문에 `var(--primary)` 가 HSL 컴포넌트로 풀려도
         *  문법 자체가 안 맞아 색이 fallback (검정/투명) 으로 깨졌다. */
        return (
          <div
            key={note.id}
            className={cn(
              "absolute border-2 transition-colors",
              isHovered
                ? "border-primary bg-primary/20"
                : "border-primary/70 bg-primary/10 hover:border-primary hover:bg-primary/20",
            )}
            style={{
              left: px.left,
              top: px.top,
              width: px.width,
              height: px.height,
              pointerEvents: "auto",
              borderRadius: 0,
            }}
            onMouseEnter={() => setHoveredId(note.id)}
            onMouseLeave={() => setHoveredId((cur) => (cur === note.id ? null : cur))}
            title={note.text}
          >
            {/* 라벨 — 메인 앱 RegionOverlay 와 동일하게 박스 좌상단에서 위로
             *  -translate-y-full 로 띄움. 박스가 컨테이너 상단에 너무 붙어
             *  있어 라벨이 잘릴 위험이 있을 땐(boxTop ≤ 44) 박스 안쪽 상단으로
             *  자동 폴백. */}
            <RegionLabel text={note.text} aboveSafely={px.top > 44} boxWidth={px.width} />
          </div>
        );
      })}
    </div>
  );
}

function RegionLabel({ text, aboveSafely, boxWidth }: { text: string; aboveSafely: boolean; boxWidth: number }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 leading-snug bg-primary px-1.5 py-0.5 text-2xs text-primary-foreground shadow-sm",
        aboveSafely && "-translate-y-full",
      )}
      /* 줄바꿈/정렬 정책은 메인 앱 RegionOverlay 라벨과 1:1 로 맞춘다.
         - left: -2 → 박스 border-2(2px) 바깥 가장자리와 라벨 좌측을 정렬.
           absolute 자식의 left:0 은 부모 *테두리 안쪽* 기준이라, 보정이
           없으면 라벨이 박스 선보다 2px 안쪽으로 들어가 박스만 좌측으로
           튀어나와(아웃라인 도드라짐) 보인다.
         - truncate 대신 normal + overflowWrap:anywhere 로 긴 코멘트를 전체
           표시. (Tailwind break-words 는 absolute 요소의 min-content 폭 계산에
           영향을 주지 않아 공백 없는 긴 문자열이 잘리는 버그가 있어 인라인으로
           강제.) */
      style={{
        borderRadius: 0,
        left: -2,
        maxWidth: Math.max(240, boxWidth),
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        lineHeight: 1.35,
      }}
    >
      {text}
    </div>
  );
}
