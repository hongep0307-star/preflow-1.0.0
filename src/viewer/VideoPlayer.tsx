import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  FastForward,
  Maximize,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Rewind,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RegionView } from "./RegionView";
import { ShortcutsPopover } from "./ShortcutsPopover";
import { ViewerSelect } from "./ViewerSelect";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem, TimestampNote } from "./types";

/* Read-only 영상 플레이어.
 *
 * 메인 앱 LibraryPreviewPanel 의 영상 분기를 핵심만 추려 옮긴 것.
 * 차이:
 *   - "Save Frame / Set Cover / Save Loop as GIF / Add Note" 같은 *쓰기*
 *     액션 없음 (사용자 요구: read-only).
 *   - Loop 는 사용자가 명시적으로 요청 — 토글 한 번에 in/out 양 끝 핸들이
 *     활성화돼 드래그로 좁히는 메인 앱과 동일한 UX 유지.
 *   - 호버 썸네일도 유지 — 마커 사이를 빠르게 훑는 시청 흐름에서 매우 유용.
 *
 * 외부 ref 로 비디오 element 를 노출하지 않고 자체 ref 만 사용 — 메인 앱
 * 처럼 부모가 currentTime 을 직접 조작해야 할 케이스(인스펙터 → seek) 가
 * viewer 에는 없고, NotesPanel 은 onSeekRequest 콜백을 통해 부탁한다. */

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4] as const;
const HOVER_THUMB_MAX_DIM = 280;

interface VideoPlayerProps {
  item: ReferenceItem;
  /** NotesPanel 등 외부가 특정 시각으로 점프 요청. ref 등록 후 사용. */
  registerSeek?: (seek: (sec: number) => void) => void;
  /** NotesPanel 이 시각 노트 active highlight 에 쓸 timeupdate 콜백.
   *  매 timeupdate 마다 호출되므로 부모는 throttle/RAF 자체 처리. */
  onTimeUpdate?: (sec: number) => void;
  /** 툴팁/단축키 라벨 언어 — App 의 언어 토글이 구동. */
  language?: ViewerLang;
}

function formatDuration(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function VideoPlayer({ item, registerSeek, onTimeUpdate, language = "en" }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenWrapRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const volumeTrackRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [videoDuration, setVideoDuration] = useState(0);
  const [mediaNaturalSize, setMediaNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [playbackRate, setPlaybackRate] = useState("1");

  /* Loop in/out — null 이면 비활성. 활성화 시 양 끝(0 ~ duration) 으로
   *  초기화돼 사용자가 드래그로 좁힌다. */
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [loopDragMode, setLoopDragMode] = useState<"start" | "end" | null>(null);
  /* 전체 반복 — 구간 루프와 별개로 클립 전체를 무한 반복(video loop 속성). */
  const [fullLoop, setFullLoop] = useState(false);

  /* 호버 썸네일 — 메인 앱과 동일 패턴(drop-old-seek). */
  const [hoverPreview, setHoverPreview] = useState<{ sec: number; pct: number } | null>(null);
  const hoverTargetRef = useRef<number | null>(null);
  const hoverSeekingRef = useRef(false);

  const isDraggingRef = useRef(false);
  const isDraggingVolumeRef = useRef(false);

  /* item 이 변하면 (모달 안에서 prev/next 가능) 모든 상태 reset. videoRef 의
   *  src 도 React 가 새로 박아주므로 자연스럽게 다시 로드된다. */
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setMediaNaturalSize(null);
    setLoopStart(null);
    setLoopEnd(null);
    setLoopDragMode(null);
    setFullLoop(false);
    setHoverPreview(null);
    hoverTargetRef.current = null;
    hoverSeekingRef.current = false;
  }, [item.id]);

  /* video element 상태를 React 로 sync. */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => {
      setCurrentTime(v.currentTime);
      onTimeUpdate?.(v.currentTime);
    };
    const onVol = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("volumechange", onVol);
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
  }, [item.id, onTimeUpdate]);

  /* External seek API 등록 — NotesPanel 이 noteId 행을 클릭하면 호출. */
  useEffect(() => {
    if (!registerSeek) return;
    registerSeek((sec) => {
      const v = videoRef.current;
      if (!v) return;
      try {
        v.currentTime = sec;
      } catch {
        /* noop */
      }
    });
  }, [registerSeek]);

  /* Loop 강제 — out 도달 시 in 으로 시크. */
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
  }, [loopEnd, loopStart]);

  /* 호버 seek 요청. fastSeek 가 있으면 더 빠른 키프레임 정밀도. */
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

  const totalDuration = videoDuration || item.duration_sec || 0;
  /* 단축키 안내용 시크 수식키 라벨 — Mac 은 Option(⌥), 그 외는 Ctrl. */
  const seekModLabel = useMemo(() => {
    const mac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
    return `${mac ? "\u2325" : "Ctrl"} \u2190/\u2192`;
  }, []);
  const positionToPct = (atSec: number): number => {
    if (!totalDuration) return 0;
    return Math.max(0, Math.min(100, (atSec / totalDuration) * 100));
  };

  const sortedNotes = useMemo(
    () => [...(item.timestamp_notes ?? [])].sort((a, b) => (a.atSec ?? 0) - (b.atSec ?? 0)),
    [item.timestamp_notes],
  );

  /* visibleRegionNotes — 영상은 ±0.15s 윈도우 내의 region 만 표시.
   *  재생 중일 땐 박스를 숨겨 시청 방해 안 함(메인 앱과 동일 정책). */
  const visibleRegionNotes = useMemo(() => {
    if (isPlaying) return [];
    return (item.timestamp_notes ?? []).filter(
      (note) => note.region && Math.abs(currentTime - (note.atSec ?? 0)) < 0.15,
    );
  }, [currentTime, isPlaying, item.timestamp_notes]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  /* ±초 시크 (5초 점프). duration 을 알면 clamp, 모르면 0 하한만. */
  const seekBy = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) ? v.duration : item.duration_sec || 0;
      const next = v.currentTime + delta;
      try {
        v.currentTime = dur > 0 ? Math.max(0, Math.min(dur, next)) : Math.max(0, next);
      } catch {
        /* noop */
      }
    },
    [item.duration_sec],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.muted && v.volume === 0) v.volume = 0.5;
    v.muted = !v.muted;
  }, []);

  const handlePlaybackRateChange = useCallback((rate: string) => {
    setPlaybackRate(rate);
    const v = videoRef.current;
    if (v) v.playbackRate = Number(rate) || 1;
  }, []);

  /* Ctrl/Cmd + ↑/↓ 로 배속 단계 이동 — 메인 앱과 동일. 현재 배속에서 가장
   *  가까운 단계를 찾아 한 칸 위/아래로. */
  const cyclePlaybackRate = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      const cur = v ? v.playbackRate : Number(playbackRate) || 1;
      let idx = PLAYBACK_RATES.findIndex((r) => r === cur);
      if (idx === -1) {
        idx = PLAYBACK_RATES.reduce(
          (best, r, i) =>
            Math.abs(r - cur) < Math.abs(PLAYBACK_RATES[best] - cur) ? i : best,
          0,
        );
      }
      const next = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, idx + dir));
      handlePlaybackRateChange(String(PLAYBACK_RATES[next]));
    },
    [handlePlaybackRateChange, playbackRate],
  );

  const cycleLoop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const duration = videoDuration || (Number.isFinite(v.duration) ? v.duration : 0) || item.duration_sec || 0;
    if (loopStart !== null || loopEnd !== null) {
      setLoopStart(null);
      setLoopEnd(null);
      return;
    }
    if (!duration || duration <= 0) return;
    /* 초기 루프 범위 — 이전엔 [0, duration] 으로 잡아 사실상 "전체 재생" 과
     *  구분이 안 가 "loop 가 안 된다" 는 인상이 컸다. 현재 시각을 중심으로
     *  ±2.5s (총 5s) 짧은 구간으로 잡고, duration 이 더 짧으면 양 끝으로
     *  clamp. 핸들을 드래그하면 그대로 좁힐/늘릴 수 있다. */
    const window = Math.min(5, Math.max(0.4, duration));
    const half = window / 2;
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const start = Math.max(0, Math.min(duration - window, cur - half));
    const end = Math.min(duration, start + window);
    /* 현재 위치를 중심으로 루프 구간만 생성하고 playhead 는 건드리지 않는다.
     *  (이전엔 start 로 시크 + 자동재생을 해 "엉뚱한 곳으로 점프" 하는 문제가
     *  있었음.) 현재 시각이 [start,end] 안에 있어 loop-enforce 도 즉시 점프
     *  하지 않는다. 구간은 [/] 또는 핸들 드래그로 조정. */
    setLoopStart(start);
    setLoopEnd(end);
  }, [item.duration_sec, loopEnd, loopStart, videoDuration]);

  /* Timeline seek 드래그. */
  const seekToClientX = useCallback(
    (clientX: number) => {
      const track = timelineRef.current;
      const v = videoRef.current;
      if (!track || !v || !totalDuration) return;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      try { v.currentTime = pct * totalDuration; } catch { /* noop */ }
    },
    [totalDuration],
  );

  const handleTimelineMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    isDraggingRef.current = true;
    seekToClientX(event.clientX);
  };

  const handleLoopHandleMouseDown =
    (which: "start" | "end") => (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setLoopDragMode(which);
    };

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (isDraggingRef.current) {
        seekToClientX(event.clientX);
        return;
      }
      if (!loopDragMode) return;
      const track = timelineRef.current;
      if (!track || !totalDuration) return;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const t = pct * totalDuration;
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

  const handleTimelineMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!totalDuration) return;
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
    [loopDragMode, requestHoverSeek, totalDuration],
  );

  const handleTimelineMouseLeave = useCallback(() => {
    setHoverPreview(null);
    hoverTargetRef.current = null;
  }, []);

  /* Volume 슬라이더. */
  const setVolumeFromClientX = useCallback((clientX: number) => {
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
  }, []);

  const handleVolumeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      isDraggingVolumeRef.current = true;
      setVolumeFromClientX(event.clientX);
    },
    [setVolumeFromClientX],
  );

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!isDraggingVolumeRef.current) return;
      setVolumeFromClientX(event.clientX);
    };
    const onUp = () => { isDraggingVolumeRef.current = false; };
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

  /* 키보드 단축키 — 메인 앱 LibraryPreviewPanel 과 동일 키맵:
   *   Space 재생/정지 · M 음소거 · D/F 프레임 이동 · L 루프 토글 ·
   *   [/] 루프 in/out 을 현재 시각으로 조정(루프 활성 시) ·
   *   ±5초/±10초 시크는 Mac=Alt+화살표 / Win=Ctrl+화살표(+Shift=10초).
   *   평범한 ←/→ 는 모달의 이전/다음 자료 이동이라 여기서 건드리지 않고
   *   App 핸들러로 흘려보낸다.
   *   capture 단계 등록: 포커스된 버튼이 Space 를 click 으로 가로채는 사고 방지.
   *   deps 에 loop/seek 핸들러를 포함해야 stale 값으로 루프 조정이 깨지지 않는다. */
  useEffect(() => {
    const FRAME_STEP_SEC = 1 / 30;
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const v = videoRef.current;

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const fiveMod = isMac
          ? event.altKey && !event.ctrlKey && !event.metaKey
          : event.ctrlKey && !event.altKey && !event.metaKey;
        const tenMod = event.shiftKey;
        if (fiveMod || tenMod) {
          event.preventDefault();
          const skip = tenMod ? 10 : 5;
          seekBy(event.key === "ArrowLeft" ? -skip : skip);
        }
        /* 수식키 없는 ←/→ 는 App 의 자료 이동으로 전파(preventDefault 안 함). */
        return;
      }

      /* Ctrl/Cmd + ↑/↓ → 배속 단계 이동. */
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        cyclePlaybackRate(event.key === "ArrowUp" ? 1 : -1);
        return;
      }

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (event.repeat) return;
        togglePlay();
        if (target && typeof target.blur === "function") target.blur();
      } else if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        if (v) v.muted = !v.muted;
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        if (!v) return;
        if (!v.paused) v.pause();
        try { v.currentTime = Math.max(0, v.currentTime - FRAME_STEP_SEC); } catch { /* noop */ }
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        if (!v) return;
        if (!v.paused) v.pause();
        const dur = Number.isFinite(v.duration) ? v.duration : 0;
        const next = v.currentTime + FRAME_STEP_SEC;
        try { v.currentTime = dur > 0 ? Math.min(dur, next) : next; } catch { /* noop */ }
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        cycleLoop();
      } else if (event.key === "[") {
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        if (!v) return;
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        const MIN_GAP = 0.05;
        const upper = Math.max(0, loopEnd - MIN_GAP);
        setLoopStart(Math.max(0, Math.min(cur, upper)));
      } else if (event.key === "]") {
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        if (!v) return;
        const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        const dur = videoDuration || item.duration_sec || (Number.isFinite(v.duration) ? v.duration : 0);
        const MIN_GAP = 0.05;
        const lower = Math.min(dur, loopStart + MIN_GAP);
        setLoopEnd(Math.min(dur, Math.max(cur, lower)));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [item.id, item.duration_sec, videoDuration, loopStart, loopEnd, cycleLoop, seekBy, togglePlay, cyclePlaybackRate]);

  return (
    <div ref={fullscreenWrapRef} className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col items-stretch justify-center p-4">
        <div
          ref={containerRef}
          className="relative flex w-full flex-1 items-center justify-center border border-border-subtle bg-black"
        >
          <video
            ref={videoRef}
            src={item.file_url ?? undefined}
            poster={item.thumbnail_url ?? undefined}
            controls={false}
            loop={fullLoop}
            onClick={togglePlay}
            className="absolute inset-0 h-full w-full cursor-pointer object-contain"
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = Number(playbackRate) || 1;
              const duration = Number.isFinite(event.currentTarget.duration)
                ? event.currentTarget.duration
                : 0;
              setVideoDuration(duration);
              const w = event.currentTarget.videoWidth;
              const h = event.currentTarget.videoHeight;
              if (w > 0 && h > 0) setMediaNaturalSize({ w, h });
            }}
          />
          <RegionView
            containerRef={containerRef}
            naturalWidth={mediaNaturalSize?.w ?? null}
            naturalHeight={mediaNaturalSize?.h ?? null}
            visibleNotes={visibleRegionNotes}
          />
        </div>

        {/* 커스텀 timeline */}
        <div
          ref={timelineRef}
          className={cn(
            "group/timeline relative mt-2 h-2 cursor-pointer bg-muted/40 transition-[height] hover:h-3",
            loopStart !== null && loopEnd !== null && "h-3",
            loopDragMode && "h-3",
          )}
          onMouseDown={handleTimelineMouseDown}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
        >
          <div className="absolute inset-x-0 -top-2 -bottom-2" aria-hidden />
          <div
            className="pointer-events-none absolute top-0 h-full bg-primary/60"
            style={{ width: `${positionToPct(currentTime)}%` }}
          />
          {loopStart !== null && loopEnd !== null ? (
            <div
              className="pointer-events-none absolute top-0 h-full bg-foreground/30"
              style={{
                left: `${positionToPct(loopStart)}%`,
                width: `${Math.max(0, positionToPct(loopEnd) - positionToPct(loopStart))}%`,
              }}
            />
          ) : null}

          {totalDuration > 0
            ? sortedNotes.map((note) => {
                if (note.atSec === undefined || !Number.isFinite(note.atSec)) return null;
                const leftPct = positionToPct(note.atSec);
                const isRegion = Boolean(note.region);
                return (
                  <button
                    key={note.id}
                    type="button"
                    className={cn(
                      "absolute top-0 h-full w-[3px] bg-primary transition-transform hover:scale-y-[2.4]",
                      isRegion && "before:absolute before:-top-1 before:left-1/2 before:h-1 before:w-2 before:-translate-x-1/2 before:bg-primary",
                    )}
                    style={{ left: `${leftPct}%`, transform: "translateX(-1.5px)" }}
                    title={`${formatDuration(note.atSec)}${isRegion ? " · region" : ""} — ${note.text}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const v = videoRef.current;
                      if (v) v.currentTime = note.atSec ?? 0;
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  />
                );
              })
            : null}

          {loopStart !== null ? (
            <div
              role="slider"
              aria-label="Loop start"
              aria-valuemin={0}
              aria-valuemax={totalDuration}
              aria-valuenow={loopStart}
              className={cn(
                "absolute -top-1.5 z-10 flex h-[calc(100%+12px)] w-3 cursor-ew-resize items-center justify-center",
                loopDragMode === "start" && "scale-110",
              )}
              style={{
                left: `${positionToPct(loopStart)}%`,
                transform: "translateX(-50%)",
              }}
              onMouseDown={handleLoopHandleMouseDown("start")}
              title={`Loop IN ${formatDuration(loopStart)} — drag to adjust`}
            >
              <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
            </div>
          ) : null}
          {loopEnd !== null ? (
            <div
              role="slider"
              aria-label="Loop end"
              aria-valuemin={0}
              aria-valuemax={totalDuration}
              aria-valuenow={loopEnd}
              className={cn(
                "absolute -top-1.5 z-10 flex h-[calc(100%+12px)] w-3 cursor-ew-resize items-center justify-center",
                loopDragMode === "end" && "scale-110",
              )}
              style={{
                left: `${positionToPct(loopEnd)}%`,
                transform: "translateX(-50%)",
              }}
              onMouseDown={handleLoopHandleMouseDown("end")}
              title={`Loop OUT ${formatDuration(loopEnd)} — drag to adjust`}
            >
              <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
            </div>
          ) : null}

          {totalDuration > 0 ? (
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-[2px] bg-foreground"
              style={{
                left: `${positionToPct(currentTime)}%`,
                transform: "translate(-50%, -50%)",
              }}
            />
          ) : null}

          {/* 호버 썸네일 */}
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
      </div>

      {/* 컨트롤 바 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
        <ControlButton onClick={() => seekBy(-5)} title={vt(language, "skipBack5")}>
          <Rewind className="h-3.5 w-3.5" />
        </ControlButton>
        <ControlButton onClick={togglePlay} title={isPlaying ? vt(language, "pause") : vt(language, "play")}>
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </ControlButton>
        <ControlButton onClick={() => seekBy(5)} title={vt(language, "skipFwd5")}>
          <FastForward className="h-3.5 w-3.5" />
        </ControlButton>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {formatDuration(currentTime)} / {formatDuration(totalDuration)}
        </span>
        <ControlButton onClick={toggleMute} title={muted ? vt(language, "unmute") : vt(language, "mute")}>
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </ControlButton>

        <div
          ref={volumeTrackRef}
          className="group/volume relative h-1.5 w-16 shrink-0 cursor-pointer bg-muted/40 transition-[height] hover:h-2"
          role="slider"
          aria-label={vt(language, "volume")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={muted ? 0 : Math.round(volume * 100)}
          onMouseDown={handleVolumeMouseDown}
          title={muted ? vt(language, "muted") : `${vt(language, "volume")} ${Math.round(volume * 100)}%`}
        >
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

        <ViewerSelect
          value={playbackRate}
          options={PLAYBACK_RATES.map((rate) => ({ value: String(rate), label: `${rate}x` }))}
          onChange={handlePlaybackRateChange}
          title={vt(language, "speed")}
          placement="top"
          className="w-[72px] shrink-0"
        />

        <ControlButton
          onClick={cycleLoop}
          title={
            loopStart !== null && loopEnd !== null
              ? `${vt(language, "loopLabel")} ${formatDuration(loopStart)} – ${formatDuration(loopEnd)} — ${vt(language, "loopClearHint")}`
              : `${vt(language, "loopLabel")} — ${vt(language, "loopActivateHint")}`
          }
          aria-pressed={loopStart !== null && loopEnd !== null}
          variant="outline"
          active={loopStart !== null && loopEnd !== null}
        >
          <Repeat className="h-3.5 w-3.5" />
        </ControlButton>

        <ControlButton
          onClick={() => setFullLoop((v) => !v)}
          title={vt(language, "fullLoop")}
          aria-pressed={fullLoop}
          variant="outline"
          active={fullLoop}
        >
          <Repeat1 className="h-3.5 w-3.5" />
        </ControlButton>

        <ShortcutsPopover
          title={vt(language, "shortcutsTitle")}
          buttonTitle={vt(language, "shortcuts")}
          rows={[
            { keys: "Space", label: vt(language, "scPlayPause") },
            { keys: "M", label: vt(language, "scMute") },
            { keys: "D / F", label: vt(language, "scFrameStep") },
            { keys: seekModLabel, label: vt(language, "scSeek5") },
            { keys: "Ctrl \u2191/\u2193", label: vt(language, "speed") },
            { keys: "L", label: vt(language, "scLoop") },
            { keys: "[ / ]", label: vt(language, "scLoopRegion") },
            { keys: "\u2190 / \u2192", label: vt(language, "scItemNav") },
            { keys: "Esc", label: vt(language, "scClose") },
          ]}
        />

        <ControlButton onClick={toggleFullscreen} title={vt(language, "fullscreen")}>
          <Maximize className="h-3.5 w-3.5" />
        </ControlButton>
      </div>
    </div>
  );
}

/* 컨트롤 바 안 작은 버튼. */
function ControlButton({
  children,
  onClick,
  title,
  variant = "ghost",
  active = false,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  variant?: "ghost" | "outline";
  active?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "title">) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-8 w-8 items-center justify-center transition-colors",
        variant === "outline" && "border border-border-subtle",
        variant === "ghost" && "hover:bg-muted/40",
        active && "border-foreground/40 bg-foreground/15 text-foreground",
      )}
      style={{ borderRadius: 0 }}
      {...rest}
    >
      {children}
    </button>
  );
}

/* 외부에서 hover preview seek timing 을 흉내 내고 싶을 때 쓰는 helper.
 * 현재는 사용하지 않지만, 단위 테스트에서 import 가능하도록 export. */
export type { RefObject };
