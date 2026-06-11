/* Save loop as animation — 영상 reference 의 loop 구간을 GIF 또는 WebP
 * 애니메이션으로 변환하는 다이얼로그.
 *
 * 2 단계 UI:
 *   1) 옵션 폼 — Format(GIF/WebP) + FPS / Resolution / Quality 선택 + 예상 결과 추정
 *   2) 변환 진행 — progress bar + Cancel 버튼. 완료 시 부모에 Blob 을 넘기고
 *      자동 닫힘. 부모는 uploadReferenceFile + 토스트로 후처리.
 *
 * 옵션은 localStorage 에 마지막 값이 저장돼 다음 변환 때 그대로 채워진다.
 *
 * GIF vs WebP 동작 차이:
 *   - GIF: gifenc + 글로벌 팔레트 + Floyd-Steinberg 디더링 (videoToGif.worker)
 *   - WebP: wasm-webp encodeAnimation (libwebp WASM, ~470KB 동적 로드)
 *   사용자에게는 같은 옵션 폼이 노출되고, 인코더만 분기된다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useUiLanguage } from "@/lib/uiLanguage";
import {
  DEFAULT_GIF_EXPORT_OPTIONS,
  GIF_FPS_OPTIONS,
  GIF_MAX_DIM_OPTIONS,
  GIF_QUALITY_OPTIONS,
  computeGifDimensions,
  readGifExportOptions,
  saveGifExportOptions,
  type AnimationFormat,
  type GifExportOptions,
  type GifFps,
  type GifMaxDim,
  type GifQuality,
} from "@/lib/gifExportPreferences";
import {
  estimateAnimationBytes,
  formatBytes,
  GifConversionCancelledError,
} from "@/lib/videoToGif";
import { convertVideoLoopToAnimation } from "@/lib/videoToWebp";

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const total = Math.floor(sec);
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

interface SaveLoopAsGifDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** 비디오 ReferenceItem.file_url — convertVideoLoopToGif 가 직접 로드. */
  videoUrl: string;
  /** 원본 자료의 자연 해상도. UI 의 estimate 라벨에 쓰임. 메타 미로딩이면 0. */
  sourceWidth: number;
  sourceHeight: number;
  /** loop 구간 (초). 다이얼로그가 열릴 때 freeze — 변환 중에 사용자가
   *  핸들을 드래그해도 진행 중 변환은 처음 값을 사용한다. */
  startSec: number;
  endSec: number;
  /** 변환된 GIF Blob 을 부모에 넘김. 부모는 uploadReferenceFile + toast.
   *  이 콜백이 resolve 되면 다이얼로그를 닫는다. reject 면 에러 상태로 전환. */
  onConverted: (blob: Blob, options: GifExportOptions, startSec: number, endSec: number) => Promise<void>;
}

export function SaveLoopAsGifDialog({
  open,
  onOpenChange,
  videoUrl,
  sourceWidth,
  sourceHeight,
  startSec,
  endSec,
  onConverted,
}: SaveLoopAsGifDialogProps) {
  const { t } = useUiLanguage();
  const [options, setOptions] = useState<GifExportOptions>(DEFAULT_GIF_EXPORT_OPTIONS);
  const [phase, setPhase] = useState<"idle" | "extract" | "encode" | "upload">("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* 다이얼로그가 열릴 때마다 마지막 옵션을 불러와 채운다. 닫힐 때
     state 를 리셋해 다음 진입에서 stale progress 가 깜빡이지 않게 한다. */
  useEffect(() => {
    if (open) {
      setOptions(readGifExportOptions());
      setPhase("idle");
      setProgress(0);
      setErrorMsg(null);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  const isBusy = phase !== "idle";
  const duration = Math.max(0, endSec - startSec);
  const totalFrames = Math.max(1, Math.ceil(duration * options.fps));
  const { width: estW, height: estH } = useMemo(
    () =>
      sourceWidth > 0 && sourceHeight > 0
        ? computeGifDimensions(sourceWidth, sourceHeight, options.maxDim)
        : { width: 0, height: 0 },
    [sourceWidth, sourceHeight, options.maxDim],
  );
  const estBytes = useMemo(
    () => estimateAnimationBytes(estW, estH, totalFrames, options.format),
    [estW, estH, totalFrames, options.format],
  );

  /* "5초 이상 + 720p + 24fps" 처럼 무거운 조합에서 사용자에게 한 줄 경고.
     변환을 막진 않지만 결정에 도움 되는 신호. */
  const heavyWarn =
    duration > 5 ||
    options.maxDim === 0 ||
    options.maxDim === 720 ||
    options.fps >= 24;

  const handleConvert = async () => {
    if (isBusy) return;
    if (duration <= 0) {
      setErrorMsg(t("library.gifFailed"));
      return;
    }
    saveGifExportOptions(options);
    setErrorMsg(null);
    setPhase("extract");
    setProgress(0);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const blob = await convertVideoLoopToAnimation({
        videoUrl,
        startSec,
        endSec,
        options,
        signal: abort.signal,
        onProgress: (ratio, p) => {
          setPhase(p);
          setProgress(ratio);
        },
      });
      if (abort.signal.aborted) return;
      setPhase("upload");
      setProgress(1);
      await onConverted(blob, options, startSec, endSec);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof GifConversionCancelledError) {
        /* 사용자 의도 취소 — 메시지 없이 idle 로 돌아간다. */
        setPhase("idle");
        setProgress(0);
        return;
      }
      setPhase("idle");
      setProgress(0);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    if (isBusy) {
      abortRef.current?.abort();
      return;
    }
    onOpenChange(false);
  };

  /* 변환 중에는 backdrop / esc 로 닫지 못하게. close 가 곧 cancel 이 되도록
     onOpenChange 도 abort 로 라우팅. */
  const handleOpenChange = (next: boolean) => {
    if (!next && isBusy) {
      abortRef.current?.abort();
      return;
    }
    onOpenChange(next);
  };

  const progressPct = Math.round(progress * 100);
  const phaseLabel =
    phase === "extract"
      ? t("library.gifExtracting", { percent: String(progressPct) })
      : phase === "encode"
        ? t("library.gifEncoding", { percent: String(progressPct) })
        : phase === "upload"
          ? t("library.gifUploading")
          : "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("library.gifDialogTitle")}</DialogTitle>
        </DialogHeader>

        <p className="text-caption text-muted-foreground">
          {t("library.gifDialogSubtitle", {
            start: formatSec(startSec),
            end: formatSec(endSec),
            duration: `${duration.toFixed(2)}s`,
            frames: String(totalFrames),
          })}
        </p>

        {phase === "idle" ? (
          <div className="space-y-4">
            {/* 포맷 토글 — GIF vs WebP. 같은 옵션을 공유하며 인코더만
                바뀐다. WebP 는 첫 사용 때 wasm 모듈을 로드(~470KB)한다. */}
            <div className="space-y-1.5">
              <Label className="text-caption text-text-secondary font-semibold">
                {t("library.animationFormat")}
              </Label>
              <div
                className="grid grid-cols-2 gap-px border border-border-subtle bg-border-subtle"
                role="radiogroup"
                aria-label={t("library.animationFormat")}
              >
                {(["gif", "webp"] as AnimationFormat[]).map((fmt) => {
                  const active = options.format === fmt;
                  const label =
                    fmt === "gif"
                      ? t("library.animationFormatGif")
                      : t("library.animationFormatWebp");
                  const desc =
                    fmt === "gif"
                      ? t("library.animationFormatGifDesc")
                      : t("library.animationFormatWebpDesc");
                  return (
                    <button
                      key={fmt}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() =>
                        setOptions((prev) => ({ ...prev, format: fmt }))
                      }
                      className={cn(
                        "flex flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors",
                        active
                          ? "bg-primary/15 text-foreground"
                          : "bg-background text-text-secondary hover:bg-muted/30",
                      )}
                    >
                      <span
                        className={cn(
                          "text-body font-semibold",
                          active ? "text-primary" : "",
                        )}
                      >
                        {label}
                      </span>
                      <span className="text-2xs text-muted-foreground">
                        {desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-caption text-text-secondary font-semibold">
                  {t("library.gifFps")}
                </Label>
                <Select
                  value={String(options.fps)}
                  onValueChange={(v) =>
                    setOptions((prev) => ({ ...prev, fps: Number(v) as GifFps }))
                  }
                >
                  <SelectTrigger className="h-9 w-full text-meta rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border-subtle rounded-none">
                    {GIF_FPS_OPTIONS.map((fps) => (
                      <SelectItem key={fps} value={String(fps)} className="text-meta">
                        {t("library.gifFpsOption", { fps: String(fps) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-caption text-text-secondary font-semibold">
                  {t("library.gifMaxDim")}
                </Label>
                <Select
                  value={String(options.maxDim)}
                  onValueChange={(v) =>
                    setOptions((prev) => ({
                      ...prev,
                      maxDim: Number(v) as GifMaxDim,
                    }))
                  }
                >
                  <SelectTrigger className="h-9 w-full text-meta rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border-subtle rounded-none">
                    {GIF_MAX_DIM_OPTIONS.map((dim) => (
                      <SelectItem key={dim} value={String(dim)} className="text-meta">
                        {dim === 0
                          ? t("library.gifMaxDimOriginal")
                          : t("library.gifMaxDimOption", { dim: String(dim) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-caption text-text-secondary font-semibold">
                  {t("library.gifQuality")}
                </Label>
                <Select
                  value={options.quality}
                  onValueChange={(v) =>
                    setOptions((prev) => ({ ...prev, quality: v as GifQuality }))
                  }
                >
                  <SelectTrigger className="h-9 w-full text-meta rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border-subtle rounded-none">
                    {GIF_QUALITY_OPTIONS.map((q) => (
                      <SelectItem key={q} value={q} className="text-meta">
                        {q === "fast"
                          ? t("library.gifQualityFast")
                          : q === "balanced"
                            ? t("library.gifQualityBalanced")
                            : t("library.gifQualityHigh")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-caption text-muted-foreground">
                {estW > 0
                  ? t("library.gifEstimate", {
                      w: String(estW),
                      h: String(estH),
                      size: formatBytes(estBytes),
                    })
                  : "—"}
              </p>
              {heavyWarn ? (
                <p className="text-caption text-amber-300/80">
                  {t("library.gifLongClipWarning")}
                </p>
              ) : null}
              {errorMsg ? (
                <p className="text-caption text-destructive">
                  {errorMsg}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          /* progress 화면 — 진행 phase 라벨 + 4px 진행 바. 가운데 정렬로
             옵션 폼과 시각적으로 구분. */
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-meta">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>{phaseLabel}</span>
            </div>
            <div className="h-1 w-full overflow-hidden bg-muted/40">
              <div
                className="h-full bg-primary transition-[width] duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {phase === "idle" ? (
            <>
              <DialogClose asChild>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-meta"
                  style={{ borderRadius: 0 }}
                  disabled={isBusy}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                className="h-8 px-3 text-meta"
                style={{ borderRadius: 0 }}
                disabled={duration <= 0 || estW <= 0}
                onClick={handleConvert}
              >
                {t("library.gifConvert")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              className={cn("h-8 px-3 text-meta")}
              style={{ borderRadius: 0 }}
              onClick={handleCancel}
              /* upload phase 는 cancel 이 의미 없음 — 이미 인코딩 끝났고
                 uploadReferenceFile 로 진행 중. 그래도 사용자가 안절부절
                 하지 않도록 버튼은 disable 처리. */
              disabled={phase === "upload"}
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
