import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxSelect, ChevronLeft, ChevronRight, ExternalLink, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUiLanguage } from "@/lib/uiLanguage";
import { RegionOverlay } from "@/components/library/RegionOverlay";
import {
  openReferenceWithDefaultApp,
  type ReferenceItem,
  type RegionRect,
  type TimestampNote,
} from "@/lib/referenceLibrary";

/* 인앱 PDF 뷰어 — pdfjs-dist 로 한 번에 한 페이지를 캔버스에 렌더한다.
 *
 * 같은 라이브러리는 이미 src/lib/docThumbnails.ts 에서 PDF 첫 페이지 썸네일
 * 생성에 쓰고 있어 GlobalWorkerOptions 가 한 번 설정되어 있지만, 이 컴포넌트
 * 단독으로 동작해도 안전하도록 idempotent 하게 한 번 더 덮어쓴다.
 *
 * 메모리 안전을 위해 현재 페이지 1장만 캔버스에 그린다(전체 페이지를 미리
 * 렌더해 둘 수도 있지만 100+ 페이지 PDF 에서 GPU/RAM 폭발 위험). 페이지
 * 전환은 prev/next 버튼 또는 입력값으로. zoom 은 50%~400% 사이를 25% 스텝.
 *
 * 실패 케이스(파일 깨짐 / 비밀번호 / 네트워크) 는 폴백 카드 + "Open with
 * default app" — 사용자가 OS PDF 뷰어에서 직접 열도록 안내. */

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
/* 컨테이너 fit 계산 시 회색 패딩(p-4 = 16px*2) 만큼 빼서 정확히 들어가도록. */
const FIT_PADDING_PX = 32;

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

interface PdfViewerProps {
  item: ReferenceItem;
  /** 슬라이드 노트 — 이 자료의 timestamp_notes 전체. PdfViewer 가 현재
   *  페이지(pageIndex)에 anchor 된 region 노트만 골라 RegionOverlay 로 표시.
   *  미전달이면 노트 기능 자체가 비활성(영역 토글 버튼도 숨김). */
  notes?: TimestampNote[];
  /** 새 슬라이드 노트 저장 — 현재 페이지 번호를 함께 넘겨 부모가 pageIndex
   *  anchor 를 박는다. */
  onCreateRegion?: (region: RegionRect, text: string, pageIndex: number) => void;
  onEditRegion?: (noteId: string, text: string) => void;
  onDeleteRegion?: (noteId: string) => void;
  /** Inspector 노트 행 클릭으로 큰 프리뷰가 열린(또는 이미 열려 있는) 직후
   *  1회 점프할 페이지(1-based). GIF 의 initialFrameIndex 와 같은 큐잉 패턴. */
  initialPageIndex?: number | null;
  onInitialPageConsumed?: () => void;
}

export function PdfViewer({
  item,
  notes,
  onCreateRegion,
  onEditRegion,
  onDeleteRegion,
  initialPageIndex,
  onInitialPageConsumed,
}: PdfViewerProps) {
  const { t } = useUiLanguage();
  const fileUrl = item.file_url ?? "";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /* 캔버스를 정확히 감싸는 relative 래퍼 — RegionOverlay 의 좌표 기준.
     래퍼 크기 = 캔버스 CSS 크기(= 페이지 비율) 이므로 RegionOverlay 의
     letterbox 계산이 전체 박스를 반환해 region [0,1] 이 페이지에 1:1 매핑된다.
     스크롤/줌 시 캔버스와 함께 이동하므로 panX/panY/scale 전달이 불필요. */
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  /* 현재 렌더된 페이지의 CSS px 크기 — 래퍼 크기 + RegionOverlay naturalSize. */
  const [pageCssSize, setPageCssSize] = useState<{ w: number; h: number } | null>(null);
  /* 영역(슬라이드 노트) 드로잉 모드 토글. ON 이면 RegionOverlay 가 crosshair
     드래그를 캡처하고, 드래그 팬/더블클릭 fit 은 잠시 비활성. */
  const [regionMode, setRegionMode] = useState(false);
  /* 컨테이너 ref — 실제 가용 픽셀을 ResizeObserver 로 추적해 fit zoom 을
     계산한다. PDF 의 자연 viewport(point) 가 컨테이너에 들어가는 비율을
     골라 작은 패널에서도 거대한 여백 없이 페이지가 바로 차게 보여진다.
     동시에 드래그 팬의 스크롤 조작 / 휠 줌 의 cursor 좌표 측정 기준도 됨. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /* fitMode — "fit" 이면 컨테이너 크기에 자동 맞춤, "manual" 이면 사용자가
     줌 버튼/단축키로 명시 변경한 줌을 유지. 기본은 fit 으로 시작해 첫 페이지
     로드 직후 사용자가 별도 조작 없이도 "딱 맞는 크기"로 보게 한다. 사용자가
     줌 인/아웃 / 휠 줌을 사용하면 자동으로 "manual" 로 전환되어 의도된 줌이
     리사이즈로 흩어지지 않는다. 툴바의 Fit 버튼 또는 더블클릭으로 언제든
     다시 fit. */
  const [fitMode, setFitMode] = useState<"fit" | "manual">("fit");
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* 드래그 팬 — 손바닥 커서로 캔버스를 끌어 이동. mousedown 에서 시작 좌표
     + 현재 scroll 위치를 스냅샷으로 저장하고, window mousemove 가 그 기준
     delta 만큼 scrollLeft/scrollTop 을 직접 갱신한다. transform 기반 하이
     브리드도 시도해 봤으나, transformed 자식의 bounding box 가 scroll 컨테
     이너의 scrollWidth/Height 계산에 포함되면서 scroll 범위가 매 프레임
     늘었다 줄었다 하는 피드백이 발생해 우측 드래그 시 진동(trembling) 이
     생겼다. 현대 브라우저의 scrollLeft setter 는 mousemove 와 같이 묶여
     60fps 로 paint 되므로 직접 조작만으로도 충분히 부드럽다. */
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  /* 휠 줌 시 "cursor 위치의 content point 가 그 자리에 머무르도록" 스크롤을
     보정하기 위한 anchor. wheel 이벤트 시점에 cursor 가 캔버스 위의 어느
     비율(fracX, fracY) 에 있었는지와 화면상 px 좌표를 저장하고, 줌이 적용돼
     canvas 가 새 크기로 다시 그려진 직후 render effect 가 scrollLeft/Top 을
     보정해 같은 content 지점이 cursor 아래에 머무르게 한다. */
  const pendingZoomAnchorRef = useRef<{
    fracX: number;
    fracY: number;
    cursorClientX: number;
    cursorClientY: number;
  } | null>(null);

  const totalPages = pdf?.numPages ?? 0;

  /* PDF 문서 로드. item 이 바뀌면 이전 문서를 destroy 해 worker 메모리 해제. */
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
    /* 새 자료에서는 항상 fit 으로 시작 — 이전 자료에서 사용자가 수동 줌을
       만져 manual 로 전환됐다 해도, 새 PDF 는 다시 "패널에 딱 맞는" 기본
       크기로 보여야 자연스럽다. */
    setFitMode("fit");
    (async () => {
      try {
        /* pdfjs 의 url 모드는 fetch 로 가져온다. local-server URL(http://127.0.0.1)
           양쪽 모두 같은 경로로 동작. PDF 가 워크스페이스 외부 CDN 인 경우는
           현재 라이브러리 모델상 없지만(모든 자료는 local-server 가 서빙),
           안전하게 withCredentials 같은 옵션은 건드리지 않는다. */
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
        console.warn("[PdfViewer] load failed", err);
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

  /* 컨테이너 크기 추적 — fit zoom 계산용. ResizeObserver 가 없는 옛 환경은
     window resize 로 폴백. clientWidth/Height 는 padding 을 *포함하지 않은*
     content area 픽셀이라 그대로 fit 계산에 쓸 수 있지만, p-4 의 padding 이
     별도 자식 박스로 그려지지 않고 컨테이너의 padding 으로 들어가는 구조라
     FIT_PADDING_PX 를 한 번 더 빼지는 않는다 — clientHeight 가 이미 padding
     안쪽 영역을 가리키기 때문. (만약 추후 padding 을 inner div 로 옮기면
     그 시점에 빼주면 됨.) */
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

  /* fit zoom 계산 — pdf 로드 + 컨테이너 측정 + 페이지 변경 + fit 모드 토글
     중 하나라도 바뀌면 다시 계산. 자연 page viewport(scale=1) 의 width/height
     대비 컨테이너 가용 공간 비율 중 작은 쪽을 골라 letterbox(가로 또는 세로
     중 하나만 100%) 가 되도록 한다. 가로/세로 비율이 컨테이너와 비슷하면
     양쪽 100% 에 가까운 값이 나온다. */
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
        /* getPage 실패는 별도 로드 effect 의 error 분기가 이미 잡으므로 여기서는 무시. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex, containerSize.w, containerSize.h, fitMode]);

  /* 현재 페이지 렌더. pageIndex/zoom 둘 다 deps. 이전 렌더가 진행 중이면
     RenderTask.cancel() 으로 취소해 race 회피. */
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
        /* 디바이스 픽셀 비율을 반영해 고DPI 디스플레이에서 흐리지 않게.
           단, 너무 큰 zoom × DPR 조합은 canvas 가 GPU 한계를 넘을 수 있어
           안전한 상한(8192px) 으로 clamp. */
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const baseViewport = page.getViewport({ scale: zoom });
        const rawW = baseViewport.width * dpr;
        const rawH = baseViewport.height * dpr;
        const clampScale = Math.min(1, 8192 / Math.max(rawW, rawH));
        const finalScale = zoom * dpr * clampScale;
        const viewport = page.getViewport({ scale: finalScale });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        /* CSS 픽셀 기준 크기를 별도로 박아 둬야 DPR 적용한 캔버스가 화면에
           4× 크기로 그려지지 않는다. */
        const cssW = Math.round(viewport.width / dpr);
        const cssH = Math.round(viewport.height / dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        /* 래퍼 + RegionOverlay 가 이 크기를 따라가도록 상태로 기록. 동일
           값이면 setState 를 건너뛰어 불필요한 리렌더/루프를 피한다. */
        setPageCssSize((prev) =>
          prev && prev.w === cssW && prev.h === cssH ? prev : { w: cssW, h: cssH },
        );

        /* 휠 줌 anchor 적용 — canvas 가 막 새 크기로 리사이즈된 *직후* 이 시점에
           scrollLeft/scrollTop 을 보정해 cursor 위치 아래의 content point 가
           그대로 유지되도록 한다. getBoundingClientRect 가 새 사이즈를 반영
           하려면 layout flush 가 필요한데, 그 호출 자체가 동기 reflow 를
           유발하므로 별도 처리는 불필요. setZoom 직후 React 가 일괄 처리한
           단일 wheel 제스처에 대해 한 번만 anchor 가 set 되어 있어, 여러
           render frame 에 걸쳐 누적 보정되지 않는다. */
        const pendingAnchor = pendingZoomAnchorRef.current;
        if (pendingAnchor && scrollRef.current) {
          const newCanvasRect = canvas.getBoundingClientRect();
          const targetCursorX = newCanvasRect.left + pendingAnchor.fracX * newCanvasRect.width;
          const targetCursorY = newCanvasRect.top + pendingAnchor.fracY * newCanvasRect.height;
          /* 목표: 이 픽셀 좌표가 cursor 의 실제 위치에 와야 함. 그러려면
             scroll 을 (target - actualCursor) 만큼 증가시켜 캔버스가 그만큼
             왼쪽/위로 이동하게 한다. */
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
        /* pdfjs 가 render cancel 시 던지는 표식 — 정상 흐름이라 무시. */
        if (msg.includes("Rendering cancelled")) return;
        console.warn("[PdfViewer] render failed", err);
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) {
        try { renderTask.cancel(); } catch { /* noop */ }
      }
    };
  }, [pdf, pageIndex, zoom]);

  /* Inspector 노트 점프 — initialPageIndex 가 유효 값으로 들어오면 그 페이지로
     1회 이동 후 onInitialPageConsumed 로 클리어. pdf 가 로드된 뒤에만 적용해
     load effect 의 pageIndex=1 리셋과의 순서 문제를 피한다(load 완료 후 실행).
     큰 프리뷰가 이미 열려 있어도 initialPageIndex 가 새 값으로 바뀌면 다시
     점프한다. */
  useEffect(() => {
    if (!pdf) return;
    if (initialPageIndex == null || !Number.isFinite(initialPageIndex)) return;
    const target = Math.max(1, Math.min(pdf.numPages, Math.round(initialPageIndex)));
    setPageIndex(target);
    onInitialPageConsumed?.();
  }, [pdf, initialPageIndex, onInitialPageConsumed]);

  /* 현재 페이지에 anchor 된 region 노트만 오버레이에 표시. */
  const visibleNotes = useMemo(
    () => (notes ?? []).filter((note) => note.region && note.pageIndex === pageIndex),
    [notes, pageIndex],
  );

  const handleRegionCreate = useCallback(
    (region: RegionRect, text: string) => {
      onCreateRegion?.(region, text, pageIndex);
    },
    [onCreateRegion, pageIndex],
  );

  /* RegionOverlay popover 닫힘 시 영역 모드 자동 OFF — 단발 드로잉(이미지
     프리뷰와 동일 UX). */
  const handleAfterRegion = useCallback(() => {
    setRegionMode(false);
  }, []);

  const handlePrev = useCallback(() => {
    setPageIndex((p) => Math.max(1, p - 1));
  }, []);
  const handleNext = useCallback(() => {
    setPageIndex((p) => Math.min(totalPages || 1, p + 1));
  }, [totalPages]);
  /* 사용자가 명시적으로 줌을 조작하면 manual 모드로 전환 — 그래야 다음 창
     리사이즈 / 페이지 전환 때 fit 계산이 다시 끼어들어 의도한 줌이 흩어지지
     않는다. Fit 버튼으로 언제든 다시 fit 모드로 돌아갈 수 있다. */
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
    /* 실제 zoom 갱신은 위 fit zoom effect 가 처리 — fitMode 토글만으로 충분. */
  }, []);
  const handleOpenExternal = useCallback(async () => {
    try {
      await openReferenceWithDefaultApp(item);
    } catch (err) {
      console.warn("[PdfViewer] openExternal failed", err);
    }
  }, [item]);

  /* 휠 줌 — Eagle 식. 일반 휠 = 커서 위치 중심 줌, 트랙패드 핀치(ctrlKey wheel)
     도 동일. 페이지 스크롤이 필요할 땐 드래그 팬을 사용. wheel 시점에 cursor
     가 캔버스의 어느 비율(0..1) 에 있는지 측정해 pendingZoomAnchorRef 에 저장
     하고, render effect 가 canvas 를 새 크기로 다시 그린 직후 scroll 을 보정
     해 같은 content 지점이 cursor 아래에 머무르게 한다. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      event.preventDefault();
      setFitMode("manual");

      /* cursor 가 캔버스 박스 *위에* 있어야만 anchor 보정 의미가 있다.
         캔버스 밖(회색 여백) 에서 휠을 굴리면 그냥 줌만 하고 anchor 는 두지
         않아 — 그러면 scroll 보정이 일어나지 않아 cursor 가 콘텐츠 밖이어도
         자연스럽게 줌이 적용된다. */
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

      /* deltaY 부호 반대 = 위로 굴리면 확대. step 0.1 = 한 noch 당 ±10%.
         트랙패드 핀치는 deltaY 가 작은 연속 값으로 들어와 그대로 sign 만
         보면 12.5% 정도씩 잘게 줌이 되어 자연스럽다. */
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
    /* 영역 모드 ON 이면 드래그를 RegionOverlay 의 crosshair 드로잉에 양보 —
       여기서 팬을 시작하면 새 region 드래그가 스크롤로 새 버린다. */
    if (regionMode) return;
    if (event.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    /* preventDefault 로 native 텍스트 선택 / 이미지 drag-out 이 일어나지 않게.
       하지만 button/input 같은 자식 요소의 활성화는 막지 않도록 target 체크. */
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
  }, [pdf, regionMode]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const s = panStartRef.current;
      const el = scrollRef.current;
      if (!s || !el) return;
      /* threshold 없이 첫 픽셀부터 즉시 따라옴. scrollLeft setter 는 음수 /
         maxScrollLeft 초과 값을 브라우저가 자동으로 clamp 하므로 별도
         clamp 가 불필요하다 — 게다가 매 프레임 scrollWidth 를 읽지 않아
         transform 기반 모델 때 발생하던 scroll 범위 재계산 → 재진동 루프를
         원천적으로 피한다. */
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

  /* 더블클릭 = fit 으로 리셋. handleFit 이 fitMode 만 토글해도 위 fit zoom
     effect 가 컨테이너 크기 기준으로 zoom 을 다시 계산해 적용. 추가로
     scrollLeft/Top 도 0 으로 초기화해 fit 직후 좌상단부터 보이게 한다. */
  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!pdf) return;
    /* 영역 모드 중에는 더블클릭 fit 리셋을 막아 드로잉 흐름을 방해하지 않는다. */
    if (regionMode) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.closest("button") || target.tagName === "INPUT")) return;
    event.preventDefault();
    handleFit();
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollRef.current.scrollTop = 0;
    }
  }, [handleFit, pdf, regionMode]);

  /* 단축키 — *캡처 단계* (addEventListener 3번째 인자 true) 로 등록한다.
     라이브러리 그리드가 화살표를 버블 전에 가로채 레퍼런스 이동에 쓰므로,
     처리할 키는 캡처에서 먼저 잡고 stopPropagation 으로 그리드까지 내려가지
     않게 막는다.

     키 정책(영상 프리뷰와 동일한 결을 맞춤):
       - plain ← → : *건드리지 않음* → 그리드의 레퍼런스(이전/다음 자료) 이동에
         양보. (영상에서 plain ← → 가 레퍼런스 이동인 것과 동일.)
       - Ctrl/Cmd + ← → : PDF 페이지 이동. (영상의 Ctrl+방향키 5초 이동과 같은
         결.)
       - PageUp / PageDown : 페이지 이동(레퍼런스 이동과 충돌 없음).
       - + - : 줌.
       - R : 슬라이드 노트 영역 토글.
     IME(한글) 상태에서도 동작하도록 R 은 물리 키 event.code === "KeyR" 도 본다. */
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
      } else if (
        (event.key === "r" || event.key === "R" || event.code === "KeyR")
        && !mod && !event.altKey
      ) {
        /* R — 슬라이드 노트 영역 토글. 노트 기능이 배선된 경우에만. */
        if (!onCreateRegion) return;
        handled();
        setRegionMode((v) => !v);
      }
      /* plain ← → 는 어떤 분기에도 안 걸려 그대로 전파 → 그리드 레퍼런스 이동. */
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleNext, handlePrev, handleZoomIn, handleZoomOut, onCreateRegion]);

  const zoomPct = useMemo(() => Math.round(zoom * 100), [zoom]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-panel px-2">
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handlePrev}
          disabled={pageIndex <= 1 || !pdf}
          title={t("library.preview.pdfPrev")}
          aria-label={t("library.preview.pdfPrev")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {totalPages > 0 ? `${pageIndex} / ${totalPages}` : "—"}
        </span>
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleNext}
          disabled={pageIndex >= totalPages || !pdf}
          title={t("library.preview.pdfNext")}
          aria-label={t("library.preview.pdfNext")}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        <div className="mx-2 h-4 w-px bg-border-subtle" aria-hidden />

        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleZoomOut}
          disabled={zoom <= ZOOM_MIN || !pdf}
          title={t("library.preview.pdfZoomOut")}
          aria-label={t("library.preview.pdfZoomOut")}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {zoomPct}%
        </span>
        <Button
          variant="ghost"
          className="h-7 w-7 p-0"
          style={{ borderRadius: 0 }}
          onClick={handleZoomIn}
          disabled={zoom >= ZOOM_MAX || !pdf}
          title={t("library.preview.pdfZoomIn")}
          aria-label={t("library.preview.pdfZoomIn")}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        {/* Fit to window — 패널 크기에 자동 맞춤. 현재 fit 모드면 primary
            톤으로 활성 강조해 사용자가 "지금 자동 fit 중" 임을 알 수 있게 함.
            줌 인/아웃을 누르면 자동으로 manual 로 전환되고 이 버튼이 회색으로
            돌아간다. */}
        <Button
          variant="ghost"
          className={cn(
            "h-7 w-7 p-0",
            fitMode === "fit" && pdf && "bg-primary/15 text-primary",
          )}
          style={{ borderRadius: 0 }}
          onClick={handleFit}
          disabled={!pdf}
          title={t("library.preview.pdfFit")}
          aria-label={t("library.preview.pdfFit")}
          aria-pressed={fitMode === "fit"}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>

        {/* 슬라이드 노트 영역 토글 — 노트 기능이 배선된 경우(onCreateRegion)
            에만 노출. ON 이면 RegionOverlay 가 crosshair 드래그를 캡처해 현재
            페이지 위에 영역 코멘트를 그린다. 이미지 프리뷰의 BoxSelect 토글과
            동일한 시각/동작. */}
        {onCreateRegion ? (
          <>
            <div className="mx-2 h-4 w-px bg-border-subtle" aria-hidden />
            <Button
              variant="ghost"
              className={cn(
                "h-7 w-7 p-0",
                regionMode && pdf && "bg-primary/15 text-primary",
              )}
              style={{ borderRadius: 0 }}
              onClick={() => setRegionMode((v) => !v)}
              disabled={!pdf}
              title={regionMode ? t("library.preview.regionOnPdf") : t("library.preview.regionPdf")}
              aria-label={regionMode ? t("library.preview.regionOnPdf") : t("library.preview.regionPdf")}
              aria-pressed={regionMode}
            >
              <BoxSelect className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : null}

        <div className="flex-1" />

        <Button
          variant="outline"
          className="h-7 gap-1.5 px-2 text-caption"
          style={{ borderRadius: 0 }}
          onClick={handleOpenExternal}
          title={t("library.grid.ctx.openDefault")}
        >
          <ExternalLink className="h-3 w-3" />
          {t("library.grid.ctx.openDefault")}
        </Button>
      </div>

      <div
        ref={scrollRef}
        onMouseDown={handlePanMouseDown}
        onDoubleClick={handleDoubleClick}
        className={cn(
          "relative flex-1 overflow-auto bg-neutral-900",
          /* Eagle 식 손바닥 커서 — PDF 가 로드돼야 grab/grabbing 으로 전환.
             에러/로딩 중에는 기본 커서로 두어 사용자가 "끌 수 있다" 는 잘못된
             신호를 받지 않게 한다. */
          pdf && !error && !regionMode && (isPanning ? "cursor-grabbing" : "cursor-grab"),
        )}
      >
        {/* safe center — 캔버스가 컨테이너보다 작으면 가운데, 더 크면 (확대된
            상태) start 로 자동 fallback 해서 우측/하단이 잘리지 않고 정상적으로
            scroll 가능 영역에 들어온다. 일반 justify-center 만 쓰면 overflow 시
            flex item 이 음수 위치로 밀려나 scrollLeft 로 닿을 수 없는 영역이
            생긴다(= 우측 잘림 버그). */}
        <div
          className="flex min-h-full min-w-full items-start p-4 [justify-content:safe_center]"
        >
          {error ? (
            <div className="flex max-w-md flex-col items-center gap-3 px-8 py-12 text-center text-muted-foreground">
              <div className="text-label font-medium text-foreground">
                {t("library.preview.pdfLoadFailed")}
              </div>
              <div className="font-mono text-2xs text-muted-foreground/70">{error}</div>
              <Button
                className="h-8 gap-1.5 px-3 text-meta"
                style={{ borderRadius: 0 }}
                onClick={handleOpenExternal}
              >
                <ExternalLink className="h-3 w-3" />
                {t("library.grid.ctx.openDefault")}
              </Button>
            </div>
          ) : loading ? (
            <div className="py-20 text-center font-mono text-caption text-muted-foreground/70">
              {t("library.preview.pdfLoading")}
            </div>
          ) : (
            /* 캔버스 + RegionOverlay 래퍼 — 래퍼를 캔버스 CSS 크기에 정확히
               맞춰(width/height) 오버레이가 페이지를 1:1 로 덮게 한다. relative
               + lineHeight:0 로 canvas 의 inline 여백 제거. */
            <div
              ref={pageWrapRef}
              className="relative shadow-lg shadow-black/40"
              style={{
                /* 캔버스가 display:block 이라 inline 여백이 없어 lineHeight:0 같은
                   갭 방지 스타일이 불필요하다. 예전엔 lineHeight:0 을 뒀는데
                   그게 자식(RegionOverlay 라벨) 으로 상속돼 라벨 strip 높이가 0 에
                   가깝게 눌려 "텍스트 박스가 얇은" 문제가 났다. width/height 만 둔다. */
                width: pageCssSize ? pageCssSize.w : undefined,
                height: pageCssSize ? pageCssSize.h : undefined,
              }}
            >
              <canvas ref={canvasRef} style={{ display: "block" }} />
              {onCreateRegion ? (
                <RegionOverlay
                  containerRef={pageWrapRef}
                  naturalWidth={pageCssSize?.w ?? null}
                  naturalHeight={pageCssSize?.h ?? null}
                  visibleNotes={visibleNotes}
                  drawing={regionMode}
                  onCreateRegion={handleRegionCreate}
                  onAfterCreate={handleAfterRegion}
                  onDeleteRegion={onDeleteRegion}
                  onEditRegion={onEditRegion}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
