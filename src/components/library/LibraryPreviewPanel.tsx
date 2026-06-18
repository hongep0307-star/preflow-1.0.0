import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  BoxSelect,
  Camera,
  ChevronLeft,
  ChevronRight,
  Crop,
  Film,
  Image as ImageIcon,
  Keyboard,
  Library,
  Maximize,
  Maximize2,
  NotebookPen,
  Pause,
  Play,
  Repeat,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isMacPlatform } from "@/lib/shortcutLabel";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { GifFramePlayer } from "@/components/library/GifFramePlayer";
import { ImageCropOverlay } from "@/components/library/ImageCropOverlay";
import { RegionOverlay } from "@/components/library/RegionOverlay";
import { SaveLoopAsGifDialog } from "@/components/library/SaveLoopAsGifDialog";
import { AudioView } from "@/components/library/preview/AudioView";
import { LinkWebView } from "@/components/library/preview/LinkWebView";
import { PdfViewer } from "@/components/library/preview/PdfViewer";
import { withReferenceVersion, type ReferenceItem, type RegionRect } from "@/lib/referenceLibrary";
import { docExtensionTag, docHueClasses, docPresentationOf, docSubtypeOf } from "@/lib/docPresentation";
import type { GifExportOptions } from "@/lib/gifExportPreferences";
import { useUiLanguage } from "@/lib/uiLanguage";
import { useImagePanZoom } from "@/lib/useImagePanZoom";
import { youtubeEmbedUrl } from "@/lib/youtube";

/* 배속 select 옵션 — 큰 프리뷰와 인스펙터의 배속 select 가 동일 목록을
   공유하도록 export. Eagle/Premiere 류와 비슷하게 0.25x~8x 범위. select
   에 풀어 넣었을 때 "1.75x" 같은 가장 긴 라벨이 잘리지 않게 select 너비도
   함께 넓힌다. */
export const PLAYBACK_RATE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8] as const;

/* 타임라인 호버 썸네일의 긴 변(px). 영상 자연 해상도의 가로/세로 비율을
   따라가되 긴 쪽을 이 값으로 고정 — 가로 영상은 320×180, 9:16 세로 영상은
   180×320 처럼 한쪽이 잘리지 않으면서 박스가 영상 비율에 fit 한다. 메타
   로드 전엔 16:9 로 폴백. clamp 좌우 가드는 실제 박스 너비의 절반을 쓰므로
   세로 영상에서 가드가 과하게 잡혀 트랙 끝에서 미리보기가 한쪽으로 쏠리는
   일도 없다. */
const HOVER_THUMB_MAX_DIM = 320;

function formatDuration(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

interface LibraryPreviewPanelProps {
  item: ReferenceItem;
  items: ReferenceItem[];
  videoRef: RefObject<HTMLVideoElement>;
  playbackRate: string;
  onPlaybackRateChange: (rate: string) => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onSetCover: () => void;
  onSaveFrame: () => void;
  /** GIF 자료의 Set Cover/Save Frame — 자체 캔버스의 현재 프레임을 인자로
   *  전달. 영상의 onSetCover/onSaveFrame 은 video element 를 LibraryPage 가
   *  videoRef 로 직접 잡고 있어 인자가 필요없지만, GIF 는 캔버스가 자식
   *  컴포넌트(GifFramePlayer) 안에 있어 콜백 인자로 받아야 한다. */
  onSetCoverFromCanvas?: (canvas: HTMLCanvasElement, frameIndex: number) => void;
  onSaveFrameFromCanvas?: (canvas: HTMLCanvasElement, frameIndex: number) => void;
  saving: boolean;
  /** 영상 자료에서 큰 프리뷰 안에서 직접 timestamp 노트를 추가/탐색.
   *  LibraryPage 의 인스펙터용 state(timestampText / handleAddTimestampNote)
   *  를 그대로 forward 받아 동일 동작을 한다. */
  timestampText: string;
  onTimestampTextChange: (value: string) => void;
  /** 큰 프리뷰의 Add Note 다이얼로그는 자체 텍스트/시각을 인자로 직접
   *  넘겨, 부모의 timestampText state 에 의존하지 않고 즉시 저장한다.
   *  인자를 비우면 부모는 timestampText + 현재 video.currentTime 을 사용.
   *  v3 — GIF 도 같은 콜백을 사용. frameIndex 는 4번째 인자(region 다음)
   *  로 전달되어 부모 handleAddTimestampNote 가 자료 종류에 따라 anchor
   *  를 결정한다. */
  onAddTimestampNote: (
    textOverride?: string,
    atOverride?: number,
    regionOverride?: import("@/lib/referenceLibrary").RegionRect,
    frameIndexOverride?: number,
    pageIndexOverride?: number,
  ) => void;
  /** 마커 alt-click 으로 즉시 삭제. 인스펙터의 X 버튼과 동일한 핸들러를
   *  forward 받아 동작한다. */
  onDeleteTimestampNote?: (noteId: string) => void;
  /** Phase 4 — region 노트 인라인 편집. RegionOverlay 의 popover 가 호출.
   *  미전달이면 popover 의 편집 input 은 동작하지 않고 X(취소) / 삭제만 가능. */
  onEditTimestampNote?: (noteId: string, text: string) => void;
  /** LibraryPage 의 `pendingSeekSec` 와 연동 — 인스펙터에서 timestamp 노트를
   *  클릭해 큰 프리뷰가 막 열린 직후, 비디오 메타가 로드되면 이 값으로 1회
   *  자동 시크하고 onInitialSeekConsumed 로 클리어한다. */
  initialSeekSec?: number | null;
  onInitialSeekConsumed?: () => void;
  /** GIF 용 — Inspector 노트 행 클릭으로 큰 프리뷰가 열린 직후 디코드 완료
   *  시점에 1회 자동 점프할 프레임 인덱스. 영상의 initialSeekSec 와 같은 패턴. */
  initialFrameIndex?: number | null;
  onInitialFrameConsumed?: () => void;
  /** PDF 용 — Inspector 슬라이드 노트 행 클릭으로 큰 프리뷰가 열린 직후
   *  PdfViewer 가 1회 이동할 페이지(1-based). GIF 의 initialFrameIndex 와 동일 패턴. */
  initialPageIndex?: number | null;
  onInitialPageConsumed?: () => void;
  /** 정지 이미지/PSD 용 — Inspector 영역 노트 클릭으로 큰 프리뷰가 열린 직후
   *  잠깐 하이라이트할 region 노트 id. RegionOverlay 가 해당 박스를 강조하고,
   *  일정 시간 뒤 onHighlightRegionConsumed 로 클리어한다. */
  highlightRegionNoteId?: string | null;
  onHighlightRegionConsumed?: () => void;
  /** "Save loop as GIF" 다이얼로그가 변환을 끝낸 직후, GIF Blob 을 새
   *  ReferenceItem 으로 등록할 때 LibraryPage 가 처리할 콜백. Blob 을
   *  File 로 감싸 uploadReferenceFile 호출하고 upsert + toast 까지 부모가
   *  맡는다 (handleSaveFrame 과 동일한 책임 분리). 미전달이면 GIF 저장
   *  버튼은 비활성화. */
  onSaveLoopAsGif?: (
    blob: Blob,
    options: GifExportOptions,
    startSec: number,
    endSec: number,
  ) => Promise<void>;
  /** 정지 이미지 크롭 — 사용자가 8핸들로 영역을 정해 확정하면 호출.
   *  rect 는 정규화 [0,1](원본 이미지 기준). mode 로 새 파일/덮어쓰기를 구분.
   *  실제 픽셀 크롭 + 저장 + toast 는 부모(LibraryPage)가 담당한다. 미전달이면
   *  크롭 버튼을 노출하지 않는다. */
  onCropImage?: (rect: RegionRect, mode: "new" | "overwrite") => void | Promise<void>;
  /** 인앱 <video> 가 디코드 실패(MOV ProRes/HEVC 등)했을 때 OS 기본 플레이어로
   *  여는 콜백. 미전달이면 자동 열기 없이 안내만 표시. */
  onOpenInDefaultApp?: (item: ReferenceItem) => void;
}

export function LibraryPreviewPanel({
  item,
  items,
  videoRef,
  playbackRate,
  onPlaybackRateChange,
  onSelect,
  onBack,
  onSetCover,
  onSaveFrame,
  onSetCoverFromCanvas,
  onSaveFrameFromCanvas,
  saving,
  /* timestampText / onTimestampTextChange 는 인스펙터/부모와 공유되는
     상태지만, 큰 프리뷰에서는 Add Note 다이얼로그가 자체 텍스트를 관리
     하고 onAddTimestampNote 에 인자로 직접 넘기므로 여기선 destructure
     하지 않는다. props 인터페이스에는 유지되어 부모 호출부 호환성 유지. */
  onAddTimestampNote,
  onDeleteTimestampNote,
  onEditTimestampNote,
  initialSeekSec,
  onInitialSeekConsumed,
  initialFrameIndex,
  onInitialFrameConsumed,
  highlightRegionNoteId,
  onHighlightRegionConsumed,
  initialPageIndex,
  onInitialPageConsumed,
  onSaveLoopAsGif,
  onCropImage,
  onOpenInDefaultApp,
}: LibraryPreviewPanelProps) {
  const { t } = useUiLanguage();
  const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
  const previous = currentIndex > 0 ? items[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : null;
  /* 포커스 모드는 큰 화면이라 항상 원본(file_url) 을 우선 — 그리드의
     작은 thumbnail_url 을 그대로 쓰면 세로/정방형처럼 비율이 다른 자료
     에서 업스케일된 흐릿한 이미지가 보이고, 줌 클릭 시 자연 크기(=썸네일
     원본 크기) 로 돌아가 오히려 더 작아지는 현상이 났다. file_url 이
     없을 때만 thumbnail_url 로 폴백한다. */
  /* PSD/PSB 풀해상도 프리뷰 — 업로드 시 ai_suggestions.psdPreview 로 저장된
     원본 크기 WebP. 있으면 일반 이미지처럼 줌·팬 분기를 그대로 태운다.
     (file_url 은 .psd 라 <img> 로 못 그리므로 절대 쓰지 않는다)
     subtype 재판정에 기대지 않는다 — 저장된 PSD 는 mime 이 octet-stream 이고
     title 에 확장자가 없어 docSubtypeOf 가 "psd" 를 못 잡는다. psdPreview 의
     *존재* 자체가 "풀해상도 프리뷰 가능한 doc" 의 충분한 신호. */
  const psdPreviewUrl =
    item.kind === "doc"
      ? ((item.ai_suggestions?.psdPreview as string | undefined) ?? null)
      : null;
  const imagePreviewUrl = psdPreviewUrl || item.file_url || item.thumbnail_url || "";

  /* GIF / 애니메이션 WebP / APNG — 별도 GifFramePlayer 분기로 처리. file_url
     이 없으면(레거시 link-only 자료) 일반 이미지 분기로 폴백. ImageDecoder
     미지원/디코드 실패 시 gifPlayerSupported=false 로 떨어져 같은 자리에서
     <img src=file_url> 자동재생으로 자연 폴백. */
  const isAnimatedGif = item.kind === "gif" && Boolean(item.file_url);
  const [gifPlayerSupported, setGifPlayerSupported] = useState(true);

  /* 이미지 줌·팬 — Eagle/Figma 스타일.
     - 마우스 휠로 커서 위치 중심 zoom (continuous scale)
     - 좌클릭 드래그로 항상 pan (스페이스 modifier 불필요)
     - 더블클릭으로 fit 으로 리셋
     실 구현은 useImagePanZoom 훅이 담당. transformStyle 을 이미지 wrapper
     에 그대로 박아 transform: translate + scale 로 렌더한다. enabled 분기는
     region 모드 / 비디오 / GIF 플레이어 분기를 피해 *정지 이미지에서만*
     활성화 — 아래 isStillImageBranch 계산 후 훅 호출이 이어진다. */
  const imageScrollRef = useRef<HTMLDivElement>(null);

  /* 영상 길이 — 마커 트랙의 좌표 계산용. metadata 로드 전엔 item.duration_sec
     fallback 을 쓰지만 정확도가 부족할 수 있어 메타 로드 후 갱신. */
  const [videoDuration, setVideoDuration] = useState(0);

  /* Phase 4 — 자료 위에 region 박스를 그리기 위한 state.
     - regionMode: BoxSelect 토글. ON 이면 video/이미지 위에 RegionOverlay 가
       crosshair 드래그를 캡처해 새 박스를 그린다. 자료 변경 시 자동 OFF.
     - mediaNaturalSize: <video> / <img> 의 자연 해상도. RegionOverlay 가
       letterbox content box 를 정확히 산출하기 위해 필요. video 는 metadata
       로드 시점에, img 는 onLoad 에서 채워진다. */
  const [regionMode, setRegionMode] = useState(false);
  const [mediaNaturalSize, setMediaNaturalSize] = useState<{ w: number; h: number } | null>(null);

  /* 정지 이미지 크롭 모드 — 8핸들 오버레이로 영역을 정한다.
     - cropMode: 토글. ON 이면 ImageCropOverlay 가 줌/팬 위에 마스크+핸들을 띄움.
     - cropRect: 정규화 [0,1] 크롭 영역 (기본 전체).
     - cropPending: 확정 후 "새 파일 / 덮어쓰기" 선택 다이얼로그 표시 여부. */
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<RegionRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [cropPending, setCropPending] = useState(false);

  /* 커스텀 비디오 컨트롤 상태 — native <video controls> 를 끄고 우리가
     직접 그리므로, play/pause / currentTime / muted / volume 을 React state 로
     추적. video element 의 이벤트(play, pause, timeupdate, volumechange)를
     구독해 동기화한다. */
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  /* volume — 0.0 ~ 1.0. muted 와 별개로 추적해 사용자가 mute 후 unmute 했을 때
     이전 볼륨을 그대로 복원할 수 있게 한다(HTMLMediaElement 기본 동작과 일치). */
  const [volume, setVolume] = useState(1);
  /* 볼륨 슬라이더 드래그 — 트랙 mousedown 후 window mousemove 로 추적해
     트랙 밖으로 마우스가 나가도 끊기지 않게 한다(timeline 드래그와 동일 패턴). */
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const isDraggingVolumeRef = useRef(false);

  /* 노트 추가 다이얼로그 */
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteDialogAtSec, setNoteDialogAtSec] = useState(0);
  const [noteDialogText, setNoteDialogText] = useState("");

  /* "Save loop as GIF" 다이얼로그. 열릴 때 현재 loop in/out 을 freeze 해서
     변환 중에 사용자가 핸들을 다시 드래그해도 처음 값으로 변환되도록 한다. */
  const [gifDialogOpen, setGifDialogOpen] = useState(false);
  const [gifDialogLoop, setGifDialogLoop] = useState<{ startSec: number; endSec: number } | null>(null);

  /* 구간 Loop — in/out 두 점 사이를 자동 반복 재생. 루프 버튼을 한 번 누르면
     양 끝(0 → duration) 에 핸들이 활성화되고, 사용자가 핸들을 드래그해 원하는
     구간으로 좁힌다. 다시 누르면 루프 해제. */
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  /* 루프 핸들 드래그 상태. "start"/"end" 는 단일 핸들 이동. null 이면 드래그
     아님. */
  const [loopDragMode, setLoopDragMode] = useState<"start" | "end" | null>(null);

  /* 타임라인 호버 썸네일 — YouTube 식. 마우스 X 좌표(트랙 기준 0~1)와 그
     시점의 시간(초) 을 저장하고, 트랙 위쪽으로 비디오 프레임 미리보기를
     띄운다. 매 호버마다 video element 를 새로 만들면 디코딩이 처음부터
     다시 시작돼 첫 프레임 표시가 늦으므로, 노트 호버 미리보기처럼 단일
     <video> 를 미리 마운트해두고 currentTime 만 옮겨가며 재사용한다. */
  const [hoverPreview, setHoverPreview] = useState<{ sec: number; pct: number } | null>(null);
  const hoverVideoRef = useRef<HTMLVideoElement>(null);
  /* 빠른 마우스 이동 시 직전 seek 가 디코딩을 끝내기 전에 다음 seek 가
     쌓여 미리보기가 정체되는 문제를 막기 위한 "drop-old, always-latest"
     패턴.
       - hoverTargetRef: 가장 최근 호버 시각(초). 매 mousemove 마다 즉시 갱신.
       - hoverSeekingRef: 현재 in-flight 인 seek 가 있는지 플래그.
     mousemove 가 imperatively currentTime 을 갱신하고, seek 가 끝나면
     (`seeked` 이벤트) 그동안 ref 가 또 바뀌었는지 확인해 마지막 좌표로
     한 번 더 seek 한다 — 브라우저는 한 번에 하나의 seek 만 처리하므로
     이 구조가 가장 적은 latency 로 최신 프레임을 따라잡는다. */
  const hoverTargetRef = useRef<number | null>(null);
  const hoverSeekingRef = useRef(false);

  const timelineRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  /* 풀스크린 시 video element 만 풀스크린 하면 우리 커스텀 timeline /
     controls 가 사라지므로, 미디어 + timeline + controls 를 함께 묶는
     wrapper 에 fullscreen 을 건다. */
  const fullscreenWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVideoDuration(0);
    setNoteDialogOpen(false);
    setLoopStart(null);
    setLoopEnd(null);
    setLoopDragMode(null);
    setHoverPreview(null);
    hoverTargetRef.current = null;
    hoverSeekingRef.current = false;
    setIsPlaying(false);
    setCurrentTime(0);
    setGifPlayerSupported(true);
    /* Phase 4 — 자료 변경 시 region 모드 / 자연 크기도 reset. 이전 자료에서
       켜둔 토글이 새 자료에서 갑자기 crosshair 로 보이는 사고 방지. */
    setRegionMode(false);
    setMediaNaturalSize(null);
    /* 크롭 모드도 자료 변경 시 해제 — 다른 이미지로 넘어갔는데 이전 크롭
       핸들/마스크가 남아 있지 않게 한다. */
    setCropMode(false);
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    setCropPending(false);
    setVideoUnplayable(false);
  }, [item.id]);

  const isVideo = item.kind === "video" && Boolean(item.file_url);
  /* 인앱 <video> 가 코덱을 못 풀어 onError 가 뜬 경우(주로 ProRes/HEVC MOV).
     패널에 안내 오버레이 + "기본 플레이어로 열기" 버튼을 띄우되, 자동
     실행은 하지 않는다(사용자가 버튼을 직접 눌러야 OS 기본 플레이어 실행). */
  const [videoUnplayable, setVideoUnplayable] = useState(false);

  /* video element 의 상태를 React 로 동기화. item 이 바뀌면 cleanup 후
     새 video 에 다시 등록(ref 가 같은 element 라도 src 변경으로 reset 됨). */
  useEffect(() => {
    if (!isVideo) return;
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(v.currentTime);
    const onVol = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("volumechange", onVol);
    /* 초기 1회 동기화 (이벤트가 아직 안 날아온 상태) */
    setIsPlaying(!v.paused);
    setMuted(v.muted);
    setVolume(v.volume);
    setCurrentTime(v.currentTime);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("volumechange", onVol);
    };
  }, [isVideo, item.id, videoRef]);

  /* 노트 다이얼로그 열기 */
  const openNoteDialog = useCallback(() => {
    if (!isVideo) return;
    const at = videoRef.current?.currentTime ?? 0;
    setNoteDialogAtSec(Number.isFinite(at) ? at : 0);
    setNoteDialogText("");
    setNoteDialogOpen(true);
  }, [isVideo, videoRef]);

  const handleSaveNote = useCallback(() => {
    const trimmed = noteDialogText.trim();
    if (!trimmed) return;
    onAddTimestampNote(trimmed, noteDialogAtSec);
    setNoteDialogOpen(false);
  }, [noteDialogAtSec, noteDialogText, onAddTimestampNote]);

  /* 루프 토글 — 비활성 → 양 끝(0 ~ duration) 에 핸들을 띄워 곧바로 드래그
     로 좁힐 수 있게 한다. 활성 → 해제. duration 미상이면(메타 미로드) 토글
     자체를 무시해 "loopStart=0, loopEnd=0" 같은 무의미한 상태를 방지. */
  const cycleLoop = useCallback(() => {
    if (!isVideo) return;
    const v = videoRef.current;
    if (!v) return;
    const duration = videoDuration || (Number.isFinite(v.duration) ? v.duration : 0) || item.duration_sec || 0;
    if (loopStart !== null || loopEnd !== null) {
      setLoopStart(null);
      setLoopEnd(null);
      return;
    }
    if (!duration || duration <= 0) return;
    setLoopStart(0);
    setLoopEnd(duration);
  }, [isVideo, item.duration_sec, loopEnd, loopStart, videoDuration, videoRef]);

  /* timeupdate 시 loop 강제 — out 도달 시 in 으로 시크. */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (loopStart === null || loopEnd === null) return;
    const onTime = () => {
      if (v.currentTime >= loopEnd - 0.02 || v.currentTime < loopStart - 0.02) {
        try {
          v.currentTime = loopStart;
        } catch {
          /* noop */
        }
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [loopEnd, loopStart, videoRef]);

  /* 키보드 단축키 — Eagle/Premiere 식 단일 키 매핑.
       - n        : 메모(노트) 다이얼로그 열기
       - d / f    : 한 프레임 뒤로 / 앞으로 (30fps 가정 — 1/30s 스텝)
       - l        : 구간 loop 토글 (cycleLoop 와 동일)
       - [ / ]    : loop 활성 시 현재 시각을 loop in / out 으로 지정.
                    loop 비활성 시에는 무시 — 사용자는 먼저 'l' 로 활성화 후 사용.
       - Space    : 재생/일시정지
       - m        : mute on/off
       - ArrowUp  : 볼륨 +20%   (자동 unmute)
       - ArrowDown: 볼륨 -20%   (0 도달 시 자동 mute)
       - Ctrl/Cmd + ArrowUp / ArrowDown : 재생 속도 한 단계 ↑ / ↓
                    (PLAYBACK_RATE_OPTIONS 배열의 인접 값으로 이동)
     입력 포커스(INPUT/TEXTAREA/contenteditable) 중이면 모두 무시. 30fps 가정은
     대부분의 reference 영상에서 체감상 한 프레임 차이로 충분하고, 60fps 영상
     에서도 2프레임씩 이동하는 수준이라 큰 위화감 없음. */
  useEffect(() => {
    if (!isVideo) return;
    const FRAME_STEP_SEC = 1 / 30;
    const VOLUME_STEP = 0.2;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const v = videoRef.current;
      if (!v) return;

      /* 좌우 시킹 — Win/Linux: Ctrl(또는 Cmd)+←/→ = 5초, Mac: Option(⌥)+←/→ = 5초.
         Shift+←/→ = 10초(양 플랫폼 공통). 순수 ←/→ 는 LibraryPage 의 항목 이동이
         가져가므로 여기서는 수식키 조합만 처리한다. 아래 `altKey` 조기 return 보다
         위에 둬야 Mac 의 Option+화살표가 막히지 않는다. */
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const fiveMod = isMacPlatform()
          ? event.altKey && !event.ctrlKey && !event.metaKey
          : (event.ctrlKey || event.metaKey) && !event.altKey;
        const tenMod = event.shiftKey;
        if (fiveMod || tenMod) {
          event.preventDefault();
          const skip = tenMod ? 10 : 5;
          const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
          const dur = Number.isFinite(v.duration) ? v.duration : videoDuration || item.duration_sec || 0;
          const nextRaw = event.key === "ArrowLeft" ? cur - skip : cur + skip;
          const clamped = dur > 0 ? Math.min(dur, Math.max(0, nextRaw)) : Math.max(0, nextRaw);
          try { v.currentTime = clamped; } catch { /* noop */ }
          return;
        }
      }

      if (event.altKey) return;

      /* Ctrl/Cmd + ArrowUp/Down → 재생 속도 조절. 그 외 Ctrl 조합은 OS / 브라
         우저 / LibraryPage 단축키 영역이라 통째로 무시(Ctrl+D 복제, Ctrl+C 복사
         등이 우리 키 핸들러에 가로채이지 않게). */
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const cur = Number(playbackRate) || 1;
          /* 현재 값이 배열에 없으면(외부에서 임의 값 주입된 경우) 가장 가까운
             상위/하위 인덱스를 base 로 잡아 자연스럽게 한 단계 이동. */
          let idx = PLAYBACK_RATE_OPTIONS.findIndex((r) => r === cur);
          if (idx < 0) {
            idx = PLAYBACK_RATE_OPTIONS.findIndex((r) => r >= cur);
            if (idx < 0) idx = PLAYBACK_RATE_OPTIONS.length - 1;
          }
          const nextIdx = event.key === "ArrowUp"
            ? Math.min(PLAYBACK_RATE_OPTIONS.length - 1, idx + 1)
            : Math.max(0, idx - 1);
          onPlaybackRateChange(String(PLAYBACK_RATE_OPTIONS[nextIdx]));
        }
        return;
      }

      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        openNoteDialog();
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        if (!v.paused) v.pause();
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        try { v.currentTime = Math.max(0, cur - FRAME_STEP_SEC); } catch { /* noop */ }
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        if (!v.paused) v.pause();
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        const dur = Number.isFinite(v.duration) ? v.duration : 0;
        const next = cur + FRAME_STEP_SEC;
        try { v.currentTime = dur > 0 ? Math.min(dur, next) : next; } catch { /* noop */ }
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        cycleLoop();
      } else if (event.key === "[") {
        /* loop 활성 시에만 동작. 현재 시각을 loop start 로 — loopEnd 와의
           최소 간격(0.05s) 을 보장해 0 길이 loop 로 인한 무한 seek 회피. */
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        const MIN_GAP = 0.05;
        const upper = Math.max(0, loopEnd - MIN_GAP);
        setLoopStart(Math.max(0, Math.min(cur, upper)));
      } else if (event.key === "]") {
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        /* totalDuration 은 아래에서 선언되므로 TDZ 회피를 위해 인라인 계산. */
        const dur = videoDuration || item.duration_sec || (Number.isFinite(v.duration) ? v.duration : 0);
        const MIN_GAP = 0.05;
        const lower = Math.min(dur, loopStart + MIN_GAP);
        setLoopEnd(Math.min(dur, Math.max(cur, lower)));
      } else if (event.key === " " || event.code === "Space") {
        /* Space 가 페이지 스크롤로 가지 않게 차단. */
        event.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        /* toggleMute 와 동일 의미 — unmute 시 volume=0 이면 0.5 로 끌어올려
           들리도록 보장(YouTube 와 동일 UX). */
        if (v.muted && v.volume === 0) v.volume = 0.5;
        v.muted = !v.muted;
      } else if (event.key === "ArrowUp") {
        /* 페이지 스크롤 방지. 0 → 1 사이 20% 단위 증가 + 자동 unmute. */
        event.preventDefault();
        const newVol = Math.min(1, Math.round((v.volume + VOLUME_STEP) * 100) / 100);
        v.volume = newVol;
        if (v.muted && newVol > 0) v.muted = false;
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const newVol = Math.max(0, Math.round((v.volume - VOLUME_STEP) * 100) / 100);
        v.volume = newVol;
        if (newVol === 0 && !v.muted) v.muted = true;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVideo, openNoteDialog, videoRef, loopStart, loopEnd, videoDuration, item.duration_sec, cycleLoop, playbackRate, onPlaybackRateChange]);

  /* R 키 — Region 토글 단축키. 이미지/영상 양쪽 분기에서 BoxSelect 버튼과
     동일하게 동작. 입력 포커스(텍스트 입력, 코멘트 다이얼로그 등) 중에는 무시
     해 타이핑 도중 R 이 의도치 않게 region 모드를 켜는 사고를 방지. youtube/
     link/pdf 같이 region 자체가 없는 분기에서는 button 도 없으므로 단축키도
     의미가 없지만, 토글 자체는 state 변경 한 줄이라 굳이 분기 가드를 두지
     않는다 — 사용자가 R 을 눌러도 보이지 않는 곳에서 켜졌다 꺼졌다 할 뿐
     side effect 없음. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      /* event.code === "KeyR" 까지 확인 — 한글 IME 가 켜져 있으면 event.key 가
         "r" 이 아니라 한글 자모로 들어와 매칭에 실패하므로, 물리 키 기준의
         code 로 보강해 IME/레이아웃과 무관하게 토글되게 한다. */
      if (event.key !== "r" && event.key !== "R" && event.code !== "KeyR") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      setRegionMode((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const totalDuration = videoDuration || item.duration_sec || 0;
  const positionToPct = useCallback(
    (atSec: number): number => {
      if (!totalDuration) return 0;
      return Math.max(0, Math.min(100, (atSec / totalDuration) * 100));
    },
    [totalDuration],
  );

  /* 마커는 시간 순서대로 보여주는 것이 색깔 마커가 겹쳤을 때 hover 우선
     순위(나중에 그려진 게 위에 옴)를 일관되게 만든다. atSec 오름차순. */
  const sortedNotes = useMemo(
    () => [...item.timestamp_notes].sort((a, b) => (a.atSec ?? 0) - (b.atSec ?? 0)),
    [item.timestamp_notes],
  );

  /* Phase 4 — 자료 종류별 region 가시성 필터.
       - video: 현재 시점에서 ±0.15초 안에 anchor 된 region (timeupdate 가
         약 250ms 간격이라 0.15초 윈도우면 자연스럽게 따라감).
       - image / static webp / gif-fallback: 시점 개념 없이 항상 표시.
     gif (정상 GifFramePlayer 분기) 는 컴포넌트 자체가 frameIndex 필터링을
     처리하므로 여기서는 제외. youtube/link 자료는 region 자체가 없음. */
  /* "정지 이미지 분기" — 아래 JSX 의 imagePreviewUrl 분기와 *정확히 일치*
     하는 조건. doc(=PDF/audio/html/문서 썸네일)/youtube/link/video/animated-gif
     모두 자체 인터랙션을 가진 컴포넌트(PdfViewer, AudioView, LinkWebView,
     GifFramePlayer 등) 가 컨테이너를 차지하므로, 외부 컨테이너의 손바닥
     커서 / 휠 줌 / 드래그 팬 / 더블클릭 핸들러가 그 위로 새지 않아야 한다.
     PDF 의 경우 PdfViewer 가 자체 손바닥+휠 줌+팬 을 가지고 있어 외부와
     이중으로 처리되면 충돌이 난다. */
  const isStillImageBranch = !isVideo
    && item.kind !== "youtube"
    && item.kind !== "link"
    /* doc 은 자체 뷰어(PDF/audio/html) 또는 썸네일 카드라 줌·팬을 끄지만,
       PSD 풀해상도 프리뷰는 일반 이미지와 동일하게 줌·팬을 허용한다. */
    && (item.kind !== "doc" || Boolean(psdPreviewUrl))
    && Boolean(imagePreviewUrl)
    && !(isAnimatedGif && gifPlayerSupported);

  /* 정지 이미지(image / webp / gif-fallback / doc-thumbnail) 위에서만 줌·팬
     활성화. region 모드에서는 RegionOverlay 가 crosshair 드래그를 캡처해야
     하므로 잠시 끈다. 비디오/유튜브/링크/PDF/오디오 분기에서는 enabled=false
     라 휠 리스너 자체가 붙지 않아 native 인터랙션(영상 클릭=play, PDF 자체
     스크롤 등) 을 가로채지 않는다. */
  const imagePanZoom = useImagePanZoom({
    containerRef: imageScrollRef,
    enabled: isStillImageBranch && !regionMode && !cropMode,
  });

  /* 자료 변경 시 줌·팬을 fit 으로 리셋. 위 item.id reset effect 에 합쳐도
     되지만, 훅 reset 의 identity 가 안정적이고 deps 가 분리되는 게 의도가
     명확해 별도 effect 로 둔다. */
  const { reset: resetImagePanZoom } = imagePanZoom;
  useEffect(() => {
    resetImagePanZoom();
  }, [item.id, resetImagePanZoom]);

  /* 인스펙터 영역 노트 클릭으로 진입한 경우 — 줌·팬을 fit 으로 되돌려(전체
     이미지+영역 박스가 보이도록) 하이라이트 대상이 화면에 들어오게 하고,
     잠시 후 부모에 소비를 알려 강조를 끈다. onHighlightRegionConsumed 의
     identity 변화로 타이머가 리셋되지 않도록 ref 로 최신값을 참조한다. */
  const highlightConsumedRef = useRef(onHighlightRegionConsumed);
  highlightConsumedRef.current = onHighlightRegionConsumed;
  useEffect(() => {
    if (!highlightRegionNoteId) return;
    resetImagePanZoom();
    const timer = window.setTimeout(() => highlightConsumedRef.current?.(), 2600);
    return () => window.clearTimeout(timer);
  }, [highlightRegionNoteId, resetImagePanZoom]);
  const visibleRegionNotes = useMemo(() => {
    if (isVideo) {
      /* 재생 중에는 region 박스를 숨겨 영상 시청을 방해하지 않게 한다.
         사용자가 박스를 보고 싶을 땐 pause 해서 정지화면 위에서 확인.
         RegionOverlay 의 onDrawStart 가 새 박스 드래그 시작 시 자동
         pause 시키므로 region 모드로 새 박스를 그리는 흐름에는 영향 없음. */
      if (isPlaying) return [];
      return item.timestamp_notes.filter(
        (note) => note.region && Math.abs(currentTime - (note.atSec ?? 0)) < 0.15,
      );
    }
    if (isStillImageBranch) {
      return item.timestamp_notes.filter((note) => note.region);
    }
    return [];
  }, [currentTime, isPlaying, isStillImageBranch, isVideo, item.timestamp_notes]);

  /* RegionOverlay 가 새 region 을 저장 — 영상이면 atSec=현재시간 + region,
     이미지면 atSec/frameIndex 둘 다 undefined + region. 부모 handleAdd-
     TimestampNote 가 자료 종류에 맞춰 anchor 를 결정한다. */
  const handleRegionCreate = useCallback(
    (region: RegionRect, text: string) => {
      if (isVideo) {
        const at = videoRef.current?.currentTime ?? 0;
        onAddTimestampNote(text, Number.isFinite(at) ? at : 0, region);
      } else {
        onAddTimestampNote(text, undefined, region);
      }
    },
    [isVideo, onAddTimestampNote, videoRef],
  );

  /* RegionOverlay popover 닫힘 시 region 모드 자동 OFF — 단발 드로잉. */
  const handleAfterRegion = useCallback(() => {
    setRegionMode(false);
  }, []);

  /* Region 드래그 시작 시 영상 일시정지. 이미지에서는 무시. */
  const handleRegionDrawStart = useCallback(() => {
    if (isVideo) {
      videoRef.current?.pause();
    }
  }, [isVideo, videoRef]);

  /* 크롭 모드 토글. 켤 때 region 모드를 끄고 줌/팬을 fit 으로 리셋해
     크롭 사각형이 보이는 전체 이미지와 정렬되도록 한다. 끌 때 영역을
     전체로 되돌린다. */
  const { reset: resetCropPanZoom } = imagePanZoom;
  const toggleCropMode = useCallback(() => {
    setCropMode((v) => {
      if (v) {
        setCropPending(false);
        setCropRect({ x: 0, y: 0, w: 1, h: 1 });
        return false;
      }
      setRegionMode(false);
      resetCropPanZoom();
      setCropRect({ x: 0, y: 0, w: 1, h: 1 });
      setCropPending(false);
      return true;
    });
  }, [resetCropPanZoom]);

  /* 확정 → 저장 방식(새 파일/덮어쓰기) 선택 다이얼로그 표시. */
  const handleCropConfirm = useCallback(() => {
    setCropPending(true);
  }, []);

  /* 저장 방식 선택 → 부모가 픽셀 크롭 + 저장 + toast 를 수행. */
  const handleCropChoose = useCallback(
    async (mode: "new" | "overwrite") => {
      const rect = cropRect;
      setCropPending(false);
      setCropMode(false);
      setCropRect({ x: 0, y: 0, w: 1, h: 1 });
      await onCropImage?.(rect, mode);
    },
    [cropRect, onCropImage],
  );

  /* C 키 — 이미지 크롭 토글. 정지 이미지 + onCropImage 가 있을 때만 동작.
     R 단축키와 동일하게 IME/입력 포커스 가드. (isStillImageBranch /
     toggleCropMode 가 위에서 초기화된 뒤에 등록해야 TDZ 가 안 난다.) */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C" && event.code !== "KeyC") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!isStillImageBranch || !onCropImage) return;
      event.preventDefault();
      toggleCropMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isStillImageBranch, onCropImage, toggleCropMode]);

  /* 커스텀 timeline — 클릭 또는 드래그로 시크. mousemove 는 윈도우에 등록
     해 트랙 밖으로 마우스가 나가도 드래그 지속되게. */
  const seekToClientX = useCallback(
    (clientX: number) => {
      const track = timelineRef.current;
      const v = videoRef.current;
      if (!track || !v || !totalDuration) return;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      try {
        v.currentTime = pct * totalDuration;
      } catch {
        /* noop */
      }
    },
    [totalDuration, videoRef],
  );

  const handleTimelineMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    /* 마커 / 루프 핸들·밴드 클릭은 각자 onMouseDown 에서 stopPropagation 하므
       로 여기는 트랙 본문(루프 영역 밖) 클릭만 잡는다. */
    isDraggingRef.current = true;
    seekToClientX(event.clientX);
  };

  /* 루프 핸들 드래그 시작 — 트랙 시크와 충돌하지 않도록 stopPropagation. */
  const handleLoopHandleMouseDown = useCallback(
    (which: "start" | "end") => (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setLoopDragMode(which);
    },
    [],
  );

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      /* 시크 드래그 (트랙 본문 클릭) */
      if (isDraggingRef.current) {
        seekToClientX(event.clientX);
        return;
      }
      /* 루프 핸들 드래그 — start 또는 end 중 하나의 시간을 갱신. */
      if (!loopDragMode) return;
      const track = timelineRef.current;
      if (!track || !totalDuration) return;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const t = pct * totalDuration;
      /* 핸들끼리 너무 가까워지지 않도록 0.05s 간격 보장 — 0 이면 loop 강제
         seek 가 즉시 0 으로 되돌리는 무한 루프가 발생할 수 있다. */
      const MIN_GAP = 0.05;
      if (loopDragMode === "start") {
        setLoopStart((prev) => {
          const upper = loopEnd !== null ? Math.max(0, loopEnd - MIN_GAP) : totalDuration;
          const next = Math.max(0, Math.min(t, upper));
          return Number.isFinite(next) ? next : prev ?? 0;
        });
      } else if (loopDragMode === "end") {
        setLoopEnd((prev) => {
          const lower = loopStart !== null ? Math.min(totalDuration, loopStart + MIN_GAP) : 0;
          const next = Math.min(totalDuration, Math.max(t, lower));
          return Number.isFinite(next) ? next : prev ?? totalDuration;
        });
      }
    };
    const onUp = () => {
      isDraggingRef.current = false;
      if (loopDragMode) setLoopDragMode(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [loopDragMode, loopEnd, loopStart, seekToClientX, totalDuration]);

  /* 호버 video 에 대해 hoverTargetRef 의 최신 시각으로 seek 를 시도한다.
     이미 in-flight 인 seek 가 있으면 호출만 기록 — `seeked` 이벤트 핸들러
     가 그 다음 한 번 더 따라잡는다. fastSeek 가 있으면(키프레임 정밀도)
     디코딩 비용이 훨씬 낮아 빠른 호버 추적에 유리. */
  const requestHoverSeek = useCallback(() => {
    const v = hoverVideoRef.current;
    if (!v) return;
    const target = hoverTargetRef.current;
    if (target === null) return;
    if (v.readyState < 1) {
      const onLoad = () => requestHoverSeek();
      v.addEventListener("loadedmetadata", onLoad, { once: true });
      return;
    }
    if (hoverSeekingRef.current) return;
    hoverSeekingRef.current = true;
    try {
      const fast = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
      if (typeof fast === "function") fast.call(v, target);
      else v.currentTime = target;
    } catch {
      hoverSeekingRef.current = false;
    }
  }, []);

  /* seeked / seeking 이벤트로 in-flight 상태 추적. 한 seek 가 끝났을 때
     사용자가 그동안 더 멀리 움직였다면 ref 의 최신 좌표로 즉시 추가 seek. */
  useEffect(() => {
    const v = hoverVideoRef.current;
    if (!v) return;
    const onSeeked = () => {
      hoverSeekingRef.current = false;
      const target = hoverTargetRef.current;
      if (target !== null && Math.abs(v.currentTime - target) > 0.02) {
        requestHoverSeek();
      }
    };
    /* 일부 브라우저는 seek 가 abort 되면 seeked 가 안 오므로 안전장치로
       seeking 도 listen — 새 seek 가 시작되면 항상 in-flight 로 간주. */
    const onSeeking = () => {
      hoverSeekingRef.current = true;
    };
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("seeking", onSeeking);
    return () => {
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("seeking", onSeeking);
    };
  }, [requestHoverSeek]);

  /* 타임라인 호버 → 썸네일 미리보기 갱신. 트랙 또는 그 위 자식(밴드/핸들)
     모두에서 mousemove 가 들어오므로 timelineRef 의 boundingRect 기준으로
     계산한다. 드래그 중에는 호버 미리보기를 숨겨 시각 노이즈 줄임. 위치
     state 는 즉시 갱신(가벼움)하고, seek 는 ref + imperative 로 처리해
     매 프레임 React 리렌더 비용 없이 최신 좌표를 따라가게 한다. */
  const handleTimelineMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isVideo || !totalDuration) return;
      if (loopDragMode || isDraggingRef.current) return;
      const track = timelineRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const sec = pct * totalDuration;
      hoverTargetRef.current = sec;
      setHoverPreview({ sec, pct });
      requestHoverSeek();
    },
    [isVideo, loopDragMode, requestHoverSeek, totalDuration],
  );

  const handleTimelineMouseLeave = useCallback(() => {
    setHoverPreview(null);
    hoverTargetRef.current = null;
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, [videoRef]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    /* 사용자가 mute 해제했는데 volume 이 0 이라면 들리지 않으므로, unmute 와
       동시에 최소 0.5 까지 끌어올린다(YouTube 와 동일 동작). */
    if (v.muted && v.volume === 0) {
      v.volume = 0.5;
    }
    v.muted = !v.muted;
  }, [videoRef]);

  /* 볼륨 슬라이더 — 트랙 위의 clientX 비율을 0~1 로 환산해 v.volume 에 직접
     쓴다. 0 으로 끌어내리면 자동 mute, 0 보다 크게 올리면 자동 unmute —
     YouTube 와 동일한 자연스러운 전환. */
  const setVolumeFromClientX = useCallback(
    (clientX: number) => {
      const track = volumeTrackRef.current;
      const v = videoRef.current;
      if (!track || !v) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      v.volume = pct;
      if (pct === 0) {
        if (!v.muted) v.muted = true;
      } else if (v.muted) {
        v.muted = false;
      }
    },
    [videoRef],
  );

  const handleVolumeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      /* timeline / 다른 핸들과 충돌 방지 — 컨트롤 바 안이지만 보호 차원. */
      event.stopPropagation();
      event.preventDefault();
      isDraggingVolumeRef.current = true;
      setVolumeFromClientX(event.clientX);
    },
    [setVolumeFromClientX],
  );

  /* 볼륨 드래그 — window mousemove/mouseup 으로 트랙 밖으로 마우스가 나가도
     끊기지 않게(timeline 드래그와 동일 구조). 항상 켜져 있되 isDraggingVolumeRef
     로만 분기. */
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!isDraggingVolumeRef.current) return;
      setVolumeFromClientX(event.clientX);
    };
    const onUp = () => {
      isDraggingVolumeRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setVolumeFromClientX]);

  const toggleFullscreen = useCallback(() => {
    const target = fullscreenWrapRef.current;
    if (!target) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen().catch(() => {});
    }
  }, []);

  return (
    /* h-full 대신 flex-1 — 부모(LibraryPage 의 wrapper)가 flex flex-col 이라
       flex 분배로 명확한 height 를 받는다. percentage 의존성을 없애 어떤
       체인에서도 안전하게 동작. */
    <section className="flex flex-1 min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-subtle px-4">
        <Button variant="ghost" className="h-8 gap-2 text-meta" style={{ borderRadius: 0 }} onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("library.preview.backToGrid")}
        </Button>
        <div className="min-w-0 px-4 text-center">
          <div className="truncate text-body font-semibold">{item.title}</div>
          <div className="font-mono text-2xs text-muted-foreground">
            {currentIndex + 1} / {items.length}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            disabled={!previous}
            onClick={() => previous && onSelect(previous.id)}
            title={t("library.preview.prev")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            disabled={!next}
            onClick={() => next && onSelect(next.id)}
            title={t("library.preview.next")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div ref={fullscreenWrapRef} className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col items-stretch justify-center p-5">
        <div
          ref={imageScrollRef}
          onMouseDown={imagePanZoom.onMouseDown}
          onDoubleClick={imagePanZoom.onDoubleClick}
          className={cn(
            "relative flex w-full flex-1 items-center justify-center overflow-hidden border border-border-subtle bg-black",
            /* 정지 이미지 분기에선 항상 grab 커서 — Eagle 식 "어디든 드래그
               해서 옮길 수 있다" 시그널. 드래그 중엔 grabbing 으로 전환.
               region 모드 ON 일 땐 RegionOverlay 의 crosshair 가 우선이라
               default 로 두고, 비디오/유튜브/링크/PDF 분기에서는 자체 커서
               (video=pointer 등)에 양보. */
            isStillImageBranch && !regionMode
              && (imagePanZoom.isPanning ? "cursor-grabbing" : "cursor-grab"),
          )}
          style={{ borderRadius: 0 }}
        >
          {isVideo ? (
            <>
            <video
              ref={videoRef}
              src={item.file_url ?? undefined}
              poster={item.thumbnail_url ?? undefined}
              /* native controls 는 끄고 아래 커스텀 컨트롤로 대체. 비디오
                 위 클릭은 토글 재생. region 모드 ON 일 땐 비디오의 click 을
                 무시해 RegionOverlay 의 드래그가 우선되게 한다 — 그렇지
                 않으면 첫 mousedown 이 video 로 가버려 toggle play/pause 가
                 발사되고 드래그가 캡처되지 않는다. */
              controls={false}
              onClick={(event) => {
                if (regionMode) {
                  event.preventDefault();
                  return;
                }
                togglePlay();
              }}
              /* absolute inset-0: <video> 도 <img> 와 마찬가지로 replaced
                 element 라 flex item 으로 두면 min-width/min-height: auto 가
                 자연 해상도(예: 4K 영상의 3840px)로 해석돼 컨테이너를 밀어
                 내고 가로 비율 영상이 세로로 잘려 보이는 문제가 난다. flex
                 sizing 자체를 우회해 부모 정사각형/세로 박스에 정확히 fit
                 시킨다. region 모드 ON 일 땐 cursor 를 default 로 — 위
                 RegionOverlay 의 crosshair 가 더 잘 보이도록. */
              className={cn(
                "absolute inset-0 h-full w-full object-contain",
                regionMode ? "cursor-default" : "cursor-pointer",
              )}
              onError={() => {
                /* 코덱 미지원(ProRes/HEVC MOV 등) — 인앱 재생 불가. 자동으로
                   기본 플레이어를 열지 않고, 패널에 안내 오버레이 + "기본
                   플레이어로 열기" 버튼만 노출한다(사용자 명시 클릭 필요). */
                setVideoUnplayable(true);
              }}
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = Number(playbackRate);
                /* 정상 디코드되면 미재생 상태 해제(다른 자료에서 돌아온 경우 등). */
                setVideoUnplayable(false);
                if (typeof initialSeekSec === "number" && Number.isFinite(initialSeekSec)) {
                  event.currentTarget.currentTime = initialSeekSec;
                  onInitialSeekConsumed?.();
                }
                const duration = Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0;
                setVideoDuration(duration);
                /* Phase 4 — 자연 해상도(영상 픽셀) 캐시. RegionOverlay 가
                   letterbox box 산출에 사용. videoWidth/Height 는 metadata
                   이후에만 0 이상의 값. */
                const w = event.currentTarget.videoWidth;
                const h = event.currentTarget.videoHeight;
                if (w > 0 && h > 0) setMediaNaturalSize({ w, h });
              }}
            />
            {/* Phase 4 — 영상 위 Region 오버레이. videoRef 를 직접 쓰지 않고
                imageScrollRef(=영상의 부모 컨테이너) 를 좌표 기준으로 삼는다
                — <video> 는 absolute inset-0 이라 부모와 같은 박스라 OK.
                onAddTimestampNote 는 항상 정의되어 있으므로 가드 없이 마운트. */}
            <RegionOverlay
              containerRef={imageScrollRef}
              naturalWidth={mediaNaturalSize?.w ?? null}
              naturalHeight={mediaNaturalSize?.h ?? null}
              visibleNotes={visibleRegionNotes}
              drawing={regionMode}
              onCreateRegion={handleRegionCreate}
              onAfterCreate={handleAfterRegion}
              onDrawStart={handleRegionDrawStart}
              onDeleteRegion={onDeleteTimestampNote}
              onEditRegion={onEditTimestampNote}
            />
            {videoUnplayable ? (
              /* 인앱 디코드 실패 — 포스터 위에 안내 + 기본 플레이어 열기 버튼.
                 자동 위임은 하지 않으며, 사용자가 버튼을 직접 눌러야 OS 기본
                 플레이어가 실행된다. */
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center">
                <Film className="h-10 w-10 text-white/70" aria-hidden />
                <p className="max-w-xs text-caption text-white/90">
                  {t("library.preview.videoUnplayable")}
                </p>
                {onOpenInDefaultApp ? (
                  <Button
                    className="h-8 px-3 text-meta"
                    style={{ borderRadius: 0 }}
                    onClick={() => onOpenInDefaultApp(item)}
                  >
                    {t("library.preview.openInDefaultPlayer")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            </>
          ) : item.kind === "youtube" && youtubeEmbedUrl(item.source_url) ? (
            <iframe
              src={youtubeEmbedUrl(item.source_url) ?? undefined}
              title={item.title}
              /* iframe 은 일반 inline 요소지만 같은 flex sizing 이슈 방지
                 차원에서 absolute 로 통일. */
              className="absolute inset-0 h-full w-full"
              /* prod (file://) origin 으로 직접 Referer 가 새는 것을 막아
                 youtube 가 embed 거부(error 153 등) 하는 빈도를 줄인다.
                 default 세션의 onBeforeSendHeaders 가 한 번 더 youtube 도메인
                 요청의 Referer 를 강제 spoof 하지만, referrerpolicy 로 미리
                 알리면 Chromium 이 처음부터 file:// 를 보내지 않아 1차 방어가
                 더 일관됨. */
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : item.kind === "link" ? (
            /* URL 자료 — Electron <webview> 게스트로 실제 페이지를 임베드.
               일반 <iframe> 은 외부 사이트 대부분이 X-Frame-Options 로 거부하므로
               webview 필수. 메인의 web-contents-created 가드가 권한/팝업/외부
               네비게이션을 OS 브라우저로 위임한다. */
            <LinkWebView item={item} />
          ) : item.kind === "doc" && !psdPreviewUrl ? (
            /* doc 카테고리 큰 프리뷰 — sub-type 별 분기.
               PSD 는 풀해상도 프리뷰가 있으면 이 분기를 건너뛰고 아래
               imagePreviewUrl(이미지 줌·팬) 분기로 떨어진다.
               - pdf:   PDF.js 캔버스 뷰어 (페이지 네비/줌)
               - audio: native <audio controls>
               - html:  webview 게스트로 file_url 임베드
               - 그 외(presentation/spreadsheet/document/font/archive/code/exe/...):
                       기존 카드 — thumbnail_url 이 있으면 이미지, 없으면
                       아이콘/배지 카드. 이쪽은 파일 자체를 브라우저로 렌더하기
                       어려운(또는 의미 없는) 군이라 OS 위임이 자연스럽다. */
            (() => {
              const subtype = docSubtypeOf(item);
              if (subtype === "pdf" && item.file_url) {
                return (
                  <PdfViewer
                    item={item}
                    notes={item.timestamp_notes}
                    onCreateRegion={(region, text, pageIndex) =>
                      onAddTimestampNote(text, undefined, region, undefined, pageIndex)
                    }
                    onEditRegion={onEditTimestampNote}
                    onDeleteRegion={onDeleteTimestampNote}
                    initialPageIndex={initialPageIndex}
                    onInitialPageConsumed={onInitialPageConsumed}
                  />
                );
              }
              if (subtype === "audio" && item.file_url) {
                return <AudioView item={item} />;
              }
              if (subtype === "html" && item.file_url) {
                /* useFileUrl: link 자료의 source_url 대신 doc 자료의
                   file_url(local-server 에 호스팅된 .html) 을 src 로. */
                return <LinkWebView item={item} useFileUrl />;
              }
              const docPresentation = docPresentationOf(item);
              const hueCls = docHueClasses(docPresentation);
              const DocIcon = docPresentation.Icon;
              const thumb = item.thumbnail_url
                ? withReferenceVersion(item.thumbnail_url, item)
                : "";
              if (thumb) {
                return (
                  <img
                    src={thumb}
                    alt={item.title}
                    className="absolute inset-0 h-full w-full object-contain"
                    draggable={false}
                  />
                );
              }
              return (
                <div className={cn("flex max-w-xl flex-col items-center gap-4 px-8 py-12 text-center text-white/85", hueCls.surface)}>
                  <DocIcon className={cn("h-16 w-16", hueCls.iconColor)} />
                  <span className={cn("rounded px-2 py-1 font-mono text-meta font-semibold tracking-wider", hueCls.badgeBg)}>
                    {docExtensionTag(item)}
                  </span>
                  <div className="break-all text-label">{item.title}</div>
                </div>
              );
            })()
          ) : isAnimatedGif && gifPlayerSupported ? (
            /* GIF / 애니메이션 WebP / APNG — 영상과 동일한 컨트롤 UX 로 재생.
               GifFramePlayer 가 자체적으로 canvas + 컨트롤 바 + 단축키를 그리므로
               wrapper 의 image zoom/pan 핸들러는 적용되지 않는다(클래스 가드 +
               컴포넌트 자체가 이벤트를 잡음). ImageDecoder 미지원/디코드 실패
               시 onUnsupported 가 호출돼 같은 자리에서 <img> 자동재생으로 폴백.
               Phase 4 — notes / onEdit / onDelete 를 forward 해 GifFramePlayer
               안의 RegionOverlay 가 region 노트 표시·편집·삭제까지 처리. */
            <div className="absolute inset-0">
              <GifFramePlayer
                src={item.file_url!}
                mimeType={item.mime_type ?? "image/gif"}
                posterUrl={item.thumbnail_url ?? undefined}
                playbackRate={playbackRate}
                onPlaybackRateChange={onPlaybackRateChange}
                onUnsupported={() => setGifPlayerSupported(false)}
                onAddTimestampNote={(text, frameIndex, region) =>
                  onAddTimestampNote(text, undefined, region, frameIndex)
                }
                onSetCoverFromCanvas={onSetCoverFromCanvas}
                onSaveFrameFromCanvas={onSaveFrameFromCanvas}
                saving={saving}
                initialFrameIndex={initialFrameIndex ?? null}
                onInitialFrameConsumed={onInitialFrameConsumed}
                notes={item.timestamp_notes}
                onEditTimestampNote={onEditTimestampNote}
                onDeleteTimestampNote={onDeleteTimestampNote}
              />
            </div>
          ) : imagePreviewUrl ? (
            <>
            {/* Eagle 식 자유 줌·팬 — useImagePanZoom 훅의 transform 을 inner
                wrapper 에 박는다. wrapper 는 컨테이너와 동일한 absolute inset-0
                박스라 scale=1·tx=ty=0 일 때 정확히 fit 상태. 휠/드래그로
                wrapper 의 transform 이 바뀌면 이미지가 함께 이동·확대된다.
                will-change-transform 으로 GPU 컴포지트 레이어로 승격시켜
                60fps 팬·줌을 보장. */}
            <div
              className="absolute inset-0 will-change-transform"
              style={imagePanZoom.transformStyle}
            >
              <img
                src={imagePreviewUrl}
                alt={item.title}
                className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
                draggable={false}
                onLoad={(event) => {
                  const w = event.currentTarget.naturalWidth;
                  const h = event.currentTarget.naturalHeight;
                  if (w > 0 && h > 0) setMediaNaturalSize({ w, h });
                }}
              />
            </div>
            {/* Phase 4 — 이미지 위 Region 오버레이. transform wrapper 의 *형제*
                로 두어, popover 와 텍스트는 unscaled 컨테이너 크기로 정상 렌더
                되면서 region 박스만 wrapper 의 transform 을 따라가도록 한다.
                panX/panY/scale 을 명시 전달해 RegionOverlay 내부의 contentBox
                가 visible 이미지 위치에 정확히 정렬된다. region 모드 ON 일 땐
                위 훅이 enabled=false 라 휠/드래그가 비활성화되고 오버레이의
                자체 pointer events 가 crosshair 드래그를 캡처. */}
            {/* 크롭 모드에서는 region 박스/오버레이를 숨겨 핸들·마스크에 집중. */}
            {!cropMode && (
              <RegionOverlay
                containerRef={imageScrollRef}
                naturalWidth={mediaNaturalSize?.w ?? null}
                naturalHeight={mediaNaturalSize?.h ?? null}
                visibleNotes={visibleRegionNotes}
                drawing={regionMode}
                onCreateRegion={handleRegionCreate}
                onAfterCreate={handleAfterRegion}
                onDeleteRegion={onDeleteTimestampNote}
                onEditRegion={onEditTimestampNote}
                highlightNoteId={highlightRegionNoteId}
                panX={imagePanZoom.tx}
                panY={imagePanZoom.ty}
                scale={imagePanZoom.scale}
              />
            )}
            {/* 정지 이미지 크롭 — 8핸들 오버레이. transform wrapper 의 형제로 두어
                RegionOverlay 와 동일한 좌표계(pan/scale)를 공유한다. */}
            {cropMode && (
              <ImageCropOverlay
                containerRef={imageScrollRef}
                naturalWidth={mediaNaturalSize?.w ?? null}
                naturalHeight={mediaNaturalSize?.h ?? null}
                value={cropRect}
                onChange={setCropRect}
                onConfirm={handleCropConfirm}
                onCancel={toggleCropMode}
                onReset={() => setCropRect({ x: 0, y: 0, w: 1, h: 1 })}
                panX={imagePanZoom.tx}
                panY={imagePanZoom.ty}
                scale={imagePanZoom.scale}
              />
            )}
            {/* 우상단 floating 컨트롤 — 이미지에는 컨트롤 바가 없어서 별도
                위치. 좌측: Fit 버튼(현재 fit 상태면 primary 강조 + 클릭 시
                scale=1·tx=ty=0 으로 리셋, PDF 뷰어의 Fit 버튼과 동일 UX).
                우측: Region(BoxSelect) 토글(단축키 R). 두 버튼을 한 묶음으로
                두어 시각적으로 그룹화. */}
            <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
              <button
                type="button"
                className={cn(
                  "flex h-8 w-8 items-center justify-center border border-border-subtle bg-background/80 text-foreground shadow-sm transition-colors hover:bg-background",
                  imagePanZoom.scale === 1 && imagePanZoom.tx === 0 && imagePanZoom.ty === 0
                    && "bg-primary/15 text-primary",
                )}
                style={{ borderRadius: 0 }}
                onClick={(event) => {
                  event.stopPropagation();
                  imagePanZoom.reset();
                }}
                title={t("library.preview.imgFit")}
                aria-label={t("library.preview.imgFit")}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={cn(
                  "flex h-8 w-8 items-center justify-center border border-border-subtle bg-background/80 text-foreground shadow-sm transition-colors hover:bg-background",
                  regionMode && "border-primary/40 bg-primary/15 text-primary",
                )}
                style={{ borderRadius: 0 }}
                onClick={(event) => {
                  event.stopPropagation();
                  setCropMode(false);
                  setRegionMode((v) => !v);
                }}
                title={regionMode ? t("library.preview.regionOnImg") : t("library.preview.regionImg")}
                aria-label={t("library.preview.regionAria")}
                aria-pressed={regionMode}
              >
                <BoxSelect className="h-3.5 w-3.5" />
              </button>
              {onCropImage && (
                <button
                  type="button"
                  className={cn(
                    "flex h-8 w-8 items-center justify-center border border-border-subtle bg-background/80 text-foreground shadow-sm transition-colors hover:bg-background",
                    cropMode && "border-primary/40 bg-primary/15 text-primary",
                  )}
                  style={{ borderRadius: 0 }}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleCropMode();
                  }}
                  title={cropMode ? t("library.preview.cropOnImg") : t("library.preview.cropImg")}
                  aria-label={t("library.preview.cropAria")}
                  aria-pressed={cropMode}
                >
                  <Crop className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            </>
          ) : (
            <Library className="h-12 w-12 text-white/50" />
          )}
        </div>

        {/* 커스텀 timeline — 영상 컨테이너 *바로 아래* 의 별도 행. 이전엔
            native <video controls> 의 timeline 슬라이더에 마커를 정렬시키
            려 했지만 브라우저별 controls 레이아웃이 달라 정확히 맞추기가
            불가능했다. 이제 native controls 를 끄고 우리가 직접 타임라인을
            그리므로, 타임라인 X 좌표 = 마커 X 좌표 가 보장된다. */}
        {isVideo ? (
          <div
            ref={timelineRef}
            className={cn(
              "group/timeline relative mt-2 h-2 cursor-pointer bg-muted/40 transition-[height] hover:h-3",
              /* 루프 활성 시 트랙 자체를 살짝 더 두껍게 — 핸들 hit area 가
                 충분한 높이를 갖도록. 드래그 중에는 hover 와 무관하게 두껍게
                 유지해 마우스가 잠깐 빗나가도 세로 클리핑이 안 되게 한다. */
              (loopStart !== null && loopEnd !== null) && "h-3",
              loopDragMode && "h-3",
            )}
            onMouseDown={handleTimelineMouseDown}
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
          >
            {/* hit-area 확장 — 8px 가량 빗나가도 hover/click 이 인식되도록
                트랙 상하로 투명한 자식 박스를 깐다. 자식이라 모든 mouse
                event 가 트랙으로 bubble 되어 동일 핸들러로 처리되며, 시각
                트랙 높이는 그대로(h-2/h-3). loop 핸들·timestamp 마커보다
                먼저 렌더되므로 z-10 핸들 클릭과는 충돌하지 않는다. */}
            <div className="absolute inset-x-0 -top-2 -bottom-2" aria-hidden />

            {/* 진행 바 — currentTime 까지의 영역. */}
            <div
              className="pointer-events-none absolute top-0 h-full bg-primary/60"
              style={{ width: `${positionToPct(currentTime)}%` }}
            />

            {/* loop 범위 띠 — 시각 표시 전용(드래그/시크 클릭을 가로채지 않음).
                범위 변경은 양 끝 핸들로만. Eagle 의 reference 라이브러리와 동일
                하게 *중립 흰색 톤* — primary(빨강) 진행 바와도 자연스럽게 겹치고,
                채도가 강한 sky 색이 영상 콘텐츠 위로 튀어 보이던 어색함을
                제거. region 노트는 마커 상단 cap 으로 따로 구분되므로 색상으로
                분리할 필요가 없다. */}
            {loopStart !== null && loopEnd !== null ? (
              <div
                className="pointer-events-none absolute top-0 h-full bg-foreground/30"
                style={{
                  left: `${positionToPct(loopStart)}%`,
                  width: `${Math.max(0, positionToPct(loopEnd) - positionToPct(loopStart))}%`,
                }}
              />
            ) : null}

            {/* timestamp 마커 — region/시점-only 둘 다 primary 로 통일(사이트
                컬러 토큰). region 노트는 marker 위쪽에 살짝 두꺼운 cap 을 얹어
                "영역 anchored" 임을 구분한다. atSec 이 없는 image-only region
                노트(영상 자료에 들어가지 않지만 안전망) 는 마커 없음. */}
            {totalDuration > 0
              ? sortedNotes.map((note) => {
                if (!Number.isFinite(note.atSec)) return null;
                const leftPct = positionToPct(note.atSec);
                const isRegion = Boolean(note.region);
                return (
                  <button
                    key={note.id}
                    type="button"
                    className={cn(
                      "absolute top-0 h-full w-[3px] bg-primary transition-transform hover:scale-y-[2.4]",
                      /* region anchored 마커는 상단에 cap 을 그려 시점-only
                         마커와 구분 — color 대신 형태로 분기. */
                      isRegion && "before:absolute before:-top-1 before:left-1/2 before:h-1 before:w-2 before:-translate-x-1/2 before:bg-primary",
                    )}
                    style={{ left: `${leftPct}%`, transform: "translateX(-1.5px)" }}
                    title={`${formatDuration(note.atSec)}${isRegion ? ` · ${t("library.preview.region")}` : ""} — ${note.text}${onDeleteTimestampNote ? ` ${t("library.preview.altClickDelete")}` : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.altKey && onDeleteTimestampNote) {
                        onDeleteTimestampNote(note.id);
                        return;
                      }
                      const v = videoRef.current;
                      if (v) v.currentTime = note.atSec ?? 0;
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  />
                );
              })
              : null}

            {/* loop in/out 드래그 핸들 — 트랙 위/아래로 튀어나온 ew-resize 영역.
                넓은 hit area(12px) 안에 얇은 시각 막대(3px) 를 가운데 정렬해
                좁은 트랙에서도 정확히 잡을 수 있게 한다. */}
            {loopStart !== null ? (
              <div
                role="slider"
                aria-label={t("library.preview.loopStartAria")}
                aria-valuemin={0}
                aria-valuemax={totalDuration}
                aria-valuenow={loopStart}
                className={cn(
                  "absolute -top-1.5 z-10 h-[calc(100%+12px)] w-3 cursor-ew-resize",
                  "flex items-center justify-center",
                  loopDragMode === "start" && "scale-110",
                )}
                style={{
                  left: `${positionToPct(loopStart)}%`,
                  transform: "translateX(-50%)",
                }}
                onMouseDown={handleLoopHandleMouseDown("start")}
                title={t("library.preview.loopInTitle", { time: formatDuration(loopStart) })}
              >
                <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
              </div>
            ) : null}
            {loopEnd !== null ? (
              <div
                role="slider"
                aria-label={t("library.preview.loopEndAria")}
                aria-valuemin={0}
                aria-valuemax={totalDuration}
                aria-valuenow={loopEnd}
                className={cn(
                  "absolute -top-1.5 z-10 h-[calc(100%+12px)] w-3 cursor-ew-resize",
                  "flex items-center justify-center",
                  loopDragMode === "end" && "scale-110",
                )}
                style={{
                  left: `${positionToPct(loopEnd)}%`,
                  transform: "translateX(-50%)",
                }}
                onMouseDown={handleLoopHandleMouseDown("end")}
                title={t("library.preview.loopOutTitle", { time: formatDuration(loopEnd) })}
              >
                <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
              </div>
            ) : null}

            {/* 현재 시점 thumb */}
            {totalDuration > 0 ? (
              <span
                className="pointer-events-none absolute top-1/2 h-4 w-[2px] bg-foreground"
                style={{
                  left: `${positionToPct(currentTime)}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
            ) : null}

            {/* 호버 썸네일 미리보기 — 트랙 바로 위로 부유. video element 는
                상시 마운트 + opacity 토글로 첫 프레임 디코딩 지연 회피.
                clamp 로 좌우 트랙 끝에서도 잘리지 않게 가두기. 박스의 가로/
                세로 비율은 영상 자연 해상도를 따라가며, 긴 변을
                HOVER_THUMB_MAX_DIM 으로 고정한다. 메타 로드 전엔 16:9 폴백. */}
            {item.file_url ? (() => {
              const aspect =
                mediaNaturalSize && mediaNaturalSize.w > 0 && mediaNaturalSize.h > 0
                  ? mediaNaturalSize.w / mediaNaturalSize.h
                  : 16 / 9;
              const thumbWidth =
                aspect >= 1 ? HOVER_THUMB_MAX_DIM : Math.round(HOVER_THUMB_MAX_DIM * aspect);
              return (
                <div
                  className={cn(
                    "pointer-events-none absolute z-20 border border-border-subtle bg-background shadow-xl transition-opacity",
                    hoverPreview ? "opacity-100" : "opacity-0",
                  )}
                  style={{
                    borderRadius: 0,
                    bottom: "100%",
                    marginBottom: 8,
                    width: thumbWidth,
                    left: `clamp(${thumbWidth / 2}px, ${(hoverPreview?.pct ?? 0) * 100}%, calc(100% - ${thumbWidth / 2}px))`,
                    transform: "translateX(-50%)",
                  }}
                >
                  <video
                    ref={hoverVideoRef}
                    src={item.file_url}
                    poster={item.thumbnail_url ?? undefined}
                    muted
                    preload="metadata"
                    playsInline
                    className="block w-full bg-black object-contain"
                    style={{ aspectRatio: `${aspect}` }}
                  />
                  <div className="border-t border-border-subtle bg-surface-panel py-0.5 text-center font-mono text-2xs">
                    {formatDuration(hoverPreview?.sec ?? 0)}
                  </div>
                </div>
              );
            })() : null}
          </div>
        ) : null}
      </div>

      {/* 영상 컨트롤 — 1 행으로 모든 컨트롤. 좌측: play/pause, 시간, 음소거.
          우측: 배속, loop, note, set cover, save frame, fullscreen. */}
      {isVideo ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={togglePlay}
            title={isPlaying ? t("library.preview.pauseTitle") : t("library.preview.playTitle")}
            aria-label={isPlaying ? t("library.preview.pause") : t("library.preview.play")}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {formatDuration(currentTime)} / {formatDuration(totalDuration)}
          </span>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={toggleMute}
            title={muted ? t("library.preview.unmute") : t("library.preview.mute")}
            aria-label={muted ? t("library.preview.unmuteAria") : t("library.preview.muteAria")}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>

          {/* 볼륨 슬라이더 — timeline 과 동일한 시각 언어(평평한 바 + 얇은
              thumb)로 그려 일관성 유지. mute 상태에서는 fill 폭이 0 으로
              내려가 시각적으로도 "소리 없음" 을 알 수 있다. */}
          <div
            ref={volumeTrackRef}
            className="group/volume relative h-1.5 w-16 shrink-0 cursor-pointer bg-muted/40 transition-[height] hover:h-2"
            style={{ borderRadius: 0 }}
            role="slider"
            aria-label={t("library.preview.volumeAria")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={muted ? 0 : Math.round(volume * 100)}
            onMouseDown={handleVolumeMouseDown}
            title={muted ? t("library.preview.muted") : t("library.preview.volumePct", { pct: Math.round(volume * 100) })}
          >
            {/* hit-area 확장 — 트랙이 얇아도 잡기 쉽게 상하 패딩. */}
            <div className="absolute inset-x-0 -top-2 -bottom-2" aria-hidden />
            <div
              className="pointer-events-none absolute top-0 h-full bg-foreground/80"
              style={{ width: `${muted ? 0 : volume * 100}%` }}
            />
            <span
              className="pointer-events-none absolute top-1/2 h-3 w-[2px] bg-foreground"
              style={{
                left: `${muted ? 0 : volume * 100}%`,
                transform: "translate(-50%, -50%)",
              }}
            />
          </div>

          <div className="flex-1" />

          <select
            value={playbackRate}
            onChange={(event) => onPlaybackRateChange(event.target.value)}
            className="h-8 w-[72px] shrink-0 border border-border-subtle bg-background px-2 text-caption"
            style={{ borderRadius: 0 }}
          >
            {PLAYBACK_RATE_OPTIONS.map((rate) => (
              <option key={rate} value={String(rate)}>{`${rate}x`}</option>
            ))}
          </select>

          <Button
            variant="outline"
            className={cn(
              "h-8 w-8 p-0",
              loopStart !== null && loopEnd !== null && "border-foreground/40 bg-foreground/15 text-foreground",
            )}
            style={{ borderRadius: 0 }}
            onClick={cycleLoop}
            title={
              loopStart !== null && loopEnd !== null
                ? t("library.preview.loopActive", { start: formatDuration(loopStart), end: formatDuration(loopEnd) })
                : t("library.preview.loopIdle")
            }
            aria-label={t("library.preview.loopAria")}
            aria-pressed={loopStart !== null && loopEnd !== null}
          >
            <Repeat className="h-3.5 w-3.5" />
          </Button>

          {/* Save loop as GIF — loop 구간이 정의돼 있을 때만 활성화. 다이얼로그
              가 열릴 때 현재 loopStart/loopEnd 를 freeze 한 뒤, 부모가 받은
              Blob 으로 uploadReferenceFile + upsert + toast 까지 마무리한다.
              아이콘은 Film 으로 export/추출 의미를 한 번에 전달. */}
          {(() => {
            const canSaveGif =
              loopStart !== null &&
              loopEnd !== null &&
              loopEnd > loopStart &&
              Boolean(item.file_url) &&
              Boolean(onSaveLoopAsGif);
            const loopLen =
              loopStart !== null && loopEnd !== null && loopEnd > loopStart
                ? loopEnd - loopStart
                : 0;
            return (
              <Button
                variant="outline"
                className={cn(
                  "h-8 w-8 p-0",
                  canSaveGif && "border-foreground/40 text-foreground",
                )}
                style={{ borderRadius: 0 }}
                onClick={() => {
                  if (!canSaveGif || loopStart === null || loopEnd === null) return;
                  setGifDialogLoop({ startSec: loopStart, endSec: loopEnd });
                  setGifDialogOpen(true);
                }}
                disabled={!canSaveGif}
                title={
                  canSaveGif
                    ? t("library.saveLoopAsGifEnabled", {
                        duration: `${loopLen.toFixed(2)}s`,
                      })
                    : t("library.saveLoopAsGifDisabled")
                }
                aria-label={t("library.saveLoopAsGif")}
              >
                <Film className="h-3.5 w-3.5" />
              </Button>
            );
          })()}

          {/* Phase 4 — Region annotation 토글. ON 이면 영상 위 RegionOverlay
              가 crosshair 드래그를 캡처해 새 박스를 그린다. 영상은 자동
              일시정지 + drawing 끝나면 자동 OFF 된다. */}
          <Button
            variant="outline"
            className={cn(
              "h-8 w-8 p-0",
              regionMode && "border-primary/40 bg-primary/15 text-primary",
            )}
            style={{ borderRadius: 0 }}
            onClick={() => setRegionMode((v) => !v)}
            title={regionMode ? t("library.preview.regionOn") : t("library.preview.regionIdle")}
            aria-label={t("library.preview.regionAria")}
            aria-pressed={regionMode}
          >
            <BoxSelect className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={openNoteDialog}
            title={t("library.preview.addNoteTitle")}
            aria-label={t("library.preview.addNoteAria")}
          >
            <NotebookPen className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={onSetCover}
            disabled={saving}
            title={t("library.preview.setCoverTitle")}
            aria-label={t("library.preview.setCover")}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={onSaveFrame}
            disabled={saving}
            title={t("library.preview.saveFrameTitle")}
            aria-label={t("library.preview.saveFrame")}
          >
            <Camera className="h-3.5 w-3.5" />
          </Button>

          {/* 단축키 안내 — 컨트롤 바에 숨은 키보드 단축키를 한곳에 노출한다.
              시킹/배속 수식키는 플랫폼(Win: Ctrl, Mac: ⌥/⌘)에 맞춰 표기. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className="h-8 w-8 p-0"
                style={{ borderRadius: 0 }}
                title={t("library.preview.shortcutsBtn")}
                aria-label={t("library.preview.shortcutsBtn")}
              >
                <Keyboard className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-0" style={{ borderRadius: 0 }}>
              <div className="border-b border-border-subtle px-3 py-2 text-caption font-semibold">
                {t("library.preview.shortcutsTitle")}
              </div>
              <ul className="max-h-[60vh] overflow-auto py-1">
                {(() => {
                  const mac = isMacPlatform();
                  const rows: { keys: string; label: string }[] = [
                    { keys: "Space", label: t("library.preview.scPlayPause") },
                    { keys: "M", label: t("library.preview.scMute") },
                    { keys: "↑ / ↓", label: t("library.preview.scVolume") },
                    { keys: "← / →", label: t("library.preview.scItemNav") },
                    { keys: mac ? "⌥ ← / →" : "Ctrl ← / →", label: t("library.preview.scSeek5") },
                    { keys: "Shift ← / →", label: t("library.preview.scSeek10") },
                    { keys: "D / F", label: t("library.preview.scFrame") },
                    { keys: mac ? "⌘ ↑ / ↓" : "Ctrl ↑ / ↓", label: t("library.preview.scSpeed") },
                    { keys: "L", label: t("library.preview.scLoop") },
                    { keys: "[ / ]", label: t("library.preview.scLoopBounds") },
                    { keys: "N", label: t("library.preview.scNote") },
                    { keys: "R", label: t("library.preview.scRegion") },
                  ];
                  return rows.map((row) => (
                    <li
                      key={row.label}
                      className="flex items-center justify-between gap-3 px-3 py-1 text-caption"
                    >
                      <span className="text-muted-foreground">{row.label}</span>
                      <kbd className="shrink-0 border border-border-subtle bg-muted/40 px-1.5 py-0.5 font-mono text-micro text-foreground">
                        {row.keys}
                      </kbd>
                    </li>
                  ));
                })()}
              </ul>
            </PopoverContent>
          </Popover>

          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={toggleFullscreen}
            title={t("library.preview.fullscreen")}
            aria-label={t("library.preview.fullscreen")}
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
      </div>

      {gifDialogLoop && item.file_url && onSaveLoopAsGif ? (
        <SaveLoopAsGifDialog
          open={gifDialogOpen}
          onOpenChange={(next) => {
            setGifDialogOpen(next);
            if (!next) setGifDialogLoop(null);
          }}
          videoUrl={item.file_url}
          sourceWidth={mediaNaturalSize?.w ?? item.width ?? 0}
          sourceHeight={mediaNaturalSize?.h ?? item.height ?? 0}
          startSec={gifDialogLoop.startSec}
          endSec={gifDialogLoop.endSec}
          onConverted={onSaveLoopAsGif}
        />
      ) : null}

      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("library.preview.noteDialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <span className="font-mono text-meta text-primary">{formatDuration(noteDialogAtSec)}</span>
            <Input
              autoFocus
              value={noteDialogText}
              onChange={(event) => setNoteDialogText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSaveNote();
                }
              }}
              placeholder={t("library.preview.noteDialogPlaceholder")}
              className="h-9 text-body"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="h-8 px-3 text-meta" style={{ borderRadius: 0 }}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              className="h-8 px-3 text-meta"
              style={{ borderRadius: 0 }}
              onClick={handleSaveNote}
              disabled={!noteDialogText.trim()}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 크롭 저장 방식 선택 — 확정 후 새 파일/덮어쓰기 중 선택. */}
      <Dialog open={cropPending} onOpenChange={(o) => !o && setCropPending(false)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("library.preview.cropSaveTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-meta text-muted-foreground leading-relaxed">
            {t("library.preview.cropSaveDesc")}
          </p>
          <div className="mt-1 space-y-2">
            <button
              type="button"
              onClick={() => void handleCropChoose("new")}
              className="flex w-full items-start gap-3 border border-border-subtle p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
              style={{ borderRadius: 0 }}
            >
              <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <div>
                <div className="text-meta font-semibold text-foreground">{t("library.preview.cropSaveNew")}</div>
                <div className="mt-0.5 text-caption text-muted-foreground">{t("library.preview.cropSaveNewDesc")}</div>
              </div>
            </button>
            {/* PSD 는 원본(.psd)을 크롭 PNG 로 덮어쓸 수 없으므로 새 이름 저장만
                허용한다(덮어쓰기 옵션 숨김). */}
            {!psdPreviewUrl && (
              <button
                type="button"
                onClick={() => void handleCropChoose("overwrite")}
                className="flex w-full items-start gap-3 border border-border-subtle p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                style={{ borderRadius: 0 }}
              >
                <Crop className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <div>
                  <div className="text-meta font-semibold text-foreground">{t("library.preview.cropOverwrite")}</div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{t("library.preview.cropOverwriteDesc")}</div>
                </div>
              </button>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" className="h-8 px-3 text-meta" style={{ borderRadius: 0 }}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
