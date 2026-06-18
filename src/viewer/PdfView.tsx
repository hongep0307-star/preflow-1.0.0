import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
/* 단일 HTML 뷰어는 외부 파일을 fetch 할 수 없으므로(특히 single-html 모드의
 *  data: URI), pdf 워커를 별도 .mjs 파일(?url) 로 두면 동작하지 않는다.
 *  Vite 의 `?worker&inline` 은 워커 코드를 base64 로 번들 안에 인라인해
 *  Blob 워커 생성자를 돌려주므로, 추가 네트워크 요청 없이 자체 완결적으로
 *  동작한다. 메인 앱(Electron + local-server)이 쓰는 `?url` 와 다른 점. */
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";
import { cn } from "@/lib/utils";
import { RegionView } from "./RegionView";
import { vt, type ViewerLang } from "./i18n";
import type { ReferenceItem, TimestampNote } from "./types";

/* 뷰어 전용 *읽기 전용* PDF 뷰어.
 *
 * 메인 앱 src/components/library/preview/PdfViewer.tsx 의 렌더/줌/팬/페이지
 * 네비게이션 로직을 그대로 가져오되, 영역 드로잉·편집·삭제(=RegionOverlay)
 * 는 제거하고 읽기 전용 RegionView 로 교체했다. "Open with default app"
 * 같은 Electron 의존도 제거하고, 대신 새 탭 열기 링크만 둔다.
 *
 * NotesPanel 의 슬라이드 노트 행을 클릭하면 그 노트의 pageIndex 로 점프해야
 * 하므로, GifPlayer/VideoPlayer 와 동일한 registerSeek 패턴으로 페이지 점프
 * 핸들러를 부모(PreviewModal)에 등록한다. */

/* 인라인 Blob 워커를 전역 workerPort 로 한 번 설정. pdfjs 는 외부에서 받은
 *  port 를 문서 destroy 시 terminate 하지 않으므로(내부 생성 _webWorker 만
 *  종료), 모달이 자료를 바꿔 가며 여러 PDF 를 순차 로드해도 같은 워커를
 *  안전하게 재사용한다. */
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const FIT_PADDING_PX = 32;

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

interface PdfViewProps {
  item: ReferenceItem;
  /** 이 자료의 timestamp_notes 전체. 현재 페이지(pageIndex)에 anchor 된
   *  region 노트만 골라 RegionView 로 표시. */
  notes?: TimestampNote[];
  /** NotesPanel 의 슬라이드 노트 행 클릭 → 그 페이지(1-based)로 점프. */
  registerSeek?: (seek: (pageIndex: number) => void) => void;
  /** 현재 페이지가 바뀔 때 부모에 알림 — NotesPanel active 행 강조용. */
  onPageUpdate?: (pageIndex: number) => void;
  language?: ViewerLang;
}

export function PdfView({ item, notes, registerSeek, onPageUpdate, language = "en" }: PdfViewProps) {
  const fileUrl = item.file_url ?? "";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const [pageCssSize, setPageCssSize] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [fitMode, setFitMode] = useState<"fit" | "manual">("fit");
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const pendingZoomAnchorRef = useRef<{
    fracX: number;
    fracY: number;
    cursorClientX: number;
    cursorClientY: number;
  } | null>(null);

  const totalPages = pdf?.numPages ?? 0;

  /* PDF 문서 로드. 워커는 자료마다 새로 만들어(인라인 Blob 워커) 문서와 함께
     destroy 해 메모리/포트를 깔끔히 정리한다. */
  useEffect(() => {
    if (!fileUrl) {
      setPdf(null);
      setError("no-url");
      setLoading(false);
      return;
    }
    let cancelled = false;
    let loadedDoc: PdfDocument | null = null;
    setPdf(null);
    setError(null);
    setLoading(true);
    setPageIndex(1);
    setZoom(1);
    setFitMode("fit");
    (async () => {
      try {
        const task = pdfjsLib.getDocument({ url: fileUrl });
        const doc = await task.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        loadedDoc = doc;
        setPdf(doc);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.warn("[PdfView] load failed", err);
        setError((err as Error)?.message || "load-failed");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (loadedDoc) {
        try { loadedDoc.destroy(); } catch { /* noop */ }
      }
    };
  }, [fileUrl, item.id]);

  /* 컨테이너 크기 추적 — fit zoom 계산용. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* fit zoom 계산 — 자연 viewport 대비 컨테이너 가용 공간 비율 중 작은 쪽. */
  useEffect(() => {
    if (!pdf) return;
    if (fitMode !== "fit") return;
    if (containerSize.w <= 0 || containerSize.h <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageIndex);
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        const availW = Math.max(1, containerSize.w - FIT_PADDING_PX);
        const availH = Math.max(1, containerSize.h - FIT_PADDING_PX);
        const fitScale = Math.min(availW / v.width, availH / v.height);
        const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fitScale));
        setZoom((prev) => (Math.abs(prev - clamped) < 0.001 ? prev : clamped));
      } catch {
        /* getPage 실패는 로드 effect 의 error 분기가 처리. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex, containerSize.w, containerSize.h, fitMode]);

  /* 현재 페이지 렌더. */
  useEffect(() => {
    if (!pdf) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    (async () => {
      try {
        const page = await pdf.getPage(pageIndex);
        if (cancelled) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const baseViewport = page.getViewport({ scale: zoom });
        const rawW = baseViewport.width * dpr;
        const rawH = baseViewport.height * dpr;
        const clampScale = Math.min(1, 8192 / Math.max(rawW, rawH));
        const finalScale = zoom * dpr * clampScale;
        const viewport = page.getViewport({ scale: finalScale });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const cssW = Math.round(viewport.width / dpr);
        const cssH = Math.round(viewport.height / dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        setPageCssSize((prev) =>
          prev && prev.w === cssW && prev.h === cssH ? prev : { w: cssW, h: cssH },
        );

        const pendingAnchor = pendingZoomAnchorRef.current;
        if (pendingAnchor && scrollRef.current) {
          const newCanvasRect = canvas.getBoundingClientRect();
          const targetCursorX = newCanvasRect.left + pendingAnchor.fracX * newCanvasRect.width;
          const targetCursorY = newCanvasRect.top + pendingAnchor.fracY * newCanvasRect.height;
          scrollRef.current.scrollLeft += targetCursorX - pendingAnchor.cursorClientX;
          scrollRef.current.scrollTop += targetCursorY - pendingAnchor.cursorClientY;
          pendingZoomAnchorRef.current = null;
        }

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = page.render({ canvasContext: ctx, viewport } as any);
        renderTask = task as unknown as { cancel: () => void };
        await task.promise;
      } catch (err) {
        const msg = (err as Error)?.message ?? "";
        if (msg.includes("Rendering cancelled")) return;
        console.warn("[PdfView] render failed", err);
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) {
        try { renderTask.cancel(); } catch { /* noop */ }
      }
    };
  }, [pdf, pageIndex, zoom]);

  /* NotesPanel 슬라이드 노트 점프 — 부모가 호출할 수 있게 핸들러 등록.
     pdf 가 로드된 뒤 등록되므로 numPages 로 안전하게 clamp 한다. */
  useEffect(() => {
    if (!registerSeek) return;
    registerSeek((target) => {
      const total = pdf?.numPages ?? 0;
      const clamped = total > 0
        ? Math.max(1, Math.min(total, Math.floor(target)))
        : Math.max(1, Math.floor(target));
      setPageIndex(clamped);
    });
  }, [registerSeek, pdf]);

  /* 현재 페이지 변경을 부모에 알림 — NotesPanel active 행 강조. */
  useEffect(() => {
    onPageUpdate?.(pageIndex);
  }, [pageIndex, onPageUpdate]);

  /* 현재 페이지에 anchor 된 region 노트만 오버레이에 표시. */
  const visibleNotes = useMemo(
    () => (notes ?? []).filter((note) => note.region && note.pageIndex === pageIndex),
    [notes, pageIndex],
  );

  const handlePrev = useCallback(() => {
    setPageIndex((p) => Math.max(1, p - 1));
  }, []);
  const handleNext = useCallback(() => {
    setPageIndex((p) => Math.min(totalPages || 1, p + 1));
  }, [totalPages]);
  const handleZoomIn = useCallback(() => {
    setFitMode("manual");
    setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  }, []);
  const handleZoomOut = useCallback(() => {
    setFitMode("manual");
    setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  }, []);
  const handleFit = useCallback(() => {
    setFitMode("fit");
  }, []);

  /* 휠 줌 — 커서 위치 중심. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      event.preventDefault();
      setFitMode("manual");

      const canvasRect = canvas.getBoundingClientRect();
      const insideCanvas =
        event.clientX >= canvasRect.left
        && event.clientX <= canvasRect.right
        && event.clientY >= canvasRect.top
        && event.clientY <= canvasRect.bottom;
      if (insideCanvas && canvasRect.width > 0 && canvasRect.height > 0) {
        pendingZoomAnchorRef.current = {
          fracX: (event.clientX - canvasRect.left) / canvasRect.width,
          fracY: (event.clientY - canvasRect.top) / canvasRect.height,
          cursorClientX: event.clientX,
          cursorClientY: event.clientY,
        };
      } else {
        pendingZoomAnchorRef.current = null;
      }

      const dir = -Math.sign(event.deltaY);
      if (dir === 0) return;
      setZoom((prev) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + dir * 0.1));
        return Math.round(next * 100) / 100;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handlePanMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!pdf) return;
    if (event.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.closest("button") || target.tagName === "INPUT")) return;
    event.preventDefault();
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
    setIsPanning(true);
  }, [pdf]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const s = panStartRef.current;
      const el = scrollRef.current;
      if (!s || !el) return;
      const dx = event.clientX - s.x;
      const dy = event.clientY - s.y;
      el.scrollLeft = s.sl - dx;
      el.scrollTop = s.st - dy;
    };
    const onUp = () => {
      if (!panStartRef.current) return;
      panStartRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /* 더블클릭 = fit 으로 리셋. */
  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!pdf) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.closest("button") || target.tagName === "INPUT")) return;
    event.preventDefault();
    handleFit();
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
  }, [handleFit, pdf]);

  /* 단축키 — 캡처 단계에서 잡아 그리드/모달 네비와 충돌 회피.
     - Ctrl/Cmd + ← → : 페이지 이동 (plain ← → 는 모달 자료 이동에 양보)
     - PageUp / PageDown : 페이지 이동
     - + - : 줌 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (mod && event.key === "ArrowLeft") {
        handled();
        handlePrev();
      } else if (mod && event.key === "ArrowRight") {
        handled();
        handleNext();
      } else if (event.key === "PageUp") {
        handled();
        handlePrev();
      } else if (event.key === "PageDown") {
        handled();
        handleNext();
      } else if (!mod && (event.key === "+" || event.key === "=")) {
        handled();
        handleZoomIn();
      } else if (!mod && (event.key === "-" || event.key === "_")) {
        handled();
        handleZoomOut();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleNext, handlePrev, handleZoomIn, handleZoomOut]);

  const zoomPct = useMemo(() => Math.round(zoom * 100), [zoom]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-panel px-2">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30"
          style={{ borderRadius: 0 }}
          onClick={handlePrev}
          disabled={pageIndex <= 1 || !pdf}
          title={vt(language, "pdfPrev")}
          aria-label={vt(language, "pdfPrev")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {totalPages > 0 ? `${pageIndex} / ${totalPages}` : "—"}
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30"
          style={{ borderRadius: 0 }}
          onClick={handleNext}
          disabled={pageIndex >= totalPages || !pdf}
          title={vt(language, "pdfNext")}
          aria-label={vt(language, "pdfNext")}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        <div className="mx-2 h-4 w-px bg-border-subtle" aria-hidden />

        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30"
          style={{ borderRadius: 0 }}
          onClick={handleZoomOut}
          disabled={zoom <= ZOOM_MIN || !pdf}
          title={vt(language, "pdfZoomOut")}
          aria-label={vt(language, "pdfZoomOut")}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {zoomPct}%
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30"
          style={{ borderRadius: 0 }}
          onClick={handleZoomIn}
          disabled={zoom >= ZOOM_MAX || !pdf}
          title={vt(language, "pdfZoomIn")}
          aria-label={vt(language, "pdfZoomIn")}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-30",
            fitMode === "fit" && pdf && "bg-primary/15 text-primary",
          )}
          style={{ borderRadius: 0 }}
          onClick={handleFit}
          disabled={!pdf}
          title={vt(language, "pdfFit")}
          aria-label={vt(language, "pdfFit")}
          aria-pressed={fitMode === "fit"}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>

        <div className="flex-1" />

        {fileUrl ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-7 items-center gap-1.5 border border-border-subtle px-2 text-caption text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            style={{ borderRadius: 0 }}
            title={vt(language, "pdfOpenNewTab")}
          >
            <ExternalLink className="h-3 w-3" />
            {vt(language, "pdfOpenNewTab")}
          </a>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        onMouseDown={handlePanMouseDown}
        onDoubleClick={handleDoubleClick}
        className={cn(
          "relative flex-1 overflow-auto bg-neutral-900",
          pdf && !error && (isPanning ? "cursor-grabbing" : "cursor-grab"),
        )}
      >
        <div className="flex min-h-full min-w-full items-start p-4 [justify-content:safe_center]">
          {error ? (
            <div className="flex max-w-md flex-col items-center gap-3 px-8 py-12 text-center text-muted-foreground">
              <div className="text-label font-medium text-foreground">
                {vt(language, "pdfLoadFailed")}
              </div>
              <div className="font-mono text-2xs text-muted-foreground/70">{error}</div>
              {fileUrl ? (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-8 items-center gap-1.5 border border-border-subtle px-3 text-meta text-foreground hover:bg-muted/40"
                  style={{ borderRadius: 0 }}
                >
                  <ExternalLink className="h-3 w-3" />
                  {vt(language, "pdfOpenNewTab")}
                </a>
              ) : null}
            </div>
          ) : loading ? (
            <div className="py-20 text-center font-mono text-caption text-muted-foreground/70">
              {vt(language, "pdfLoading")}
            </div>
          ) : (
            <div
              ref={pageWrapRef}
              className="relative shadow-lg shadow-black/40"
              style={{
                width: pageCssSize ? pageCssSize.w : undefined,
                height: pageCssSize ? pageCssSize.h : undefined,
              }}
            >
              <canvas ref={canvasRef} style={{ display: "block" }} />
              <RegionView
                containerRef={pageWrapRef}
                naturalWidth={pageCssSize?.w ?? null}
                naturalHeight={pageCssSize?.h ?? null}
                visibleNotes={visibleNotes}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
