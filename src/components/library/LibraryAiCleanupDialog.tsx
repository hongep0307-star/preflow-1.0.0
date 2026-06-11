/**
 * LibraryAiCleanupDialog — Library AI 정리(backfill) 워크플로우 컨테이너.
 *
 * Settings → "라이브러리 AI 정리" 진입점에서 호출되어 두 단계의 작업을
 * 한 다이얼로그에서 끝낸다:
 *   1) gap 분석 + 옵션 선택  (`phase = "options"`)
 *   2) 사용자 한글 태그 정규화 *미리보기*  (`phase = "preview"`)
 *   3) 실제 실행 + 진행 progress  (`phase = "running"`)
 *   4) 완료 / 실패  (`phase = "done"` / `"error"`)
 *
 * 데이터 흐름:
 *   - mount 시 `listReferences` 로 라이브러리 전체를 한 번 가져와
 *     `analyzeBackfillGaps` 로 결손 리포트 생성.
 *   - "한글 태그 정규화" 옵션이 켜져 있으면 시드(L1) 즉시 매칭 결과는
 *     미리보기에 그대로 보여 주고, 시드 미스 토큰은 "LLM 처리 예정"
 *     배지로 표시.
 *   - 실행 단계에서:
 *       a) 시드 미스 토큰을 모아 `translateUserTags` 한 번 호출
 *       b) 시드 + LLM 결과를 합쳐 자료별 `buildUserTagAliasPatch` 적용
 *       c) re-classify 카테고리 자료들은 `enqueueClassify` 로 큐 투입
 *     each step 진척이 progress 로 갱신.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
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
import { listReferences, updateReference, type ReferenceItem } from "@/lib/referenceLibrary";
import {
  analyzeBackfillGaps,
  buildUserTagAliasPatch,
  type BackfillCategory,
  type BackfillReport,
} from "@/lib/libraryAiBackfill";
import { translateUserTags } from "@/lib/referenceAi";
import { enqueueClassify } from "@/lib/classifyQueue";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import {
  getAiOutputLanguageMode,
  getAiTagLanguageMode,
  resolveAiOutputLanguage,
  resolveAiTagLanguage,
} from "@/lib/aiOutputLanguage";

interface LibraryAiCleanupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: (result: { success: number; failed: number }) => void;
}

type Phase = "scanning" | "options" | "preview" | "running" | "done" | "error";

/** 5 카테고리 default — 모두 켜진 채로 시작. UX: 사용자가 "전체 정리"를
 *  자연스럽게 한 번에 누를 수 있게. 결손이 0 인 카테고리는 disabled 로
 *  렌더되어 자동 비활성화.
 *
 *  카테고리 순서는 사용자 정신 모델 순서와 일치 — "AI 자체 누락 → 한국어
 *  메타 누락(태그/무드/장면) → 사용자 직접 입력 한글 정리". `missingScene`
 *  은 `moodKoMismatch` 다음에 두어 "AI 분석 메타 보강" 그룹과 시각적으로
 *  뭉치게 한다. */
const ALL_CATEGORIES: ReadonlyArray<BackfillCategory> = [
  "missingAi",
  "tagKoMismatch",
  "moodKoMismatch",
  "missingScene",
  "userHangulTags",
];

const CATEGORY_LABEL_KEY: Record<BackfillCategory, string> = {
  missingAi: "library.aiCleanup.optMissingAi",
  tagKoMismatch: "library.aiCleanup.optTagKo",
  moodKoMismatch: "library.aiCleanup.optMoodKo",
  missingScene: "library.aiCleanup.optMissingScene",
  userHangulTags: "library.aiCleanup.optUserHangul",
};

export function LibraryAiCleanupDialog({
  open,
  onOpenChange,
  onComplete,
}: LibraryAiCleanupDialogProps) {
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  const [phase, setPhase] = useState<Phase>("scanning");
  const [items, setItems] = useState<ReferenceItem[]>([]);
  const [report, setReport] = useState<BackfillReport | null>(null);
  const [enabled, setEnabled] = useState<Record<BackfillCategory, boolean>>({
    missingAi: true,
    tagKoMismatch: true,
    moodKoMismatch: true,
    missingScene: true,
    userHangulTags: true,
  });
  /** 미리보기에서 사용자가 *제외* 한 한글 토큰 — 실행 단계에서 매핑이
   *  적용되지 않는다. 자료 patch 빌더는 매핑이 없는 토큰을 그대로 보존
   *  (한글 태그 그대로) 하므로 자연스럽게 no-op. */
  const [excludedTokens, setExcludedTokens] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  /** 완료 통계 — 단순 success/failed 외에도 LLM 호출 결과(번역됨/미번역
   *  토큰 수, 호출 자체 실패 여부)를 담아 done 화면에서 사용자가 *왜
   *  변환이 안 됐는지* 즉시 알 수 있게 한다. 이전 빌드에서 LLM 응답이
   *  silent 하게 거부되면 다이얼로그가 "0건 반영" 으로 닫혀 버려 디버깅
   *  단서가 없었던 회귀 보고를 받아 추가. */
  const [completed, setCompleted] = useState<{
    success: number;
    failed: number;
    translatedTokens: number;
    untranslatedTokens: number;
    llmCallFailed: boolean;
  } | null>(null);

  /* mount 시 한 번 — 다이얼로그를 닫고 다시 열면 새로 분석. */
  useEffect(() => {
    if (!open) return;
    setPhase("scanning");
    setError(null);
    setProgress({ done: 0, total: 0 });
    setExcludedTokens(new Set());
    setCompleted(null);
    setEnabled({
      missingAi: true,
      tagKoMismatch: true,
      moodKoMismatch: true,
      missingScene: true,
      userHangulTags: true,
    });
    void (async () => {
      try {
        const list = await listReferences({ limit: 10_000 });
        const rep = analyzeBackfillGaps(list);
        setItems(list);
        setReport(rep);
        setPhase("options");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [open]);

  const hasAnyGap = !!report && report.perItem.length > 0;
  /* "옵션 켜진 카테고리에 실제 영향받는 자료가 있는가?" — 모든 카테고리가
     0 이거나 사용자가 모두 꺼 두면 실행 버튼 disable. */
  const anyEnabledHasWork = useMemo(() => {
    if (!report) return false;
    return ALL_CATEGORIES.some((c) => enabled[c] && report.counts[c] > 0);
  }, [enabled, report]);

  /* LLM 호출 예상치 — re-classify 큐(자료당 1회) + translateUserTags 1회.
     translateUserTags 는 토큰을 한 번에 묶어 보내지만, 사용자 한글 태그
     옵션이 꺼져 있거나 시드 미스 토큰이 0 이면 호출 자체가 생략된다.
     missingScene 도 re-classify 경로를 그대로 타지만, dedupe 가 itemId
     기준이라 다른 re-classify 카테고리(missingAi/tagKoMismatch/moodKoMismatch)
     와 중복돼도 자료 1건으로만 카운트된다. */
  const llmEstimate = useMemo(() => {
    if (!report) return 0;
    let n = 0;
    if (
      enabled.missingAi ||
      enabled.tagKoMismatch ||
      enabled.moodKoMismatch ||
      enabled.missingScene
    ) {
      n += report.itemsToReClassify;
    }
    if (enabled.userHangulTags && report.llmHangulTagsToTranslate > 0) {
      n += 1;
    }
    return n;
  }, [enabled, report]);

  const togglePreview = () => setPhase("preview");
  const backToOptions = () => setPhase("options");

  /** 실제 실행. 단계별로 progress 를 갱신. 자료 patch 적용 + LLM 번역
   *  + queue enqueue 모두 여기서 합성. 부분 실패는 fail 카운트만 올리고
   *  다음 자료로 진행 — silent best-effort. */
  const run = async () => {
    if (!report) return;
    setPhase("running");
    setError(null);

    let success = 0;
    let failed = 0;
    let translatedTokens = 0;
    let untranslatedTokens = 0;
    let llmCallFailed = false;

    /* ── 단계 1: 사용자 한글 태그 정규화 매핑 빌드 ──────────────
       시드 hit 은 즉시 mapping 에 등록. 시드 미스 + 사용자 미제외
       토큰은 LLM 호출(translateUserTags 가 chunk 분할 처리)로 번역.
       결과 null 은 매핑에서 빠짐 → buildUserTagAliasPatch 가 자동으로
       한글 그대로 보존. 이 단계의 통계(번역됨/미번역/호출 실패)는
       완료 화면에서 사용자에게 명시적으로 노출되어 silent 변환 누락을
       디버깅 가능하게 한다. */
    const aliasMappings = new Map<string, string>();
    if (enabled.userHangulTags) {
      const llmTokens: string[] = [];
      for (const ir of report.perItem) {
        for (const ht of ir.hangulTags) {
          if (excludedTokens.has(ht.ko)) continue;
          if (ht.seedHit && ht.suggestedEn) {
            aliasMappings.set(ht.ko, ht.suggestedEn);
            translatedTokens += 1;
          } else if (!ht.seedHit) {
            if (!llmTokens.includes(ht.ko)) llmTokens.push(ht.ko);
          }
        }
      }
      if (llmTokens.length > 0) {
        try {
          const translations = await translateUserTags(llmTokens);
          for (const tr of translations) {
            if (tr.en) {
              aliasMappings.set(tr.ko, tr.en);
              translatedTokens += 1;
            } else {
              untranslatedTokens += 1;
            }
          }
        } catch (err) {
          /* 번역 단계 자체가 throw 한 경우 — chunk 분할 후에도 실패하면
             네트워크/auth/rate-limit 류. 시드 hit 만 적용하고 진행하며
             사용자에게 done 화면에서 명시적으로 표시. */
          llmCallFailed = true;
          untranslatedTokens += llmTokens.length;
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    /* ── 단계 2: 영향받는 자료 IDs 모음 (중복 제거) ────────────
       missingScene 은 missingAi/tagKoMismatch/moodKoMismatch 와 같은 큐를
       공유 — itemIdsToReClassify Set 의 dedupe 로 같은 자료가 두 번 enqueue
       되지 않는다. 큐 워커는 ai_suggestions 전체를 새로 써내려가므로 기존
       태그/무드/장면이 *함께* 갱신된다. */
    const itemIdsToPatch = new Set<string>();
    const itemIdsToReClassify = new Set<string>();
    for (const ir of report.perItem) {
      const cats = ir.categories;
      if (
        (enabled.missingAi && cats.has("missingAi")) ||
        (enabled.tagKoMismatch && cats.has("tagKoMismatch")) ||
        (enabled.moodKoMismatch && cats.has("moodKoMismatch")) ||
        (enabled.missingScene && cats.has("missingScene"))
      ) {
        itemIdsToReClassify.add(ir.itemId);
      }
      if (enabled.userHangulTags && cats.has("userHangulTags")) {
        itemIdsToPatch.add(ir.itemId);
      }
    }

    const total = itemIdsToPatch.size + itemIdsToReClassify.size;
    setProgress({ done: 0, total });
    let done = 0;

    const itemById = new Map(items.map((it) => [it.id, it] as const));

    /* ── 단계 3: alias patch 적용 ───────────────────────────── */
    for (const id of itemIdsToPatch) {
      const it = itemById.get(id);
      if (!it) {
        failed += 1;
        done += 1;
        setProgress({ done, total });
        continue;
      }
      try {
        const patch = buildUserTagAliasPatch(it, aliasMappings);
        if (patch) {
          await updateReference(it.id, patch);
        }
        success += 1;
      } catch {
        failed += 1;
      }
      done += 1;
      setProgress({ done, total });
    }

    /* ── 단계 4: re-classify 큐 투입 (비동기) ───────────────────
       enqueueClassify 는 fire-and-forget — 큐 워커가 background 에서
       처리한다. 이 다이얼로그는 enqueue 가 *수락* 됐는지(중복 dedupe
       성공 여부)만 success/failed 에 반영하고 즉시 다음으로. 사용자가
       Library 화면으로 돌아가면 자연스럽게 진행 상황을 볼 수 있다.

       ★ autoApplyTags: true — 인스펙터의 "Run AI"(enqueueClassifyForItem)
       와 동일하게, 일괄 정리도 분류 직후 suggested_tags 를 자동으로 item.tags
       에 머지한다. 이게 빠져 있어 일괄 분석 후 제안 태그가 자동 태깅되지 않던
       회귀를 수정. language/tagLanguage 도 manual 경로와 동일하게 현재
       Settings(표시·태그 언어)의 effective 값을 따라 머지 언어를 맞춘다. */
    const aiLanguage = resolveAiOutputLanguage(getAiOutputLanguageMode(), uiLanguage);
    const aiTagLanguage = resolveAiTagLanguage(
      getAiTagLanguageMode(),
      getAiOutputLanguageMode(),
      uiLanguage,
    );
    for (const id of itemIdsToReClassify) {
      const it = itemById.get(id);
      if (!it) {
        failed += 1;
        done += 1;
        setProgress({ done, total });
        continue;
      }
      try {
        enqueueClassify(it, {
          autoApplyTags: true,
          language: aiLanguage,
          tagLanguage: aiTagLanguage,
        });
        success += 1;
      } catch {
        failed += 1;
      }
      done += 1;
      setProgress({ done, total });
    }

    setCompleted({ success, failed, translatedTokens, untranslatedTokens, llmCallFailed });
    setPhase("done");
    onComplete?.({ success, failed });
  };

  const close = () => {
    if (phase === "running") return; // 실행 중에는 닫지 못함
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : onOpenChange(true))}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("library.aiCleanup.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("library.aiCleanup.entryDescription")}</DialogDescription>
        </DialogHeader>

        {phase === "scanning" ? (
          <div
            className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 px-3 py-3 text-meta text-muted-foreground"
            style={{ borderRadius: 0 }}
          >
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("library.aiCleanup.scanLoading")}
          </div>
        ) : null}

        {phase === "options" && report ? (
          <OptionsView
            report={report}
            enabled={enabled}
            onToggle={(c) => setEnabled((prev) => ({ ...prev, [c]: !prev[c] }))}
            llmEstimate={llmEstimate}
          />
        ) : null}

        {phase === "preview" && report ? (
          <PreviewView
            report={report}
            excluded={excludedTokens}
            onToggleExclude={(ko) =>
              setExcludedTokens((prev) => {
                const next = new Set(prev);
                if (next.has(ko)) next.delete(ko);
                else next.add(ko);
                return next;
              })
            }
          />
        ) : null}

        {phase === "running" ? (
          <div
            className="flex flex-col gap-3 border border-border-subtle bg-surface-panel/60 p-4 text-meta"
            style={{ borderRadius: 0 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="font-medium">{t("library.aiCleanup.running")}</span>
              </div>
              <div className="font-mono text-2xs text-muted-foreground">
                {t("library.aiCleanup.progress", {
                  done: String(progress.done),
                  total: String(progress.total),
                })}
              </div>
            </div>
            <ProgressBar done={progress.done} total={progress.total} />
            {error ? (
              <div className="flex items-start gap-2 text-caption text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("library.aiCleanup.failed", { message: error })}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "done" && completed ? (
          <div
            className="flex flex-col gap-2 border border-border-subtle bg-surface-panel/60 p-4 text-meta"
            style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
          >
            <div className="flex items-center gap-2 text-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span className="font-medium">
                {completed.failed === 0
                  ? t("library.aiCleanup.completedAllOk", { success: String(completed.success) })
                  : t("library.aiCleanup.completed", {
                      success: String(completed.success),
                      failed: String(completed.failed),
                    })}
              </span>
            </div>
            {/* L3(LLM) 변환 통계 — 시드 hit 으로 즉시 변환된 토큰 + LLM
                응답으로 변환된 토큰 합산. 미번역 토큰 / 호출 실패 여부를
                같이 노출해 사용자가 "왜 그대로 남아 있지?" 의문을 즉시
                해소 — 이전 회귀(silent skip) 복귀 가드. */}
            {completed.translatedTokens + completed.untranslatedTokens > 0 ? (
              <div className="ml-6 font-mono text-2xs text-muted-foreground">
                {t("library.aiCleanup.tokenStats", {
                  translated: String(completed.translatedTokens),
                  untranslated: String(completed.untranslatedTokens),
                })}
              </div>
            ) : null}
            {completed.llmCallFailed ? (
              <div className="ml-6 flex items-start gap-2 text-caption text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("library.aiCleanup.llmFailedHint")}</span>
              </div>
            ) : completed.untranslatedTokens > 0 ? (
              <div className="ml-6 text-caption text-muted-foreground">
                {t("library.aiCleanup.partialMissHint")}
              </div>
            ) : null}
            {error ? (
              <div className="ml-6 flex items-start gap-2 text-caption text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("library.aiCleanup.failed", { message: error })}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "error" && error ? (
          <div
            className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 p-3 text-meta text-destructive"
            style={{ borderRadius: 0 }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("library.aiCleanup.failed", { message: error })}</span>
          </div>
        ) : null}

        {/* ── Footer — phase 별 버튼 셋 ──────────────────────────── */}
        <DialogFooter>
          {phase === "preview" ? (
            <>
              <Button variant="outline" style={{ borderRadius: 0 }} onClick={backToOptions}>
                {t("library.aiCleanup.previewBack")}
              </Button>
              <Button
                style={{ borderRadius: 0 }}
                onClick={() => void run()}
                disabled={!anyEnabledHasWork}
              >
                {t("library.aiCleanup.run")}
              </Button>
            </>
          ) : phase === "options" ? (
            <>
              <Button variant="outline" style={{ borderRadius: 0 }} onClick={close}>
                {t("library.aiCleanup.cancel")}
              </Button>
              {enabled.userHangulTags && report && report.counts.userHangulTags > 0 ? (
                <Button variant="outline" style={{ borderRadius: 0 }} onClick={togglePreview}>
                  {t("library.aiCleanup.preview")}
                </Button>
              ) : null}
              <Button
                style={{ borderRadius: 0 }}
                onClick={() => void run()}
                disabled={!hasAnyGap || !anyEnabledHasWork}
              >
                {t("library.aiCleanup.run")}
              </Button>
            </>
          ) : phase === "done" || phase === "error" || phase === "scanning" ? (
            <Button variant="outline" style={{ borderRadius: 0 }} onClick={close} disabled={phase === "scanning"}>
              {t("common.close")}
            </Button>
          ) : (
            /* running 중에는 dim disabled 닫기 */
            <Button variant="outline" style={{ borderRadius: 0 }} disabled>
              {t("common.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sub views — 단순 presentational. 자체 state 없음.
 * ───────────────────────────────────────────────────────────────── */

function OptionsView({
  report,
  enabled,
  onToggle,
  llmEstimate,
}: {
  report: BackfillReport;
  enabled: Record<BackfillCategory, boolean>;
  onToggle: (c: BackfillCategory) => void;
  llmEstimate: number;
}) {
  const t = useT();
  if (report.perItem.length === 0) {
    return (
      <div
        className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 p-3 text-meta text-muted-foreground"
        style={{ borderRadius: 0 }}
      >
        <CheckCircle2 className="h-4 w-4 text-success" />
        {t("library.aiCleanup.allClean")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {/* ── 상단 요약 — 좌측 브랜드 레드 액센트로 시선 첫 종착점.
          단순 muted 텍스트보다 "검사 결과" 라는 메타 컨텍스트가
          한 번에 들어온다. */}
      <div
        className="flex items-center justify-between bg-surface-panel/60 px-3 py-2"
        style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
      >
        <span className="text-meta text-foreground">
          {t("library.aiCleanup.summaryItems", { total: String(report.totalItems) })}
        </span>
      </div>

      {/* ── 카테고리 카드-리스트. 각 행은:
            - 좌측 shadcn Checkbox (브랜드 레드, sharp)
            - 라벨 + 우측 카운트
            - checked 시 옅은 브랜드 틴트 배경 + primary 보더로 선택 상태 강조
            - count=0 인 행은 disabled (이벤트도 차단). */}
      <div className="flex flex-col gap-1.5">
        {ALL_CATEGORIES.map((cat) => {
          const count = report.counts[cat];
          const isUserHangul = cat === "userHangulTags";
          /* 사용자 한글 태그 카테고리만 "토큰 수" 추가 표기 — 실제 변환
             대상 토큰 수가 자료 수보다 의미 있는 지표이기 때문. */
          const tokensCount = isUserHangul
            ? report.perItem.reduce((sum, ir) => sum + ir.hangulTags.length, 0)
            : 0;
          const isDisabled = count === 0;
          const isChecked = enabled[cat] && !isDisabled;
          return (
            <label
              key={cat}
              className={`flex items-center justify-between border bg-surface-panel/40 px-3 py-2.5 transition-colors ${
                isDisabled
                  ? "cursor-not-allowed border-border-subtle/40 opacity-40"
                  : isChecked
                    ? "cursor-pointer border-primary/30 bg-primary/[0.04] hover:bg-primary/[0.07]"
                    : "cursor-pointer border-border-subtle hover:border-border hover:bg-surface-panel/80"
              }`}
              style={{ borderRadius: 0 }}
            >
              <span className="flex items-center gap-3">
                <Checkbox
                  checked={enabled[cat]}
                  onCheckedChange={() => onToggle(cat)}
                  disabled={isDisabled}
                  className="h-4 w-4"
                />
                <span
                  className={`text-meta ${isChecked ? "text-foreground" : "text-foreground/85"}`}
                >
                  {t(CATEGORY_LABEL_KEY[cat])}
                </span>
              </span>
              <span
                className={`font-mono text-2xs ${
                  isDisabled
                    ? "text-muted-foreground"
                    : isChecked
                      ? "text-primary"
                      : "text-muted-foreground"
                }`}
              >
                {isUserHangul && tokensCount > 0
                  ? `${t("library.aiCleanup.itemsCount", { count: String(count) })} · ${t(
                      "library.aiCleanup.tokensCount",
                      { count: String(tokensCount) },
                    )}`
                  : t("library.aiCleanup.itemsCount", { count: String(count) })}
              </span>
            </label>
          );
        })}
      </div>

      {/* ── LLM 호출 예상치 — Sparkles 아이콘으로 "AI 호출 비용" 컨텍스트를
          시각적으로 한 번에 전달. 단순 muted 텍스트 대비 시인성 향상. */}
      <div
        className="flex items-center gap-2 border border-border-subtle bg-surface-panel/60 px-3 py-2 text-caption text-muted-foreground"
        style={{ borderRadius: 0 }}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span>
          {llmEstimate > 0
            ? t("library.aiCleanup.estimateLlmCalls", { count: String(llmEstimate) })
            : t("library.aiCleanup.estimateNoLlm")}
        </span>
      </div>
    </div>
  );
}

function PreviewView({
  report,
  excluded,
  onToggleExclude,
}: {
  report: BackfillReport;
  excluded: Set<string>;
  onToggleExclude: (ko: string) => void;
}) {
  const t = useT();
  /* 같은 한글 토큰이 여러 자료에 등장하면 한 번만 표시(uniqueness by ko).
     사용자가 토글해 제외하면 *모든 자료에서* 그 토큰이 변환 안 됨 — 직관적. */
  const uniqueTokens = useMemo(() => {
    const map = new Map<string, { ko: string; seedHit: boolean; suggestedEn?: string }>();
    for (const ir of report.perItem) {
      for (const ht of ir.hangulTags) {
        if (!map.has(ht.ko)) map.set(ht.ko, { ko: ht.ko, seedHit: ht.seedHit, suggestedEn: ht.suggestedEn });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.ko.localeCompare(b.ko, "ko"));
  }, [report]);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex items-center justify-between bg-surface-panel/60 px-3 py-2"
        style={{ borderRadius: 0, borderLeft: "2px solid hsl(var(--primary))" }}
      >
        <span className="text-meta text-foreground">
          {t("library.aiCleanup.previewTitle")}
        </span>
        <span className="font-mono text-2xs text-muted-foreground">
          {t("library.aiCleanup.itemsCount", { count: String(uniqueTokens.length) })}
        </span>
      </div>
      <div
        className="max-h-[320px] overflow-y-auto border border-border-subtle bg-surface-panel/30"
        style={{ borderRadius: 0 }}
      >
        {uniqueTokens.map((tok) => {
          const isExcluded = excluded.has(tok.ko);
          return (
            <label
              key={tok.ko}
              className={`flex cursor-pointer items-center justify-between gap-3 border-b border-border-subtle/60 px-3 py-2 transition-colors last:border-0 hover:bg-surface-panel/80 ${
                isExcluded ? "opacity-40" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Checkbox
                  checked={!isExcluded}
                  onCheckedChange={() => onToggleExclude(tok.ko)}
                  className="h-4 w-4"
                />
                <span
                  className={`truncate text-meta ${isExcluded ? "line-through" : ""}`}
                >
                  <span className="font-medium text-foreground">{tok.ko}</span>
                  <span className="px-1.5 text-muted-foreground">→</span>
                  <span className="font-mono text-foreground/85">
                    {tok.seedHit ? tok.suggestedEn : "(LLM)"}
                  </span>
                </span>
              </span>
              <span
                className={`shrink-0 border px-1.5 py-0.5 text-2xs font-medium tracking-normal ${
                  tok.seedHit
                    ? "border-border-subtle text-muted-foreground"
                    : "border-primary/30 bg-primary/10 text-primary"
                }`}
                style={{ borderRadius: 0 }}
              >
                {tok.seedHit
                  ? t("library.aiCleanup.previewSeedHit")
                  : t("library.aiCleanup.previewSeedMiss")}
              </span>
            </label>
          );
        })}
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
