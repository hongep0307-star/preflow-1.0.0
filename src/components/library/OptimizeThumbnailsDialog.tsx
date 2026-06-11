/**
 * OptimizeThumbnailsDialog — Library 이미지 thumbnail 백필 (D-2).
 *
 * D-1 에서 ingest 파이프가 image/webp 자료에 대해 다운스케일 thumbnail.webp
 * 를 생성하도록 바뀌었지만, *기존* 자료는 여전히 원본을 카드 thumbnail 로
 * 사용한다(=`thumbnail_url === file_url`). 4K/8K 원본을 200~400px 카드에
 * 디코드시키면 한 장당 100~300ms 메인스레드가 묻혀 라이브러리 진입 직후
 * grid 가 잠시 멈춘다.
 *
 * 본 다이얼로그는 사용자에게 *명시적으로* 1회 정리 액션을 트리거시킨다 —
 * Settings 진입점에 "AI 정리" 옆에 둬 같은 정리 워크플로우 그룹으로 인지
 * 되도록 했다.
 *
 * Phase machine: scanning → confirm → running → done / error
 *   - scanning: listReferences + 백필 대상 추출
 *   - confirm: 대상 개수 안내 + 시작 버튼 (0 건이면 "이미 깔끔" 표시)
 *   - running: ProgressBar + cancel 버튼 (AbortController)
 *   - done: success/failed/skipped 통계 + 사용자에게 라이브러리로 돌아가
 *           바로 효과 확인 가능함을 안내
 *   - error: scan 단계 자체 실패만 (per-item 실패는 done 의 failed 카운트)
 *
 * 데이터 흐름은 LibraryAiCleanupDialog 와 동형(分phase + ProgressBar) —
 * 별도 디자인 시스템 도입 없이 같은 시각 언어 유지.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ImageDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  backfillImageThumbnails,
  listReferences,
  selectThumbnailBackfillCandidates,
  type ReferenceItem,
  type ThumbnailBackfillProgress,
} from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

interface OptimizeThumbnailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: (result: ThumbnailBackfillProgress) => void;
}

type Phase = "scanning" | "confirm" | "running" | "done" | "error";

export function OptimizeThumbnailsDialog({
  open,
  onOpenChange,
  onComplete,
}: OptimizeThumbnailsDialogProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("scanning");
  const [candidates, setCandidates] = useState<ReferenceItem[]>([]);
  const [progress, setProgress] = useState<ThumbnailBackfillProgress>({
    done: 0,
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  });
  const [error, setError] = useState<string | null>(null);
  /* 취소 컨트롤러 — running phase 동안에만 의미가 있고, scan 단계의 다이얼로그
     재오픈 시 reset 된다. 다이얼로그가 닫힐 때도 안전하게 abort. */
  const abortRef = useRef<AbortController | null>(null);

  /* 다이얼로그 open 시마다 새로 스캔 — 사용자가 D-1 ingest 로 새 자료를
     올린 직후 다시 열 수 있어 캐시하지 않는다. */
  useEffect(() => {
    if (!open) return;
    setPhase("scanning");
    setError(null);
    setProgress({ done: 0, total: 0, success: 0, failed: 0, skipped: 0 });
    void (async () => {
      try {
        const list = await listReferences({ limit: 10_000 });
        const targets = selectThumbnailBackfillCandidates(list);
        setCandidates(targets);
        setPhase("confirm");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      // 다이얼로그가 닫히거나 unmount 될 때 진행 중인 백필을 안전히 정지.
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [open]);

  const run = async () => {
    setPhase("running");
    setError(null);
    setProgress({ done: 0, total: candidates.length, success: 0, failed: 0, skipped: 0 });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await backfillImageThumbnails({
        items: candidates,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });
      setProgress(result);
      setPhase("done");
      onComplete?.(result);
    } catch (err) {
      // backfill 자체가 throw 하는 케이스는 거의 없지만 안전망.
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const close = () => {
    if (phase === "running") return; // 실행 중에는 외부 닫기 차단(Cancel 버튼으로 명시 취소)
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : onOpenChange(true))}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("library.thumbBackfill.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("library.thumbBackfill.entryDescription")}</DialogDescription>
        </DialogHeader>

        {phase === "scanning" ? (
          <div
            className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 px-3 py-3 text-meta text-muted-foreground"
            style={{ borderRadius: 0 }}
          >
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("library.thumbBackfill.scanLoading")}
          </div>
        ) : null}

        {phase === "confirm" ? (
          <ConfirmView count={candidates.length} />
        ) : null}

        {phase === "running" ? (
          <div
            className="flex flex-col gap-3 border border-border-subtle bg-surface-panel/60 p-4 text-meta"
            style={{ borderRadius: 0 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="font-medium">{t("library.thumbBackfill.running")}</span>
              </div>
              <div className="font-mono text-2xs text-muted-foreground">
                {t("library.thumbBackfill.progress", {
                  done: String(progress.done),
                  total: String(progress.total),
                })}
              </div>
            </div>
            <ProgressBar done={progress.done} total={progress.total} />
            <div className="font-mono text-2xs text-muted-foreground">
              {t("library.thumbBackfill.runningStats", {
                success: String(progress.success),
                skipped: String(progress.skipped),
                failed: String(progress.failed),
              })}
            </div>
          </div>
        ) : null}

        {phase === "done" ? (
          <div
            className="flex flex-col gap-2 border border-border-subtle bg-surface-panel/60 p-4 text-meta"
            style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
          >
            <div className="flex items-center gap-2 text-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span className="font-medium">
                {progress.failed === 0
                  ? t("library.thumbBackfill.completedAllOk", { success: String(progress.success) })
                  : t("library.thumbBackfill.completed", {
                      success: String(progress.success),
                      failed: String(progress.failed),
                    })}
              </span>
            </div>
            {progress.skipped > 0 ? (
              <div className="ml-6 font-mono text-2xs text-muted-foreground">
                {t("library.thumbBackfill.skippedHint", { count: String(progress.skipped) })}
              </div>
            ) : null}
            <div className="ml-6 text-caption text-muted-foreground">
              {t("library.thumbBackfill.doneHint")}
            </div>
          </div>
        ) : null}

        {phase === "error" && error ? (
          <div
            className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 p-3 text-meta text-destructive"
            style={{ borderRadius: 0 }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("library.thumbBackfill.failed", { message: error })}</span>
          </div>
        ) : null}

        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <Button variant="outline" style={{ borderRadius: 0 }} onClick={close}>
                {t("library.thumbBackfill.cancel")}
              </Button>
              <Button
                style={{ borderRadius: 0 }}
                onClick={() => void run()}
                disabled={candidates.length === 0}
              >
                {t("library.thumbBackfill.run")}
              </Button>
            </>
          ) : phase === "running" ? (
            <Button variant="outline" style={{ borderRadius: 0 }} onClick={cancel}>
              {t("library.thumbBackfill.cancel")}
            </Button>
          ) : phase === "done" || phase === "error" || phase === "scanning" ? (
            <Button
              variant="outline"
              style={{ borderRadius: 0 }}
              onClick={close}
              disabled={phase === "scanning"}
            >
              {t("common.close")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmView({ count }: { count: number }) {
  const t = useT();
  if (count === 0) {
    return (
      <div
        className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 p-3 text-meta text-muted-foreground"
        style={{ borderRadius: 0 }}
      >
        <CheckCircle2 className="h-4 w-4 text-success" />
        {t("library.thumbBackfill.allClean")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex items-center justify-between bg-surface-panel/60 px-3 py-2"
        style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
      >
        <span className="text-meta text-foreground">
          {t("library.thumbBackfill.summaryItems", { total: String(count) })}
        </span>
        <span className="font-mono text-2xs text-muted-foreground">
          {t("library.thumbBackfill.itemsCount", { count: String(count) })}
        </span>
      </div>
      <div
        className="flex items-start gap-2 border border-border-subtle bg-surface-panel/60 px-3 py-2 text-caption text-muted-foreground"
        style={{ borderRadius: 0 }}
      >
        <ImageDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span>{t("library.thumbBackfill.estimateHint")}</span>
      </div>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      className="h-1 w-full overflow-hidden bg-border-subtle"
      style={{ borderRadius: 0 }}
    >
      <div
        className="h-full bg-primary transition-all duration-300 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
