/**
 * MoodFilterChip (Phase C2)
 *
 * 라이브러리 툴바에 끼어드는 필터 칩 — Types/Tags 와 같은 형태(popover
 * trigger) 지만, popover 안에서 사용자가 자연어 한 줄을 입력하면 OpenAI
 * 가 BriefSignals 로 확장하고, 부모(LibraryPage) 가 그 신호를
 * scoreReferences() 로 매칭한다.
 *
 * 책임 분리:
 *   - 이 컴포넌트는 NL 입력/expand 호출/Recent dropdown/슬라이더 UI 만
 *     담당. 점수 매칭과 그리드 갱신은 부모가 책임.
 *   - 활성 상태(spec 보유) 일 때 칩 라벨이 "Mood: {원본 NL}" 로 바뀌고
 *     × 클릭으로 한 번에 해제할 수 있어, 다른 필터 칩과 동일한 양식.
 *
 * AbortController 일관성:
 *   - popover 가 닫히거나 새 expand 요청이 들어오면 직전 in-flight 가
 *     자동으로 끊어진다 — useEffect cleanup 으로 처리.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useT } from "@/lib/uiLanguage";
import { cn } from "@/lib/utils";
import {
  hasInventoryMatch,
  type BriefSignals,
} from "@/lib/referenceRecommender";
import {
  clampMinScore,
  DEFAULT_MOOD_MIN_SCORE,
  expandMoodQuery,
  getRecentMoodEntries,
  MOOD_MIN_SCORE_MAX,
  MOOD_MIN_SCORE_MIN,
  pickMinScore,
  rememberMoodEntry,
  removeMoodEntry,
  type MoodFilterSpec,
  type RecentMoodEntry,
} from "@/lib/moodSearch";

const SIGNAL_KEYS = [
  "mood",
  "genre",
  "lighting",
  "camera",
  "location",
  "product",
  "keywords",
] as const satisfies ReadonlyArray<keyof BriefSignals>;
type SignalKey = (typeof SIGNAL_KEYS)[number];

/** Hangul/CJK 검출 — 페어링 단에서 각 토큰을 EN 그룹과 KO/CJK 그룹으로
 *  분리하는 데 쓴다. Hangul Jamo + Syllables + 일반 CJK Ideograph 범위를
 *  모두 커버. 토큰이 짧고 정규식이 단순해 호출 비용은 무시 가능. */
const CJK_RE = /[\u3131-\u318E\uAC00-\uD7A3\u3400-\u4DBF\u4E00-\u9FFF]/;
function hasCjk(s: string): boolean {
  return CJK_RE.test(s);
}

/** 한 카테고리에서 사용자에게 보일 칩 단위.
 *  main 은 메인 라벨(주로 EN), aliases 는 함께 묶일 동의어/한글 표기.
 *  tokens 는 main + aliases 모두 — × 클릭 시 spec 에서 한 번에 제거할
 *  대상 집합이다. */
interface PairedChip {
  key: SignalKey;
  main: string;
  aliases: ReadonlyArray<string>;
  tokens: ReadonlyArray<string>;
}

/** 카테고리 토큰 배열을 EN/KO 페어 칩으로 그룹화.
 *
 *  현재 LLM 프롬프트는 한 컨셉에 대해 EN 표기와 KO 표기를 *같은 순서로*
 *  emit 하도록 가이드돼 있어, 한 카테고리에 EN 2 + KO 2 가 있으면
 *  position-zip 으로 (EN[0], KO[0]), (EN[1], KO[1]) 의 페어가 자연스럽게
 *  맞아 떨어진다. EN 1 + KO 다수("low-angle" + "로우 앵글", "로우앵글")
 *  같은 동의어 다발 케이스는 단일 EN 칩에 모든 KO 를 alias 로 부착해
 *  화면 잡음을 더 줄인다. 길이 불일치 잔여분은 각각 단독 칩으로 폴백.
 *  여기서 정렬을 추측하지 않으므로 LLM 순서가 어긋나면 페어가 약간
 *  어색해질 수 있지만, 점수/필터엔 전혀 영향이 없는 표시 레이아웃 한정
 *  로직이다. */
function pairCategoryTokens(
  key: SignalKey,
  tokens: ReadonlyArray<string>,
): PairedChip[] {
  if (tokens.length === 0) return [];
  const en = tokens.filter((t) => !hasCjk(t));
  const ko = tokens.filter((t) => hasCjk(t));
  if (en.length === 0) {
    return ko.map((t) => ({ key, main: t, aliases: [], tokens: [t] }));
  }
  if (ko.length === 0) {
    return en.map((t) => ({ key, main: t, aliases: [], tokens: [t] }));
  }
  if (en.length === 1) {
    return [{ key, main: en[0], aliases: ko, tokens: [en[0], ...ko] }];
  }
  if (ko.length === 1) {
    return [{ key, main: en[0], aliases: ko, tokens: [en[0], ...ko] }, ...en.slice(1).map((t) => ({ key, main: t, aliases: [] as string[], tokens: [t] }))];
  }
  const pairs: PairedChip[] = [];
  const max = Math.max(en.length, ko.length);
  for (let i = 0; i < max; i++) {
    const e = en[i];
    const k = ko[i];
    if (e && k) pairs.push({ key, main: e, aliases: [k], tokens: [e, k] });
    else if (e) pairs.push({ key, main: e, aliases: [], tokens: [e] });
    else if (k) pairs.push({ key, main: k, aliases: [], tokens: [k] });
  }
  return pairs;
}

/** 0건 토큰 자동 숨김 + 페어링을 한 번에 처리.
 *
 *  inventory 가 주어지면 hasInventoryMatch 로 "라이브러리 자료 중 하나
 *  라도 매치 가능한 토큰" 만 남긴다 — LLM 이 합리적으로 추정했지만
 *  자료에 한 건도 매치 안 되는 노이즈 칩을 화면에서 자동 제거. inventory
 *  가 null/undefined 면 필터 없이 전체 통과(legacy 호출/테스트용).
 *  필터된 결과를 카테고리별로 pairCategoryTokens 에 넘겨 EN/KO 페어 칩
 *  배열로 그룹화. */
function buildVisibleChips(
  signals: BriefSignals,
  inventory: ReadonlySet<string> | null | undefined,
): { mood: PairedChip[]; details: PairedChip[] } {
  const mood: PairedChip[] = [];
  const details: PairedChip[] = [];
  for (const key of SIGNAL_KEYS) {
    const filtered = inventory
      ? signals[key].filter((t) => hasInventoryMatch(t, inventory))
      : signals[key];
    const pairs = pairCategoryTokens(key, filtered);
    if (pairs.length === 0) continue;
    if (key === "mood") mood.push(...pairs);
    else details.push(...pairs);
  }
  return { mood, details };
}

/** spec 의 신호 배열에서 토큰 묶음 전체를 한 번에 제거. 칩 × 클릭의
 *  핸들러 — 한 칩이 main + aliases 다중 토큰을 묶고 있으므로 한 번의
 *  클릭으로 묶음 전체를 spec 에서 빼야 사용자 의도와 일치한다. */
function removeSignalTokens(
  signals: BriefSignals,
  key: SignalKey,
  tokens: ReadonlyArray<string>,
): BriefSignals {
  const removeSet = new Set(tokens);
  return {
    ...signals,
    [key]: signals[key].filter((t) => !removeSet.has(t)),
  };
}

function totalSignals(signals: BriefSignals): number {
  return SIGNAL_KEYS.reduce((acc, key) => acc + signals[key].length, 0);
}

export interface MoodFilterChipProps {
  spec: MoodFilterSpec | null;
  onChange: (spec: MoodFilterSpec | null) => void;
  /** 라이브러리 자료 전체의 매칭 가능 토큰 union Set.
   *  주어지면 신호 칩 렌더 단에서 0건 매치 토큰을 자동 숨김.
   *  점수/필터 계산엔 영향 없음 — 표시 잡음 제거 한정. */
  inventoryTokens?: ReadonlySet<string>;
}

export function MoodFilterChip({
  spec,
  onChange,
  inventoryTokens,
}: MoodFilterChipProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(spec?.rawQuery ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentMoodEntry[]>(() => getRecentMoodEntries());
  const abortRef = useRef<AbortController | null>(null);

  /* popover 가 닫히면 직전 in-flight 가 살아 있을 의미가 없다. 다시 열릴
     땐 사용자가 새 입력을 줄 가능성이 더 크므로 일관되게 끊는다. */
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(false);
      setError(null);
    } else {
      /* 열릴 때마다 localStorage 의 최근 목록을 한 번 refresh — 다른
         세션에서 추가된 항목이 있을 수 있다. */
      setRecent(getRecentMoodEntries());
      setDraft(spec?.rawQuery ?? "");
    }
  }, [open, spec?.rawQuery]);

  const apply = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError(null);
      try {
        const next = await expandMoodQuery(trimmed, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (totalSignals(next.signals) === 0) {
          /* 0 signals 는 cache 에도 저장하지 않으므로(lib 가 그렇게 동작)
             재시도가 가능한 상태. UI 에서는 친절한 안내만 보여 준다. */
          setError(t("library.mood.noSignals"));
          setBusy(false);
          return;
        }
        /* 슬라이더는 popover 안에서 따로 조정 가능 — 사용자가 이전 spec
           에서 직접 minScore 를 조정했다면 그 값을 보존, 그 외엔
           expandMoodQuery 가 산정한 dynamic minScore(`next.minScore`) 를
           그대로 채택한다.
           단일 명사 쿼리("청바지") 처럼 신호 풍부도가 낮은 케이스는 dynamic
           으로 0.4/0.7 로 떨어져 결과가 자연스럽게 잡힌다.
           clampMinScore 로 v2 슬라이더 상한(2.0) 내에 강제 — 과거 spec 이
           3.0 으로 박혀 있던 사용자도 자동 안전 범위로. */
        const minScore = clampMinScore(spec?.minScore ?? next.minScore);
        /* strict 도 동일하게 사용자가 직전 spec 에서 명시 조정했으면 보존,
           아니면 next 의 기본(true) 채택. AI Search 적용 시점부터 strict
           ON 이 디폴트라 첫 적용 자료는 항상 엄격 매칭부터 시작한다. */
        const strict = spec?.strict ?? next.strict;
        /* signals 까지 함께 저장해 다음에 "최근 검색" 에서 클릭하면 즉시
           복원되도록(LLM 재호출 없음). */
        rememberMoodEntry({ rawQuery: trimmed, signals: next.signals });
        setRecent(getRecentMoodEntries());
        onChange({ rawQuery: trimmed, signals: next.signals, minScore, strict });
        setBusy(false);
        setOpen(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setBusy(false);
        setError(err instanceof Error ? err.message : t("library.mood.failed"));
      }
    },
    [onChange, spec?.minScore, t],
  );

  const handleApplyClick = useCallback(() => {
    void apply(draft);
  }, [apply, draft]);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    onChange(null);
    setDraft("");
    setError(null);
    setBusy(false);
  }, [onChange]);

  /* 최근 검색 row 클릭 — 저장된 signals 가 있으면 LLM 재호출 없이 즉시
     spec 을 복원한다. legacy(v1) 항목은 signals 가 비어 있어 apply() 로
     자연스럽게 폴백 — 한 번 통과한 뒤로는 새 v2 포맷으로 갱신된다. */
  const handleRecentClick = useCallback(
    (entry: RecentMoodEntry) => {
      setDraft(entry.rawQuery);
      const hasSignals =
        entry.signals.mood.length +
          entry.signals.genre.length +
          entry.signals.product.length +
          entry.signals.location.length +
          entry.signals.lighting.length +
          entry.signals.camera.length +
          entry.signals.keywords.length >
        0;
      if (!hasSignals) {
        void apply(entry.rawQuery);
        return;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      /* expandMoodQuery 와 동일한 정책 — 사용자의 직전 슬라이더 값이
         있으면 보존, 없으면 신호 풍부도 기반 dynamic minScore.
         clampMinScore 로 v2 상한 내 강제. strict 는 spec 이 있으면 그
         값, 없으면 true 기본. */
      const minScore = clampMinScore(spec?.minScore ?? pickMinScore(entry.signals));
      const strict = spec?.strict ?? true;
      /* row 를 다시 맨 위로 올려 두는 의미에서 rememberMoodEntry 호출 —
         signals 는 그대로, savedAt 만 now() 로 갱신된다. */
      rememberMoodEntry({ rawQuery: entry.rawQuery, signals: entry.signals });
      setRecent(getRecentMoodEntries());
      onChange({ rawQuery: entry.rawQuery, signals: entry.signals, minScore, strict });
      setError(null);
      setBusy(false);
      setOpen(false);
    },
    [apply, onChange, spec?.minScore],
  );

  const handleRecentRemove = useCallback((rawQuery: string) => {
    removeMoodEntry(rawQuery);
    setRecent(getRecentMoodEntries());
  }, []);

  const active = spec !== null;
  const chipLabel = active
    ? t("library.mood.activeChip", {
        query:
          spec.rawQuery.length > 24 ? `${spec.rawQuery.slice(0, 24)}…` : spec.rawQuery,
      })
    : t("library.mood.chipLabel");

  /* 슬라이더 range — v2 dedup/weak-penalty 적용으로 raw 가중합이 낮아진 만큼
     상한도 0.3 ~ 2.0 으로 좁힘. clampMinScore 로 기존 spec 의 3.0 같은
     out-of-range 값을 즉시 정상 범위로 끌어내린다 — 사용자가 슬라이더를
     움직이지 않아도 다음 렌더에서 자동 정상화. */
  const minScore = clampMinScore(spec?.minScore ?? DEFAULT_MOOD_MIN_SCORE);
  const handleMinScoreChange = useCallback(
    (v: number) => {
      if (!spec) return;
      onChange({ ...spec, minScore: clampMinScore(v) });
    },
    [onChange, spec],
  );
  /* Strict 토글 — 기본 true. 즉시 onChange 로 spec 갱신하면 LibraryPage 의
     moodScoreMap useMemo 가 재계산돼 그리드가 바로 좁아지거나 넓어진다.
     LLM 재호출 없음 — 같은 signals 위에서 게이트만 켰다 껐다. */
  const strict = spec?.strict ?? true;
  const handleStrictToggle = useCallback(() => {
    if (!spec) return;
    onChange({ ...spec, strict: !strict });
  }, [onChange, spec, strict]);

  /* 칩 렌더용 데이터.
     · 0 건 자동 숨김: inventoryTokens 가 주어지면 LLM 추정 토큰 중 라이브러리
       에 한 자료도 매치되지 않는 것은 칩에서 제외.
     · EN/KO 페어링: 한 컨셉의 EN/KO 표기를 하나의 칩으로 묶어 라벨 잡음을
       줄임. main 옆에 동의어를 작게 부가 표시.
     · mood/details 분리: mood 는 사용자가 가장 의식적으로 보는 신호라
       헤더로 분리하고, 그 외는 details 로 묶어 보조 정보임을 표시. */
  const visibleChips = useMemo(
    () => (spec ? buildVisibleChips(spec.signals, inventoryTokens ?? null) : { mood: [], details: [] }),
    [spec, inventoryTokens],
  );
  const moodChips = visibleChips.mood;
  const detailChips = visibleChips.details;
  /* count 는 *화면에 노출된 유효 신호 토큰 수* 와 일치시켜, 칩 안 보이는데
     배지만 큰 숫자로 뜨는 회귀를 막는다. spec 에 21 개 토큰이 있어도
     0건 필터로 5 개만 보이면 배지도 5 로 표기. inventory prop 이 없으면
     legacy 동작(전체 신호 수)으로 폴백. */
  const count = useMemo(() => {
    if (!spec) return 0;
    const visibleTokenCount =
      moodChips.reduce((acc, c) => acc + c.tokens.length, 0)
      + detailChips.reduce((acc, c) => acc + c.tokens.length, 0);
    if (!inventoryTokens) return Math.max(1, totalSignals(spec.signals));
    return visibleTokenCount > 0 ? visibleTokenCount : 0;
  }, [detailChips, inventoryTokens, moodChips, spec]);

  return (
    <span className="relative inline-flex">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "h-8 gap-1.5 px-2 text-caption",
              /* 활성 상태 — 옆 Moods/Folder/Tags 칩(FilterChipShell) 과 동일한
                 브랜드 red 톤. 아이콘·라벨·카운트 배지까지 한 덩어리로 정렬
                 되도록 text-primary 적용. amber 강조는 의미 근거 없어 제거. */
              active && "border-primary/60 bg-primary/10 text-primary",
            )}
            style={{ borderRadius: 0 }}
            title={active ? spec.rawQuery : t("library.mood.placeholder")}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="max-w-[200px] truncate">{chipLabel}</span>
            {count > 0 ? (
              <span
                className={cn(
                  "ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center px-1 font-mono text-micro",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
                style={{ borderRadius: 0 }}
              >
                {count}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="rounded-none p-0"
          style={{ width: 360 }}
        >
          <div className="flex flex-col gap-3 p-3">
            <div className="space-y-1.5">
              <label className="block text-caption font-semibold tracking-[0.04em] text-muted-foreground">
                {t("library.mood.chipLabel")}
              </label>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("library.mood.placeholder")}
                rows={2}
                className="w-full resize-none border border-border-subtle bg-surface-panel px-2 py-1.5 text-meta text-text-secondary placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                style={{ borderRadius: 0 }}
                onKeyDown={(event) => {
                  /* Enter (no shift) → Apply. Shift+Enter 는 줄바꿈 유지. */
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleApplyClick();
                  }
                }}
              />
              {error ? (
                <p className="text-caption text-destructive">{error}</p>
              ) : null}
            </div>

            {/* 추출된 신호 미리보기 — mood 와 details 두 그룹으로 분리.
                · Mood: 헤더 + 약간 큰 칩(h-24px font-medium), 카테고리 prefix 생략.
                · Details: 작은 outline 칩(h-22px), "category:" prefix 유지.
                두 그룹 모두 brand-neutral 톤 — 노란색 강조는 의미 근거가
                없어 제거. mood 의 시각 우선순위는 *크기/굵기* 로 유지된다.
                칩 하나에 EN + KO 동의어가 묶여 있을 수 있고, × 클릭 시
                묶음 전체가 spec 에서 빠진다. */}
            {spec && (moodChips.length > 0 || detailChips.length > 0) ? (
              <div className="space-y-2">
                {moodChips.length > 0 ? (
                  <div className="space-y-1.5">
                    <span className="block text-2xs font-semibold tracking-normal text-muted-foreground">
                      {t("library.mood.signalsMood")}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {moodChips.map((chip) => (
                        <button
                          key={`${chip.key}:${chip.main}`}
                          type="button"
                          title={t("library.mood.removeSignal")}
                          onClick={() =>
                            onChange({
                              ...spec,
                              signals: removeSignalTokens(spec.signals, chip.key, chip.tokens),
                            })
                          }
                          className="inline-flex h-[24px] items-center gap-1.5 border border-border-subtle bg-transparent px-2 text-meta font-medium text-text-secondary transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-foreground"
                          style={{ borderRadius: 0 }}
                        >
                          <span>{chip.main}</span>
                          {chip.aliases.length > 0 ? (
                            <span className="text-2xs font-normal text-muted-foreground/70">
                              {chip.aliases.join(", ")}
                            </span>
                          ) : null}
                          <X className="h-2.5 w-2.5 opacity-70" aria-hidden />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {detailChips.length > 0 ? (
                  <div
                    className={cn(
                      "space-y-1.5",
                      moodChips.length > 0 && "border-t border-dashed border-border-subtle/60 pt-2",
                    )}
                  >
                    <span className="block text-2xs font-semibold tracking-normal text-muted-foreground">
                      {t("library.mood.signalsDetails")}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {detailChips.map((chip) => (
                        <button
                          key={`${chip.key}:${chip.main}`}
                          type="button"
                          title={t("library.mood.removeSignal")}
                          onClick={() =>
                            onChange({
                              ...spec,
                              signals: removeSignalTokens(spec.signals, chip.key, chip.tokens),
                            })
                          }
                          className="inline-flex h-[22px] items-center gap-1 border border-border-subtle bg-transparent px-1.5 text-2xs text-text-secondary transition-colors hover:border-destructive/50 hover:bg-destructive/10"
                          style={{ borderRadius: 0 }}
                        >
                          <span className="text-muted-foreground/70">{chip.key}:</span>
                          <span>{chip.main}</span>
                          {chip.aliases.length > 0 ? (
                            <span className="text-muted-foreground/50">
                              {chip.aliases.join(", ")}
                            </span>
                          ) : null}
                          <X className="h-2.5 w-2.5 opacity-70" aria-hidden />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Strict matching 토글 — 활성 spec 있을 때만 보임. Min relevance
                슬라이더 위에 한 줄로 — 사용자가 게이트와 임계를 가까이 놓고
                튜닝할 수 있게. 토글 변경 시 즉시 onChange → moodScoreMap 재계산.
                ON 일 때 brand primary(red), OFF 일 때 muted — amber 강조는
                의미 근거가 없어 제거. */}
            {spec ? (
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="text-2xs font-semibold tracking-normal text-muted-foreground">
                    {t("library.mood.strict")}
                  </span>
                  <span className="text-2xs leading-snug text-muted-foreground/70">
                    {t("library.mood.strictHint")}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={strict}
                  onClick={handleStrictToggle}
                  className={cn(
                    "relative inline-flex h-4 w-7 shrink-0 items-center border transition-colors",
                    strict
                      ? "border-primary/70 bg-primary/30"
                      : "border-border-subtle bg-surface-panel hover:bg-muted/60",
                  )}
                  style={{ borderRadius: 0 }}
                  title={t("library.mood.strictHint")}
                >
                  <span
                    className={cn(
                      "block h-2.5 w-2.5 transition-transform",
                      strict ? "translate-x-3.5 bg-primary" : "translate-x-0.5 bg-muted-foreground/70",
                    )}
                    style={{ borderRadius: 0 }}
                    aria-hidden
                  />
                </button>
              </div>
            ) : null}

            {/* Min relevance slider — active 일 때만 의미가 있어 spec 없으면 숨김.
                v2 에서 raw 가중합이 낮아진 만큼 범위도 0.3 ~ 2.0 으로 좁혔다. */}
            {spec ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-2xs font-semibold tracking-normal text-muted-foreground">
                    {t("library.mood.minRelevance")}
                  </span>
                  <span className="font-mono text-2xs text-text-secondary">
                    {minScore.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  min={MOOD_MIN_SCORE_MIN}
                  max={MOOD_MIN_SCORE_MAX}
                  step={0.1}
                  value={minScore}
                  onChange={(event) =>
                    handleMinScoreChange(Number(event.target.value))
                  }
                  className="w-full accent-primary"
                />
              </div>
            ) : null}

            {/* Recent queries — 저장된 signals 그대로 복원해 LLM 재호출 없이
                즉시 적용. row hover 시 X 버튼이 노출돼 개별 삭제 가능. */}
            {recent.length > 0 ? (
              <div className="space-y-1">
                <span className="block text-2xs font-semibold tracking-normal text-muted-foreground">
                  {t("library.mood.recent")}
                </span>
                <div className="flex flex-col gap-0.5">
                  {recent.map((entry) => (
                    <div
                      key={entry.rawQuery}
                      className="group flex items-stretch gap-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => handleRecentClick(entry)}
                        className="min-w-0 flex-1 truncate px-2 py-1 text-left text-caption text-text-secondary hover:bg-muted/40 hover:text-foreground"
                        title={entry.rawQuery}
                      >
                        {entry.rawQuery}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRecentRemove(entry.rawQuery);
                        }}
                        aria-label={t("library.mood.removeRecent")}
                        title={t("library.mood.removeRecent")}
                        className="inline-flex w-6 items-center justify-center text-muted-foreground/0 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:text-muted-foreground/70"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
              <button
                type="button"
                onClick={handleClear}
                disabled={!active && !draft}
                className={cn(
                  "h-7 px-2 text-caption transition-colors",
                  active || draft
                    ? "text-muted-foreground hover:text-foreground"
                    : "cursor-not-allowed text-muted-foreground/50",
                )}
              >
                {t("library.mood.clear")}
              </button>
              <Button
                size="sm"
                variant="default"
                onClick={handleApplyClick}
                disabled={busy || draft.trim().length === 0}
                className="h-7 gap-1.5 px-3 text-caption"
                style={{ borderRadius: 0 }}
              >
                {busy ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    <span>{t("library.mood.thinking")}</span>
                  </>
                ) : (
                  <span>{t("library.mood.apply")}</span>
                )}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {active ? (
        <button
          type="button"
          aria-label={t("library.mood.clear")}
          title={t("library.mood.clear")}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleClear();
          }}
          className="absolute -right-1.5 -top-1.5 z-10 inline-flex h-4 w-4 items-center justify-center rounded-full bg-neutral-700 text-neutral-200 ring-1 ring-neutral-900 transition-colors hover:bg-neutral-600 hover:text-white"
        >
          <X className="h-2.5 w-2.5" strokeWidth={3} />
        </button>
      ) : null}
    </span>
  );
}
