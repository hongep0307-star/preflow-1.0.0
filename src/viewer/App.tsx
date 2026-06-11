import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelRightClose, X } from "lucide-react";
import { ViewerGrid } from "./Grid";
import { PreviewModal } from "./PreviewModal";
import { ViewerInspector } from "./ViewerInspector";
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

export function ViewerApp({ data }: ViewerAppProps) {
  const items = data.items;
  const [modalId, setModalId] = useState<string | null>(null);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readPersistedWidth());

  const modalIndex = useMemo(() => {
    if (!modalId) return -1;
    return items.findIndex((item) => item.id === modalId);
  }, [items, modalId]);
  const modalItem: ReferenceItem | null = modalIndex >= 0 ? items[modalIndex] : null;

  const inspectorItem: ReferenceItem | null = useMemo(() => {
    if (!inspectorId) return null;
    return items.find((item) => item.id === inspectorId) ?? null;
  }, [items, inspectorId]);

  const closeModal = useCallback(() => setModalId(null), []);
  const goPrev = useCallback(() => {
    setModalId((current) => {
      if (!current) return current;
      const idx = items.findIndex((item) => item.id === current);
      if (idx <= 0) return current;
      return items[idx - 1]?.id ?? current;
    });
  }, [items]);
  const goNext = useCallback(() => {
    setModalId((current) => {
      if (!current) return current;
      const idx = items.findIndex((item) => item.id === current);
      if (idx < 0 || idx >= items.length - 1) return current;
      return items[idx + 1]?.id ?? current;
    });
  }, [items]);

  /* 카드 더블클릭 분기:
   *   - link / youtube → source_url 을 외부 브라우저로 즉시 오픈
   *   - 그 외 (이미지/비디오/GIF) → 큰 화면 모달
   *   더블클릭으로 외부 링크를 여는 것은 메인 앱과 동일한 UX 이지만, 사이드바
   *   인스펙터에서도 같은 onOpen 콜백을 공유하기 위해 한 곳에 모은다. */
  const handleOpen = useCallback((item: ReferenceItem) => {
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
  }, []);

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
        event.preventDefault();
        goPrev();
      } else if (event.key === "ArrowRight") {
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
        <main className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-meta text-muted-foreground">
              No items.
            </div>
          ) : (
            <ViewerGrid
              items={items}
              selectedId={inspectorId}
              onSelect={handleSelect}
              onOpen={handleOpen}
            />
          )}
        </main>

        {inspectorItem ? (
          <Sidebar
            width={sidebarWidth}
            onResize={setSidebarWidth}
            onClose={() => setInspectorId(null)}
          >
            <ViewerInspector item={inspectorItem} onOpen={() => handleOpen(inspectorItem)} />
          </Sidebar>
        ) : null}
      </div>

      {modalItem ? (
        <ModalChrome
          title={modalItem.title}
          index={modalIndex}
          total={items.length}
          onClose={closeModal}
          onPrev={modalIndex > 0 ? goPrev : null}
          onNext={modalIndex < items.length - 1 ? goNext : null}
        >
          <PreviewModal item={modalItem} />
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

/* ── Sidebar — 좌측 가장자리 드래그로 리사이즈 가능한 컨테이너 ──
 *
 * mousemove/mouseup 은 window 에 attach 해 빠른 드래그에도 cursor 가
 * 컨테이너를 벗어나면서 잡지 못하는 사고를 막는다. handle 위에 hover 영역을
 * 4px → 8px 로 확장(가시 너비는 1px) 해 잡기 쉽게. */
interface SidebarProps {
  width: number;
  onResize: (next: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}

function Sidebar({ width, onResize, onClose, children }: SidebarProps) {
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

      {/* 헤더 — 닫기 버튼 한 개. 메인 앱처럼 X 버튼이 우상단. */}
      <div className="flex h-9 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          Inspector
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Close inspector"
          aria-label="Close inspector"
          style={{ borderRadius: 0 }}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
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
  children: React.ReactNode;
}

/* PreviewModal 자체는 콘텐츠만 그린다. 닫기/네비 버튼·헤더·바깥
 * 클릭으로 닫기 같은 chrome 은 여기서 분리해 PreviewModal 내부 로직이
 * 단순해진다. tabIndex+autoFocus 로 모달이 열리자마자 키 이벤트가 모달
 * 컨테이너에서 시작되게 한다 — Space 가 그리드에서 *마지막으로 클릭된
 * 버튼* 에 잘못 활성화되는 사고를 막는다. */
function ModalChrome({ title, index, total, onClose, onPrev, onNext, children }: ModalChromeProps) {
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
            title="Previous (←)"
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center border border-white/10 text-white/80 disabled:opacity-30 hover:bg-white/10"
            style={{ borderRadius: 0 }}
            disabled={!onNext}
            onClick={() => onNext?.()}
            title="Next (→)"
            aria-label="Next"
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
          title="Close (ESC)"
          aria-label="Close"
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
