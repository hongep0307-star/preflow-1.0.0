import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Link as LinkIcon, X } from "lucide-react";
import { ViewerGrid } from "./Grid";
import { PreviewModal } from "./PreviewModal";
import { ViewerInspector } from "./ViewerInspector";
import { ViewerToolbar } from "./ViewerToolbar";
import { FolderTree } from "./FolderTree";
import { TagChips } from "./TagChips";
import {
  EMPTY_FILTERS,
  applyFilters,
  foldersFromTags,
  presentKinds,
  tagFrequencies,
  type ViewerFilterState,
} from "./state/viewerFilters";
import { readHashState, writeHashState } from "./state/hashState";
import { isOpenable } from "./linkPlatform";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem, ViewerData } from "./types";

interface ViewerAppProps {
  data: ViewerData;
}

/* 최상위 viewer 컴포넌트.
 *
 * 책임:
 *   - 상단 헤더 (제목 + 생성 시각 + 아이템 개수)
 *   - 그리드 + 우측 사이드바 인스펙터 (싱글 클릭 → 인스펙터 활성)
 *   - 더블 클릭 → 미디어는 큰 화면 모달, link/youtube 는 외부 브라우저
 *   - 모달 안의 prev/next 키보드/버튼 네비게이션 (←/→/ESC)
 *
 * 사이드바 너비는 좌측 가장자리를 드래그해 리사이즈 가능. 마지막 값은
 * localStorage 에 보관해 새로고침/다음 탐색에서도 유지된다. */

const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_LS_KEY = "preflow.viewer.sidebar.width";

const ROW_HEIGHT_DEFAULT = 180;
const ROW_HEIGHT_MIN = 120;
const ROW_HEIGHT_MAX = 320;
const ROW_HEIGHT_LS_KEY = "preflow.viewer.rowHeight";
const FOLDER_PANEL_WIDTH = 220;
const LANG_LS_KEY = "preflow.viewer.lang";

export function ViewerApp({ data }: ViewerAppProps) {
  const items = data.items;
  const [modalId, setModalId] = useState<string | null>(null);
  /* 초기 인스펙터/필터는 URL hash 딥링크에서 복원. */
  const [inspectorId, setInspectorId] = useState<string | null>(() => {
    const id = readHashState().itemId;
    return id && items.some((item) => item.id === id) ? id : null;
  });
  /* 인스펙터를 닫아도 마지막으로 본 항목을 기억해, 툴바 토글로 같은 항목을
   *  다시 열 수 있게 한다(닫으면 복구 못 하던 문제 해결). */
  const [lastInspectorId, setLastInspectorId] = useState<string | null>(() => inspectorId);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readPersistedWidth());
  const [rowHeight, setRowHeight] = useState<number>(() => readPersistedRowHeight());
  const [filters, setFilters] = useState<ViewerFilterState>(() => {
    const h = readHashState();
    return { ...EMPTY_FILTERS, query: h.query ?? "", folderPath: h.folder ?? null };
  });
  const [language, setLanguage] = useState<"ko" | "en">(() => readInitialLanguage(data));

  /* 폴더 트리 소스 — export 스냅샷 우선, 없으면 tags 의 folder: prefix 폴백. */
  const folders = useMemo(
    () => (data.folders && data.folders.length > 0 ? data.folders : foldersFromTags(items)),
    [data.folders, items],
  );

  const availableKinds = useMemo(() => presentKinds(items), [items]);

  /* 필터 통과 + 정렬된 최종 표시 목록. */
  const visibleItems = useMemo(() => applyFilters(items, filters), [items, filters]);

  /* 태그 칩 빈도 — 선택 태그를 *제외한* 나머지 필터 기준으로 집계해, 태그를
   *  하나 골라도 함께 고를 수 있는 다른 태그가 사라지지 않게 한다. */
  const tagFreq = useMemo(() => {
    const base = applyFilters(items, { ...filters, tags: new Set() });
    return tagFrequencies(base);
  }, [items, filters]);

  const modalIndex = useMemo(() => {
    if (!modalId) return -1;
    return visibleItems.findIndex((item) => item.id === modalId);
  }, [visibleItems, modalId]);
  const modalItem: ReferenceItem | null = modalIndex >= 0 ? visibleItems[modalIndex] : null;

  /* 인스펙터는 전체 items 에서 해석 — 필터로 카드가 가려져도 사이드바는
   *  열린 상태를 유지한다(의도치 않게 닫히는 사고 방지). */
  const inspectorItem: ReferenceItem | null = useMemo(() => {
    if (!inspectorId) return null;
    return items.find((item) => item.id === inspectorId) ?? null;
  }, [items, inspectorId]);

  const closeModal = useCallback(() => setModalId(null), []);
  const goPrev = useCallback(() => {
    setModalId((current) => {
      if (!current) return current;
      const idx = visibleItems.findIndex((item) => item.id === current);
      if (idx <= 0) return current;
      return visibleItems[idx - 1]?.id ?? current;
    });
  }, [visibleItems]);
  const goNext = useCallback(() => {
    setModalId((current) => {
      if (!current) return current;
      const idx = visibleItems.findIndex((item) => item.id === current);
      if (idx < 0 || idx >= visibleItems.length - 1) return current;
      return visibleItems[idx + 1]?.id ?? current;
    });
  }, [visibleItems]);

  /* 카드 더블클릭 분기:
   *   - link / youtube → source_url 을 외부 브라우저로 즉시 오픈
   *   - 그 외 (이미지/비디오/GIF) → 큰 화면 모달
   *   더블클릭으로 외부 링크를 여는 것은 메인 앱과 동일한 UX 이지만, 사이드바
   *   인스펙터에서도 같은 onOpen 콜백을 공유하기 위해 한 곳에 모은다. */
  const handleOpen = useCallback((item: ReferenceItem) => {
    /* 뷰어가 표시 못 하는 자료(zip/문서/실행파일 등)는 더블클릭으로 모달을
     *  열지 않는다. PDF/오디오/미디어/링크는 openable 이라 통과. */
    if (!isOpenable(item)) return;
    if ((item.kind === "link" || item.kind === "youtube") && item.source_url) {
      try {
        window.open(item.source_url, "_blank", "noopener,noreferrer");
      } catch {
        /* 차단된 경우(예: file:// 컨텍스트의 브라우저 정책)에는 모달로 폴백 */
        setModalId(item.id);
      }
      return;
    }
    setModalId(item.id);
  }, []);

  /* 싱글 클릭 → 사이드바. 다시 같은 항목을 클릭해도 그대로 유지(닫는 토글
   *  로 두지 않은 이유: 한번 열린 인스펙터를 의도치 않게 닫는 사고를 막음).
   *  사이드바 자체의 X 버튼으로만 닫도록. */
  const handleSelect = useCallback((item: ReferenceItem) => {
    setInspectorId(item.id);
    setLastInspectorId(item.id);
  }, []);

  /* 툴바 인스펙터 토글: 열려 있으면 닫고, 닫혀 있으면 마지막 항목(없거나
   *  사라졌으면 현재 보이는 첫 항목)을 연다. */
  const handleToggleInspector = useCallback(() => {
    setInspectorId((current) => {
      if (current) {
        setLastInspectorId(current);
        return null;
      }
      const fallback =
        lastInspectorId && items.some((item) => item.id === lastInspectorId)
          ? lastInspectorId
          : visibleItems[0]?.id ?? items[0]?.id ?? null;
      return fallback;
    });
  }, [items, visibleItems, lastInspectorId]);

  /* 모달 키보드 단축키 — 모달이 열려 있을 때만. Inspector 가 열려 있어도
   *  모달이 없으면 ESC/Arrow 는 흘려 보낸다 (Space 는 VideoPlayer 자체가
   *  capture 단계에서 처리). */
  useEffect(() => {
    if (!modalId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      } else if (event.key === "ArrowLeft") {
        /* 수식키+화살표는 VideoPlayer 의 ±5/10초 시크 전용 — 자료 이동 안 함. */
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        goPrev();
      } else if (event.key === "ArrowRight") {
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal, goNext, goPrev, modalId]);

  /* 사이드바 폭 변경 시 디바운스 없이 즉시 localStorage 에 기록 — drag
   *  종료가 mouseup 한 번이라 setItem 폭주 위험이 낮다. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SIDEBAR_LS_KEY, String(sidebarWidth));
    } catch {
      /* 사용자가 localStorage 를 차단한 경우엔 그냥 무시 — 다음 세션에서
       *  기본값으로 폴백. */
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ROW_HEIGHT_LS_KEY, String(rowHeight));
    } catch {
      /* localStorage 차단 시 무시. */
    }
  }, [rowHeight]);

  /* 언어 선택 영속 + <html lang> 동기화(폰트/줄바꿈 등 일부 CSS 의존). */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LANG_LS_KEY, language);
    } catch {
      /* 무시. */
    }
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", language);
    }
  }, [language]);

  /* 상태 -> URL hash 동기화 (인스펙터 아이템 / 폴더 / 검색어). */
  useEffect(() => {
    writeHashState({ itemId: inspectorId, folder: filters.folderPath, query: filters.query });
  }, [inspectorId, filters.folderPath, filters.query]);

  /* 마운트 시 딥링크 아이템으로 스크롤 — 그리드 레이아웃이 width 측정 후
   *  그려지므로 다음 프레임에 한 번 시도. */
  useEffect(() => {
    const id = readHashState().itemId;
    if (!id) return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`viewer-card-${id}`);
      el?.scrollIntoView({ block: "center" });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generatedLabel = useMemo(() => {
    if (!data.generated_at) return null;
    const date = new Date(data.generated_at);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, [data.generated_at]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-subtle px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate text-body font-semibold">{data.title}</span>
          <span className="font-mono text-2xs text-muted-foreground">
            {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {generatedLabel ? (
            <span className="font-mono text-2xs text-muted-foreground">{generatedLabel}</span>
          ) : null}
          <span className="font-mono text-2xs text-muted-foreground">Pre-Flow Viewer</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {folders.length > 0 ? (
          <nav
            className="flex-shrink-0 overflow-y-auto border-r border-border-subtle bg-background"
            style={{ width: FOLDER_PANEL_WIDTH }}
          >
            <FolderTree
              folders={folders}
              selectedPath={filters.folderPath}
              onSelect={(path) => setFilters((prev) => ({ ...prev, folderPath: path }))}
              language={language}
            />
          </nav>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <ViewerToolbar
            filters={filters}
            onChange={setFilters}
            availableKinds={availableKinds}
            rowHeight={rowHeight}
            onRowHeightChange={setRowHeight}
            totalCount={items.length}
            visibleCount={visibleItems.length}
            language={language}
            onLanguageChange={setLanguage}
            inspectorOpen={inspectorItem !== null}
            onToggleInspector={handleToggleInspector}
          />

          {tagFreq.length > 0 ? (
            <div className="border-b border-border-subtle px-4 py-2">
              <TagChips
                frequencies={tagFreq}
                selected={filters.tags}
                onToggle={(tag) =>
                  setFilters((prev) => {
                    const next = new Set(prev.tags);
                    if (next.has(tag)) next.delete(tag);
                    else next.add(tag);
                    return { ...prev, tags: next };
                  })
                }
              />
            </div>
          ) : null}

          <main className="min-h-0 flex-1 overflow-auto">
            {items.length === 0 ? (
              <div className="flex h-full items-center justify-center text-meta text-muted-foreground">
                No items.
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="flex h-full items-center justify-center text-meta text-muted-foreground">
                No items match the current filters.
              </div>
            ) : (
              <ViewerGrid
                items={visibleItems}
                selectedId={inspectorId}
                onSelect={handleSelect}
                onOpen={handleOpen}
                targetRowHeight={rowHeight}
              />
            )}
          </main>
        </div>

        {inspectorItem ? (
          <Sidebar
            width={sidebarWidth}
            onResize={setSidebarWidth}
            language={language}
          >
            <ViewerInspector
              item={inspectorItem}
              onOpen={() => handleOpen(inspectorItem)}
              language={language}
            />
          </Sidebar>
        ) : null}
      </div>

      {modalItem ? (
        <ModalChrome
          title={modalItem.title}
          index={modalIndex}
          total={visibleItems.length}
          onClose={closeModal}
          onPrev={modalIndex > 0 ? goPrev : null}
          onNext={modalIndex < visibleItems.length - 1 ? goNext : null}
          language={language}
        >
          <PreviewModal item={modalItem} language={language} />
        </ModalChrome>
      ) : null}
    </div>
  );
}

function readPersistedWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LS_KEY);
    if (!raw) return SIDEBAR_DEFAULT_WIDTH;
    const num = Number(raw);
    if (!Number.isFinite(num)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, num));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readPersistedRowHeight(): number {
  if (typeof window === "undefined") return ROW_HEIGHT_DEFAULT;
  try {
    const raw = window.localStorage.getItem(ROW_HEIGHT_LS_KEY);
    if (!raw) return ROW_HEIGHT_DEFAULT;
    const num = Number(raw);
    if (!Number.isFinite(num)) return ROW_HEIGHT_DEFAULT;
    return Math.max(ROW_HEIGHT_MIN, Math.min(ROW_HEIGHT_MAX, num));
  } catch {
    return ROW_HEIGHT_DEFAULT;
  }
}

/* 초기 언어 — localStorage 저장값 -> export 시점 source_language -> navigator
 *  순으로 폴백. */
function readInitialLanguage(data: ViewerData): "ko" | "en" {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(LANG_LS_KEY);
      if (saved === "ko" || saved === "en") return saved;
    } catch {
      /* 무시. */
    }
  }
  if (data.source_language === "ko" || data.source_language === "en") {
    return data.source_language;
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
  }
  return "en";
}

/* ── Sidebar — 좌측 가장자리 드래그로 리사이즈 가능한 컨테이너 ──
 *
 * mousemove/mouseup 은 window 에 attach 해 빠른 드래그에도 cursor 가
 * 컨테이너를 벗어나면서 잡지 못하는 사고를 막는다. handle 위에 hover 영역을
 * 4px → 8px 로 확장(가시 너비는 1px) 해 잡기 쉽게. */
interface SidebarProps {
  width: number;
  onResize: (next: number) => void;
  language: ViewerLang;
  children: React.ReactNode;
}

/* 현재 URL(딥링크 hash 포함)을 클립보드로 복사. file:// 경로도 그대로
 *  복사되어 받는 사람이 같은 아이템/폴더/검색 상태로 열 수 있다. */
function CopyLinkButton({ language }: { language: ViewerLang }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(location.href)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, []);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      title={vt(language, "copyLink")}
      aria-label={vt(language, "copyLink")}
      style={{ borderRadius: 0 }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <LinkIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

function Sidebar({ width, onResize, language, children }: SidebarProps) {
  const draggingRef = useRef(false);
  const startRef = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current || !startRef.current) return;
      /* 드래그 방향: 사이드바가 *오른쪽* 에 붙어 있으므로 left handle 을
       *  오른쪽으로 끌면 너비가 줄어들고, 왼쪽으로 끌면 너비가 늘어난다.
       *  delta = startX - currentX. */
      const delta = startRef.current.x - event.clientX;
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startRef.current.width + delta),
      );
      onResize(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      startRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onResize]);

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    startRef.current = { x: event.clientX, width };
    /* 드래그 동안 텍스트 선택 / 마우스 커서 변동 방지. mouseup 에서 복구. */
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <aside
      className="relative flex-shrink-0 border-l border-border-subtle bg-background"
      style={{ width }}
    >
      {/* 좌측 가장자리 드래그 핸들 — 가시 너비 1px, hit area 6px. */}
      <div
        className="absolute -left-[3px] top-0 z-10 h-full w-[6px] cursor-ew-resize select-none"
        onMouseDown={handleMouseDown}
        title="Drag to resize"
      >
        <div className="pointer-events-none absolute inset-y-0 left-[2px] w-px bg-transparent transition-colors hover:bg-primary/40" />
      </div>

      {/* 헤더 — 링크 복사 + 닫기. 메인 앱처럼 우상단 액션. */}
      <div className="flex h-9 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-caption font-medium tracking-wide text-muted-foreground">
          {vt(language, "inspector")}
        </span>
        <div className="flex items-center gap-0.5">
          <CopyLinkButton language={language} />
        </div>
      </div>
      <div className="h-[calc(100%-2.25rem)] min-h-0">{children}</div>
    </aside>
  );
}

interface ModalChromeProps {
  title: string;
  index: number;
  total: number;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  language: ViewerLang;
  children: React.ReactNode;
}

/* PreviewModal 자체는 콘텐츠만 그린다. 닫기/네비 버튼·헤더·바깥
 * 클릭으로 닫기 같은 chrome 은 여기서 분리해 PreviewModal 내부 로직이
 * 단순해진다. tabIndex+autoFocus 로 모달이 열리자마자 키 이벤트가 모달
 * 컨테이너에서 시작되게 한다 — Space 가 그리드에서 *마지막으로 클릭된
 * 버튼* 에 잘못 활성화되는 사고를 막는다. */
function ModalChrome({ title, index, total, onClose, onPrev, onNext, language, children }: ModalChromeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex flex-col focus:outline-none"
      style={{ background: "rgba(0,0,0,0.92)" }}
      onClick={onClose}
    >
      <div
        className="flex h-12 flex-shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border border-white/10 text-white/80 disabled:opacity-30 hover:bg-white/10"
            style={{ borderRadius: 0 }}
            disabled={!onPrev}
            onClick={() => onPrev?.()}
            title={vt(language, "modalPrev")}
            aria-label={vt(language, "modalPrev")}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border border-white/10 text-white/80 disabled:opacity-30 hover:bg-white/10"
            style={{ borderRadius: 0 }}
            disabled={!onNext}
            onClick={() => onNext?.()}
            title={vt(language, "modalNext")}
            aria-label={vt(language, "modalNext")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="min-w-0 px-3 text-center">
          <div className="truncate text-meta font-semibold text-white">{title}</div>
          <div className="font-mono text-2xs text-white/50">
            {index + 1} / {total}
          </div>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center border border-white/10 text-white/80 hover:bg-white/10"
          style={{ borderRadius: 0 }}
          onClick={onClose}
          title={vt(language, "modalClose")}
          aria-label={vt(language, "modalClose")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
