/**
 * KoreanAliasExpandDialog — "한국어 검색어 확장" 워크플로우.
 *
 * 영문 canonical 태그/무드를 한국어 *검색 별칭*(음역 포함, 예: halftone→하프톤)
 * 으로 확장해 `koreanTagAliasOverrides` 에 저장한다. AI 분류가 채우는
 * `suggested_tags_ko` 는 자연 번역(직역, 망점) 만이라 음역으로는 검색이 안 되는
 * 갭을 메운다. 검색 인덱스(`buildKoreanTagAliasIndex`) 가 이 오버라이드를
 * seedDictionary 로 합류시키므로, 확장 직후 한글 검색이 즉시 잡힌다.
 *
 * 하이브리드:
 *   - "새 자료 자동 확장" 토글 — 켜면 LibraryPage 가 새 태그를 백그라운드 확장.
 *   - "신규만 확장" / "전체 재확장" 버튼 — 원할 때 수동 일괄 실행.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listReferences } from "@/lib/referenceLibrary";
import { expandEnTagsToKorean } from "@/lib/referenceAi";
import {
  collectEnAliasInventory,
  getExpandedEnSet,
  mergeKoreanAliasOverrides,
  readKoreanAliasAutoExpand,
  saveKoreanAliasAutoExpand,
} from "@/lib/koreanTagAliasOverrides";
import { useT } from "@/lib/uiLanguage";

interface KoreanAliasExpandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Phase = "scanning" | "ready" | "running" | "done" | "error";

export function KoreanAliasExpandDialog({ open, onOpenChange }: KoreanAliasExpandDialogProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("scanning");
  const [inventory, setInventory] = useState<string[]>([]);
  const [expandedCount, setExpandedCount] = useState(0);
  const [autoExpand, setAutoExpand] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNow, setExpandedNow] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number; tags: number }>({
    done: 0,
    total: 0,
    tags: 0,
  });
  const [canceled, setCanceled] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const freshTokens = useMemo(() => {
    const expanded = getExpandedEnSet();
    return inventory.filter((en) => !expanded.has(en));
    // expandedCount 를 dep 에 넣어 실행 후 재계산되게 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, expandedCount]);

  useEffect(() => {
    if (!open) return;
    setPhase("scanning");
    setError(null);
    setExpandedNow(0);
    setCanceled(false);
    setProgress({ done: 0, total: 0, tags: 0 });
    setAutoExpand(readKoreanAliasAutoExpand());
    void (async () => {
      try {
        const list = await listReferences({ limit: 10_000 });
        const inv = collectEnAliasInventory(list);
        setInventory(inv);
        setExpandedCount(getExpandedEnSet().size);
        setPhase("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [open]);

  const run = async (mode: "fresh" | "all") => {
    const targets = mode === "fresh" ? freshTokens : inventory;
    if (targets.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setCanceled(false);
    setExpandedNow(0);
    setProgress({ done: 0, total: 0, tags: 0 });
    setPhase("running");
    try {
      // 증분 저장 — chunk 가 끝날 때마다 바로 localStorage 에 머지한다. 중간에
      // 취소/창닫기 해도 완료된 묶음은 보존된다(올-오어-나싱 제거).
      let savedTags = 0;
      await expandEnTagsToKorean(targets, {
        signal: controller.signal,
        onChunk: (partial) => {
          mergeKoreanAliasOverrides(partial);
          savedTags += Object.keys(partial).length;
          setExpandedNow(savedTags);
          setExpandedCount(getExpandedEnSet().size);
        },
        onProgress: (p) =>
          setProgress({ done: p.doneChunks, total: p.totalChunks, tags: p.expandedTags }),
      });
      setExpandedCount(getExpandedEnSet().size);
      setCanceled(controller.signal.aborted);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const toggleAuto = () => {
    const next = !autoExpand;
    setAutoExpand(next);
    saveKoreanAliasAutoExpand(next);
  };

  const close = () => {
    // 실행 중 닫기 = 취소. 진행 중 chunk 까지만 마무리되고(이미 저장됨) 멈춘다.
    if (phase === "running") abortRef.current?.abort();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : onOpenChange(true))}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("library.koreanAlias.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("library.koreanAlias.entryDescription")}</DialogDescription>
        </DialogHeader>

        {phase === "scanning" ? (
          <div
            className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 px-3 py-3 text-meta text-muted-foreground"
            style={{ borderRadius: 0 }}
          >
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("library.koreanAlias.scanLoading")}
          </div>
        ) : null}

        {phase === "ready" ? (
          <div className="flex flex-col gap-3">
            {inventory.length === 0 ? (
              <div
                className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 p-3 text-meta text-muted-foreground"
                style={{ borderRadius: 0 }}
              >
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                {t("library.koreanAlias.empty")}
              </div>
            ) : (
              <div
                className="flex items-center gap-2 bg-surface-panel/60 px-3 py-2 text-meta text-foreground"
                style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
              >
                <Languages className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span>
                  {t("library.koreanAlias.summary", {
                    total: String(inventory.length),
                    expanded: String(expandedCount),
                    fresh: String(freshTokens.length),
                  })}
                </span>
              </div>
            )}

            {/* 자동 확장 토글 — 워크스페이스별 영속. */}
            <label
              className="flex cursor-pointer items-start gap-3 border border-border-subtle bg-surface-panel/40 px-3 py-2.5 hover:bg-surface-panel/70"
              style={{ borderRadius: 0 }}
            >
              <Checkbox checked={autoExpand} onCheckedChange={toggleAuto} className="mt-0.5 h-4 w-4" />
              <span className="flex flex-col gap-0.5">
                <span className="text-meta font-medium text-foreground">
                  {t("library.koreanAlias.autoToggle")}
                </span>
                <span className="text-caption text-muted-foreground leading-relaxed">
                  {t("library.koreanAlias.autoToggleDesc")}
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {phase === "running" ? (
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 p-4 text-meta text-foreground"
              style={{ borderRadius: 0 }}
            >
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="font-medium">
                {progress.total > 0
                  ? t("library.koreanAlias.progress", {
                      done: String(progress.done),
                      total: String(progress.total),
                      tags: String(progress.tags),
                    })
                  : t("library.koreanAlias.running")}
              </span>
            </div>
            {/* 진행 바 — done/total 비율. total 0 일 땐 표시 안 함. */}
            {progress.total > 0 ? (
              <div className="h-1.5 w-full overflow-hidden bg-surface-panel/60" style={{ borderRadius: 0 }}>
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            ) : null}
            <span className="text-caption text-muted-foreground leading-relaxed">
              {t("library.koreanAlias.progressHint")}
            </span>
          </div>
        ) : null}

        {phase === "done" ? (
          <div
            className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 p-4 text-meta text-foreground"
            style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
          >
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <span className="font-medium">
              {canceled
                ? t("library.koreanAlias.canceled", { n: String(expandedNow) })
                : expandedNow > 0
                  ? t("library.koreanAlias.done", { n: String(expandedNow) })
                  : t("library.koreanAlias.noFresh")}
            </span>
          </div>
        ) : null}

        {phase === "error" && error ? (
          <div
            className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 p-3 text-meta text-destructive"
            style={{ borderRadius: 0 }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("library.koreanAlias.failed", { message: error })}</span>
          </div>
        ) : null}

        <DialogFooter>
          {phase === "ready" ? (
            <>
              <Button variant="outline" style={{ borderRadius: 0 }} onClick={close}>
                {t("common.close")}
              </Button>
              <Button
                variant="outline"
                style={{ borderRadius: 0 }}
                disabled={freshTokens.length === 0}
                onClick={() => void run("fresh")}
              >
                {t("library.koreanAlias.runFresh", { n: String(freshTokens.length) })}
              </Button>
              <Button
                style={{ borderRadius: 0 }}
                disabled={inventory.length === 0}
                onClick={() => void run("all")}
              >
                {t("library.koreanAlias.runAll", { n: String(inventory.length) })}
              </Button>
            </>
          ) : phase === "running" ? (
            <Button variant="outline" style={{ borderRadius: 0 }} onClick={cancel}>
              {t("common.cancel")}
            </Button>
          ) : phase === "done" || phase === "error" ? (
            <Button variant="outline" style={{ borderRadius: 0 }} onClick={close}>
              {t("common.close")}
            </Button>
          ) : (
            <Button variant="outline" style={{ borderRadius: 0 }} disabled>
              {t("common.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
