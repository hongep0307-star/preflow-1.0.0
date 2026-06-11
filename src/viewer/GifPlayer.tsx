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
 * 단축키([, ]) 와 가변 zoom 은 의도적으로 제거. 재생/정지 + 프레임 slider +
 * loop + 배속 + region 만 유지. */

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
}

export function GifPlayer({ item, onUnsupported, registerSeek, onFrameUpdate }: GifPlayerProps) {
  const { status, frames, durationsMs, naturalSize } = useGifFrames(
    item.file_url ?? null,
    item.mime_type ?? "image/gif",
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [rate, setRate] = useState("1");

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
        const next = cur + 1;
        if (next >= frames.length) {
          if (loop) return 0;
          setPlaying(false);
          return cur;
        }
        return next;
      });
    }, dur);
    return () => clearTimeout(timer);
  }, [durationsMs, frameIndex, frames.length, loop, playing, rate, status]);

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
  const toggleLoop = useCallback(() => setLoop((l) => !l), []);

  const visibleRegionNotes = useMemo(() => {
    return (item.timestamp_notes ?? []).filter(
      (note) => note.region && (note.frameIndex ?? -1) === frameIndex,
    );
  }, [frameIndex, item.timestamp_notes]);

  const totalFrames = frames.length;

  /* 로딩 / 실패 시는 부모가 알아서 폴백 처리. 여기는 그 사이의 시각 빈
   *  공백을 최소화하는 placeholder 만. */
  if (status === "loading" || status === "unsupported" || status === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-caption text-white/40">
        {status === "loading" ? "Decoding…" : ""}
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
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {frameIndex + 1} / {totalFrames}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          step={1}
          value={frameIndex}
          onChange={(event) => {
            setFrameIndex(Number(event.target.value));
            setPlaying(false);
          }}
          className="mx-2 flex-1 accent-primary"
        />

        <button
          type="button"
          onClick={toggleLoop}
          className={cn(
            "flex h-8 w-8 items-center justify-center border border-border-subtle hover:bg-muted/40",
            loop && "border-foreground/40 bg-foreground/15 text-foreground",
          )}
          style={{ borderRadius: 0 }}
          title={loop ? "Loop ON" : "Loop OFF"}
          aria-pressed={loop}
        >
          <Repeat className="h-3.5 w-3.5" />
        </button>

        <select
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          className="h-8 w-[68px] shrink-0 border border-border-subtle bg-background px-2 text-caption"
          style={{ borderRadius: 0 }}
        >
          {PLAYBACK_RATES.map((r) => (
            <option key={r} value={String(r)}>{`${r}x`}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* 폴백 분기 — ImageDecoder 가 없을 때 단순 <img> 자동재생.
 *  region 노트는 frameIndex 기준이 무의미해지므로 "frame-anchored 가 아닌"
 *  노트(region 만 있고 frameIndex 없는 케이스) 만 항상 표시. 사용자가
 *  여전히 코멘트의 *위치* 는 볼 수 있도록. */
export function GifFallback({ item }: { item: ReferenceItem }) {
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
        Frame-precise playback is not supported in this browser; showing autoplay GIF.
      </div>
    </div>
  );
}
