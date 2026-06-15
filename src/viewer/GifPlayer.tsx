import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pause, Play, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGifFrames } from "@/lib/gifFrames";
import { RegionView } from "./RegionView";
import { ShortcutsPopover } from "./ShortcutsPopover";
import { ViewerSelect } from "./ViewerSelect";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem } from "./types";

/* GIF / 애니메이션 WebP / APNG 프레임 정밀 재생 (viewer 버전).
 *
 * 핵심:
 *   - ImageDecoder 로 모든 프레임을 사전 디코드 → 캔버스에 순서대로 찍기.
 *   - frame slider 로 사용자가 임의 프레임 점프.
 *   - region 노트는 frameIndex 가 일치할 때만 표시.
 *   - 미지원 환경(Firefox 등) → onUnsupported 콜백으로 부모가 <img> 폴백.
 *
 * 메인 앱 GifFramePlayer 의 단순화 버전: Add Note / Set Cover / Save Frame /
 * 가변 zoom 은 의도적으로 제거. 재생/정지 + 프레임 slider + loop + 배속 +
 * region + 프레임 단축키([, ]) 유지(메인 앱과 동일 키맵). */

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

interface GifPlayerProps {
  item: ReferenceItem;
  /** ImageDecoder 미지원 / 디코드 실패 시 호출. 부모는 <img> 자동재생으로
   *  자연 폴백. */
  onUnsupported: () => void;
  /** NotesPanel 이 frame 행 클릭 → 점프 요청. */
  registerSeek?: (seek: (frameIndex: number) => void) => void;
  /** NotesPanel active row 강조용. */
  onFrameUpdate?: (frameIndex: number) => void;
  /** 툴팁/단축키 라벨 언어 — App 의 언어 토글이 구동. */
  language?: ViewerLang;
}

export function GifPlayer({ item, onUnsupported, registerSeek, onFrameUpdate, language = "en" }: GifPlayerProps) {
  const { status, frames, durationsMs, naturalSize } = useGifFrames(
    item.file_url ?? null,
    item.mime_type ?? "image/gif",
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  /* 루프 구간(프레임 인덱스). null 이면 비활성 = 전체 반복. 비디오의
   *  loopStart/loopEnd 와 동일 UX 를 프레임 단위로 제공. */
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [loopDragMode, setLoopDragMode] = useState<"start" | "end" | null>(null);
  const [rate, setRate] = useState("1");
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  /* 미지원 / 실패 시 부모로 전달. */
  useEffect(() => {
    if (status === "unsupported" || status === "error") {
      onUnsupported();
    }
  }, [status, onUnsupported]);

  /* 새 자료 / 다시 디코드 → 0 으로 리셋. */
  useEffect(() => {
    setFrameIndex(0);
    setPlaying(true);
    setLoopStart(null);
    setLoopEnd(null);
  }, [item.id]);

  /* External seek API 등록. */
  useEffect(() => {
    if (!registerSeek) return;
    registerSeek((idx) => {
      const total = frames.length;
      if (total <= 0) return;
      const clamped = Math.max(0, Math.min(total - 1, Math.floor(idx)));
      setFrameIndex(clamped);
      setPlaying(false);
    });
  }, [frames.length, registerSeek]);

  /* 프레임 진행. */
  useEffect(() => {
    if (status !== "ready" || frames.length === 0) return;
    if (!playing) return;
    const r = Math.max(0.05, Number(rate) || 1);
    const dur = Math.max(20, (durationsMs[frameIndex] ?? 100) / r);
    const timer = setTimeout(() => {
      setFrameIndex((cur) => {
        /* 구간 루프가 켜져 있으면 [lo,hi] 안에서, 아니면 전체에서 반복.
         *  gif 는 항상 반복(정지 없음). */
        const lo = loopStart ?? 0;
        const hi = loopEnd ?? frames.length - 1;
        const next = cur + 1;
        if (next > hi || next >= frames.length) return lo;
        return next;
      });
    }, dur);
    return () => clearTimeout(timer);
  }, [durationsMs, frameIndex, frames.length, loopStart, loopEnd, playing, rate, status]);

  /* 캔버스에 그리기. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "ready" || frames.length === 0 || !naturalSize) return;
    const frame = frames[frameIndex];
    if (!frame) return;
    canvas.width = naturalSize.w;
    canvas.height = naturalSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      ctx.clearRect(0, 0, naturalSize.w, naturalSize.h);
      ctx.drawImage(frame, 0, 0, naturalSize.w, naturalSize.h);
      onFrameUpdate?.(frameIndex);
    } catch {
      /* 일부 브라우저에서 closed VideoFrame 을 그리려고 하면 throw — 무시. */
    }
  }, [frameIndex, frames, naturalSize, onFrameUpdate, status]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);
  /* 비디오 cycleLoop 의 프레임판 — 활성 시 해제, 비활성 시 전체 범위로 켜고
   *  [/] 로 in/out 을 좁힌다. playhead 는 건드리지 않는다. */
  const cycleLoop = useCallback(() => {
    const total = frames.length;
    if (loopStart !== null || loopEnd !== null) {
      setLoopStart(null);
      setLoopEnd(null);
      return;
    }
    if (total <= 1) return;
    /* 비디오와 동일하게 현재 프레임을 중심으로 한 구간으로 시작(전체가 아니라).
     *  playhead 는 건드리지 않고 [/] 또는 핸들 드래그로 좁힌다. */
    const last = total - 1;
    const half = Math.max(1, Math.round(last * 0.15));
    const start = Math.max(0, Math.min(last - 1, frameIndex - half));
    const end = Math.min(last, start + half * 2);
    setLoopStart(start);
    setLoopEnd(end);
  }, [frames.length, frameIndex, loopStart, loopEnd]);

  /* ── 커스텀 프레임 타임라인 (비디오 타임라인과 동일 UX) ── */
  const frameFromClientX = useCallback(
    (clientX: number): number => {
      const track = timelineRef.current;
      const last = Math.max(0, frames.length - 1);
      if (!track || last <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(pct * last);
    },
    [frames.length],
  );

  const handleTimelineMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    scrubbingRef.current = true;
    setPlaying(false);
    setFrameIndex(frameFromClientX(event.clientX));
  };
  const handleLoopHandleMouseDown =
    (which: "start" | "end") => (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setLoopDragMode(which);
    };

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const last = Math.max(0, frames.length - 1);
      if (scrubbingRef.current) {
        setFrameIndex(frameFromClientX(event.clientX));
        return;
      }
      if (!loopDragMode) return;
      const f = frameFromClientX(event.clientX);
      if (loopDragMode === "start") {
        setLoopStart(Math.max(0, Math.min(f, (loopEnd ?? last) - 1)));
      } else {
        setLoopEnd(Math.min(last, Math.max(f, (loopStart ?? 0) + 1)));
      }
    };
    const onUp = () => {
      scrubbingRef.current = false;
      if (loopDragMode) setLoopDragMode(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [frameFromClientX, frames.length, loopDragMode, loopStart, loopEnd]);

  /* 키보드 단축키 — 비디오와 동일 키맵: Space(재생/정지), D/F(이전/다음
   *  프레임), L(루프 구간 토글), [/](루프 in/out 을 현재 프레임으로 설정).
   *  capture 단계 등록 이유는 VideoPlayer 와 동일(포커스된 버튼이 Space 를
   *  click 으로 가로채는 사고 방지). */
  useEffect(() => {
    const lastFrame = Math.max(0, frames.length - 1);
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && (event.ctrlKey || event.metaKey)) {
        /* Ctrl/Cmd + ↑/↓ → 배속 단계 이동 (비디오와 동일). */
        event.preventDefault();
        const dir = event.key === "ArrowUp" ? 1 : -1;
        setRate((cur) => {
          const c = Number(cur) || 1;
          let idx = PLAYBACK_RATES.findIndex((r) => r === c);
          if (idx === -1) {
            idx = PLAYBACK_RATES.reduce(
              (best, r, i) => (Math.abs(r - c) < Math.abs(PLAYBACK_RATES[best] - c) ? i : best),
              0,
            );
          }
          const next = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, idx + dir));
          return String(PLAYBACK_RATES[next]);
        });
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (event.repeat) return;
        setPlaying((p) => !p);
        if (target && typeof target.blur === "function") target.blur();
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        setPlaying(false);
        setFrameIndex((i) => Math.max(0, i - 1));
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        setPlaying(false);
        setFrameIndex((i) => Math.min(lastFrame, i + 1));
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        cycleLoop();
      } else if (event.key === "[") {
        /* 루프 in = 현재 프레임 (out 보다 최소 1 프레임 앞). 루프 활성 시만. */
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        setLoopStart(Math.max(0, Math.min(frameIndex, loopEnd - 1)));
      } else if (event.key === "]") {
        if (loopStart === null || loopEnd === null) return;
        event.preventDefault();
        setLoopEnd(Math.min(lastFrame, Math.max(frameIndex, loopStart + 1)));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [frames.length, item.id, loopStart, loopEnd, frameIndex, cycleLoop]);

  const visibleRegionNotes = useMemo(() => {
    return (item.timestamp_notes ?? []).filter(
      (note) => note.region && (note.frameIndex ?? -1) === frameIndex,
    );
  }, [frameIndex, item.timestamp_notes]);

  const totalFrames = frames.length;
  /* 타임라인 비율 계산용 분모(0 나눗셈 방지). */
  const loopTimelineLast = Math.max(1, totalFrames - 1);

  /* 로딩 / 실패 시는 부모가 알아서 폴백 처리. 여기는 그 사이의 시각 빈
   *  공백을 최소화하는 placeholder 만. */
  if (status === "loading" || status === "unsupported" || status === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-caption text-white/40">
        {status === "loading" ? vt(language, "decoding") : ""}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
      >
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full object-contain"
          style={{ width: naturalSize?.w, height: naturalSize?.h }}
        />
        <RegionView
          containerRef={containerRef}
          naturalWidth={naturalSize?.w ?? null}
          naturalHeight={naturalSize?.h ?? null}
          visibleNotes={visibleRegionNotes}
        />
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-2.5">
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-8 w-8 items-center justify-center hover:bg-muted/40"
          style={{ borderRadius: 0 }}
          title={playing ? vt(language, "pause") : vt(language, "play")}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {frameIndex + 1} / {totalFrames}
        </span>

        {/* 커스텀 프레임 타임라인 — 비디오와 동일: 진행 + 루프 밴드 + 드래그
            in/out 핸들 + 재생헤드 + 클릭/드래그 시크. */}
        <div
          ref={timelineRef}
          className={cn(
            "group/timeline relative mx-2 h-2 flex-1 cursor-pointer bg-muted/40 transition-[height] hover:h-3",
            (loopStart !== null || loopDragMode) && "h-3",
          )}
          onMouseDown={handleTimelineMouseDown}
        >
          <div className="absolute inset-x-0 -top-2 -bottom-2" aria-hidden />
          <div
            className="pointer-events-none absolute top-0 h-full bg-primary/60"
            style={{ width: `${(frameIndex / loopTimelineLast) * 100}%` }}
          />
          {loopStart !== null && loopEnd !== null ? (
            <div
              className="pointer-events-none absolute top-0 h-full bg-foreground/30"
              style={{
                left: `${(loopStart / loopTimelineLast) * 100}%`,
                width: `${Math.max(0, ((loopEnd - loopStart) / loopTimelineLast) * 100)}%`,
              }}
            />
          ) : null}
          {loopStart !== null ? (
            <div
              role="slider"
              aria-label="Loop start"
              aria-valuemin={0}
              aria-valuemax={loopTimelineLast}
              aria-valuenow={loopStart}
              className={cn(
                "absolute -top-1.5 z-10 flex h-[calc(100%+12px)] w-3 cursor-ew-resize items-center justify-center",
                loopDragMode === "start" && "scale-110",
              )}
              style={{ left: `${(loopStart / loopTimelineLast) * 100}%`, transform: "translateX(-50%)" }}
              onMouseDown={handleLoopHandleMouseDown("start")}
              title={`Loop IN #${loopStart + 1}`}
            >
              <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
            </div>
          ) : null}
          {loopEnd !== null ? (
            <div
              role="slider"
              aria-label="Loop end"
              aria-valuemin={0}
              aria-valuemax={loopTimelineLast}
              aria-valuenow={loopEnd}
              className={cn(
                "absolute -top-1.5 z-10 flex h-[calc(100%+12px)] w-3 cursor-ew-resize items-center justify-center",
                loopDragMode === "end" && "scale-110",
              )}
              style={{ left: `${(loopEnd / loopTimelineLast) * 100}%`, transform: "translateX(-50%)" }}
              onMouseDown={handleLoopHandleMouseDown("end")}
              title={`Loop OUT #${loopEnd + 1}`}
            >
              <span className="block h-full w-[3px] bg-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
            </div>
          ) : null}
          <span
            className="pointer-events-none absolute top-1/2 h-4 w-[2px] bg-foreground"
            style={{ left: `${(frameIndex / loopTimelineLast) * 100}%`, transform: "translate(-50%, -50%)" }}
          />
        </div>

        <button
          type="button"
          onClick={cycleLoop}
          className={cn(
            "flex h-8 w-8 items-center justify-center border border-border-subtle hover:bg-muted/40",
            loopStart !== null && "border-foreground/40 bg-foreground/15 text-foreground",
          )}
          style={{ borderRadius: 0 }}
          title={
            loopStart !== null
              ? `${vt(language, "loopOn")} (${(loopStart ?? 0) + 1}–${(loopEnd ?? 0) + 1})`
              : `${vt(language, "loopOff")} — ${vt(language, "scLoopRegion")}`
          }
          aria-pressed={loopStart !== null}
        >
          <Repeat className="h-3.5 w-3.5" />
        </button>

        <ViewerSelect
          value={rate}
          options={PLAYBACK_RATES.map((r) => ({ value: String(r), label: `${r}x` }))}
          onChange={setRate}
          title={vt(language, "speed")}
          placement="top"
          className="w-[72px] shrink-0"
        />

        <ShortcutsPopover
          title={vt(language, "shortcutsTitle")}
          buttonTitle={vt(language, "shortcuts")}
          rows={[
            { keys: "Space", label: vt(language, "scPlayPause") },
            { keys: "D / F", label: vt(language, "scFrameNav") },
            { keys: "Ctrl \u2191/\u2193", label: vt(language, "speed") },
            { keys: "L", label: vt(language, "scLoop") },
            { keys: "[ / ]", label: vt(language, "scLoopRegion") },
            { keys: "\u2190 / \u2192", label: vt(language, "scItemNav") },
            { keys: "Esc", label: vt(language, "scClose") },
          ]}
        />
      </div>
    </div>
  );
}

/* 폴백 분기 — ImageDecoder 가 없을 때 단순 <img> 자동재생.
 *  region 노트는 frameIndex 기준이 무의미해지므로 "frame-anchored 가 아닌"
 *  노트(region 만 있고 frameIndex 없는 케이스) 만 항상 표시. 사용자가
 *  여전히 코멘트의 *위치* 는 볼 수 있도록. */
export function GifFallback({ item, language = "en" }: { item: ReferenceItem; language?: ViewerLang }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const visibleRegionNotes = useMemo(() => {
    return (item.timestamp_notes ?? []).filter(
      (note) => note.region && note.frameIndex === undefined,
    );
  }, [item.timestamp_notes]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {item.file_url ? (
          <img
            src={item.file_url}
            alt={item.title}
            className="absolute inset-0 h-full w-full object-contain"
            onLoad={(event) => {
              const w = event.currentTarget.naturalWidth;
              const h = event.currentTarget.naturalHeight;
              if (w > 0 && h > 0) setNatural({ w, h });
            }}
          />
        ) : null}
        <RegionView
          containerRef={containerRef}
          naturalWidth={natural?.w ?? null}
          naturalHeight={natural?.h ?? null}
          visibleNotes={visibleRegionNotes}
        />
      </div>
      <div className="flex-shrink-0 border-t border-border-subtle px-4 py-2 text-2xs text-muted-foreground">
        {vt(language, "gifFallbackNote")}
      </div>
    </div>
  );
}
