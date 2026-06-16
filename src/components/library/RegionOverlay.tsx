import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RegionRect, TimestampNote } from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

/* RegionOverlay — video / GIF / image 위에 *드래그-to-draw* 영역 코멘트 오버레이.
 *
 * 책임:
 *   1. 자료가 object-contain 으로 letterbox 된 *content box* 안의 좌표를
 *      [0,1] 정규화로 환산해 region 을 만들고, 기존 region 을 같은 좌표계로
 *      되돌려 그려준다 — 자료 비율 ≠ 컨테이너 비율 일 때도 박스가 자료 위에
 *      "박혀" 있도록 보장.
 *   2. drawing 모드 토글 시 마우스 인터랙션 정책:
 *        - drawing=true  → 오버레이 div 자체가 pointer events 캡처(crosshair).
 *          드래그가 새 region 을 그리고, mouseup 직후 popover 가 떠 텍스트 입력.
 *        - drawing=false → 오버레이 div 는 pointer-events: none. 다만 자식인
 *          *기존 region 박스* 만 pointer-events: auto 라서 hover/click 이
 *          여전히 동작. 박스 사이 빈 공간 클릭은 미디어로 통과(영상의 play/pause,
 *          이미지의 zoom 등) — 영역 모드가 꺼진 상태에서 그동안의 인터랙션을
 *          전혀 방해하지 않게 하기 위함.
 *   3. 기존 region 클릭 → 인라인 popover (편집 input + Save/Delete/Cancel).
 *      편집 중 텍스트를 비우고 Save 하면 삭제로 폴백한다.
 *
 * 좌표계 결정 — 왜 *content box* 기준인가:
 *   img/video/canvas 가 모두 object-contain 으로 letterbox 되는 환경에서,
 *   region 을 *컨테이너* 비율로 저장하면 윈도우/사이드바 리사이즈로 컨테이너
 *   비율이 바뀌는 순간 박스가 자료에서 떨어져 보인다. 자연 종횡비를 받아
 *   content box 만 산출해 그 안에서 비율로 저장하면 어떤 컨테이너 크기에서도
 *   박스가 *자료의 같은 부분* 을 가리킨다.
 */

interface ContentBox {
  /** 컨테이너의 (0,0) 기준 content 좌상단 px. */
  x: number;
  y: number;
  /** content box 의 px 크기. */
  w: number;
  h: number;
}

function computeContentBox(
  containerW: number,
  containerH: number,
  naturalW: number | null,
  naturalH: number | null,
): ContentBox {
  /* 자연 크기를 모르는 초기 페인트(이미지 onLoad 직전 / 영상 metadata 직전)
     에서는 컨테이너 전체를 content box 로 가정한다. 잠깐의 미스매치는 다음
     ResizeObserver tick 또는 metadata 이벤트로 즉시 보정. */
  if (!naturalW || !naturalH || containerW <= 0 || containerH <= 0) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  const naturalAspect = naturalW / naturalH;
  const containerAspect = containerW / containerH;
  /* 비율이 거의 같으면 letterbox 가 사실상 0 — 정수 px 반올림으로 박스가
     1px 어긋나 보이는 시각 노이즈를 막기 위해 임계값으로 컨테이너 자체로
     바꿔 사용한다. */
  if (Math.abs(naturalAspect - containerAspect) < 0.001) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }
  if (naturalAspect > containerAspect) {
    /* 자료가 컨테이너보다 가로가 길다 → 위/아래 letterbox. */
    const contentH = containerW / naturalAspect;
    return { x: 0, y: (containerH - contentH) / 2, w: containerW, h: contentH };
  }
  /* 자료가 컨테이너보다 세로가 길다 → 좌/우 letterbox. */
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

/* 새 region 으로 인정할 최소 크기 — 자연 비율에서 0.5% (가로·세로 모두).
   너무 작으면 우발적인 클릭이 빈 region 으로 저장돼 사용자에게 혼란을
   주므로, 의도된 드래그만 region 화. */
const MIN_REGION_FRACTION = 0.005;

interface PendingDraw {
  /** 컨테이너 좌상단 기준 픽셀(드래그 시작점). */
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface RegionOverlayProps {
  /** 이 오버레이가 absolute inset-0 으로 덮을 컨테이너의 ref.
   *  좌표/크기 측정의 단일 진실원. */
  containerRef: RefObject<HTMLElement>;
  /** 자료의 자연 크기. video.videoWidth/Height, image.naturalWidth/Height,
   *  GifFramePlayer 의 naturalSize. 미상이면 null/0 — 컨테이너 박스로 폴백. */
  naturalWidth: number | null;
  naturalHeight: number | null;
  /** 자료가 transform 으로 자유 줌·팬 되는 경우 (정지 이미지 + useImagePanZoom),
   *  오버레이는 transform 밖에 두고 여기로 transform 값을 전달한다. 그러면
   *  region 박스는 transform 된 contentBox 기준으로 그려져 visible 이미지와
   *  정확히 정렬되고, popover/text 자체는 unscaled 컨테이너 크기로 정상 렌더
   *  된다. 영상/GIF 등 zoom·pan 이 없는 자료에서는 미전달(=0/0/1) 이라 동작
   *  변화 없음. */
  panX?: number;
  panY?: number;
  scale?: number;
  /** 부모가 anchor 기준으로 이미 필터링한 region 노트. video=현재 시점,
   *  gif=현재 frameIndex, image=전체. region 이 없는 노트는 부모가 걸러서
   *  넘겨주는 게 깔끔하지만, 안전망으로 여기서 다시 한 번 region 유무 체크. */
  visibleNotes: TimestampNote[];
  /** drawing 모드 ON 이면 오버레이가 pointer events 를 캡처하고 crosshair
   *  커서. OFF 이면 기존 region 박스만 인터랙션 가능. */
  drawing: boolean;
  /** 새 region 저장 — 부모 LibraryPage 의 handleAddTimestampNote 가 자료
   *  종류에 맞춰 atSec/frameIndex 를 결정한다. */
  onCreateRegion: (region: RegionRect, text: string) => void;
  /** 새 region 의 popover 가 닫힐 때(Save/Cancel 양쪽) 부모가 drawing 토글을
   *  자동으로 OFF 로 돌려놓고 싶다면 사용. 미전달이면 사용자가 직접 토글을
   *  꺼야 함. */
  onAfterCreate?: () => void;
  /** 기존 region 편집/삭제 — Inspector 의 onEditTimestampNote/onDelete 와
   *  같은 의미. 둘 중 하나라도 미전달이면 popover 의 해당 액션이 disabled. */
  onDeleteRegion?: (noteId: string) => void;
  onEditRegion?: (noteId: string, text: string) => void;
  /** 사용자가 드래그를 시작하는 순간 부모에게 알림 — 영상/GIF 일시정지 같은
   *  안전한 부수 효과를 위함. (image 자료는 사용처가 무시.) */
  onDrawStart?: () => void;
}

export function RegionOverlay({
  containerRef,
  naturalWidth,
  naturalHeight,
  visibleNotes,
  drawing,
  onCreateRegion,
  onAfterCreate,
  onDeleteRegion,
  onEditRegion,
  onDrawStart,
  panX = 0,
  panY = 0,
  scale = 1,
}: RegionOverlayProps) {
  /* 컨테이너 픽셀 크기 — ResizeObserver 로 추적. wrapper 가 사이드바 드래그
     / 윈도우 리사이즈로 변하면 region 박스 위치도 즉시 갱신된다. RO 미지원
     환경(구형 Electron 빌드)에서는 window resize fallback. */
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

  /* fit 상태(scale=1, pan=0)에서의 letterbox content box — "자연 비율로 컨테이너
     에 들어맞을 때" 의 박스. */
  const baseContentBox = useMemo(
    () => computeContentBox(containerSize.w, containerSize.h, naturalWidth, naturalHeight),
    [containerSize.w, containerSize.h, naturalWidth, naturalHeight],
  );

  /* 실제 화면에 보이는 content box — base 에 translate + scale 을 적용. 오버레이
     자체는 transform 밖에 있으므로 이 좌표는 컨테이너 픽셀 공간이고, 마우스
     event.clientX/Y - container.rect.left/top 와 같은 좌표계라 일관된다. zoom·
     pan 이 없는 자료(panX/Y=0, scale=1)에서는 base 와 동일. */
  const contentBox = useMemo(
    () => ({
      x: panX + baseContentBox.x * scale,
      y: panY + baseContentBox.y * scale,
      w: baseContentBox.w * scale,
      h: baseContentBox.h * scale,
    }),
    [baseContentBox.x, baseContentBox.y, baseContentBox.w, baseContentBox.h, panX, panY, scale],
  );

  const overlayRef = useRef<HTMLDivElement>(null);

  /* 드래그 진행 상태. mousedown→null→{start,end} 로 들어오고, mouseup 시점에
     크기를 검사해 충분히 크면 pendingRegion 으로 confirm. */
  const [pendingDraw, setPendingDraw] = useState<PendingDraw | null>(null);
  /* mouseup 이후 popover 입력 단계의 region. 정규화된 [0,1] 좌표. */
  const [pendingRegion, setPendingRegion] = useState<RegionRect | null>(null);
  const [pendingText, setPendingText] = useState("");

  /* 기존 region 편집 모드 — 같은 시점에 하나만 열림. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  /* drawing 토글이 OFF 로 바뀌면 진행 중이던 draw/popover 를 정리한다 —
     사용자가 마음을 바꿔 토글을 끈 경우 pending state 가 남아있으면
     혼란스러우므로. (편집은 drawing 과 무관하게 유지.) */
  useEffect(() => {
    if (!drawing) {
      setPendingDraw(null);
      setPendingRegion(null);
      setPendingText("");
    }
  }, [drawing]);

  /* selected 자료가 바뀌면(부모가 visibleNotes 를 새 자료의 노트로 교체하면)
     편집 popover 도 자연스럽게 닫는다. 단순 휴리스틱: visibleNotes 의 id
     배열이 바뀌었을 때 editingId 가 그 안에 없으면 close. */
  useEffect(() => {
    if (!editingId) return;
    if (!visibleNotes.some((note) => note.id === editingId)) {
      setEditingId(null);
      setEditingText("");
    }
  }, [editingId, visibleNotes]);

  /* px(컨테이너 기준) → 정규화 region. */
  const pixelsToRegion = useCallback(
    (left: number, top: number, width: number, height: number): RegionRect => {
      if (contentBox.w <= 0 || contentBox.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
      return clampRegion({
        x: (left - contentBox.x) / contentBox.w,
        y: (top - contentBox.y) / contentBox.h,
        w: width / contentBox.w,
        h: height / contentBox.h,
      });
    },
    [contentBox],
  );

  /* 정규화 region → px(컨테이너 기준). 박스 그릴 때 사용. */
  const regionToPixels = useCallback(
    (r: RegionRect) => {
      const c = clampRegion(r);
      return {
        left: contentBox.x + c.x * contentBox.w,
        top: contentBox.y + c.y * contentBox.h,
        width: c.w * contentBox.w,
        height: c.h * contentBox.h,
      };
    },
    [contentBox],
  );

  /* 오버레이에서 mousedown 이 들어오면 드래그 시작. drawing=false 일 땐
     오버레이의 pointer-events 가 none 이라 이 핸들러는 불리지 않음(자식
     region 박스만 호출됨). pendingRegion 이 떠 있으면(popover 입력 중)
     새 드래그를 막아 사용자 입력 컨텍스트를 보호. */
  const handleOverlayMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!drawing) return;
      if (pendingRegion) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setPendingDraw({ startX: x, startY: y, endX: x, endY: y });
      onDrawStart?.();
      event.preventDefault();
    },
    [drawing, onDrawStart, pendingRegion],
  );

  /* 글로벌 mousemove/mouseup 으로 드래그 추적 — 오버레이 밖으로 마우스가
     나가도 안전하게 종료. pendingDraw 가 있을 때만 등록되어 idle 시 비용
     0. */
  useEffect(() => {
    if (!pendingDraw) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onMove = (event: MouseEvent) => {
      const rect = overlay.getBoundingClientRect();
      setPendingDraw((prev) =>
        prev
          ? { ...prev, endX: event.clientX - rect.left, endY: event.clientY - rect.top }
          : prev,
      );
    };
    const onUp = () => {
      setPendingDraw((prev) => {
        if (!prev) return null;
        const left = Math.min(prev.startX, prev.endX);
        const top = Math.min(prev.startY, prev.endY);
        const width = Math.abs(prev.endX - prev.startX);
        const height = Math.abs(prev.endY - prev.startY);
        const region = pixelsToRegion(left, top, width, height);
        if (region.w < MIN_REGION_FRACTION || region.h < MIN_REGION_FRACTION) {
          /* 우발적인 클릭/짧은 드래그 — 그냥 취소(popover 안 띄움). */
          return null;
        }
        setPendingRegion(region);
        setPendingText("");
        return null;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [pendingDraw, pixelsToRegion]);

  const handleSavePending = useCallback(() => {
    if (!pendingRegion) return;
    const text = pendingText.trim();
    if (!text) return;
    onCreateRegion(pendingRegion, text);
    setPendingRegion(null);
    setPendingText("");
    onAfterCreate?.();
  }, [onAfterCreate, onCreateRegion, pendingRegion, pendingText]);

  const handleCancelPending = useCallback(() => {
    setPendingRegion(null);
    setPendingText("");
    onAfterCreate?.();
  }, [onAfterCreate]);

  const beginEdit = useCallback((id: string, text: string) => {
    setEditingId(id);
    setEditingText(text);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return;
    const text = editingText.trim();
    if (!text) {
      onDeleteRegion?.(editingId);
    } else {
      onEditRegion?.(editingId, text);
    }
    setEditingId(null);
    setEditingText("");
  }, [editingId, editingText, onDeleteRegion, onEditRegion]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingText("");
  }, []);

  const handleDeleteEditing = useCallback(() => {
    if (!editingId) return;
    onDeleteRegion?.(editingId);
    setEditingId(null);
    setEditingText("");
  }, [editingId, onDeleteRegion]);

  /* drawing 모드 ON / 편집 popover 열림 / pendingRegion 떠 있음 — 셋 중
     하나라도 true 면 오버레이 자체를 인터랙티브하게(pointer-events: auto).
     아니면 자식 region 박스만 인터랙티브. */
  const overlayInteractive = drawing || pendingRegion !== null || editingId !== null;

  /* 미리보기 박스(드래그 중) px 좌표. */
  const pendingPx = pendingDraw
    ? {
        left: Math.min(pendingDraw.startX, pendingDraw.endX),
        top: Math.min(pendingDraw.startY, pendingDraw.endY),
        width: Math.abs(pendingDraw.endX - pendingDraw.startX),
        height: Math.abs(pendingDraw.endY - pendingDraw.startY),
      }
    : null;

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleOverlayMouseDown}
      className={cn(
        "absolute inset-0",
        drawing && !pendingRegion && "cursor-crosshair",
      )}
      style={{
        pointerEvents: overlayInteractive ? "auto" : "none",
      }}
    >
      {/* 기존 region 박스 — anchor 가 맞는 노트만 부모가 visibleNotes 로
          넘겨주므로 여기는 단순히 그리기만 한다. drawing 모드 ON 일 땐
          박스가 새 드래그를 가로막지 않도록 pointer-events: none — 사용자가
          기존 박스 위에서 드래그를 시작해도 자연스럽게 새 region 이 그려진다. */}
      {visibleNotes.map((note) => {
        if (!note.region) return null;
        const px = regionToPixels(note.region);
        const isEditing = editingId === note.id;
        const canEdit = Boolean(onEditRegion || onDeleteRegion);
        return (
          <div
            key={note.id}
            className={cn(
              "absolute transition-colors",
              /* 편집 중인 박스는 라인을 *가늘고 점선* 으로 약화시켜 popover 가
                 시각 주체가 되도록 한다. 평소엔 두꺼운 실선 + hover 강조. */
              isEditing
                ? "border border-dashed border-primary/60 bg-primary/15"
                : "border-2 border-primary/70 bg-primary/10 hover:border-primary hover:bg-primary/20",
            )}
            style={{
              left: px.left,
              top: px.top,
              width: px.width,
              height: px.height,
              borderRadius: 0,
              /* drawing 모드일 땐 박스가 인터랙션을 가로채지 않게 통과
                 시킨다 — 새 region 을 박스 위에서도 그릴 수 있어야 자연스럽다.
                 단 편집 중이면 popover 입력을 보호해야 하므로 auto. */
              pointerEvents: drawing && !isEditing ? "none" : "auto",
              cursor: !drawing && canEdit && !isEditing ? "pointer" : undefined,
            }}
            onClick={(event) => {
              if (drawing) return;
              if (isEditing) return;
              if (!canEdit) return;
              event.stopPropagation();
              beginEdit(note.id, note.text);
            }}
            title={note.text}
          >
            {/* 박스 위에 떠 있는 라벨 — 사용자가 한눈에 어떤 코멘트인지 알 수
                있도록. 편집 중에는 popover 가 그 자리를 차지하므로 라벨 숨김.
                -translate-y-full 로 박스 *바로 위* 에 붙임.
                긴 코멘트가 잘리지 않도록 truncate 대신 줄바꿈(whitespace-normal
                + break-words) 으로 전체 텍스트를 표시한다. 폰트 크기는 고정이라
                PDF 줌/패널 리사이즈로 박스 크기가 바뀌어도 텍스트는 그대로
                읽히고, max-w 로 가로 폭만 제한해 박스가 작아도 라벨이 과도하게
                넓어지지 않게 한다. */}
            {!isEditing ? (
              <div
                className={cn(
                  "pointer-events-none absolute left-0 top-0 leading-snug bg-primary px-1.5 py-0.5 text-2xs text-primary-foreground shadow-sm",
                  /* 기본은 박스 *바로 위*. 단 박스가 컨테이너 상단에 가까우면
                     위로 뻗은 라벨이 스크롤 영역 밖으로 잘리므로, 그 경우
                     translate 를 빼서 박스 *안쪽 상단* 에 붙여 항상 보이게 한다.
                     (PDF 줌인 시 상단 영역의 라벨이 사라지던 케이스 방지.) */
                  px.top > 44 && "-translate-y-full",
                )}
                /* 줄바꿈 정책은 인라인 스타일로 강제 — Tailwind 의 break-words
                   (overflow-wrap: break-word) 는 *절대위치 요소의 폭(min-content)
                   계산* 에 영향을 주지 않아 공백 없는 긴 문자열이 wrap 되지 않고
                   잘리는 버그가 있다. overflow-wrap: anywhere 는 min-content 를
                   줄여 박스가 maxWidth 로 줄어들고 텍스트가 확실히 여러 줄로
                   풀린다. maxWidth 는 박스 폭과 240px 중 큰 값으로 둬, 넓은
                   영역에서는 한 줄에 더 많이 보이고 좁은 영역에서도 240px 까지는
                   확보한다. */
                style={{
                  borderRadius: 0,
                  /* 영역 박스의 border-2(2px) 바깥 가장자리와 좌측 정렬을 맞춘다.
                     absolute 자식의 left:0 은 부모 *테두리 안쪽* 기준이라, 보정이
                     없으면 라벨이 박스 선보다 2px 안쪽으로 들어가 박스가 좌측으로
                     튀어나와 보인다. */
                  left: -2,
                  maxWidth: Math.max(240, px.width),
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  /* lineHeight 를 인라인으로 못박아 라벨 strip 이 항상 텍스트를
                     충분히 감싸게 한다. 상위 컨테이너의 lineHeight 상속이나
                     text-2xs 의 tight line-height 로 strip 이 얇아지지 않도록. */
                  lineHeight: 1.35,
                }}
              >
                {note.text}
              </div>
            ) : null}

            {isEditing ? (
              <RegionEditPopover
                anchorPx={px}
                containerSize={containerSize}
                text={editingText}
                onTextChange={setEditingText}
                onSave={handleSaveEdit}
                onCancel={handleCancelEdit}
                onDelete={onDeleteRegion ? handleDeleteEditing : undefined}
              />
            ) : null}
          </div>
        );
      })}

      {/* 드래그 중 임시 박스 — pointer-events 없음, 이벤트는 글로벌 listener
          가 처리. 사이트 primary 톤(빨강) + dashed 로 "아직 확정 안 된" 상태를
          저장된 박스와 시각적으로 구분. */}
      {pendingPx ? (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-primary/80 bg-primary/15"
          style={{ ...pendingPx, borderRadius: 0 }}
        />
      ) : null}

      {/* mouseup 직후 입력 단계 — 박스를 primary dashed 로 한 번 더 그리고
          popover 표시. */}
      {pendingRegion ? (
        <>
          <div
            className="pointer-events-none absolute border border-dashed border-primary/60 bg-primary/15"
            style={{ ...regionToPixels(pendingRegion), borderRadius: 0 }}
          />
          <RegionCreatePopover
            anchorPx={regionToPixels(pendingRegion)}
            containerSize={containerSize}
            text={pendingText}
            onTextChange={setPendingText}
            onSave={handleSavePending}
            onCancel={handleCancelPending}
          />
        </>
      ) : null}
    </div>
  );
}

/* 박스 좌상단 기준으로 popover 의 top/left 를 결정한다.
 *
 * 세로 정책:
 *   1. 기본은 박스 *위* (라벨 위에 popover) — 위 공간이 충분할 때.
 *   2. 위가 부족하면 박스 *아래* — 아래 공간이 충분할 때.
 *   3. 위/아래 모두 부족 (박스가 컨테이너 거의 전체를 덮는 케이스)
 *      → 박스 *안쪽 상단* 으로 폴백. 라인과 겹치지 않도록 GAP*2 만큼 들여서
 *      배치해 popover 가 라인과 시각적으로 분리되도록.
 *
 * 가로 정책:
 *   1. 기본은 박스 *좌측* 정렬.
 *   2. 우측 오버플로면 박스 *우측* 에 popover *우측* 정렬 — popover 가 항상
 *      박스에 인접하도록 (이전엔 컨테이너 우측 끝으로 클램프돼 박스에서
 *      멀어지는 문제).
 *   3. 그래도 못 맞추면 컨테이너 우측 PADDING 까지만 후퇴.
 *
 * placement 는 popover 가 컨테이너 *내부* 에 배치된 경우(inside-top) 추가
 * shadow/ring 등 시각 분리 처리를 적용하기 위해 같이 반환한다.
 */
function placePopover(
  anchorPx: { left: number; top: number; width: number; height: number },
  containerSize: { w: number; h: number },
  width: number,
): { top: number; left: number; placement: "above" | "below" | "inside-top" } {
  const POPOVER_HEIGHT_GUESS = 56;
  const GAP = 8;
  const PADDING = 8;

  const aboveTop = anchorPx.top - POPOVER_HEIGHT_GUESS - GAP;
  const belowTop = anchorPx.top + anchorPx.height + GAP;

  let top: number;
  let placement: "above" | "below" | "inside-top";
  if (aboveTop > PADDING) {
    top = aboveTop;
    placement = "above";
  } else if (belowTop + POPOVER_HEIGHT_GUESS < containerSize.h - PADDING) {
    top = belowTop;
    placement = "below";
  } else {
    /* 박스가 거의 컨테이너 전체 — 박스 라인과 겹치지 않게 안쪽 패딩(GAP*2)
       만큼 들여서 배치. */
    top = anchorPx.top + GAP * 2;
    placement = "inside-top";
  }

  let left = anchorPx.left;
  /* 1단계: 박스 좌측 정렬이 컨테이너 우측 오버플로면 박스 우측 정렬로 폴백. */
  if (left + width > containerSize.w - PADDING) {
    left = anchorPx.left + anchorPx.width - width;
  }
  /* 2단계: 그래도 우측 오버플로면 컨테이너 우측까지만 후퇴. */
  if (left + width > containerSize.w - PADDING) {
    left = containerSize.w - width - PADDING;
  }
  if (left < PADDING) left = PADDING;

  return { top, left, placement };
}

interface RegionCreatePopoverProps {
  anchorPx: { left: number; top: number; width: number; height: number };
  containerSize: { w: number; h: number };
  text: string;
  onTextChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

const POPOVER_WIDTH = 280;

/* 두 popover 공통 컨테이너 스타일.
 *
 * 디자인 정돈 포인트:
 *   - 배경을 짙은 primary 톤(bg-popover 가 빨강 계열로 매핑돼 있어) → 중립
 *     surface 로 변경. primary 강조는 Save 버튼에만 남겨 시각 위계 정리.
 *   - placement === "inside-top" 인 케이스에선 ring 으로 박스 라인과의 경계
 *     를 또렷이 분리해, popover 가 region 라인과 겹쳐 보이지 않도록.
 */
function popoverContainerClass(placement: "above" | "below" | "inside-top"): string {
  return cn(
    "absolute z-30 flex items-center gap-2 border border-border-subtle bg-surface-panel p-2 shadow-xl",
    placement === "inside-top" && "ring-1 ring-black/40",
  );
}

function RegionCreatePopover({
  anchorPx,
  containerSize,
  text,
  onTextChange,
  onSave,
  onCancel,
}: RegionCreatePopoverProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  /* 마운트 직후 input 에 포커스 — 사용자가 즉시 타이핑 시작할 수 있게.
     autoFocus prop 만으로는 일부 브라우저/조합에서 첫 focus 가 늦거나
     스킵돼 imperative call 로 보강. */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const pos = placePopover(anchorPx, containerSize, POPOVER_WIDTH);
  return (
    <div
      className={popoverContainerClass(pos.placement)}
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        borderRadius: 0,
        pointerEvents: "auto",
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Input
        ref={inputRef}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSave();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("regionOverlay.notePlaceholder")}
        /* 글로벌 Input 의 focus-visible ring-2 + offset-2 빨강이 popover
           안에서는 시각 노이즈가 커서 ring-1 + offset-0 으로 줄임. */
        className="h-8 flex-1 text-meta focus-visible:ring-1 focus-visible:ring-offset-0"
        style={{ borderRadius: 0 }}
      />
      <Button
        className="h-8 px-3 text-caption"
        style={{ borderRadius: 0 }}
        onClick={onSave}
        disabled={!text.trim()}
        title={t("regionOverlay.saveTitle")}
      >
        {t("common.save")}
      </Button>
      <button
        type="button"
        onClick={onCancel}
        className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
        title={t("regionOverlay.cancelTitle")}
        aria-label={t("regionOverlay.cancelRegionAria")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface RegionEditPopoverProps {
  anchorPx: { left: number; top: number; width: number; height: number };
  containerSize: { w: number; h: number };
  text: string;
  onTextChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}

function RegionEditPopover({
  anchorPx,
  containerSize,
  text,
  onTextChange,
  onSave,
  onCancel,
  onDelete,
}: RegionEditPopoverProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const pos = placePopover(anchorPx, containerSize, POPOVER_WIDTH);
  return (
    <div
      className={popoverContainerClass(pos.placement)}
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        borderRadius: 0,
        pointerEvents: "auto",
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Input
        ref={inputRef}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSave();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("regionOverlay.editPlaceholder")}
        className="h-8 flex-1 text-meta focus-visible:ring-1 focus-visible:ring-offset-0"
        style={{ borderRadius: 0 }}
      />
      <Button
        className="h-8 px-3 text-caption"
        style={{ borderRadius: 0 }}
        onClick={onSave}
        title={t("regionOverlay.saveTitle")}
      >
        {t("common.save")}
      </Button>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-destructive"
          title={t("regionOverlay.deleteTitle")}
          aria-label={t("regionOverlay.deleteAria")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onCancel}
        className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
        title={t("regionOverlay.cancelTitle")}
        aria-label={t("regionOverlay.cancelEditAria")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
