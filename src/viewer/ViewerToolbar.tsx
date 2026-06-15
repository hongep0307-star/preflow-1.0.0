import { PanelRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ViewerSelect } from "./ViewerSelect";
import { vt } from "./i18n";
import type { ReferenceKind } from "./types";
import type { ViewerFilterState, ViewerSort } from "./state/viewerFilters";

/* 상단 툴바 — 검색 + 종류 토글 + 정렬 + 크기 슬라이더 + 카운트.
 * 메인 앱 LibraryToolbar 의 핵심을 뷰어용으로 추린 것. radix 의존을 피해
 * VideoPlayer 와 동일하게 네이티브 <select>/<input range> 를 쓴다. */

const KIND_KEY: Record<ReferenceKind, Parameters<typeof vt>[1]> = {
  image: "kindImage",
  webp: "kindWebp",
  gif: "kindGif",
  video: "kindVideo",
  youtube: "kindYoutube",
  link: "kindUrl",
  doc: "kindDoc",
};

const SORT_KEY: Record<ViewerSort, Parameters<typeof vt>[1]> = {
  imported_desc: "sortNewest",
  imported_asc: "sortOldest",
  title: "sortTitle",
  duration_desc: "sortDuration",
};

interface ViewerToolbarProps {
  filters: ViewerFilterState;
  onChange: (next: ViewerFilterState) => void;
  availableKinds: ReferenceKind[];
  rowHeight: number;
  onRowHeightChange: (h: number) => void;
  totalCount: number;
  visibleCount: number;
  language: "ko" | "en";
  onLanguageChange: (lang: "ko" | "en") => void;
  /** 인스펙터 패널 토글 — 현재 열림 여부 + 토글 콜백. */
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function ViewerToolbar({
  filters,
  onChange,
  availableKinds,
  rowHeight,
  onRowHeightChange,
  totalCount,
  visibleCount,
  language,
  onLanguageChange,
  inspectorOpen,
  onToggleInspector,
}: ViewerToolbarProps) {
  const toggleKind = (kind: ReferenceKind) => {
    const next = new Set(filters.kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange({ ...filters, kinds: next });
  };

  const hasActiveFilters =
    filters.query.trim() !== "" ||
    filters.kinds.size > 0 ||
    filters.tags.size > 0 ||
    filters.folderPath !== null ||
    filters.color !== null;

  const clearAll = () =>
    onChange({
      ...filters,
      query: "",
      kinds: new Set(),
      tags: new Set(),
      folderPath: null,
      color: null,
    });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
      {/* 검색 — 너비를 뷰포트 기준(clamp)으로 고정. 이전엔 flex-1 이라 우측
          카운트("25"→"7 / 25")·Clear 버튼이 생기면 함께 줄어들어 폭이 흔들렸다.
          shrink-0 + 고정폭으로 필터 토글과 무관하게 항상 동일 너비를 유지한다. */}
      <div className="relative flex h-8 w-[clamp(220px,32vw,460px)] shrink-0 items-center">
        <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          placeholder={vt(language, "searchPlaceholder")}
          className="h-8 w-full border border-border-subtle bg-background pl-7 pr-7 text-meta outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
          style={{ borderRadius: 0 }}
        />
        {filters.query ? (
          <button
            type="button"
            onClick={() => onChange({ ...filters, query: "" })}
            className="absolute right-1.5 flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
            title={vt(language, "clear")}
            aria-label={vt(language, "clear")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {/* 종류 토글 */}
      {availableKinds.length > 1 ? (
        <div className="flex items-center gap-1">
          {availableKinds.map((kind) => {
            const active = filters.kinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                className={cn(
                  "h-8 border px-2 text-caption transition-colors",
                  active
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border-subtle text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                style={{ borderRadius: 0 }}
                aria-pressed={active}
              >
                {vt(language, KIND_KEY[kind])}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* 색 필터 활성 칩 */}
      {filters.color ? (
        <button
          type="button"
          onClick={() => onChange({ ...filters, color: null })}
          className="flex h-8 items-center gap-1.5 border border-border-subtle px-2 text-caption text-muted-foreground hover:text-foreground"
          style={{ borderRadius: 0 }}
          title={`${filters.color} — ${vt(language, "colorFilterClear")}`}
        >
          <span
            className="h-4 w-4 border border-border ring-1 ring-inset ring-white/20"
            style={{ backgroundColor: filters.color }}
          />
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}

      <div className="flex-1" />

      {/* 카운트 */}
      <span className="font-mono text-2xs text-muted-foreground">
        {visibleCount === totalCount
          ? `${totalCount.toLocaleString()}`
          : `${visibleCount.toLocaleString()} / ${totalCount.toLocaleString()}`}
      </span>

      {/* 정렬 */}
      <ViewerSelect
        value={filters.sort}
        options={(Object.keys(SORT_KEY) as ViewerSort[]).map((sort) => ({
          value: sort,
          label: vt(language, SORT_KEY[sort]),
        }))}
        onChange={(sort) => onChange({ ...filters, sort })}
        title={vt(language, "sortLabel")}
        className="shrink-0"
      />

      {/* 크기 슬라이더 */}
      <input
        type="range"
        min={120}
        max={320}
        step={20}
        value={rowHeight}
        onChange={(event) => onRowHeightChange(Number(event.target.value))}
        className="h-8 w-24 cursor-pointer accent-primary"
        title={vt(language, "thumbnailSize")}
        aria-label={vt(language, "thumbnailSize")}
      />

      {/* 언어 토글 — AI 분석 표시 언어(KO/EN). */}
      <div className="flex h-8 shrink-0 items-center border border-border-subtle" style={{ borderRadius: 0 }}>
        {(["en", "ko"] as const).map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => onLanguageChange(lang)}
            className={cn(
              "h-full px-2 text-caption uppercase transition-colors",
              language === lang
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={language === lang}
            title={lang === "ko" ? "한국어" : "English"}
          >
            {lang}
          </button>
        ))}
      </div>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={clearAll}
          className="h-8 border border-border-subtle px-2 text-caption text-muted-foreground hover:border-primary/40 hover:text-foreground"
          style={{ borderRadius: 0 }}
        >
          {vt(language, "clear")}
        </button>
      ) : null}

      {/* 인스펙터 토글 — 닫은 뒤 복구 진입점. */}
      <button
        type="button"
        onClick={onToggleInspector}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center border transition-colors",
          inspectorOpen
            ? "border-primary bg-primary/15 text-foreground"
            : "border-border-subtle text-muted-foreground hover:border-primary/40 hover:text-foreground",
        )}
        style={{ borderRadius: 0 }}
        aria-pressed={inspectorOpen}
        title={vt(language, "toggleInspector")}
        aria-label={vt(language, "toggleInspector")}
      >
        <PanelRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
