import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  BoxSelect,
  Camera,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  NotebookPen,
  Pause,
  Play,
  Repeat,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGifFrames } from "@/lib/gifFrames";
import { cn } from "@/lib/utils";
import { PLAYBACK_RATE_OPTIONS } from "@/components/library/LibraryPreviewPanel";
import { RegionOverlay } from "@/components/library/RegionOverlay";
import type { RegionRect, TimestampNote } from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

/* GIF / 애니메이션 WebP / APNG 를 영상 자료와 동일한 컨트롤 UX 로 재생.
 * 모드 토글 없음 — kind === "gif" 자료는 항상 이 컴포넌트로 렌더링되고,
 * ImageDecoder 미지원 / 디코드 실패 시에만 부모가 <img> 자동재생으로 폴백.
 *
 * Phase 2 (현재) 범위:
 *   - canvas 사전 디코드 + 재생 루프(setTimeout 체인, ms 정밀도)
 *   - 컨트롤 바: play/pause / 프레임번호 / prev·next / 슬라이더 / 배속 / loop
 *   - 단축키: Space (play/pause), [ (prev frame), ] (next frame)
 *   - 캔버스 클릭 → play/pause toggle
 *   - 단일 프레임 자료는 컨트롤 바 숨기고 정적 캔버스만 렌더
 *
 * Phase 3+ 에서 추가될 항목 (Add Note / Set Cover / Save Frame / Region) 은
 * 현재 props 자리만 비워두지 않고 *호출 측이 필요할 때 props 를 추가* 하는 방식.
 * 현재는 가장 단순한 시그니처만 노출한다. */

interface GifFramePlayerProps {
  src: string;
  mimeType: string;
  /** 디코드 중 캔버스 위에 깔리는 정적 썸네일. 디코드 완료 시점에 캔버스가
   *  동일 콘텐츠를 그려 자연스럽게 cross-fade 될 필요는 없다 — 사용자가
   *  Decoding 상태를 짧게 인지하는 게 더 정직하다. */
  posterUrl?: string;
  playbackRate: string;
  onPlaybackRateChange: (rate: string) => void;
  /** ImageDecoder 미지원/디코드 실패 시 호출. 부모는 같은 자리에 <img src=src>
   *  자동재생을 띄워 시각 끊김을 최소화한다. */
  onUnsupported: () => void;
  /** GIF 프레임 단위 노트 추가. 미전달 시 NotebookPen 아이콘 숨김.
   *  text 는 사용자가 다이얼로그에 입력한 본문, frameIndex 는 다이얼로그가
   *  열린 시점의 currentFrame 인덱스. 부모(LibraryPage) 가 timestamp_notes
   *  배열에 region=undefined / frameIndex=N 인 노트를 append 한다.
   *  Phase 4 — region 4번째 인자 추가. RegionOverlay 가 새 region 을 만들 때
   *  같은 콜백으로 호출(region!=undefined). 영상과 동일한 시그니처. */
  onAddTimestampNote?: (text: string, frameIndex: number, region?: RegionRect) => void;
  /** GIF 현재 프레임을 cover 로 등록. 미전달 시 ImageIcon 아이콘 숨김.
   *  자체 캔버스 (canvasRef.current) 를 그대로 인자로 전달해 부모가 추가
   *  drawImage 없이 바로 toBlob → 업로드. */
  onSetCoverFromCanvas?: (canvas: HTMLCanvasElement, frameIndex: number) => void;
  /** GIF 현재 프레임을 새 image reference 로 저장. 미전달 시 Camera 아이콘 숨김. */
  onSaveFrameFromCanvas?: (canvas: HTMLCanvasElement, frameIndex: number) => void;
  /** 저장 중 disabled 토글. 영상의 saving prop 과 동일 의미. */
  saving?: boolean;
  /** Inspector 에서 GIF 노트 행을 클릭해 큰 프리뷰가 막 열린 직후, 디코드가
   *  끝나면 이 인덱스로 1회 자동 시크하고 onInitialFrameConsumed 로 클리어.
   *  (영상의 initialSeekSec 와 같은 패턴 — pendingFrameIndex.) */
  initialFrameIndex?: number | null;
  onInitialFrameConsumed?: () => void;
  /** Phase 4 — 부모가 보유한 timestamp_notes 전체. RegionOverlay 가 현재
   *  frameIndex 와 같은 region 노트만 그리는 데 사용한다. 미전달이면
   *  region 오버레이는 빈 상태로 동작(=새 region 만 그릴 수 있음). */
  notes?: TimestampNote[];
  /** Phase 4 — region 노트 편집/삭제. 미전달이면 popover 의 해당 액션 disabled.
   *  Inspector 의 onEdit/onDelete 와 동일 시그니처를 그대로 forward 받는다. */
  onEditTimestampNote?: (noteId: string, text: string) => void;
  onDeleteTimestampNote?: (noteId: string) => void;
  /** 인스펙터 영역 노트 클릭으로 진입 시 잠깐 강조할 노트 id. initialFrameIndex
   *  로 그 노트의 프레임으로 점프된 직후 RegionOverlay 가 해당 박스를
   *  하이라이트한다(image/video 와 동일 UX). */
  highlightNoteId?: string | null;
}

export function GifFramePlayer({
  src,
  mimeType,
  posterUrl,
  playbackRate,
  onPlaybackRateChange,
  onUnsupported,
  onAddTimestampNote,
  onSetCoverFromCanvas,
  onSaveFrameFromCanvas,
  saving = false,
  initialFrameIndex,
  onInitialFrameConsumed,
  notes,
  onEditTimestampNote,
  onDeleteTimestampNote,
  highlightNoteId,
}: GifFramePlayerProps) {
  const t = useT();
  const { status, frames, durationsMs, naturalSize, error } = useGifFrames(src, mimeType);

  /* RegionOverlay 의 좌표 측정 단일 진실원 — 캔버스의 letterbox 박스를
     그대로 덮어 region 이 캔버스 영역 안에서만 그려지게 한다. canvasRef
     자체를 넘기지 않는 이유: 캔버스의 internal bitmap (canvas.width/height)
     이 자연 해상도라 RegionOverlay 가 client 픽셀로 측정해야 하는데,
     canvas element 의 clientWidth/Height 도 객체로 잡힐 수 있지만 wrapper
     div 가 더 안정적이다(캔버스 mount/unmount race 없음). */
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  /* 구간 Loop — 비디오의 LibraryPreviewPanel 과 동일한 in/out 두 점 사이 자동
     반복 재생. Repeat 버튼을 한 번 누르면 양 끝(0 → last frame) 에 핸들이
     활성화되고 사용자가 드래그해 좁힌다. 다시 누르면 해제.
       loopStart === null && loopEnd === null → 일반 재생 (마지막 프레임 도달
       시 0 으로 wrap-around 무한 반복). GIF 의 자연스러운 기본 동작을 살려
       사용자가 명시적으로 Pause 를 누르기 전까지 계속 돌게 한다 — Repeat 은
       *구간* 반복 (특정 in/out 사이만) 으로만 의미를 가진다. */
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [loopDragMode, setLoopDragMode] = useState<"start" | "end" | null>(null);
  /* Region drawing 토글 — ON 이면 캔버스 위에 RegionOverlay 가 pointer
     events 를 캡처해 crosshair 드래그로 새 region 을 만든다. 토글 OFF
     상태에서는 기존 region 박스만 인터랙티브(hover/click 편집).
     자료가 바뀌면 자동으로 OFF — 이전 자료의 모드가 새 자료에 새지 않게. */
  const [regionMode, setRegionMode] = useState(false);

  /* Add Note 다이얼로그 — 영상의 noteDialogOpen / Text / At 와 동일 구조.
     dialogFrameIndex 는 다이얼로그를 *열던 시점* 의 currentFrame 을 잠가둠
     (사용자가 입력 중에 frame 이 자동 재생으로 흘러도 노트는 열린 시점에
     박힘). text 입력 후 Save → onAddTimestampNote(text, dialogFrameIndex). */
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteDialogFrame, setNoteDialogFrame] = useState(0);
  const [noteDialogText, setNoteDialogText] = useState("");

  /* 재생 타이머 ref. setState 와 분리해 cleanup 시 race-free 하게 취소 가능. */
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 최신 isPlaying / currentFrame / durationsMs / playbackRate 를 ref 로
     보유해 setTimeout 콜백이 *생성 시점의 stale 값* 으로 동작하지 않게 한다.
     deps 배열에 모두 넣고 timer 를 매번 재설정해도 되지만, currentFrame 이
     매 프레임 갱신되므로 effect re-run 비용이 누적. ref 동기화가 더 깔끔. */
  const playingRef = useRef(isPlaying);
  const currentFrameRef = useRef(currentFrame);
  const durationsRef = useRef(durationsMs);
  const rateRef = useRef(Number(playbackRate) || 1);
  /* loop 구간을 재생 tick 에서 enforce 하기 위한 ref. setState 변경이 매번
     timer effect 를 재생성하지 않도록 ref 동기화. */
  const loopStartRef = useRef<number | null>(loopStart);
  const loopEndRef = useRef<number | null>(loopEnd);
  const framesLengthRef = useRef(frames.length);

  useEffect(() => { playingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);
  useEffect(() => { durationsRef.current = durationsMs; }, [durationsMs]);
  useEffect(() => { rateRef.current = Number(playbackRate) || 1; }, [playbackRate]);
  useEffect(() => { loopStartRef.current = loopStart; }, [loopStart]);
  useEffect(() => { loopEndRef.current = loopEnd; }, [loopEnd]);
  useEffect(() => { framesLengthRef.current = frames.length; }, [frames.length]);

  /* status 가 unsupported / error 면 부모에게 폴백 신호. effect 안에서 1회만
     호출해 무한 루프 방지(부모 콜백이 새 인스턴스라도 onUnsupported deps 미포함). */
  useEffect(() => {
    if (status === "unsupported" || status === "error") {
      onUnsupported();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, error]);

  /* src 변경 시 인덱스 / 재생 상태 reset. status=ready 가 새로 들어올 때마다
     처음(0번 프레임)부터 자동재생. note dialog 도 닫음(이전 자료 컨텍스트의
     입력이 새 자료에 박히는 사고 방지). regionMode 도 OFF 로 — 이전 자료에서
     켜둔 토글이 새 자료에서 갑자기 crosshair 로 보이지 않게. */
  useEffect(() => {
    setCurrentFrame(0);
    setIsPlaying(true);
    setNoteDialogOpen(false);
    setNoteDialogText("");
    setRegionMode(false);
    setLoopStart(null);
    setLoopEnd(null);
    setLoopDragMode(null);
  }, [src]);

  /* Inspector → Big Preview → 특정 프레임으로 1회 자동 점프. status=ready
     이전엔 frames.length 가 0 이라 무의미하므로 ready 시점에 트리거. 영상의
     initialSeekSec 와 동일 패턴. */
  useEffect(() => {
    if (status !== "ready") return;
    if (initialFrameIndex == null || !Number.isFinite(initialFrameIndex)) return;
    const max = Math.max(0, frames.length - 1);
    const target = Math.max(0, Math.min(max, Math.floor(initialFrameIndex)));
    setIsPlaying(false);
    setCurrentFrame(target);
    onInitialFrameConsumed?.();
    // initialFrameIndex 가 매번 새 ref 인 경우(같은 값) 재진입을 막기 위해
    // onInitialFrameConsumed 가 부모에서 즉시 null 로 클리어하는 것에 의존.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, initialFrameIndex]);

  /* 매 프레임 캔버스에 그림. status=ready 이전엔 frames[0] 가 없어 no-op.
     캔버스의 internal bitmap 크기는 naturalSize 로 1회 세팅하고, currentFrame
     변경 때는 drawImage 만 다시 호출. */
  useEffect(() => {
    if (status !== "ready") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = frames[currentFrame];
    if (!frame) return;
    if (naturalSize) {
      if (canvas.width !== naturalSize.w) canvas.width = naturalSize.w;
      if (canvas.height !== naturalSize.h) canvas.height = naturalSize.h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    } catch {
      /* 프레임이 close 된 직후 race — 다음 effect cycle 에서 다시 그려짐. */
    }
  }, [status, frames, currentFrame, naturalSize]);

  /* 재생 루프 — setTimeout 체인. requestAnimationFrame 이 아니라 ms 정밀도가
     필요한 이유: GIF 프레임의 정확한 표시 시간(예: 33ms / 50ms / 100ms) 이
     재생 속도 변경(0.25x ~ 8x)과 곱해져야 하므로, RAF (16.67ms 고정 tick) 로는
     배속이 부정확. 한 setTimeout 가 끝나면 다음 프레임 인덱스로 이동 + 다음
     setTimeout 예약. 일시정지/단일프레임/언마운트 시 clearTimeout. */
  useEffect(() => {
    if (status !== "ready") return;
    if (frames.length <= 1) return;

    const tick = () => {
      if (!playingRef.current) return;
      const len = framesLengthRef.current;
      if (len <= 0) return;
      const cur = currentFrameRef.current;
      const next = cur + 1;
      const lStart = loopStartRef.current;
      const lEnd = loopEndRef.current;
      const loopActive = lStart !== null && lEnd !== null;

      /* 구간 loop ON: next 가 loopEnd 를 넘어가면 loopStart 로 되돌림.
         loopStart..loopEnd 가 같은 프레임이거나 매우 가까워도 무한 점프가
         안 나도록 schedule 만 호출. */
      if (loopActive && next > (lEnd as number)) {
        const target = lStart as number;
        setCurrentFrame(target);
        schedule(durationsRef.current[target] ?? 100);
        return;
      }

      if (next >= len) {
        /* 구간 loop OFF + 마지막 프레임 도달 → wrap-around 으로 0 프레임으로
           되돌아가 무한 반복 재생. GIF 의 자연스러운 기본 동작 — 사용자가
           Pause 를 명시적으로 누르기 전까지는 계속 돌게 한다. 정지 후 Play
           를 다시 눌렀을 때 currentFrame 이 마지막에 박혀 있어 즉시 멈추던
           이슈도 이 wrap-around 으로 같이 해결됨. */
        setCurrentFrame(0);
        schedule(durationsRef.current[0] ?? 100);
        return;
      }
      setCurrentFrame(next);
      schedule(durationsRef.current[next] ?? 100);
    };

    const schedule = (ms: number) => {
      const rate = rateRef.current > 0 ? rateRef.current : 1;
      const delay = Math.max(1, ms / rate);
      playTimerRef.current = setTimeout(tick, delay);
    };

    if (isPlaying) {
      schedule(durationsMs[currentFrame] ?? 100);
    }

    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
    // currentFrame / durationsMs / playbackRate 는 ref 로 follow 하므로 deps 에
    // 넣지 않는다(매 프레임 effect 재생성 비용 회피). isPlaying 토글과 src 단위
    // (frames length 변경) 만으로 timer 를 재시작.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isPlaying, frames.length]);

  /* loop 구간이 켜져 있을 때 currentFrame 이 범위 밖이면 loopStart 로 클램프.
     사용자가 핸들을 드래그해 currentFrame 보다 작은 위치로 loopEnd 를 옮기거나
     loopStart 를 늦은 위치로 옮긴 직후를 처리. 비디오의 timeupdate 클램프와
     동일 의도. */
  useEffect(() => {
    if (loopStart === null || loopEnd === null) return;
    if (currentFrame < loopStart || currentFrame > loopEnd) {
      setCurrentFrame(loopStart);
    }
  }, [currentFrame, loopStart, loopEnd]);

  const togglePlay = useCallback(() => {
    if (status !== "ready" || frames.length <= 1) return;
    setIsPlaying((p) => !p);
  }, [status, frames.length]);

  const stepPrev = useCallback(() => {
    setIsPlaying(false);
    setCurrentFrame((idx) => Math.max(0, idx - 1));
  }, []);
  const stepNext = useCallback(() => {
    setIsPlaying(false);
    setCurrentFrame((idx) => Math.min(framesLengthRef.current - 1, idx + 1));
  }, []);

  /* 루프 토글 — 비활성 → 양 끝(0 ~ last frame) 에 핸들을 띄워 곧바로 드래그
     로 좁힐 수 있게 한다. 활성 → 해제. frames.length ≤ 1 이면 토글 무시.
     비디오 LibraryPreviewPanel.cycleLoop 와 동일 흐름. */
  const cycleLoop = useCallback(() => {
    if (status !== "ready" || frames.length <= 1) return;
    if (loopStart !== null || loopEnd !== null) {
      setLoopStart(null);
      setLoopEnd(null);
      return;
    }
    setLoopStart(0);
    setLoopEnd(frames.length - 1);
  }, [status, frames.length, loopStart, loopEnd]);

  /* 루프 핸들 드래그 시작 — 트랙 시크와 충돌하지 않도록 stopPropagation.
     실제 좌표 계산은 GifTimelineTrack 내부 window mousemove 가 담당. */
  const handleLoopHandleMouseDown = useCallback(
    (which: "start" | "end") => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setLoopDragMode(which);
    },
    [],
  );

  /* 루프 핸들 드래그 처리 — 비디오의 동일한 effect 와 같은 구조. trackRef 는
     GifTimelineTrack 내부에 있어야 폭/좌표를 알 수 있으므로, 트랙 컴포넌트에
     drag mode 와 setter 를 prop 으로 넘기고 거기서 window listener 를 건다.
     여기서는 단순히 드래그 종료(mouseup) 만 처리하면 되지만, 일관성을 위해
     모든 좌표 변환을 GifTimelineTrack 으로 위임한다. */

  /* Add Note 다이얼로그 — 영상의 openNoteDialog 와 동일한 UX. 일시정지 후
     현재 프레임 인덱스를 잠그고 다이얼로그 오픈. 부모가 onAddTimestampNote
     를 안 넣어주면 호출 자체가 일어나지 않으므로 가드 불필요. */
  const openNoteDialog = useCallback(() => {
    if (!onAddTimestampNote) return;
    setIsPlaying(false);
    setNoteDialogFrame(currentFrameRef.current);
    setNoteDialogText("");
    setNoteDialogOpen(true);
  }, [onAddTimestampNote]);

  const handleSaveNote = useCallback(() => {
    const trimmed = noteDialogText.trim();
    if (!trimmed || !onAddTimestampNote) return;
    onAddTimestampNote(trimmed, noteDialogFrame);
    setNoteDialogOpen(false);
  }, [noteDialogFrame, noteDialogText, onAddTimestampNote]);

  /* 단축키 — 비디오 LibraryPreviewPanel 의 매핑과 동일 구조로 통일.
       - Space          : play/pause
       - d / ArrowLeft  : prev frame (한 프레임 뒤로)
       - f / ArrowRight : next frame (한 프레임 앞으로)
       - l              : 구간 loop 토글 (cycleLoop 와 동일)
       - [ / ]          : loop 활성 시 *현재 프레임* 을 loop in / out 으로 지정.
                          loop 비활성 시에는 무시 — 사용자는 먼저 'l' 로 활성화 후 사용.
       - r              : Region(BoxSelect) 모드 토글
       - n              : 메모(노트) 다이얼로그 열기
       - Ctrl/Cmd + ArrowUp / ArrowDown : 재생 속도 한 단계 ↑ / ↓
                          (PLAYBACK_RATE_OPTIONS 배열의 인접 값으로 이동)
     INPUT/TEXTAREA/contenteditable 포커스 시 무시. capture 단계로 등록해 다른
     핸들러가 먼저 가로채지 않게. ArrowLeft/Right 는 d/f 의 보조 단축키 — 기존
     사용자 기억과의 호환을 위해 유지. */
  useEffect(() => {
    if (status !== "ready") return;
    if (frames.length <= 1) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.altKey) return;

      /* Ctrl/Cmd + ArrowUp/Down → 재생 속도 조절. 그 외 Ctrl 조합은 OS /
         LibraryPage 단축키 영역이라 통째로 무시. */
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const cur = rateRef.current || 1;
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

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        setIsPlaying((p) => !p);
      } else if (event.key === "ArrowLeft" || event.key === "d" || event.key === "D") {
        event.preventDefault();
        setIsPlaying(false);
        setCurrentFrame((idx) => Math.max(0, idx - 1));
      } else if (event.key === "ArrowRight" || event.key === "f" || event.key === "F") {
        event.preventDefault();
        setIsPlaying(false);
        setCurrentFrame((idx) => Math.min(framesLengthRef.current - 1, idx + 1));
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        cycleLoop();
      } else if (event.key === "[") {
        /* loop 활성 시에만 동작. 현재 프레임을 loopStart 로 — loopEnd 와의
           최소 1 프레임 간격을 보장. */
        const lStart = loopStartRef.current;
        const lEnd = loopEndRef.current;
        if (lStart === null || lEnd === null) return;
        event.preventDefault();
        const cur = currentFrameRef.current;
        const MIN_GAP = 1;
        const upper = Math.max(0, lEnd - MIN_GAP);
        setLoopStart(Math.max(0, Math.min(cur, upper)));
      } else if (event.key === "]") {
        const lStart = loopStartRef.current;
        const lEnd = loopEndRef.current;
        if (lStart === null || lEnd === null) return;
        event.preventDefault();
        const cur = currentFrameRef.current;
        const denom = Math.max(0, framesLengthRef.current - 1);
        const MIN_GAP = 1;
        const lower = Math.min(denom, lStart + MIN_GAP);
        setLoopEnd(Math.min(denom, Math.max(cur, lower)));
      } else if (event.key === "r" || event.key === "R") {
        /* onAddTimestampNote 가 미전달이면 RegionOverlay 자체가 마운트되지
           않으므로 토글해도 보이지 않지만, 부모가 콜백을 안 넘기는 분기에서
           단축키만 켜진 채 토글 state 가 변하는 건 의미가 없으므로 가드. */
        if (!onAddTimestampNote) return;
        event.preventDefault();
        setRegionMode((v) => !v);
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        openNoteDialog();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status, frames.length, cycleLoop, openNoteDialog, onAddTimestampNote, onPlaybackRateChange]);

  /* Set Cover / Save Frame — 자체 캔버스 그대로 인자로 전달. 일시정지 후
     호출해 사용자가 "방금 본" 프레임이 정확히 캡처됨을 보장. */
  const handleSetCover = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onSetCoverFromCanvas) return;
    setIsPlaying(false);
    onSetCoverFromCanvas(canvas, currentFrameRef.current);
  }, [onSetCoverFromCanvas]);

  const handleSaveFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onSaveFrameFromCanvas) return;
    setIsPlaying(false);
    onSaveFrameFromCanvas(canvas, currentFrameRef.current);
  }, [onSaveFrameFromCanvas]);

  /* RegionOverlay 가 새 region 을 저장할 때 호출 — 부모 LibraryPage 의
     handleAddTimestampNote 에 region + frameIndex(현재) 를 함께 넘긴다.
     onAddTimestampNote 가 미전달이면 RegionOverlay 자체가 마운트되지
     않으므로 가드는 단순. */
  const handleRegionCreate = useCallback(
    (region: RegionRect, text: string) => {
      onAddTimestampNote?.(text, currentFrameRef.current, region);
    },
    [onAddTimestampNote],
  );

  /* RegionOverlay 가 새 region 의 popover 를 닫을 때(Save/Cancel 양쪽) 자동
     으로 regionMode 를 OFF 로 — Eagle 의 단발 드로잉 UX 와 동일. 사용자가
     연속으로 박스를 그리고 싶으면 토글을 다시 켜면 된다. */
  const handleAfterRegion = useCallback(() => {
    setRegionMode(false);
  }, []);

  /* RegionOverlay 가 드래그를 시작하는 순간 GIF 를 일시정지 — 사용자가
     "방금 본" 프레임 위에 박스를 그리는 것이 자연스럽다. */
  const handleRegionDrawStart = useCallback(() => {
    setIsPlaying(false);
  }, []);

  /* 현재 프레임에 anchor 된 region 노트만 RegionOverlay 에 넘긴다. notes 가
     미전달이면 빈 배열 — RegionOverlay 는 새 region 그리기만 가능. region 이
     없는 노트(시점-only frame note)는 자연스레 제외.
     재생 중에는 region 박스를 숨겨 GIF/애니메이션 감상을 방해하지 않게 한다.
     사용자가 박스를 보고 싶을 땐 pause 해서 정지화면 위에서 확인. drawing
     시작 시 handleRegionDrawStart 가 자동 pause 시키므로 새 박스 그리기에는
     영향 없음. */
  const visibleRegionNotes = useMemo(() => {
    if (!notes || notes.length === 0) return [];
    if (isPlaying) return [];
    return notes.filter((note) => note.region && note.frameIndex === currentFrame);
  }, [notes, currentFrame, isPlaying]);

  const isSingleFrame = status === "ready" && frames.length <= 1;
  const showControls = status === "ready" && frames.length > 1;
  /* 단일 프레임 자료에서도 Set Cover / Save Frame 은 의미가 있으므로,
     컨트롤 바 자체는 frames.length>1 일 때만 보이지만 액션 버튼 그룹은
     status=ready 면 노출. 단일 프레임의 경우 컨트롤 바가 숨어있어 액션 행도
     자연히 함께 숨음(별도 분기 필요 없음). */

  /* aspect ratio 계산 — 캔버스 CSS 크기는 부모(검정 배경 컨테이너) 의 fit
     영역 안에서 object-contain 처럼 letterbox. naturalSize 가 알려진 경우
     `aspect-ratio` 로 비율 보존하고 max-w/max-h 100% 로 가둔다. */
  const aspectStyle = useMemo(() => {
    if (!naturalSize) return undefined;
    return { aspectRatio: `${naturalSize.w} / ${naturalSize.h}` } as const;
  }, [naturalSize]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {/* 디코드 중: 정적 poster 를 깔고 중앙에 스피너. canvas 는 같은
            자리에 mount 해두지만 status<ready 일 땐 그릴 게 없어 빈 상태. */}
        {status === "loading" && posterUrl ? (
          <img
            src={posterUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-contain opacity-70"
            draggable={false}
          />
        ) : null}

        {/* canvas 와 그 위 RegionOverlay 를 같은 wrapper 로 묶는다 — wrapper
            의 client 박스가 정확히 캔버스 letterbox 박스와 동일하도록 width/
            height 을 캔버스에 맞춰 흐르게 한다. wrapper 가 따로 필요한 이유:
            RegionOverlay 가 absolute inset-0 으로 덮으려면 *relative parent*
            가 캔버스와 같은 크기여야 하는데, 검정 배경 컨테이너(flex item-
            center)는 캔버스보다 클 수 있어 region 좌표가 어긋난다. wrapper
            를 inline-block + max 제약으로 캔버스 박스 그대로 잡는다. */}
        {status === "ready" ? (
          <div
            ref={canvasWrapRef}
            className="relative inline-block max-h-full max-w-full"
            style={aspectStyle}
          >
            <canvas
              ref={canvasRef}
              onClick={togglePlay}
              className={cn(
                "block h-full w-full",
                isSingleFrame ? "cursor-default" : "cursor-pointer",
              )}
            />
            {/* Region 오버레이 — 부모(wrapper) 가 정확히 캔버스 박스이므로
                inset-0 가 자연스러운 좌표 기준이 된다. region 모드 ON 이면
                pointer events 를 잡아 새 박스 드래그, OFF 이면 기존 region
                만 hover/click 으로 인터랙션. onAddTimestampNote 가 없으면
                새 region 을 저장할 길이 없으므로 오버레이 자체를 마운트
                안 함(메모리/이벤트 비용 0). */}
            {onAddTimestampNote ? (
              <RegionOverlay
                containerRef={canvasWrapRef}
                naturalWidth={naturalSize?.w ?? null}
                naturalHeight={naturalSize?.h ?? null}
                visibleNotes={visibleRegionNotes}
                drawing={regionMode}
                onCreateRegion={handleRegionCreate}
                onAfterCreate={handleAfterRegion}
                onDrawStart={handleRegionDrawStart}
                onDeleteRegion={onDeleteTimestampNote}
                onEditRegion={onEditTimestampNote}
                highlightNoteId={highlightNoteId}
              />
            ) : null}
          </div>
        ) : null}

        {status === "loading" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 bg-black/55 px-3 py-1.5 text-caption text-white">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Decoding frames…
            </div>
          </div>
        ) : null}
      </div>

      {/* 커스텀 timeline — 영상의 LibraryPreviewPanel timeline 과 동일한 외관/
          상호작용으로 통일.
            - 트랙: bg-muted/40 h-2 hover:h-3
            - 진행 fill: bg-primary/60, width = currentFrame/(N-1) * 100%
            - 노트 마커: bg-primary 3px 막대, region 은 상단 cap 으로 구분
            - 현재 시점 thumb: h-4 w-[2px] bg-foreground
          이전엔 native <input type="range"> 위에 마커를 % 로 덧대 그렸는데,
          브라우저별 thumb inset 때문에 마커 위치와 thumb 동선이 미세하게
          어긋났다. 동일 좌표계(부모 div 의 100%)에서 fill/marker/thumb 를
          그리면서 정렬 어긋남 자체가 사라진다. */}
      {showControls && frames.length > 1 ? (
        <div className="mt-2 px-1">
          <GifTimelineTrack
            currentFrame={currentFrame}
            frameCount={frames.length}
            notes={notes}
            onSeek={(frameIndex) => {
              setIsPlaying(false);
              setCurrentFrame(frameIndex);
            }}
            loopStart={loopStart}
            loopEnd={loopEnd}
            loopDragMode={loopDragMode}
            onLoopHandleMouseDown={handleLoopHandleMouseDown}
            setLoopStart={setLoopStart}
            setLoopEnd={setLoopEnd}
            setLoopDragMode={setLoopDragMode}
          />
        </div>
      ) : null}

      {showControls ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={togglePlay}
            title={isPlaying ? t("gif.pauseTitle") : t("gif.playTitle")}
            aria-label={isPlaying ? t("library.preview.pause") : t("library.preview.play")}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {currentFrame + 1} / {frames.length}
          </span>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={stepPrev}
            title={t("gif.prevFrameTitle")}
            aria-label={t("gif.prevFrameAria")}
            disabled={currentFrame <= 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            style={{ borderRadius: 0 }}
            onClick={stepNext}
            title={t("gif.nextFrameTitle")}
            aria-label={t("gif.nextFrameAria")}
            disabled={currentFrame >= frames.length - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

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
              (loopStart !== null || loopEnd !== null) && "border-foreground/40 bg-foreground/15 text-foreground",
            )}
            style={{ borderRadius: 0 }}
            onClick={cycleLoop}
            title={
              loopStart !== null || loopEnd !== null
                ? t("gif.loopOnTitle")
                : t("gif.loopOffTitle")
            }
            aria-label={t("gif.loopAria")}
            aria-pressed={loopStart !== null || loopEnd !== null}
          >
            <Repeat className="h-3.5 w-3.5" />
          </Button>

          {/* GIF 액션 — 영상의 NotebookPen / Set Cover / Save Frame 과 같은
              아이콘 묶음. 부모가 콜백을 안 넘기면 해당 버튼은 노출하지 않아
              빈 자리가 생기지 않게 한다.
              Phase 4 — Region 토글이 액션 그룹 맨 앞에 위치. ON 이면 캔버스
              위에 crosshair 가 뜨고 드래그로 영역을 그려 코멘트 추가. */}
          {onAddTimestampNote ? (
            <Button
              variant="outline"
              className={cn(
                "h-8 w-8 p-0",
                regionMode && "border-primary/40 bg-primary/15 text-primary",
              )}
              style={{ borderRadius: 0 }}
              onClick={() => setRegionMode((v) => !v)}
              title={regionMode ? t("gif.regionOnTitle") : t("gif.regionIdleTitle")}
              aria-label={t("gif.regionAria")}
              aria-pressed={regionMode}
            >
              <BoxSelect className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {onAddTimestampNote ? (
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              style={{ borderRadius: 0 }}
              onClick={openNoteDialog}
              title={t("gif.addNoteAtFrame", { n: currentFrame + 1 })}
              aria-label={t("gif.addNoteAria")}
            >
              <NotebookPen className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {onSetCoverFromCanvas ? (
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              style={{ borderRadius: 0 }}
              onClick={handleSetCover}
              disabled={saving}
              title={t("library.preview.setCoverTitle")}
              aria-label={t("library.preview.setCover")}
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {onSaveFrameFromCanvas ? (
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              style={{ borderRadius: 0 }}
              onClick={handleSaveFrame}
              disabled={saving}
              title={t("library.preview.saveFrameTitle")}
              aria-label={t("library.preview.saveFrame")}
            >
              <Camera className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Add Note 다이얼로그 — 영상의 큰 프리뷰 다이얼로그와 동일한 시각.
          시점 prefix 자리에 "frame N/M" 표시. */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("gif.addNoteTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <span className="font-mono text-meta text-primary">
              {t("gif.frameOfTotal", { current: noteDialogFrame + 1, total: frames.length })}
            </span>
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
              placeholder={t("gif.notePlaceholder")}
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
    </div>
  );
}

/* 비디오 timeline 과 동일한 외관/상호작용으로 구성한 GIF 전용 트랙.
 *
 * 비디오와 다른 점:
 *   - 좌표 단위가 "시간(초)" 이 아닌 "프레임 인덱스" — duration_ms 가 균일치
 *     않은 GIF 의 경우 시점이 아닌 *인덱스* 가 정확한 anchor.
 *   - 노트는 frameIndex anchor 로 저장되므로 marker 위치도 동일하게
 *     frameIndex/(frameCount-1) 로 계산.
 *
 * 트랙 영역(부모 wrapper) 전체가 같은 100% 좌표계를 공유하므로 fill / marker /
 * thumb 모두 자연스럽게 정렬된다. */
interface GifTimelineTrackProps {
  currentFrame: number;
  frameCount: number;
  notes?: TimestampNote[];
  onSeek: (frameIndex: number) => void;
  /* 구간 Loop — null 이면 비활성. 비디오 LibraryPreviewPanel 의 sky 색 band /
     핸들과 동일한 시각/상호작용을 frameIndex 좌표계로 구현한다. */
  loopStart: number | null;
  loopEnd: number | null;
  loopDragMode: "start" | "end" | null;
  onLoopHandleMouseDown: (which: "start" | "end") => (event: ReactMouseEvent<HTMLDivElement>) => void;
  setLoopStart: (next: number | null | ((prev: number | null) => number | null)) => void;
  setLoopEnd: (next: number | null | ((prev: number | null) => number | null)) => void;
  setLoopDragMode: (next: "start" | "end" | null) => void;
}

function GifTimelineTrack({
  currentFrame,
  frameCount,
  notes,
  onSeek,
  loopStart,
  loopEnd,
  loopDragMode,
  onLoopHandleMouseDown,
  setLoopStart,
  setLoopEnd,
  setLoopDragMode,
}: GifTimelineTrackProps) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const denom = Math.max(1, frameCount - 1);
  const currentPct = (currentFrame / denom) * 100;
  const loopActive = loopStart !== null && loopEnd !== null;

  /* 클릭/드래그 → 프레임 시크. clientX 를 트랙 폭에 대한 비율로 환산해
     반올림한 인덱스로 점프. mousedown 후 mousemove 도 같은 로직으로 처리해
     비디오와 같은 "드래그 스크럽" 인터랙션 제공. */
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const idx = Math.round(pct * denom);
      onSeek(idx);
    },
    [denom, onSeek],
  );

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      seekFromClientX(event.clientX);
      const handleMove = (e: MouseEvent) => seekFromClientX(e.clientX);
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [seekFromClientX],
  );

  /* 루프 핸들 드래그 처리 — 비디오 LibraryPreviewPanel 의 동일한 effect 와
     같은 구조. setLoopDragMode("start" | "end") 가 켜져 있는 동안 window
     mousemove 가 clientX → frameIndex 로 변환해 setLoopStart/End 갱신.
     mouseup 에 dragMode 해제. */
  useEffect(() => {
    if (!loopDragMode) return;
    const onMove = (event: MouseEvent) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const idx = Math.round(pct * denom);
      /* 핸들끼리 같은 프레임으로 겹치면 loop 가 무의미해지므로 최소 1 프레임
         간격을 강제. */
      const MIN_GAP = 1;
      if (loopDragMode === "start") {
        setLoopStart((prev) => {
          const upper = loopEnd !== null ? Math.max(0, loopEnd - MIN_GAP) : denom;
          const next = Math.max(0, Math.min(idx, upper));
          return Number.isFinite(next) ? next : prev ?? 0;
        });
      } else {
        setLoopEnd((prev) => {
          const lower = loopStart !== null ? Math.min(denom, loopStart + MIN_GAP) : 0;
          const next = Math.min(denom, Math.max(idx, lower));
          return Number.isFinite(next) ? next : prev ?? denom;
        });
      }
    };
    const onUp = () => setLoopDragMode(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [loopDragMode, loopStart, loopEnd, denom, setLoopStart, setLoopEnd, setLoopDragMode]);

  const loopStartPct = loopActive ? ((loopStart as number) / denom) * 100 : 0;
  const loopEndPct = loopActive ? ((loopEnd as number) / denom) * 100 : 0;

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={t("gif.framePositionAria")}
      aria-valuemin={0}
      aria-valuemax={denom}
      aria-valuenow={currentFrame}
      className={cn(
        "group/timeline relative h-2 w-full cursor-pointer bg-muted/40 transition-[height] hover:h-3",
        /* 루프 드래그 중에는 트랙을 더 크게 — 비디오와 동일. */
        loopActive && "h-3",
        loopDragMode && "h-3",
      )}
      onMouseDown={handleMouseDown}
    >
      {/* hit-area 확장 — 8px 가량 빗나가도 클릭이 인식되게 트랙 상하로 투명한
          자식 박스를 깐다. 자식이라 모든 mouse event 가 트랙으로 bubble 돼
          동일 핸들러로 처리됨. */}
      <div className="absolute inset-x-0 -top-2 -bottom-2" aria-hidden />

      {/* 진행 fill — 현재 프레임까지의 영역. */}
      <div
        className="pointer-events-none absolute top-0 h-full bg-primary/60"
        style={{ width: `${currentPct}%` }}
      />

      {/* 루프 band — 비디오와 동일하게 *중립 흰색 톤*. loop start 부터 end 까지
          반투명 색칠. pointer-events-none 으로 트랙 시크 클릭은 그대로 통과.
          Eagle reference 라이브러리와 같은 톤으로 통일해 채도가 강한 sky 색이
          영상 콘텐츠 위로 튀어 보이던 어색함 제거. */}
      {loopActive ? (
        <div
          className="pointer-events-none absolute top-0 h-full bg-foreground/30"
          style={{
            left: `${loopStartPct}%`,
            width: `${Math.max(0, loopEndPct - loopStartPct)}%`,
          }}
        />
      ) : null}

      {/* frame note 마커. */}
      {notes
        ?.filter((note) => note.frameIndex !== undefined && note.frameIndex >= 0 && note.frameIndex < frameCount)
        .map((note) => {
          const leftPct = ((note.frameIndex as number) / denom) * 100;
          const isRegion = Boolean(note.region);
          return (
            <button
              key={note.id}
              type="button"
              className={cn(
                "absolute top-0 h-full w-[3px] bg-primary transition-transform hover:scale-y-[2.4]",
                /* region anchored 는 상단 cap 으로 시점-only 와 구분. */
                isRegion && "before:absolute before:-top-1 before:left-1/2 before:h-1 before:w-2 before:-translate-x-1/2 before:bg-primary",
              )}
              style={{ left: `${leftPct}%`, transform: "translateX(-1.5px)" }}
              title={`#${(note.frameIndex as number) + 1}${isRegion ? ` · ${t("library.preview.region")}` : ""} — ${note.text}`}
              onClick={(event) => {
                event.stopPropagation();
                onSeek(note.frameIndex as number);
              }}
              onMouseDown={(event) => event.stopPropagation()}
            />
          );
        })}

      {/* 루프 핸들 (in/out) — 비디오와 동일한 *흰색* 세로 막대. 트랙 위로
          살짝 튀어나와 hit-area 가 노트 마커와 겹쳐도 잡기 쉽게 위에 깐다. */}
      {loopActive ? (
        <>
          <div
            role="slider"
            aria-label={t("library.preview.loopStartAria")}
            aria-valuemin={0}
            aria-valuemax={denom}
            aria-valuenow={loopStart as number}
            className="absolute -top-1 z-10 h-[calc(100%+0.5rem)] w-[3px] cursor-ew-resize bg-foreground"
            style={{ left: `${loopStartPct}%`, transform: "translateX(-1.5px)" }}
            onMouseDown={onLoopHandleMouseDown("start")}
            title={t("gif.loopInTitle", { n: (loopStart as number) + 1 })}
          />
          <div
            role="slider"
            aria-label={t("library.preview.loopEndAria")}
            aria-valuemin={0}
            aria-valuemax={denom}
            aria-valuenow={loopEnd as number}
            className="absolute -top-1 z-10 h-[calc(100%+0.5rem)] w-[3px] cursor-ew-resize bg-foreground"
            style={{ left: `${loopEndPct}%`, transform: "translateX(-1.5px)" }}
            onMouseDown={onLoopHandleMouseDown("end")}
            title={t("gif.loopOutTitle", { n: (loopEnd as number) + 1 })}
          />
        </>
      ) : null}

      {/* 현재 프레임 thumb — 비디오와 동일한 형태. */}
      <span
        className="pointer-events-none absolute top-1/2 h-4 w-[2px] bg-foreground"
        style={{ left: `${currentPct}%`, transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}
