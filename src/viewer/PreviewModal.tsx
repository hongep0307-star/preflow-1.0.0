import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { youtubeEmbedUrl } from "@/lib/youtube";
import { useImagePanZoom } from "@/lib/useImagePanZoom";
import { VideoPlayer } from "./VideoPlayer";
import { GifPlayer, GifFallback } from "./GifPlayer";
import { NotesPanel } from "./NotesPanel";
import { RegionView } from "./RegionView";
import type { ReferenceItem } from "./types";

/* 큰 화면 모달 본체.
 *
 * 좌측: 미디어 분기 (video / gif / image / youtube / link)
 * 우측: 노트 패널 (timestamp_notes 가 있을 때만 노출)
 *
 * notes 가 없는 자료는 우측 패널 자체를 생략해 미디어가 더 넓게 보이도록.
 * 메인 앱 LibraryInspector 가 항상 우측에 있는 것과 다른 정책 — 공유
 * 뷰어의 의도가 "이 시점/이 영역에 코멘트가 달린 자료를 함께 본다" 이므로
 * 코멘트가 있는 자료에서만 패널이 의미를 갖는다. */

const NOTES_PANEL_WIDTH = 320;
const NOTES_PANEL_MIN_VIEWPORT_WIDTH = 900;

interface PreviewModalProps {
  item: ReferenceItem;
}

export function PreviewModal({ item }: PreviewModalProps) {
  const hasNotes = (item.timestamp_notes?.length ?? 0) > 0;
  // useViewportWiderThan 은 항상 호출되어야 한다 — `hasNotes && useViewportWiderThan(...)`
  // 처럼 short-circuit 자리에 두면 자료에 노트가 추가/제거되는 순간 호출 횟수가
  // 달라져 React 가 훅 호출 순서 invariant 위반으로 즉시 throw 한다. 변수로
  // 분리해 항상 호출하고, 노출 여부는 별도 변수로 결합한다.
  const wideEnough = useViewportWiderThan(NOTES_PANEL_MIN_VIEWPORT_WIDTH);
  const showNotesPanel = hasNotes && wideEnough;

  /* 영상 / GIF 에서 NotesPanel 행 클릭 → seek. registerSeek 가 자식
   *  컴포넌트에 콜백을 등록하면 그 콜백을 ref 에 보관해 부모가 호출. */
  const seekSecRef = useRef<((sec: number) => void) | null>(null);
  const seekFrameRef = useRef<((idx: number) => void) | null>(null);
  const registerSeekSec = useCallback((fn: (sec: number) => void) => {
    seekSecRef.current = fn;
  }, []);
  const registerSeekFrame = useCallback((fn: (idx: number) => void) => {
    seekFrameRef.current = fn;
  }, []);

  /* active note highlight 상태 — 자식이 update 콜백으로 매 timeupdate /
   *  매 프레임마다 알려준다. RAF 쓰로틀은 자식 쪽이 책임. */
  const [activeAtSec, setActiveAtSec] = useState<number | undefined>(undefined);
  const [activeFrameIndex, setActiveFrameIndex] = useState<number | undefined>(undefined);
  /* item 변경 시 초기화 — 이전 자료의 active 가 새 자료 NotesPanel 에 잘못
   *  강조되는 것을 막는다. */
  useEffect(() => {
    setActiveAtSec(undefined);
    setActiveFrameIndex(undefined);
    seekSecRef.current = null;
    seekFrameRef.current = null;
  }, [item.id]);

  return (
    <div className="flex h-full w-full bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <MediaBranch
          item={item}
          registerSeekSec={registerSeekSec}
          registerSeekFrame={registerSeekFrame}
          onTimeUpdate={setActiveAtSec}
          onFrameUpdate={setActiveFrameIndex}
        />
      </div>
      {showNotesPanel ? (
        <aside
          className="flex-shrink-0 border-l border-border-subtle"
          style={{ width: NOTES_PANEL_WIDTH }}
        >
          <NotesPanel
            item={item}
            onSeekSec={(sec) => seekSecRef.current?.(sec)}
            onSeekFrame={(idx) => seekFrameRef.current?.(idx)}
            activeAtSec={activeAtSec}
            activeFrameIndex={activeFrameIndex}
          />
        </aside>
      ) : null}
    </div>
  );
}

interface MediaBranchProps {
  item: ReferenceItem;
  registerSeekSec: (fn: (sec: number) => void) => void;
  registerSeekFrame: (fn: (idx: number) => void) => void;
  onTimeUpdate: (sec: number) => void;
  onFrameUpdate: (idx: number) => void;
}

function MediaBranch({
  item,
  registerSeekSec,
  registerSeekFrame,
  onTimeUpdate,
  onFrameUpdate,
}: MediaBranchProps) {
  /* GIF 의 unsupported 폴백 — ImageDecoder 가 없으면 GifPlayer 가 부모에게
   *  알리고, 같은 자리에서 GifFallback 으로 교체. */
  const [gifFallback, setGifFallback] = useState(false);
  useEffect(() => { setGifFallback(false); }, [item.id]);

  if (item.kind === "video" && item.file_url) {
    return (
      <VideoPlayer
        item={item}
        registerSeek={registerSeekSec}
        onTimeUpdate={onTimeUpdate}
      />
    );
  }
  if (item.kind === "gif" && item.file_url) {
    if (gifFallback) return <GifFallback item={item} />;
    return (
      <GifPlayer
        item={item}
        onUnsupported={() => setGifFallback(true)}
        registerSeek={registerSeekFrame}
        onFrameUpdate={onFrameUpdate}
      />
    );
  }
  if (item.kind === "youtube") {
    return <YouTubeView item={item} />;
  }
  if (item.kind === "link") {
    return <LinkView item={item} />;
  }
  /* image / webp / file_url 없는 자료들 — 정지 이미지 + 줌. */
  return <ImageView item={item} />;
}

/* ────────────── Image / WebP ────────────── */

function ImageView({ item }: { item: ReferenceItem }) {
  /* Eagle 식 자유 줌·팬 — useImagePanZoom 훅이 마우스 휠(커서 위치 중심
   *  zoom), 좌클릭 드래그(자유 pan), 더블클릭(fit 리셋) 을 한꺼번에 처리.
   *  메인 앱 LibraryPreviewPanel 의 이미지 분기와 동일 UX 를 공유. */
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const imagePanZoom = useImagePanZoom({
    containerRef,
    enabled: Boolean(item.file_url),
  });

  /* 자료 변경 시 fit 으로 리셋 — 이전 자료에서 줌·팬해두었던 위치가 새 자료에
   *  남지 않게 한다. natural 도 함께 비워 onLoad 가 새 값을 채울 때까지 빈
   *  상태에서 시작. */
  const { reset: resetImagePanZoom } = imagePanZoom;
  useEffect(() => {
    resetImagePanZoom();
    setNatural(null);
  }, [item.id, resetImagePanZoom]);

  /* image 자료의 region 노트는 항상 표시(시점 개념 없음). */
  const visibleRegionNotes = useMemo(
    () => (item.timestamp_notes ?? []).filter((n) => n.region),
    [item.timestamp_notes],
  );

  if (!item.file_url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-meta text-white/40">
        No image.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseDown={imagePanZoom.onMouseDown}
      onDoubleClick={imagePanZoom.onDoubleClick}
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden bg-black",
        imagePanZoom.isPanning ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      {/* transform wrapper — 컨테이너와 동일한 absolute inset-0 박스. scale=1·
       *  tx=ty=0 일 때 정확히 fit, 휠/드래그로 transform 이 바뀌면 자식 이미지
       *  가 함께 따라간다. RegionView 는 wrapper 의 *형제* 로 두어 transform
       *  영향을 받지 않게 하고, panX/panY/scale 을 명시 전달해 박스만 visible
       *  이미지에 정렬되도록 한다 — popover/text 가 unscaled 컨테이너 크기로
       *  정상 렌더되어 줌 상태에서도 라벨이 일정한 크기로 읽힌다. */}
      <div
        className="absolute inset-0 will-change-transform"
        style={imagePanZoom.transformStyle}
      >
        <img
          src={item.file_url}
          alt={item.title}
          draggable={false}
          onLoad={(event) => {
            const w = event.currentTarget.naturalWidth;
            const h = event.currentTarget.naturalHeight;
            if (w > 0 && h > 0) setNatural({ w, h });
          }}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
        />
      </div>
      <RegionView
        containerRef={containerRef}
        naturalWidth={natural?.w ?? null}
        naturalHeight={natural?.h ?? null}
        visibleNotes={visibleRegionNotes}
        panX={imagePanZoom.tx}
        panY={imagePanZoom.ty}
        scale={imagePanZoom.scale}
      />
    </div>
  );
}

/* ────────────── YouTube ────────────── */

function YouTubeView({ item }: { item: ReferenceItem }) {
  const embed = youtubeEmbedUrl(item.source_url);
  if (!embed) {
    return <LinkView item={item} />;
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-black p-4">
      <div className="relative h-full max-h-[90vh] w-full" style={{ aspectRatio: "16 / 9" }}>
        <iframe
          src={embed}
          title={item.title}
          className="absolute inset-0 h-full w-full"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}

/* ────────────── Link ────────────── */

function LinkView({ item }: { item: ReferenceItem }) {
  const url = item.source_url ?? "";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black px-8 text-center text-white/80">
      <Link2 className="h-12 w-12" />
      <div className="break-all text-label">{url || item.title}</div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 border border-white/20 px-3 py-1.5 text-meta text-white hover:bg-white/10"
          style={{ borderRadius: 0 }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in browser
        </a>
      ) : null}
    </div>
  );
}

/* ────────────── helpers ────────────── */

function useViewportWiderThan(threshold: number): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= threshold,
  );
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= threshold);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [threshold]);
  return wide;
}
