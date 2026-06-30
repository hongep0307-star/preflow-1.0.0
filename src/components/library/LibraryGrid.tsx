import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, Download, ExternalLink, Eye, EyeOff, FileImage, FileText, Film, FolderInput, FolderOpen, ImageIcon, Library, Link2, Loader2, MessageSquare, Network, Pencil, Pin, RefreshCw, RotateCcw, ScanSearch, Sparkles, Square, Star, Tags, Trash2, Type, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuCheckboxItem } from "./MenuCheckboxItem";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import { getImageSearchSourceUrl, withReferenceVersion, type ReferenceItem, type ReferenceKind } from "@/lib/referenceLibrary";
import { IMAGE_SEARCH_ENGINES, type ImageSearchEngineId } from "@/lib/imageSearchEngines";
import { docExtensionTag, docHueClasses, docPresentationOf } from "@/lib/docPresentation";
import { extensionFromItem, resolveFormatLabel } from "@/lib/linkPlatform";
import {
  saveAnimatedThumbnailsAutoplay,
  useAnimatedThumbnailsAutoplay,
} from "@/lib/animationPreferences";
import {
  saveLibraryShowAnnotation,
  saveLibraryShowBadges,
  saveLibraryShowName,
  saveLibraryShowTypeLabel,
  useLibraryShowAnnotation,
  useLibraryShowBadges,
  useLibraryShowName,
  useLibraryShowTypeLabel,
} from "@/lib/libraryGridDisplayPreferences";
import {
  clearActiveLibraryDrag,
  getActiveLibraryDrag,
  installDragTracker,
  INTERNAL_DRAG_MIME,
  setActiveLibraryDrag,
  subscribeDragHover,
  type DragTrackerHandle,
  type DropTarget,
} from "@/lib/libraryDragChannel";
import type { LibraryFolderRow } from "./LibrarySidebar";
import type { LibrarySortKey, LibrarySortOrder, LibraryViewMode } from "./LibraryToolbar";
import type { QuickFilter } from "./LibrarySidebar";

const KIND_ICON: Record<ReferenceKind, typeof ImageIcon> = {
  image: ImageIcon,
  webp: ImageIcon,
  gif: ImageIcon,
  video: Film,
  youtube: Film,
  link: Link2,
  doc: FileText,
};

function formatDate(value?: string | null): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** 리스트 뷰의 Date Added 컬럼 — 분 단위까지 보여 같은 날짜라도 정렬 결과를
 *  눈으로 따라가기 쉽다. yyyy/MM/dd HH:mm 24h 고정 포맷. */
function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

/** 리스트 뷰의 Dimensions 컬럼. width/height 가 비어 있는 link/youtube 같은
 *  자료는 "—" 로 자리만 잡는다(빈 칸으로 두면 행 정렬이 흐트러진다). */
function formatDimensions(item: ReferenceItem): string {
  const w = item.width;
  const h = item.height;
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return "—";
  return `${w} × ${h}`;
}

function formatDuration(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatBytes(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/* ───────────────── 드래그 ghost 빌더 ─────────────────
 * Eagle 식 "썸네일 + 파일명 + 카운트 칩". offscreen 요소를 만들어
 * setDragImage 로 전달하면 OS 가 그 모양 그대로 cursor 옆에 띄운다.
 * Electron startDrag 호출 후에는 OS 가 자체 NativeImage 로 덮어쓰는
 * 플랫폼도 있지만, 그 짧은 순간이라도 자연스러운 시각을 주기 위함.
 *
 * 본체 dragstart 와 grip dragstart 양쪽에서 같은 ghost 를 쓰기 위해
 * 모듈 스코프 헬퍼로 추출. 호출자는 반환된 노드를 document.body 에
 * append 하고 setDragImage 후 다음 tick 에 remove 한다(OS 가 raster 한
 * 뒤 떼어내야 빈 미리보기가 안 보인다).
 *
 * ⚠ 실험 (2026-05-14): 썸네일을 `<img>` 가 아닌 `background-image` div 로
 * 그린다. 가설 — Chromium 이 `setDragImage(ghost)` 의 raster 단계에서
 * 자식 `<img>` 의 image MIME 을 감지해 dataTransfer 를 image-content
 * 모드로 승격시키고, 그 결과 OS native cursor 가 not-allowed 로 그려진다
 * (PNG/JPG/WEBP 만 깨지고 AVIF/GIF 는 정상인 매트릭스가 이 가설을
 * 뒷받침 — 같은 `<img>` 라도 Chromium 이 *디코딩 가능한 비트맵 포맷*
 * 으로 인식하는지 여부로 분기됨).
 *
 * background-image 는 CSS 단의 paint 라 DOM 요소 자체가 image element 가
 * 아니므로 그 디스패치 경로에서 빠질 가능성이 있다. 시각적으로는 동일
 * (32×32, object-fit:cover ≡ background-size:cover).
 *
 * 검증 결과 분기:
 *   - 이미지 카드(PNG/JPG/WEBP) cursor 가 정상화 → ghost 가 진범.
 *     그러면 노트의 "inner <img> 가 단독 trigger" 결론은 오진단이었고
 *     button 안의 <img> 는 그대로 둬도 안전 (시도 8/9 의 display:none
 *     코드 정리 가능).
 *   - cursor 여전히 깨짐 → ghost 는 무고. 다음 실험(② mousedown 시점
 *     inner <img> 제거 / ③ overlay 재구성 / ④ MIME override) 로 이동. */
function buildDragGhost(item: ReferenceItem, dragIds: string[]): HTMLElement {
  // 색은 theme CSS 변수에서 그때그때 해소 — index.css 의 --popover / --primary /
  // --foreground / --muted 가 바뀌면 ghost 도 자동으로 따라간다.
  const cs = getComputedStyle(document.documentElement);
  const popover = `hsl(${cs.getPropertyValue("--popover").trim()})`;
  const primary = `hsl(${cs.getPropertyValue("--primary").trim()})`;
  const foreground = `hsl(${cs.getPropertyValue("--foreground").trim()})`;
  const muted = `hsl(${cs.getPropertyValue("--muted").trim()})`;
  const ghost = document.createElement("div");
  ghost.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;display:flex;align-items:center;gap:8px;" +
    `padding:6px 10px;background:${popover};color:${foreground};border:1px solid ${primary};` +
    "font:12px/1 Pretendard,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,0.45);";
  const thumb = document.createElement("div");
  const thumbUrl = item.thumbnail_url || item.file_url || "";
  // CSS url() 안에 들어가는 문자열은 따옴표·역슬래시만 이스케이프하면
  // local-file:// 의 모든 path 가 안전하게 처리됨.
  const safeUrl = thumbUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  thumb.style.cssText =
    "width:32px;height:32px;background-size:cover;background-position:center;" +
    `background-repeat:no-repeat;background-color:${muted};flex-shrink:0;` +
    (thumbUrl ? `background-image:url("${safeUrl}");` : "");
  const label = document.createElement("span");
  label.textContent =
    dragIds.length > 1
      ? `${item.title}  +${dragIds.length - 1}`
      : item.title;
  label.style.cssText =
    "max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  ghost.appendChild(thumb);
  ghost.appendChild(label);
  return ghost;
}

/* ───────────────── Justified-Rows 레이아웃 유틸 ─────────────────
 * Eagle / Flickr 스타일 정렬 그리드. 각 항목이 자연 비율을 유지한 채로
 * 같은 행 안에서는 동일한 썸네일 높이를 갖도록 가로 폭을 스케일한다.
 * 이전 구현은 모든 카드를 강제 16:9 박스에 가두어 9:16 영상이나
 * 1:1 이미지가 잘리거나 검은 띠가 들어가던 문제가 있었다. */

/** kind 별 폴백 비율 — DB 의 width/height 가 비어 있는 legacy 항목을
 *  안전하게 다루기 위함. image 는 4:3, 그 외는 16:9 가 가장 흔한 비율. */
const ASPECT_FALLBACK_BY_KIND: Record<ReferenceKind, number> = {
  image: 4 / 3,
  webp: 4 / 3,
  gif: 16 / 9,
  video: 16 / 9,
  youtube: 16 / 9,
  link: 16 / 9,
  /* doc 카드 — 그리드의 *Eagle 스타일* 자유 비율 그리드 안에서 일관된
     높이를 유지하기 위해 4:3 으로 가정. DB 가 width/height 를 비워 두는
     경우(대부분의 doc) 의 폴백이고, PDF 같은 종이 비율을 정확히 측정하면
     onAspect 콜백이 자연스럽게 보정한다. */
  doc: 4 / 3,
};

/** 항목의 자연 비율(W/H). DB 메타가 있으면 그 값을 사용하고,
 *  없으면 kind 폴백. 극단치(파노라마/세로 스크린샷)는 0.3~4 로 클램프해
 *  한 항목이 한 행을 통째로 점유하지 못하게 한다.
 *
 *  툴바의 Shape 필터(`aspectBucket`)에서도 같은 정의를 쓰기 위해 export
 *  한다. 학습된 비율(LibraryGrid 내부 상태)이 없는 호출자에서도 DB 메타
 *  기반의 일관된 비율을 얻을 수 있다. */
export function aspectOf(item: ReferenceItem): number {
  const w = typeof item.width === "number" ? item.width : NaN;
  const h = typeof item.height === "number" ? item.height : NaN;
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return Math.max(0.3, Math.min(4, w / h));
  }
  return ASPECT_FALLBACK_BY_KIND[item.kind] ?? 16 / 9;
}

interface JustifiedRow {
  items: ReferenceItem[];
  /** 이 행의 썸네일 픽셀 높이. 컨테이너 폭에 맞춰 스케일된 결과. */
  height: number;
  /** 마지막(미완성) 행 — stretch 하지 않고 targetRowHeight 를 그대로 쓴다. */
  isLast: boolean;
}

/** items 를 순서대로 행에 채우는 그리디 레이아웃.
 *
 * 한 행에 항목을 누적하면서 자연폭 합 + gap 들이 컨테이너 폭을 처음 넘는
 * 시점에 행을 커밋한다. 커밋 시 scale = (container - gaps) / 자연폭합 으로
 * 가로를 정확히 채우게 row.height 를 늘이거나 줄인다. 실제로는 한 행을
 * 약간 over-fill 한 뒤 줄이는 방향이라 row.height ≤ targetRowHeight 의
 * 일관된 시각.
 *
 * 마지막 행은 stretch 하지 않는다 — 항목이 1~2 개뿐일 때 거대하게 늘어나
 * 페이지 균형이 깨지는 Eagle 의 약점을 피하기 위함. 단, 단일 항목의
 * 자연폭이 컨테이너보다 클 때만 비율 유지를 위해 축소한다. */
function layoutJustifiedRows(
  items: ReferenceItem[],
  containerWidth: number,
  gap: number,
  targetRowHeight: number,
  /** 자연 비율을 결정하는 함수. 컴포넌트 단계에서 학습된 aspect map 을
   *  반영하기 위해 closure 로 주입한다. 미지정 시 모듈 레벨 aspectOf 폴백. */
  aspectFn: (item: ReferenceItem) => number = aspectOf,
): JustifiedRow[] {
  if (containerWidth <= 0 || targetRowHeight <= 0 || items.length === 0) return [];
  const rows: JustifiedRow[] = [];
  let buf: ReferenceItem[] = [];
  let naturalSum = 0;

  const flush = (isLast: boolean) => {
    if (buf.length === 0) return;
    const totalGap = (buf.length - 1) * gap;
    let scale: number;
    if (isLast) {
      scale = naturalSum + totalGap > containerWidth
        ? (containerWidth - totalGap) / Math.max(1, naturalSum)
        : 1;
    } else {
      scale = (containerWidth - totalGap) / Math.max(1, naturalSum);
    }
    rows.push({ items: buf, height: targetRowHeight * scale, isLast });
    buf = [];
    naturalSum = 0;
  };

  for (const item of items) {
    const nW = aspectFn(item) * targetRowHeight;
    buf.push(item);
    naturalSum += nW;
    const totalGap = (buf.length - 1) * gap;
    if (naturalSum + totalGap >= containerWidth) {
      flush(false);
    }
  }
  flush(true);
  return rows;
}

/* ─────────────── 통합 단일 드래그 (Eagle 패턴) — 시도했으나 내부 이동과 충돌 ───────
 *
 * 가설: HTML5 native drag 를 끄고(button.draggable=false) mousedown→threshold
 * 로 OLE drag 하나만 시작하면, Chromium 이 자기 drag source 가 아니게 되어
 * 우리 창으로 들어오는 OLE drag 를 외부 파일 드래그로 정상 인식 → 폴더 위
 * 커서 정상(+) + 내부 이동도 OLE 의 dragover/drop 으로 처리.
 *
 * 검증 결과 (2026-06-05, native addon v2 기준): **실패**.
 *   v2 는 DoDragDrop 을 *메인 UI thread* 에서 블록 실행한다. 블록 동안
 *   Chromium 은 OLE drag 에 대한 DOM dragover/drop 을 렌더러로 dispatch 하지
 *   못한다(듀얼 모드에서는 HTML5 drag 가 그 이벤트 스트림을 대신 제공해
 *   tracker 가 동작했음). 따라서 통합 모드에선:
 *     - 내부 폴더 이동/재정렬 깨짐 (#2 회귀)  ← 치명적
 *     - 폴더 위 커서도 그대로 빨간 금지 (#1 미해결)
 *   외부 export 만 정상. 블로킹 방식 통합은 내부 이동과 근본 충돌.
 *
 * 결론: false 유지 = 듀얼 드래그(커밋 0e0ebb1). 폴더 위 빨간 커서만 잔존,
 * 기능(폴더 이동 + 외부 export)은 모두 정상. 커서는 native IDropSource
 * GiveFeedback 에서 own-window 위일 때 SetCursor 로 덮는 별도 접근으로 해결
 * 검토 (DoDragDrop 메커니즘은 그대로 두므로 내부 이동 안 깨짐). */
const USE_EAGLE_PATTERN = false;
/** mouse 이동 threshold (px). 이만큼 움직여야 click → drag 로 인정. */
const EAGLE_DRAG_THRESHOLD_PX = 5;
/** OLE drag 종료 알림이 보장되지 않으니 사이드채널 / tracker 의 강제
 *  cleanup timeout (ms). 한 번의 drag 가 이보다 오래 걸리는 시나리오는
 *  사용자 시나리오에 없다고 가정. */
const EAGLE_DRAG_SAFETY_MS = 30_000;

/* ─── 실험 토글: image kind 의 text/uri-list setData 비활성 ──────
 *
 * 이 한 줄이 Chromium image-content 모드의 *유일한 트리거*인지(=cursor
 * not-allowed 깨짐의 단독 원인) vs inner img element 자동 attach 도 함께
 * 트리거하는지를 가르는 단일 변수 실험.
 *
 * `true` = setData 안 함 (image-mode trigger 의 한 vector 차단)
 * `false` = 기존 동작 (PNG 외부 export 의 안전 trigger)
 *
 * 결과 분기:
 *   - PNG cursor 정상화 + PNG 외부 OK → 우리가 박는 setData 가 *불필요*
 *     했으며 inner <img> 가 OLE 와 별개로 외부 export 도 살리고 있었음.
 *     큰 win, 그대로 마무리.
 *   - PNG cursor 정상화 + PNG 외부 X → setData 가 외부 export 의 핵심
 *     trigger 였고 cursor 도 그것 때문이었음. trade-off 옵션으로 환원.
 *   - PNG cursor 여전히 깨짐 + PNG 외부 OK → inner <img> 가 cursor 깨짐
 *     의 진범. <img> 의 image-mode trigger 를 다른 방식으로 회피해야 함. */
const EXPERIMENT_NO_URI_LIST = true;

/* ─── 실험 X-bis 토글: DownloadURL setData 박을지 ──────────────────
 *
 * 가설: `dataTransfer.setData("DownloadURL", "image/png:...:url")` 의
 * MIME 부분이 Chromium 의 static-bitmap 카테고리 (PNG/JPEG/WEBP) 면
 * image-mode trigger 가 켜질 수 있다. GIF (mime=image/gif) 는 카테고리
 * 밖이라 안 켜짐 — 매트릭스 분기와 일치.
 *
 * 검증 (2026-05-14, 실패): flag 를 false 로 두고도 PNG cursor 여전히 깨짐.
 * → DownloadURL 은 trigger 가 아니었음. */
const ENABLE_DOWNLOAD_URL = false;

/* ─── 실험 Y 토글: webContents.startDrag (OLE) 호출 자체를 끌지 ──────
 *
 * 가설: 모든 webview-level 시도가 image-mode 를 못 끄는 이유는, trigger
 * 가 `webContents.startDrag` 의 OLE 채널 안에 있기 때문. Chromium/Electron
 * 이 file path 의 확장자(.png/.jpg/.webp) 를 보고 static-bitmap 임을 감지
 * → OLE drag 에 image 데이터를 자동 첨부 + image-mode cursor 강제.
 *
 * 검증 (2026-05-14): flag false 로 두면 PNG cursor 정상화 + 외부 export X.
 * → startDrag 가 단독 진범 확정. ⑤ native addon 으로 직진 결정.
 *
 * Native addon v1 (2026-05-14) — libuv AsyncWorker 패턴은 *실패*:
 *   `DoDragDrop` 이 worker thread 에서 SetCapture 가능한 window 가 없어
 *   영원히 return 안 함 → libuv 워커 스레드 4개 leak → 풀 고갈 → 썸네일
 *   까만 사고 + 앱 뻗음.
 *
 * Native addon v2 (2026-06-05, Phase 0) — 메인 UI thread 동기 DoDragDrop 으로
 *   재작성. 메인 스레드가 BrowserWindow 를 소유해 SetCapture 성공 → return
 *   정상. main.ts 가 returnValue 를 먼저 set 한 뒤 startDrag 를 블록 호출하므로
 *   렌더러 dragstart 는 즉시 unblock 됨.
 *   ⚠️ Phase 0 검증용으로 true. 검증 항목: (1) freeze 재발 없음 (2) drag 중
 *   사이드바 폴더 이동/그리드 재정렬(내부 drop) 생존 (3) 외부 export 동작
 *   (4) 커서 정상(never not-allowed). 문제 시 즉시 false 로 환원.
 *
 * macOS 분기 (2026-06-11): macOS 의 외부 드래그아웃은 webContents.startDrag
 *   폴백의 NSDraggingSession 종료 콜백 미발동 → OS mouse capture stuck(hang)
 *   문제가 남아 있어, macOS 에서는 OS 드래그아웃 호출 자체를 끈다(외부 export
 *   기능을 Mac 한정으로 비활성화 — 앱 내부 폴더 이동/그리드 재정렬은 HTML5
 *   DnD 라 그대로 동작). Windows 는 native/drag-out OLE addon 으로 정상
 *   동작하므로 영향 없음. */
const ENABLE_STARTDRAG_OLE =
  typeof navigator !== "undefined" &&
  navigator.userAgent.toLowerCase().includes("mac")
    ? false
    : true;

/** 한 카드의 행 사이 간격(px) — 기존 Tailwind `gap-3` 과 동일. */
const GRID_GAP = 12;
/** 카드 하단의 파일명 라벨 고정 높이(px). 한 줄 truncate. */
const GRID_LABEL_HEIGHT = 22;

/* ───────────────── 리스트 뷰 레이아웃 토큰 ─────────────────
 * Eagle 식 표 형태 리스트: thumb · Name · Dimensions · Extension · File Size
 * · Date Added 의 6 컬럼. 모든 행과 sticky 헤더가 동일한
 * `gridTemplateColumns` 를 공유해 가로 줄이 한 픽셀 단위로 맞는다.
 *
 * Name 만 `minmax(0, 1fr)` 가변 — 인스펙터 패널이 열려 그리드 영역이 좁아져도
 * 가로 스크롤이 생기지 않도록 0 까지 줄어들 수 있게 한다. 짧은 제목은 좌측에
 * 모이고 긴 제목은 ellipsis 로 truncate. */
/** 메타 컬럼(Dimensions ~ Date Added) 사이가 너무 붙어 보이지 않도록 한 단계
 *  넓힌 값. 컬럼별로 다른 gap 은 CSS Grid 가 지원하지 않아 전체에 같은 폭을
 *  적용하지만, Name → Dimensions 사이도 같이 넓어져 시각적으로 더 정돈된다. */
const LIST_COLUMN_GAP = 20;

/** 리스트 행의 썸네일 크기 — 그리드 뷰의 슬라이더(gridSize, 140~360) 를
 *  리스트의 가독 범위(높이 24~140px) 로 압축 매핑한다. 슬라이더를 끝까지
 *  키우면 Eagle 의 큰 리스트 뷰처럼 ~140px 짜리 큼직한 미리보기가 되고,
 *  끝까지 줄이면 24px 의 컴팩트한 한 줄 리스트가 된다.
 *
 *  매핑은 `pow(t, 1.5)` 비선형 — 슬라이더 앞 구간은 천천히 자라고 끝에서
 *  급격히 커진다. 디폴트(gridSize=220, t≈0.36) 지점이 약 50px 로 기존
 *  고정 44px 와 거의 같게 유지돼, 슬라이더를 만지지 않은 사용자에게는
 *  시각적 변화가 거의 없다. width 는 height 와 1.636 비율을 유지해
 *  가로/세로/정사각형 자료가 한 행에서 시각적으로 균일하다. */
function listThumbSize(gridSize: number): { thumbWidth: number; thumbHeight: number } {
  const t = Math.max(0, Math.min(1, (gridSize - 140) / (360 - 140)));
  const thumbHeight = Math.round(24 + Math.pow(t, 1.5) * 116);
  const thumbWidth = Math.round(thumbHeight * 72 / 44);
  return { thumbWidth, thumbHeight };
}

/** sticky 헤더와 모든 행이 공유하는 grid 컬럼 정의. thumb 폭만 동적으로
 *  바뀌고 나머지 메타 컬럼은 고정 폭을 유지 — 슬라이더로 행 높이를 키워도
 *  메타 컬럼 정렬 라인은 변하지 않아 시선 흐름이 안정적이다.
 *
 *  컬럼별 폭(px): Dimensions 100 · Extension 100 · File Size 88 · Date Added 144.
 *  Extension 은 "Extension" 헤더 + 정렬 화살표(12px+4px gap) 가 같이 들어가야
 *  하고, 데이터 쪽도 "Instagram"/"Pinterest" 같은 9~10자 platform 라벨이 들어와
 *  truncate 되지 않도록 100px 로 잡았다. Date Added 는 "yyyy/MM/dd HH:mm"
 *  16자 + 화살표를 모두 수용. */
function listGridColumns(thumbWidth: number): string {
  return `${thumbWidth}px minmax(0, 1fr) 100px 100px 88px 144px`;
}

/** CSS `url("...")` 안에 안전하게 박기 위한 이스케이프. local-file:// 또는
 *  http://127.0.0.1 의 어떤 path 도 따옴표·역슬래시만 escape 하면 문제 없음. */
function escapeCssUrl(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* ── 실험 X (DownloadURL) helper trio ────────────────────────────────
 *
 * Chromium 의 `dataTransfer.setData("DownloadURL", "mime:filename:url")` 채널은
 * dragstart 시점에 박힌 메타로 외부 destination 에 떨어질 때 Chromium 이
 * URL 에서 파일을 받아 CF_HDROP 으로 박는다. image-mode trigger 와 *별개
 * 채널* 이라 element 안의 `<img>` 가 없어도 외부 export 가 살아남는다.
 *
 * Format 의 세 부분 — 첫 콜론까지 mime, 둘째 콜론까지 filename, 나머지가 URL.
 * URL 안에 콜론이 있어도 (http://) 파싱이 깨지지 않음. mime/filename 은
 * 우리가 만드는 부분이라 콜론을 안 박으면 안전. */

function guessMimeFromUrl(url: string | null): string {
  if (!url) return "";
  const m = url.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  if (!m) return "";
  const ext = m[1];
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "avif": return "image/avif";
    case "svg": return "image/svg+xml";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    default: return "";
  }
}

function extensionForMime(mime: string, fallbackUrl: string | null): string {
  switch (mime) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/avif": return ".avif";
    case "image/svg+xml": return ".svg";
    case "video/mp4": return ".mp4";
    case "video/webm": return ".webm";
    case "video/quicktime": return ".mov";
    default: {
      if (!fallbackUrl) return "";
      const m = fallbackUrl.toLowerCase().match(/\.([a-z0-9]{1,5})(?:\?|#|$)/);
      return m ? "." + m[1] : "";
    }
  }
}

/** Windows / macOS / Linux 모든 파일시스템이 받는 안전한 문자만 남긴다.
 *  DownloadURL 의 filename 은 외부 destination(Slack/탐색기 등)이 파일명으로
 *  그대로 쓰므로, OS 예약 문자(\/:*?"<>|) 와 콜론을 제거한다 — 콜론은
 *  Chromium 의 DownloadURL 파싱 자체를 깨므로 필수. 결과가 비면 fallback. */
function sanitizeDownloadFilename(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "untitled";
}

/** ── 실험 X (2026-05-14): background-image 기반 thumbnail 로드 헬퍼 ──
 *
 * 배경: Chromium HTML5 drag image-mode trigger 는 dragged element 내부
 * `<img>` 의 binary signature 가 static-bitmap 카테고리(PNG/JPEG/WEBP) 일
 * 때 켜져, OS native cursor 가 not-allowed 로 그려진다. 응답 MIME / src
 * 값 / display 등 webview-level 모든 회피 시도가 실패했으므로(시도 7~9,
 * 실험 ①·④) 유일한 해결책은 *element 단의 `<img>` 자체 제거*. 모든 image-
 * kind 썸네일을 `background-image` div 로 paint 하면 image element 가 트리
 * 에서 사라져 image-mode trigger 가 *원리적으로* 불가능해진다.
 *
 * 잃는 것: `<img onLoad>` 의 자연 비율(naturalWidth/Height) 보고. 이를
 * 대체하기 위해 같은 src 를 `new Image()` 로 백그라운드 로드해 dimension
 * 콜백을 발사한다 — 브라우저 캐시가 동일 URL 을 공유하므로 추가 네트워크
 * 요청은 없고, decode 비용도 한 번 더 들지 않는 케이스가 대부분(같은 URL
 * 의 `<img>`/`background-image`/`new Image()` 가 같은 ImageBitmap 캐시를
 * 참조).
 *
 * 또 잃는 것: animated WEBP/GIF 의 `onLoad`/`onError` 기반 swap. 새 Image
 * 도 같은 두 이벤트를 발사하므로 동등하게 동작. */
type ImageLoadState = "loading" | "ready" | "failed";

/* ── 공유 IntersectionObserver ──────────────────────────────────────
 * 1만 카드 × 1 observer = 1만 observer instance 는 메인스레드와 메모리에
 * 무거운 부담이라, rootMargin 별로 *하나의* IO 인스턴스를 공유하고 각
 * target Element 의 콜백은 WeakMap 으로 라우팅한다. ResizeObserver 와
 * 같은 패턴이며, 브라우저 내부적으로도 같은 root/threshold/rootMargin
 * 조합이면 같은 큐를 쓰므로 비용이 거의 동일.
 *
 * rootMargin: 화면 위/아래 600px 미리 채워두면(스크롤 속도 ~1500px/s 기준
 * 약 400ms 여유) 사용자가 빠르게 스크롤해도 카드가 "empty → 사진" 으로
 * 바뀌는 깜빡임이 거의 안 보인다. 200~800px 사이가 최적 — 너무 작으면
 * 깜빡임, 너무 크면 lazy 의미가 약해진다. */
const VIEWPORT_ROOT_MARGIN = "600px 0px 600px 0px";
const sharedObservers = new Map<string, IntersectionObserver>();
const viewportCallbacks = new WeakMap<Element, (inView: boolean) => void>();

function getSharedViewportObserver(rootMargin: string): IntersectionObserver {
  const existing = sharedObservers.get(rootMargin);
  if (existing) return existing;
  const obs = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cb = viewportCallbacks.get(entry.target);
        if (cb) cb(entry.isIntersecting);
      }
    },
    { rootMargin, threshold: 0 },
  );
  sharedObservers.set(rootMargin, obs);
  return obs;
}

/** 자기 element 가 뷰포트(+ rootMargin) 안에 들어왔는지를 boolean 으로
 *  반환. 공유 observer 사용 → 카드 1만 장이 동시에 mount 되어도 IO
 *  인스턴스는 1개. 첫 페인트 1프레임 동안은 false 인 채로 렌더되어
 *  마운트 직후의 1만 fetch 폭주를 차단한다(IO 콜백이 다음 microtask 에
 *  도착하면 실제로 보이는 카드들만 true 로 전환되어 image fetch 시작). */
function useInViewport<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* IntersectionObserver 미지원 환경(매우 드물지만 Electron 의
       구버전 Chromium 등 fallback) 에선 즉시 true 로 고정해 기존
       동작(전부 로드) 으로 회귀 — 라이브러리가 깨지지 않는 게 우선. */
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = getSharedViewportObserver(VIEWPORT_ROOT_MARGIN);
    viewportCallbacks.set(el, (v) => setInView(v));
    obs.observe(el);
    return () => {
      obs.unobserve(el);
      viewportCallbacks.delete(el);
    };
  }, []);
  return [ref, inView];
}

function useImageLoad(
  src: string | null | undefined,
  onAspect?: (w: number, h: number) => void,
  enabled = true,
): ImageLoadState {
  const [state, setState] = useState<ImageLoadState>("loading");
  /* onAspect 가 부모의 inline closure 라 매 렌더마다 새로 만들어진다.
   * useEffect 의 deps 에 그대로 박으면 매 렌더 image 가 재로드 — 무한
   * 트래시. ref 로 *현재* 콜백을 추적해 effect 자체는 src 만 의존하게. */
  const onAspectRef = useRef(onAspect);
  useEffect(() => {
    onAspectRef.current = onAspect;
  }, [onAspect]);

  /* "이 src 는 이미 한 번 ready 상태에 도달했다" 를 기록.
   *
   * 사용자가 카드를 스크롤 아래로 보내(`enabled=false`) 한참 있다가 다시
   * 위로 끌어올리면(`enabled=true`) 본 effect 의 deps `[src, enabled]` 가
   * false→true 로 바뀌면서 *재실행* 된다. 이전 구현에선 그때마다
   *   - `setState("loading")` 으로 ready 상태를 잊고
   *   - `new Image()` 를 다시 만들어 fetch + decode 를 한 번 더 트리거
   * → 디스크 캐시 hit 이라도 paint-time sync decode 가 다시 발생해 카드가
   *   "블랙 → 점진 표시" 로 깜빡인다.
   *
   * `lastReadySrcRef` 가 같은 src 를 기억하면 그 경로를 skip 하고 즉시
   * "ready" 로 복귀해 깜빡임을 차단. src 가 바뀌면(`withReferenceVersion`
   * 의 `?v=updated_at` 가 cover regenerate 시 변함) ref 와 다른 값이라
   * 정상적으로 새 로드 경로로 진입한다. */
  const lastReadySrcRef = useRef<string | null>(null);

  useEffect(() => {
    /* enabled=false (뷰포트 밖) 면 new Image() 자체를 만들지 않는다 —
       이것이 1만 카드 진입 시 메인스레드 점유의 가장 큰 원인이었음.
       state 는 "loading" 유지: 카드가 뷰포트에 들어오면 enabled=true
       전환과 동시에 본 effect 가 재실행되어 정상 로드 경로로 진입. */
    if (!enabled) return;
    if (!src) {
      setState("failed");
      return;
    }
    // 같은 src 가 이미 한 번 ready 가 된 적 있다면 새 디코드 없이 즉시 복귀.
    if (lastReadySrcRef.current === src) {
      setState("ready");
      return;
    }
    setState("loading");
    const img = new Image();
    let cancelled = false;
    const finalize = async () => {
      /* `img.decode()` 까지 await 해서 *디코드된 raster* 가 브라우저 image
         cache 에 들어간 시점에 ready 를 표시한다. 같은 URL 을 paint 하는
         `background-image` 가 그 raster cache 를 그대로 재사용 → paint
         시점에 main-thread sync decode 가 일어나지 않아 깜빡임이 사라진다.
         decode 가 미지원되거나 실패하는 환경(매우 드물지만)은 silent fallback
         — 기존처럼 onload 만으로 ready 처리. */
      try {
        await img.decode();
      } catch {
        /* ignore — image-mode trigger 회피 케이스 등 */
      }
      if (cancelled) return;
      lastReadySrcRef.current = src;
      setState("ready");
      const cb = onAspectRef.current;
      if (cb && img.naturalWidth && img.naturalHeight) {
        cb(img.naturalWidth, img.naturalHeight);
      }
    };
    img.onload = () => {
      void finalize();
    };
    img.onerror = () => {
      if (cancelled) return;
      setState("failed");
    };
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src, enabled]);

  return state;
}

/** 정적 썸네일을 `background-image` 로 paint 하는 div.
 *  `<img>` 자리 그대로 1:1 교체용 — image-mode trigger 차단의 핵심.
 *
 *  뷰포트 게이팅: 자신이 화면 + 600px rootMargin 안에 들어왔을 때만
 *  background-image URL 을 실제로 셋하고 new Image() 도 그때만 발사한다.
 *  CSS `background-image` 는 `loading="lazy"` 가 없어 1만 div 마운트 시
 *  브라우저가 1만 fetch + decode 를 즉시 큐잉하던 문제를 차단. 뷰포트
 *  밖 카드는 placeholder 배경(bg-muted/30, 부모 wrapper) 그대로 보임. */
function BackgroundThumb({
  src,
  alt,
  className,
  onAspect,
}: {
  src: string;
  alt: string;
  className?: string;
  onAspect?: (w: number, h: number) => void;
}) {
  const [ref, inView] = useInViewport<HTMLDivElement>();
  /* "한 번이라도 viewport 안에 들어왔는가" 를 기록.
   *
   * `inView=false` 로 떨어지는 순간 `backgroundImage` 를 unset 하면
   * Chromium 이 그 카드의 *디코드된 raster* 를 적극적으로 폐기한다. 다시
   * inView=true 가 되면 CSS 가 url 을 다시 셋 → fetch(디스크 캐시 hit) →
   * paint-time sync decode 가 또 일어나 사용자가 "위로 갔다 아래로 오면
   * 또 블랙 → 점진 표시" 를 본다.
   *
   * 본 ref 가 true 가 되면 그 후엔 `backgroundImage` url 을 *항상* 셋한
   * 상태로 유지한다. CSS url 만 유지할 뿐 *실제 raster 메모리는 브라우저가
   * LRU 로 관리* 하므로 강제 점유는 아니다. raster cache hit 가능성이
   * 훨씬 높아져 재진입 시 깜빡임이 사라진다. */
  const hasEverInViewRef = useRef(false);
  if (inView) hasEverInViewRef.current = true;
  const showBackground = hasEverInViewRef.current && !!src;
  useImageLoad(src, onAspect, inView);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={alt}
      className={className}
      style={{
        backgroundImage: showBackground ? `url("${escapeCssUrl(src)}")` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

function LibraryMediaThumbnail({
  item,
  Icon,
  onAspect,
}: {
  item: ReferenceItem;
  Icon: typeof ImageIcon;
  /** 미디어가 실제로 로드된 시점에 자연 비율(W/H)을 부모에게 알린다.
   *  DB 의 width/height 가 비어 있는 legacy 항목은 이 콜백으로 초기 fallback
   *  비율(예: image=4:3) 을 실제 비율로 교체해, 9:16 portrait 이미지가
   *  4:3 박스에 잘리는 문제를 피한다. 한 번만 호출되므로 불필요한 layout
   *  thrash 는 없다. */
  onAspect?: (naturalWidth: number, naturalHeight: number) => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const scrubbingVideoRef = useRef(false);
  const seekInFlightRef = useRef(false);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const [hoveringVideo, setHoveringVideo] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [scrubbingVideo, setScrubbingVideo] = useState(false);
  /* Settings 의 "GIF·WebP 썸네일 자동 재생" 토글. true 면 호버 의존을 없애고
     animated layer 가 로드되는 즉시 항상 보이게 한다. localStorage 변경은
     같은 윈도우의 CustomEvent 와 다른 윈도우의 storage 이벤트로 즉시 전파. */
  const animationAutoplay = useAnimatedThumbnailsAutoplay();
  // 호버시 애니메이션 재생 — 업로드한 GIF/WebP 뿐 아니라, og:image/oEmbed 가
  // GIF 또는 animated WebP 였던 link 레퍼런스도 같은 dual-asset 패턴을 따른다.
  // (createLinkReference 가 file_url=원본 / thumbnail_url=스마트 정지 프레임 /
  // mime_type=image/gif|webp 로 채움)
  const canAnimateOnHover = Boolean(item.file_url) && (
    item.kind === "gif" ||
    item.kind === "webp" ||
    (item.kind === "link" && (item.mime_type === "image/gif" || item.mime_type === "image/webp"))
  );
  /* stillSrc 는 보통 thumbnail_url(=업로드시 자동 생성된 poster.png 또는 Set
     Cover 로 덮어쓴 cover.png) 을 사용. 두 파일 모두 *고정 파일명* 에 upsert
     되므로 URL 문자열이 안 바뀌어 브라우저 캐시가 그대로 남는다. updated_at
     기반 cache-bust 로 Set Cover / Regenerate Thumbnail 직후 그리드 카드도
     실시간 새 프레임을 반영한다. animatedSrc(=원본 file_url) 은 업로드시
     고유 경로라 덮어쓰지 않으므로 bust 불필요. */
  const stillSrc = withReferenceVersion(item.thumbnail_url || item.file_url || "", item);
  /* animatedSrc — 경량 animated 프리뷰(preview.webp, ≤360px·~12fps)가 있으면
     그것을 재생하고, 없으면 원본(file_url)으로 폴백한다. preview.webp 는
     고정 파일명 upsert 라 재생성 시 URL 이 안 바뀌므로 withReferenceVersion
     (?v=updated_at)으로 캐시를 버스트한다(updateReference 가 updated_at 갱신).
     이 폴백-우선 구조 덕에 백필이 진행되기 전에는 기존과 동일하게 원본이
     재생되어 무중단으로 점진 전환된다. */
  const animatedSrc = item.preview_url
    ? withReferenceVersion(item.preview_url, item)
    : (item.file_url || item.thumbnail_url || "");
  const canPreviewVideo = item.kind === "video" && Boolean(item.file_url);
  const videoProgress = videoDuration > 0 ? Math.max(0, Math.min(1, videoTime / videoDuration)) : 0;
  // 호버/스크럽 중에만 비디오 프레임을 보여주고, 그 외엔 원래 썸네일(stillSrc)로
  // 돌아온다. 이전엔 `videoTime > 0` 조건이 있어서 한 번 호버한 뒤에는 비디오
  // 마지막 프레임이 계속 박혀 있어 썸네일을 지정해도 사라지는 문제가 있었음.
  const showVideoFrame = hoveringVideo || scrubbingVideo;

  useEffect(() => {
    scrubbingVideoRef.current = false;
    setVideoDuration(0);
    setVideoTime(0);
    setScrubbingVideo(false);
  }, [item.id, item.file_url, item.thumbnail_url]);

  const playVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    setHoveringVideo(true);
    void video.play().catch(() => {
      // Hover previews are opportunistic; the full preview panel still has controls.
    });
  };

  const pauseVideo = () => {
    const video = videoRef.current;
    setHoveringVideo(false);
    setScrubbingVideo(false);
    // 호버가 끝나면 비디오를 처음 프레임으로 되돌려, 다음 호버 시 항상 같은
    // 지점에서 재생을 시작하고 그 사이엔 지정한 썸네일이 그대로 보이도록 한다.
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // 일부 코덱에서 seek 가 막힐 수 있으나 표시 자체는 stillSrc 로 덮인다.
      }
    }
    pendingSeekTimeRef.current = null;
    seekInFlightRef.current = false;
    setVideoTime(0);
  };

  const seekVideoTo = (time: number) => {
    const video = videoRef.current;
    const duration = Number.isFinite(video?.duration) && video!.duration > 0
      ? video!.duration
      : item.duration_sec && item.duration_sec > 0
      ? item.duration_sec
      : 0;
    if (!video || duration <= 0) return;
    const nextTime = Math.max(0, Math.min(duration, time));
    video.pause();
    setVideoTime(nextTime);
    pendingSeekTimeRef.current = nextTime;
    if (seekInFlightRef.current) return;
    seekInFlightRef.current = true;
    video.currentTime = nextTime;
  };

  const flushPendingSeek = () => {
    const video = videoRef.current;
    if (!video) {
      seekInFlightRef.current = false;
      pendingSeekTimeRef.current = null;
      return;
    }
    const pending = pendingSeekTimeRef.current;
    if (pending === null || Math.abs(video.currentTime - pending) < 0.015) {
      seekInFlightRef.current = false;
      pendingSeekTimeRef.current = null;
      return;
    }
    video.currentTime = pending;
  };

  const seekVideoFromPointer = (event: PointerEvent<HTMLElement>) => {
    const timeline = timelineRef.current;
    const duration = videoDuration || item.duration_sec || 0;
    if (!timeline || duration <= 0) return;
    const rect = timeline.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    seekVideoTo(Math.max(0, Math.min(1, ratio)) * duration);
  };

  const seekVideoFromClientX = (clientX: number) => {
    const timeline = timelineRef.current;
    const duration = videoDuration || item.duration_sec || 0;
    if (!timeline || duration <= 0) return;
    const rect = timeline.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    seekVideoTo(Math.max(0, Math.min(1, ratio)) * duration);
  };

  const stopWindowScrub = () => {
    scrubbingVideoRef.current = false;
    setScrubbingVideo(false);
    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp);
    window.removeEventListener("pointercancel", handleWindowPointerUp);
    if (hoveringVideo) void videoRef.current?.play().catch(() => undefined);
  };

  const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
    if (!scrubbingVideoRef.current) return;
    event.preventDefault();
    seekVideoFromClientX(event.clientX);
  };

  const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
    if (!scrubbingVideoRef.current) return;
    event.preventDefault();
    seekVideoFromClientX(event.clientX);
    stopWindowScrub();
  };

  const handleTimelinePointerMove = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (scrubbingVideoRef.current) seekVideoFromPointer(event);
  };

  const handleTimelinePointerDown = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    scrubbingVideoRef.current = true;
    setScrubbingVideo(true);
    videoRef.current?.pause();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekVideoFromPointer(event);
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
  };

  const handleTimelinePointerEnd = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    seekVideoFromPointer(event);
    stopWindowScrub();
  };

  const handleTimelineChange = (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    seekVideoTo(Number(event.currentTarget.value));
  };

  const stopTimelineEvent = (event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  /* doc 카테고리 — Phase 1 generic 카드.
     - thumbnail_url 이 있으면 그것을 *진짜 썸네일* 로 사용(Phase 2 의
       PDF first page / font preview 가 채워 둔 PNG). 카드 좌상단 확장자
       배지는 그리드 외곽 레이어의 `showTypeLabel` Badge 가 담당하므로
       *여기서는 오버레이를 그리지 않는다* — 둘이 같은 자리에서 중복되어
       사용자가 토글을 꺼도 확장자가 한 번 더 보이는 문제 회피.
     - 없으면 색상 + 아이콘 + 큰 확장자 텍스트로 식별 가능한 plate.
       이 fallback 라벨은 카드 시각화 *자체* (아이콘만 뜨면 무슨 파일인지
       모름) 라 그리드 토글과 별개로 항상 노출. */
  if (item.kind === "doc") {
    const docPresentation = docPresentationOf(item);
    const hueCls = docHueClasses(docPresentation);
    const DocIcon = docPresentation.Icon;
    if (item.thumbnail_url) {
      const docThumb = withReferenceVersion(item.thumbnail_url, item);
      return (
        <BackgroundThumb
          src={docThumb}
          alt={item.title}
          className="h-full w-full transition-transform duration-200 group-hover:scale-[1.03]"
          onAspect={onAspect}
        />
      );
    }
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-2 transition-transform duration-200 group-hover:scale-[1.03]",
          hueCls.surface,
        )}
        title={item.title}
      >
        <DocIcon className={cn("h-10 w-10", hueCls.iconColor)} aria-hidden />
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wider",
            hueCls.badgeBg,
          )}
        >
          {docExtensionTag(item)}
        </span>
      </div>
    );
  }

  if (canPreviewVideo) {
    return (
      <div
        className="h-full w-full"
        title={t("library.grid.videoHoverHint")}
        onMouseEnter={playVideo}
        onMouseLeave={pauseVideo}
      >
        {item.thumbnail_url ? (
          /* (실험 X) video poster 도 `<img>` 대신 background-image div 로
             paint — video kind 의 cursor 는 현재도 정상이지만, 포스터가
             PNG/JPG 라면 잠재적 image-mode trigger 가 될 수 있으므로 모든
             정적 썸네일을 일관되게 background paint 로 통일.
             ⚠ thumbnail_url 이 없으면(=ffmpeg 포스터 추출 실패/경로 없음) src
             로 file_url(.mov 원본)을 쓰면 background-image 로 디코드가 안 돼
             검은 카드가 되므로, 아이콘 플레이스홀더로 폴백한다. */
          <BackgroundThumb
            src={stillSrc}
            alt={item.title}
            className={cn(
              "h-full w-full transition-all duration-200 group-hover:scale-[1.03]",
              showVideoFrame && "opacity-0",
            )}
            onAspect={onAspect}
          />
        ) : (
          <div className={cn("flex h-full w-full items-center justify-center bg-muted transition-opacity", showVideoFrame && "opacity-0")}>
            <Icon className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <video
          ref={videoRef}
          src={item.file_url ?? undefined}
          poster={withReferenceVersion(item.thumbnail_url ?? undefined, item) || undefined}
          muted
          loop
          playsInline
          preload="auto"
          // <video> 자체는 native draggable 이 아니지만, Chromium 에선 일부
          // 컨트롤이 mouse capture 를 가져가 dnd-kit 의 PointerSensor 를
          // 가리는 경우가 있다. controls={false} 가 default 라 보통 문제
          // 없지만, 명시적으로 draggable=false 를 박아 의도를 분명히 한다.
          draggable={false}
          onLoadedMetadata={(event) => {
            const v = event.currentTarget;
            const duration = Number.isFinite(v.duration) ? v.duration : 0;
            setVideoDuration(duration);
            setVideoTime(v.currentTime || 0);
            // 비디오의 진짜 가로/세로는 thumbnail 이미지보다 더 신뢰도 있으므로
            // 메타데이터가 들어오는 즉시 한 번 더 보고. 같은 값이면 부모의
            // map 비교에서 무시되므로 추가 layout 비용 없음.
            if (v.videoWidth && v.videoHeight) {
              onAspect?.(v.videoWidth, v.videoHeight);
            }
          }}
          onTimeUpdate={(event) => {
            if (!scrubbingVideo) setVideoTime(event.currentTarget.currentTime || 0);
          }}
          onSeeked={flushPendingSeek}
          className={cn(
            "absolute inset-0 h-full w-full object-cover opacity-0 transition-all duration-200 group-hover:scale-[1.03]",
            showVideoFrame && "opacity-100",
          )}
        />
        <div
          ref={timelineRef}
          className={cn(
            "absolute inset-x-2 bottom-1.5 z-10 h-7 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100",
            (hoveringVideo || scrubbingVideo) && "opacity-100",
          )}
          onPointerDown={handleTimelinePointerDown}
          onPointerMove={handleTimelinePointerMove}
          onPointerUp={handleTimelinePointerEnd}
          onPointerCancel={handleTimelinePointerEnd}
          onClick={stopTimelineEvent}
          onDoubleClick={stopTimelineEvent}
          title={t("library.grid.scrubHint")}
        >
          <input
            type="range"
            min={0}
            max={videoDuration || item.duration_sec || 0}
            step={0.01}
            value={videoTime}
            onChange={handleTimelineChange}
            onInput={handleTimelineChange}
            onPointerDown={handleTimelinePointerDown}
            onPointerMove={handleTimelinePointerMove}
            onPointerUp={handleTimelinePointerEnd}
            onPointerCancel={handleTimelinePointerEnd}
            onClick={stopTimelineEvent}
            onDoubleClick={stopTimelineEvent}
            className="absolute left-0 right-0 top-1/2 h-3 w-full -translate-y-1/2 cursor-ew-resize rounded-none accent-primary"
          />
        </div>
      </div>
    );
  }

  if (!stillSrc) {
    return <Icon className="h-8 w-8 text-muted-foreground" />;
  }

  if (canAnimateOnHover) {
    /* autoplay=true 면 still layer 는 animated 가 로드되기 전까지의 placeholder
       역할만 하고, animated 가 준비되는 즉시 위로 덮어 항상 재생된다.
       autoplay=false 는 기존 동작 그대로 — 정적 + group-hover 시 swap.
       (실험 X) `<img>` 두 장을 모두 `background-image` 로 paint — image-mode
       trigger 차단. animated layer 의 onLoad/onError 는 useImageLoad 의 state
       가 대신 보고 (`animatedLoad === "ready"`/"failed"`). */
    return (
      <AnimatedBackgroundPair
        stillSrc={stillSrc}
        animatedSrc={animatedSrc}
        animationAutoplay={animationAutoplay}
        showOnHover={!animationAutoplay}
        alt={item.title}
        onAspect={onAspect}
      />
    );
  }

  return (
    <BackgroundThumb
      src={stillSrc}
      alt={item.title}
      className="h-full w-full transition-transform duration-200 group-hover:scale-[1.03]"
      onAspect={onAspect}
    />
  );
}

/** (실험 X) canAnimateOnHover 케이스 전용 — still + animated 두 layer 를
 *  `background-image` 로 paint 하고, animated 의 로드 상태(`new Image()`)
 *  로 swap 가시성을 결정. `<img>` 가 한 장도 트리에 없으므로 Chromium
 *  image-mode trigger 가 *원리적으로* 켜질 수 없다.
 *
 *  기존 두 `<img>` 의 onLoad → setAnimatedPreviewReady, onError →
 *  setAnimatedPreviewFailed 시그널을 useImageLoad 의 `state` 로 1:1 대체.
 *  visual 동작 (정적/animated 전환 타이밍, autoplay 모드, hover swap) 은
 *  픽셀 단위로 동일. */
function AnimatedBackgroundPair({
  stillSrc,
  animatedSrc,
  animationAutoplay,
  showOnHover,
  alt,
  onAspect,
}: {
  stillSrc: string;
  animatedSrc: string;
  animationAutoplay: boolean;
  showOnHover: boolean;
  alt: string;
  onAspect?: (w: number, h: number) => void;
}) {
  /* 두 layer 가 같은 absolute box 안에 누적되므로 viewport gating 은
     still layer 에만 attach 하면 동일한 시각 영역을 공유한다. inView 가
     true 가 되어야 양쪽 layer 모두 backgroundImage 와 useImageLoad 가
     활성화 — 1만 카드 진입 시 animated GIF/WEBP 디코드 폭주(특히 무거움)
     를 차단한다. */
  const [ref, inView] = useInViewport<HTMLDivElement>();
  /* BackgroundThumb 와 동일 — 한 번이라도 viewport 안에 들어왔으면 그 후엔
     backgroundImage url 을 영구 유지해 raster cache 의 LRU hit 확률을
     높인다. 자세한 근거는 BackgroundThumb 의 hasEverInViewRef 주석 참조. */
  const hasEverInViewRef = useRef(false);
  if (inView) hasEverInViewRef.current = true;
  const persistBackground = hasEverInViewRef.current;
  useImageLoad(stillSrc, onAspect, inView);
  const animatedState = useImageLoad(animatedSrc, onAspect, inView);
  const showAnimatedPreview = animatedState === "ready";
  const stillStyle: React.CSSProperties = persistBackground && stillSrc
    ? { backgroundImage: `url("${escapeCssUrl(stillSrc)}")` }
    : {};
  const animatedStyle: React.CSSProperties = persistBackground && animatedSrc
    ? { backgroundImage: `url("${escapeCssUrl(animatedSrc)}")` }
    : {};
  return (
    <>
      <div
        ref={ref}
        role="img"
        aria-label={alt}
        className={cn(
          "h-full w-full bg-cover bg-center bg-no-repeat transition-all duration-200 group-hover:scale-[1.03]",
          showAnimatedPreview && (animationAutoplay ? "opacity-0" : showOnHover ? "group-hover:opacity-0" : ""),
        )}
        style={stillStyle}
      />
      <div
        role="img"
        aria-hidden="true"
        className={cn(
          "absolute inset-0 h-full w-full bg-cover bg-center bg-no-repeat opacity-0 transition-all duration-200 group-hover:scale-[1.03]",
          showAnimatedPreview && (animationAutoplay ? "opacity-100" : showOnHover ? "group-hover:opacity-100" : ""),
        )}
        style={animatedStyle}
      />
    </>
  );
}

/* ───────────────── 카드 액션 번들 ─────────────────
 * LibraryGrid 가 받는 30+ 개의 콜백 prop 들. LibraryCard 한 행에 모두 다시
 * 풀어 넘기면 시그니처가 폭발하므로, 카드가 직접 호출하는 것들만 한 객체로
 * 묶어 카드에 넘긴다. LibraryGrid 자체는 그대로 평탄한 props 로 받아 부모
 * (LibraryPage) 와의 인터페이스를 깨지 않는다. */
interface LibraryCardActions {
  onSelect: (id: string, event?: MouseEvent<HTMLElement>) => void;
  onDoubleClick?: (id: string) => void;
  /** 카드 간 재정렬 — `ids` 를 `targetId` 의 *바로 직전* 위치로 이동. dnd-kit
   *  시절의 `handleReorderReferences` 시그니처를 그대로 잇는다. */
  onReorderBefore?: (ids: string[], targetId: string) => void;
  onOpenDefault: (item: ReferenceItem) => void;
  onOpenSourceUrl: (item: ReferenceItem) => void;
  onShowInFolder: (item: ReferenceItem) => void;
  onCopyFilePath: (item: ReferenceItem) => void;
  /** Eagle 식 "Copy" — 단일 PNG/JPEG 은 비트맵, 그 외 미디어는 OS 파일
   *  복사(CF_HDROP), URL 자료는 source_url 텍스트로 클립보드에 올린다.
   *  Ctrl/Cmd+C 단축키와 동일 진입점이지만, 우클릭 메뉴에서도 발견 가능
   *  하도록 명시적 항목으로 노출. 다중 선택이면 selection 전체 기준. */
  onCopySelection: () => void;
  onCopyTags: (item: ReferenceItem) => void;
  onPasteTags: (item: ReferenceItem) => void;
  onAddToFolder: (item: ReferenceItem) => void;
  onMoveToFolder: (item: ReferenceItem) => void;
  onRemoveFromActiveFolder: (item: ReferenceItem) => void;
  onExportSelected: (item: ReferenceItem) => void;
  /** Export as HTML… — read-only viewer 패키지(.zip / .html)로 외부 공유. */
  onExportSelectedAsHtml: (item: ReferenceItem) => void;
  onTogglePin: (item: ReferenceItem) => void;
  onDuplicate: (item: ReferenceItem) => void;
  /** AI 베리에이션 — 원본 이미지를 소스로 구도/스타일 변형을 생성해 새
   *  레퍼런스로 저장한다. 정지 이미지(image/webp)만 대상. */
  onCreateVariation: (item: ReferenceItem) => void;
  onRename: (item: ReferenceItem) => void;
  onSearchByImage: (item: ReferenceItem, engineId?: ImageSearchEngineId) => void;
  onClassify: (item: ReferenceItem) => void;
  /** 이미 분석된 AI 제안 태그를 실제 태그에 적용(LLM 호출 없음). 다중 선택
   *  시 선택 전체에 일괄 적용. */
  onAcceptSuggestions: (item: ReferenceItem) => void;
  onRegenerateThumbnail: (item: ReferenceItem) => void;
  /** Eagle 식 "Custom thumbnail (Select file)" — 로컬 이미지 파일을 골라
   *  이 자료의 cover 로 박는다. 부모(LibraryPage) 가 hidden file input 을
   *  띄우고, 선택된 파일을 setReferenceCoverFromBlob 으로 적용. */
  onSetCoverFromFile: (item: ReferenceItem) => void;
  /** Eagle 식 "Custom thumbnail (From clipboard)" — 현재 OS 클립보드의 첫
   *  image/* 항목을 cover 로 박는다. 클립보드에 이미지가 없으면 토스트로
   *  실패 안내. */
  onSetCoverFromClipboard: (item: ReferenceItem) => void;
  onMergeDuplicates: (item: ReferenceItem) => void;
  onMoveToTrash: (item: ReferenceItem) => void;
  onRestore: (item: ReferenceItem) => void;
  onPermanentlyDelete: (item: ReferenceItem) => void;
  onAddToBrief: (item: ReferenceItem) => void;
  onAddToAgent: (item: ReferenceItem) => void;
  onAddToConti: (item: ReferenceItem) => void;
  onPromoteToAsset: (item: ReferenceItem) => void;
  /** 그리드뷰 전용 숨김(전역). 삭제 아님 — 그리드 목록에서만 가린다.
   *  캔버스 숨김과 독립. */
  onHideFromGrid: (item: ReferenceItem) => void;
  onUnhideFromGrid: (item: ReferenceItem) => void;
}

/* ───────────────── 한 장의 라이브러리 카드 ─────────────────
 * 기존엔 LibraryGrid 안의 renderItemCard 함수가 직접 JSX 를 뱉었으나,
 * 이제 카드별 useDraggable 훅이 필요하므로 진짜 React 컴포넌트로 분리한다.
 * (훅의 호출 규칙상 함수 컴포넌트 안에서만 호출 가능.)
 *
 * dnd-kit DnD 동작:
 *   - id        = item.id (reference uuid).
 *   - data      = { kind: "reference", ids: dragIds, item }.
 *                 ids 는 카드가 선택돼 있으면 selection 전체, 아니면
 *                 자기 한 장. drag end 시점에 LibraryPage 가 읽는다.
 *   - listeners = button 에 spread 해 mousedown 부터 트래킹. 동일
 *                 sensor(distance 6) 로 단일 클릭/우클릭/더블클릭은
 *                 그대로 통과한다 — 6 px 이상 움직여야 drag 로 promote.
 *   - 드래그 중인 본인은 opacity 로 ghost 처리하고, hit 영역만 살짝
 *     줄여 다른 카드에 드롭한 듯한 시각적 혼동을 막는다. */
function LibraryCard({
  item,
  layout,
  isHighlighted,
  selectedCount,
  dragIds,
  dragSourceById,
  duplicateCounts,
  usageCounts,
  folderRows,
  activeFolderTag,
  hasCopiedTags,
  canAddToProject,
  registerCardRef,
  reportAspect,
  actions,
  showName,
  showTypeLabel,
  showAnnotation,
  showBadges,
  generating,
  gridHidden,
}: {
  item: ReferenceItem;
  /** `mode` 로 그리드/리스트를 분기하고, 두 모드 모두 thumb 의 정확한 픽셀
   *  크기를 함께 받는다. 리스트 모드의 thumb 크기는 LibraryGrid 가 슬라이더
   *  값(gridSize) 에서 `listThumbSize` 로 매핑해 채워 준다. */
  layout: { mode: "grid" | "list"; thumbWidth: number; thumbHeight: number };
  isHighlighted: boolean;
  selectedCount: number;
  dragIds: string[];
  /** 다중 선택 드래그 시 같이 끌려가는 카드들의 file_url/source_url/
   *  thumbnail_url/title 을 빠르게 조회. native HTML5 dragstart 핸들러 안에서
   *  Electron startDragOut 에 *전체 카드 메타* 를 넘기기 위해 LibraryGrid 가
   *  만들어 준다. source_url 만 있는 URL 자료(YouTube/link bookmark) 도
   *  외부로 끌어 쓸 수 있도록 source_url + title 도 함께 운반. */
  dragSourceById: Map<
    string,
    {
      fileUrl: string | null;
      sourceUrl: string | null;
      thumbnailUrl: string | null;
      title: string;
      /* 부모에서 만들어 주는 DownloadURL 채널용 메타. link/youtube 자료는
         null. doc 자료도 file_url 이 binary 라 외부 destination 에서 정상
         적으로 다운로드 받히도록 mimeType/filename 이 채워진다. */
      mimeType: string | null;
      downloadFilename: string | null;
    }
  >;
  duplicateCounts: Map<string, number>;
  usageCounts?: Record<string, number>;
  folderRows: LibraryFolderRow[];
  activeFolderTag: string | null;
  hasCopiedTags: boolean;
  canAddToProject: boolean;
  registerCardRef: (id: string, node: HTMLButtonElement | null) => void;
  reportAspect: (id: string, w: number, h: number) => void;
  actions: LibraryCardActions;
  /** 카드 하단 파일명 라벨을 그릴지. grid 뷰에서만 의미가 있다 — list 뷰의
   *  title 은 행의 핵심 정보라 그대로 표시된다. */
  showName: boolean;
  /** 썸네일 좌상단 종류 배지("WEBP" 등) 표시 여부. */
  showTypeLabel: boolean;
  /** 썸네일 우상단 노트 배지(말풍선 아이콘 + 카운트) 표시 여부. */
  showAnnotation: boolean;
  /** 마스터 스위치 — 썸네일 위에 떠 있는 모든 오버레이(즐겨찾기/핀/중복/
   *  사용/휴지통/길이/종류/노트) 를 한 번에 끄고 켠다. false 면 위의
   *  showTypeLabel / showAnnotation 와 무관하게 모든 배지가 숨겨져 카드가
   *  순수 썸네일만 남는다. */
  showBadges: boolean;
  /** 이 카드를 원본으로 AI 베리에이션이 생성 중이면 true — 로딩 오버레이 표시. */
  generating?: boolean;
  /** 그리드 숨김 상태(전역). true 면 메뉴가 "숨김 해제" 로 바뀌고, "숨긴 항목
   *  표시" 토글이 켜진 동안 카드가 흐릿하게 렌더된다. */
  gridHidden?: boolean;
}) {
  const t = useT();
  const Icon = KIND_ICON[item.kind];
  const isGrid = layout.mode === "grid";

  // ── 네이티브 HTML5 DnD 상태 ─────────────────────────────────────
  // dnd-kit 의 useDraggable / useDroppable 을 걷어내고 native HTML5 DnD 로
  // 전환. 카드 본체는 *내부 + 외부* 양쪽을 동시에 인계한다 — Electron
  // `webContents.startDrag` 가 OS 수준 OLE 드래그를 시작하고, Chromium
  // HTML5 dataTransfer 가 같은 윈도우의 폴더/카드 hover/drop 을 받는다.
  //
  // image kind (image/webp) 는 file_url 자체가 image MIME 이라
  // `text/uri-list` 를 박아 Chromium "image-content 모드" 를 강제한다 —
  // 외부 destination 이 OLE CF_HDROP 와 image dataObject 를 받아 파일 인계
  // 가능. 단 image-mode 에서는 native onDragOver/onDrop 이 fire 되지 않는
  // 케이스가 있어, 내부 hover/drop 은 글로벌 `installDragTracker`(document
  // capture 단계 dragover/dragend) 가 좌표→data-attribute 로 검출해 dispatch
  // 한다.
  //
  // 비-image kind (gif/video/youtube/link) 는 image-mode 트릭을 적용하지
  // 않으며(원본이 image MIME 이 아닐 뿐더러, 외부에 잘못된 thumbnail PNG 가
  // 떨어지는 사고가 난다), HTML5 native 흐름 + OLE startDrag 두 시스템을
  // 함께 운반한다. 외부 destination 이 OLE 를 못 받는 케이스는 우클릭
  // "Copy" → 외부 앱 Ctrl+V 가 폴백.
  const [isDragging, setIsDragging] = useState(false);
  const [insertionHover, setInsertionHover] = useState(false);
  /** 글로벌 tracker 의 hover target 을 받아 자기 카드에 insertion line 을
   *  켤지 결정. native onDragOver 와 함께 두 채널로 양방향 동기화 — image
   *  -mode 환경에서 native 가 fire 되지 않아도 tracker 가 시각을 살린다. */
  useEffect(() => {
    return subscribeDragHover((target: DropTarget | null) => {
      if (target && target.kind === "card" && target.id === item.id) {
        const active = getActiveLibraryDrag();
        if (active && active.ids.includes(item.id)) {
          setInsertionHover(false);
          return;
        }
        setInsertionHover(true);
      } else {
        setInsertionHover(false);
      }
    });
  }, [item.id]);
  /** dragstart 시 install 한 글로벌 tracker. dragend 에서 dispose. */
  const trackerRef = useRef<DragTrackerHandle | null>(null);

  /* 카드 ref — marquee 의 cardRefs Map 에 자기 노드를 등록. dnd-kit 시절의
   * setDragRef/setDropRef 는 native DnD 로 전환되어 더 이상 필요 없다. */
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      registerCardRef(item.id, node);
    },
    [item.id, registerCardRef],
  );

  /* dragover/dragenter 가 *내부 reference 드래그* 일 때만 insertion line 을
   * 그린다. 외부 OS 파일 드래그(탐색기→그리드)는 카드 사이 끼워넣기가 의미
   * 없으므로 무시. dataTransfer.types 는 dragover 에서도 키 이름만은 노출
   * 되므로 INTERNAL_DRAG_MIME 의 존재 여부로 1차 판정. */
  const isInternalReferenceDrag = (event: DragEvent<HTMLButtonElement>): boolean => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === INTERNAL_DRAG_MIME) return true;
    }
    // 사이드 채널 — 같은 렌더러 내부 드래그의 메타. dataTransfer 가 비어
    // 들어오는 일부 엣지케이스(브라우저별 차이) 대비 보강.
    return getActiveLibraryDrag() !== null;
  };

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      // 사이드 채널에 드래그 메타 박기 → folder/card hover 시각이 즉시 반응.
      // round-trip 진입 시 그리드 import overlay 차단도 같이 담당
      // (LibraryGrid `isInternalDrag` 가 사이드채널을 본다).
      setActiveLibraryDrag({ ids: dragIds, sourceItem: item, startedAt: Date.now() });

      /* 시도 9 의 잔존 코드 — dragstart 시점에 inner <img> 를 display:none.
       * 이미 효과 없음으로 검증됐지만 회귀 추적용으로 남김. 실험 ② (mousedown
       * 단계 detach) 는 target 이 orphan 되어 drag 자체가 안 시작되는 부작용
       * 으로 폐기. 다음 단계는 ④ (MIME override) — 노트의 매트릭스에 따르면
       * GIF 도 image/gif 인데 cursor 정상이므로 단순 "image/* MIME → image-
       * mode" 가설은 거짓이고, Chromium 의 *static-bitmap* 디스패치 카테고리
       * (PNG/JPG/WEBP) 가 정확한 trigger. 그 카테고리에서 빼려면 응답 MIME 을
       * 카테고리 밖 (application/octet-stream) 으로 박는다. */
      const button = event.currentTarget as HTMLButtonElement;
      const styleRestore: Array<{ el: HTMLElement; display: string }> = [];
      try {
        const imgs = button.querySelectorAll("img");
        for (let i = 0; i < imgs.length; i += 1) {
          const el = imgs[i] as HTMLElement;
          styleRestore.push({ el, display: el.style.display });
          el.style.display = "none";
        }
      } catch {
        /* querySelectorAll 실패해도 native drag 자체는 계속 동작 */
      }
      setTimeout(() => {
        for (const { el, display } of styleRestore) {
          if (el.isConnected) el.style.display = display;
        }
      }, 0);

      // 내부 인지 판단용 MIME — dataTransfer.setData 의 value 자체는
      // dragover 에서 가려져 보이지 않지만 *키 이름* 은 노출되어 다른
      // 컴포넌트가 이 드래그가 우리 내부 것임을 안전하게 식별한다.
      try {
        event.dataTransfer.setData(
          INTERNAL_DRAG_MIME,
          JSON.stringify({ ids: dragIds, sourceId: item.id }),
        );
        /* effectAllowed = "copy" — Chromium image-content 모드 (PNG/JPG/WEBP
         * 의 inner <img> 자동 attach) 가 dropEffect="copy" 만 인정한다. "move"
         * 로 박으면 image-mode 환경에서 cursor 가 not-allowed 로 떠 사용자가
         * release 를 머뭇거린다. 의미적으로는 "이동" 이지만 cursor 시각만
         * "+ 복사" 로 보일 뿐 — 실제 dispatch 는 글로벌 tracker 가 받아 폴더
         * 이동 / 카드 reorder 로 처리하므로 결과는 동일. */
        event.dataTransfer.effectAllowed = "copy";

        /* image kind 한정 — `text/uri-list` 에 image MIME URL 을 박아 Chromium
         * 의 "image-content 모드" 를 강제 승격. 그래야 외부 destination
         * (Slack/Photoshop/탐색기) 이 OLE CF_HDROP 와 image dataObject 를
         * 받아들인다. 비-image kind 은 *일부러* 박지 않는다 — 그쪽은 file_url
         * 이 image MIME 이 아닐 뿐더러, thumbnail.png 를 박으면 외부에 mp4
         * 가 아닌 PNG 가 떨어지는 사고가 난다.
         *
         * 실험 X: image-mode 자체를 `<img>` → background-image 전환으로 차단
         * 했으므로 `text/uri-list` 도 이제 image-mode trigger 와 무관. 그러나
         * 우리는 image-mode 를 *원하지 않기* 때문에 EXPERIMENT_NO_URI_LIST=true
         * 그대로 유지. 외부 export 는 아래의 DownloadURL 채널이 담당. */
        const isImageKind = item.kind === "image" || item.kind === "webp";
        if (isImageKind && !EXPERIMENT_NO_URI_LIST) {
          const src = dragSourceById.get(item.id);
          const url = src?.fileUrl || src?.thumbnailUrl || null;
          if (url) {
            event.dataTransfer.setData("text/uri-list", url);
          }
        }

        /* (실험 X) DownloadURL 채널 — Chromium 이 외부 destination 에 떨어지는
         * 순간 URL 에서 파일을 받아 CF_HDROP 으로 박는다. image-mode 와 *별개
         * 채널* 이라 element 안 `<img>` 가 없어도 외부 export 가 살아남는다.
         * 모든 kind (image/webp/gif/video) 가 같은 경로로 통일.
         *
         * 단 한 번에 한 URL 만 박을 수 있어 multi-select 시에는 *첫 항목 한 장*
         * 만 DownloadURL 로 박고, 나머지는 OLE startDrag (multi-file 지원) 에
         * 위임. 외부 destination 마다 우선순위가 달라 (Slack 은 DownloadURL
         * 우선, 탐색기는 CF_HDROP 우선) 두 채널을 동시에 박아두면 어느 쪽이든
         * 받는 destination 에서 성공.
         *
         * link/youtube 는 fileUrl 이 없어(URL 자체가 본체) skip — 메인의 .url
         * 임시 파일 경로 (OLE) 에 위임. */
        const self = dragSourceById.get(item.id);
        if (ENABLE_DOWNLOAD_URL && self?.fileUrl && self.mimeType && self.downloadFilename) {
          try {
            event.dataTransfer.setData(
              "DownloadURL",
              `${self.mimeType}:${self.downloadFilename}:${self.fileUrl}`,
            );
          } catch {
            /* setData("DownloadURL") 미지원 환경(매우 드뭄) — silent fallback */
          }
        }
      } catch {
        /* 일부 브라우저는 setData 실패해도 native drag 자체는 계속 동작 */
      }

      // 사용자 정의 드래그 미리보기 — buildDragGhost 헬퍼.
      try {
        const ghost = buildDragGhost(item, dragIds);
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 12, 12);
        // 다음 tick 에 ghost 제거 — setDragImage 가 비동기로 raster 한 뒤
        // 떼어내야 빈 미리보기가 잠깐 보이는 문제가 없다.
        setTimeout(() => {
          if (ghost.isConnected) ghost.remove();
        }, 0);
      } catch {
        /* setDragImage 실패해도 OS 가 기본 미리보기를 띄움 */
      }

      /* ── 외부 drag-out (Electron `webContents.startDrag`) ────────────
       *
       * Windows OLE drag 가 HTML5 dragstart 핸들러가 *반환되는 시점* 에
       * 시작되므로, 그 시점 이전에 파일 페이로드가 main 에 등록돼 있어야
       * OS 가 "파일 드래그" 로 인식한다. preload 의 `startDragOut` 은
       * `ipcRenderer.sendSync` 로 메인이 `webContents.startDrag` 를 부른 뒤
       * 에야 dragstart 가 반환되도록 한다.
       *
       * ⚠ `event.preventDefault()` 는 호출하지 않는다 — 그렇게 하면
       * Windows 에서 HTML5 drag 비주얼이 끊겨 내부 폴더/카드 drop 도
       * firing 되지 않는다. preventDefault 없이 양쪽을 동시에 살려두면
       * OS 는 OLE 의 파일 페이로드(외부 destination 용) 와 HTML5
       * dataTransfer(내부 drop 식별 용) 를 모두 운반한다. */
      let startDragOk: boolean | "skipped" = "skipped";
      let payloadCount = 0;
      let hasIcon = false;
      if (ENABLE_STARTDRAG_OLE) {
        try {
          const api = window.preflowWindow;
          if (api?.startDragOut) {
            const payloadItems: Array<{ fileUrl: string | null; sourceUrl: string | null; title: string }> = [];
            let iconUrl: string | null = null;
            for (const id of dragIds) {
              const src = dragSourceById.get(id);
              if (!src) continue;
              payloadItems.push({
                fileUrl: src.fileUrl ?? null,
                sourceUrl: src.sourceUrl ?? null,
                title: src.title || "untitled",
              });
              if (!iconUrl && src.fileUrl) iconUrl = src.fileUrl;
            }
            payloadCount = payloadItems.length;
            hasIcon = Boolean(iconUrl);
            if (payloadItems.length > 0) {
              startDragOk = api.startDragOut(payloadItems, iconUrl);
            }
          }
        } catch (err) {
          console.warn("[LibraryCard] startDragOut throw:", err);
          startDragOk = false;
        }
      }

      // 진단 로그 — kind, payloadCount, hasIcon, ok 한 줄로. 메인의
      // [drag:start] 로그와 짝지어 보면 어느 단계에서 끊기는지 한눈에 파악 가능.
      console.warn(
        "[LibraryCard] dragstart kind=" +
          item.kind +
          " title=" +
          item.title +
          " ids=" +
          dragIds.length +
          " payload=" +
          payloadCount +
          " hasIcon=" +
          hasIcon +
          " startDragOk=" +
          String(startDragOk) +
          " oleEnabled=" +
          String(ENABLE_STARTDRAG_OLE),
      );

      setIsDragging(true);

      /* 글로벌 dragover/dragend tracker — single source for internal drop
       * dispatch. image-mode 가 native onDrop 을 가리는 케이스를 우회하기
       * 위해 document capture 단계 dragover 로 좌표를 추적하고, dragend 시
       * 마지막 hover target 에 dispatch (libraryDragChannel.installDragTracker).
       *
       * 두 번 install 되지 않도록 기존 tracker 가 있으면 먼저 dispose. */
      trackerRef.current?.dispose();
      trackerRef.current = installDragTracker(dragIds);
    },
    [dragIds, dragSourceById, item],
  );

  const handleDragEnd = useCallback(() => {
    /* tracker 의 dragend listener 가 dispatch + cleanup 까지 끝낸 뒤에
     * 호출되어도 무방 — installDragTracker 안의 disposed 플래그가 두 번
     * dispose 하는 것을 막는다. 단 listener 가 어떤 사유로 fire 되지 않은
     * 케이스(예: dragstart 후 즉시 escape 키)에서도 leak 이 없게 명시 호출. */
    trackerRef.current?.dispose();
    trackerRef.current = null;
    clearActiveLibraryDrag();
    setIsDragging(false);
    setInsertionHover(false);
  }, []);

  /* ── POC: Eagle 패턴 mouseDown → mouseTrack → startDrag ──────────
   *
   * USE_EAGLE_PATTERN === true 인 동안만 button 에 attach. mousedown 시점에
   * 기록된 좌표에서 EAGLE_DRAG_THRESHOLD_PX 이상 움직이면 그제야 OLE drag
   * 를 시작한다. HTML5 native drag 자체는 button.draggable=false 로 꺼져
   * 있어 image-mode 가 트리거되지 않는다.
   *
   * click 과 drag 의 분리:
   *   - mousemove 가 임계 이하 → onClick 이 정상 fire (선택)
   *   - mousemove 가 임계 초과 → drag 시작 (이 시점에 click 은 자연 취소)
   *
   * Ctrl/Shift/Alt 동반 click 은 multi-select 의도라 drag 시작을 시도하지
   * 않는다 — 사용자가 정확히 select 만 하고 싶은 상황을 보호. */
  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let dragStarted = false;

      const cleanupListeners = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };

      const beginDrag = () => {
        if (dragStarted) return;
        dragStarted = true;
        cleanupListeners();

        // 사이드 채널 — 내부 드래그 마커. round-trip(외부 → 같은 윈도우)
        // 진입 시 그리드 import overlay 차단도 같이 담당.
        setActiveLibraryDrag({ ids: dragIds, sourceItem: item, startedAt: Date.now() });

        // 글로벌 tracker — 같은 윈도우 안에서 OLE drag 가 dragover/drop 을
        // fire 하면 좌표 기반으로 internal 폴더/카드 dispatch.
        trackerRef.current?.dispose();
        trackerRef.current = installDragTracker(dragIds);

        setIsDragging(true);

        // Electron `webContents.startDrag` — OS-level OLE drag 시작.
        let startDragOk: boolean | "skipped" = "skipped";
        let payloadCount = 0;
        let hasIcon = false;
        try {
          const api = window.preflowWindow;
          if (api?.startDragOut) {
            const payloadItems: Array<{ fileUrl: string | null; sourceUrl: string | null; title: string }> = [];
            let iconUrl: string | null = null;
            for (const id of dragIds) {
              const src = dragSourceById.get(id);
              if (!src) continue;
              payloadItems.push({
                fileUrl: src.fileUrl ?? null,
                sourceUrl: src.sourceUrl ?? null,
                title: src.title || "untitled",
              });
              if (!iconUrl && src.fileUrl) iconUrl = src.fileUrl;
            }
            payloadCount = payloadItems.length;
            hasIcon = Boolean(iconUrl);
            if (payloadItems.length > 0) {
              startDragOk = api.startDragOut(payloadItems, iconUrl);
            }
          }
        } catch (err) {
          console.warn("[LibraryCard] startDragOut throw:", err);
          startDragOk = false;
        }

        console.warn(
          "[LibraryCard] mouseTrack startDrag kind=" +
            item.kind +
            " title=" +
            item.title +
            " ids=" +
            dragIds.length +
            " payload=" +
            payloadCount +
            " hasIcon=" +
            hasIcon +
            " startDragOk=" +
            String(startDragOk),
        );

        /* 안전망 cleanup — Electron OLE 가 dragend 를 보장하지 않으므로
         * 글로벌 mouseup capture (drag 종료 후 다시 들어옴) 와 timeout 두
         * 신호로 사이드채널 / tracker / isDragging 을 강제 정리. */
        const safetyTimer = window.setTimeout(() => {
          finalizeSafety("timeout");
        }, EAGLE_DRAG_SAFETY_MS);

        const finalizeSafety = (cause: "mouseup" | "timeout") => {
          window.clearTimeout(safetyTimer);
          window.removeEventListener("mouseup", onGlobalMouseUp, true);
          // OLE drag 종료 직후 OS 가 우리 document 로 mouseup 을 다시
          // 흘려보내는 시점이라, microtask 뒤로 미뤄야 tracker dragend 와
          // 충돌 없이 cleanup 이 깔끔히 수행됨.
          window.setTimeout(() => {
            if (getActiveLibraryDrag()) {
              console.warn("[LibraryCard] safety cleanup cause=" + cause);
              clearActiveLibraryDrag();
              trackerRef.current?.dispose();
              trackerRef.current = null;
              setIsDragging(false);
              setInsertionHover(false);
            }
          }, 50);
        };

        const onGlobalMouseUp = () => {
          finalizeSafety("mouseup");
        };
        window.addEventListener("mouseup", onGlobalMouseUp, true);
      };

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        if (dragStarted) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.hypot(dx, dy) >= EAGLE_DRAG_THRESHOLD_PX) {
          beginDrag();
        }
      };

      const handleUp = () => {
        // threshold 미만으로 release — 그냥 click. listener 만 정리하고
        // onClick 의 자연 fire 에 맡긴다.
        cleanupListeners();
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [dragIds, dragSourceById, item],
  );

  /* dragover — 내부 reference 드래그면 insertion line 노출 + preventDefault
   * 로 "여기 드롭 가능" 시각을 켜준다. 자기 자신 위 hover 는 의미 없으므로
   * 가드. */
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      if (!isInternalReferenceDrag(event)) return;
      const active = getActiveLibraryDrag();
      if (active && active.ids.includes(item.id)) return;
      event.preventDefault();
      // dragstart 의 effectAllowed="copy" 와 짝 — image-mode 호환.
      event.dataTransfer.dropEffect = "copy";
      setInsertionHover(true);
    },
    [item.id],
  );

  const handleDragLeave = useCallback(() => {
    setInsertionHover(false);
  }, []);

  /* native HTML5 onDrop — dispatch 는 글로벌 tracker (dragend) 가 단독으로
   * 담당하므로 여기서는 시각 정리와 preventDefault 만 한다. 이전 구현에서
   * 이 핸들러가 actions.onReorderBefore 를 직접 부르면, image-mode 환경에서
   * tracker 가 같은 dispatch 를 또 부르는 케이스에서 reorder 가 두 번
   * 적용될 위험이 있어 single source of truth 로 통합. */
  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const active = getActiveLibraryDrag();
      if (!active) return;
      if (active.ids.includes(item.id)) {
        setInsertionHover(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setInsertionHover(false);
    },
    [item.id],
  );


  const showInsertionLine = insertionHover && !isDragging;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={handleRef}
          data-library-card="true"
          data-library-card-id={item.id}
          /* 글로벌 dragover tracker 가 elementFromPoint → closest("[data-drop-
             card-id]") 로 hover 대상을 식별. native onDragOver 가 image-mode
             에 가려도 좌표만 있으면 카드 reorder 가 정상 동작한다. */
          data-drop-card-id={item.id}
          /* USE_EAGLE_PATTERN === true: HTML5 native drag 를 끄고 mouse
             tracking 으로 Electron `webContents.startDrag` 만 호출 — image
             -mode 트리거를 회피해 cursor 가 정상으로 보이고 모든 kind 가
             OLE 경로로 통일된다. internal drop 은 같은 윈도우 위로 OLE
             dragover 가 fire 되면 글로벌 tracker 가 받아 dispatch (검증 중).
             USE_EAGLE_PATTERN === false: 기존 흐름 — HTML5 drag + startDrag
             동시 시작 (image-mode 부작용 cursor 깨짐 + 일부 kind 외부 X). */
          draggable={!USE_EAGLE_PATTERN}
          onDragStart={USE_EAGLE_PATTERN ? undefined : handleDragStart}
          onDragEnd={USE_EAGLE_PATTERN ? undefined : handleDragEnd}
          onMouseDown={USE_EAGLE_PATTERN ? handleMouseDown : undefined}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={(event) => actions.onSelect(item.id, event)}
          onDoubleClick={() => actions.onDoubleClick?.(item.id)}
          onContextMenu={(event) => {
            // 그리드 빈 영역에도 ContextMenu(외곽) 가 붙어 있어, 카드 위
            // 우클릭이 그대로 bubble 하면 카드 메뉴 위에 외곽 "Thumbnail
            // display" 메뉴까지 함께 열리는 사고가 난다. 카드 자체의 메뉴
            // 동작은 Radix 가 composeEventHandlers 로 그대로 살리되, 이벤트
            // 가 상위 ContextMenuTrigger 로 전파되는 것만 막는다.
            event.stopPropagation();
            actions.onSelect(item.id, event);
          }}
          className={cn(
            "group text-left transition-all",
            // 그리드 숨김 항목은 "숨긴 항목 표시" 토글로 노출될 때만 렌더되며,
            // 흐릿하게 + 점선 테두리로 일반 항목과 구분.
            gridHidden && "opacity-45 outline-dashed outline-1 outline-muted-foreground/50",
            isGrid
              ? "flex flex-col bg-transparent"
              : cn(
                  // 리스트 뷰는 표(row) 형태 — grid template 으로 thumb + 5 메타
                  // 컬럼을 sticky 헤더와 픽셀 단위로 맞춘다. 카드 외곽 border 는
                  // 행 사이 1px 구분선(border-b)만 두고, 선택/호버는 배경 틴트로
                  // 시각화한다. (Eagle/Finder 리스트 뷰와 동일한 패턴.) py-1 은
                  // 썸네일 위아래로 4px 숨 — 행 높이가 너무 답답하지 않게.
                  "grid items-center border-b border-border-subtle px-2 py-1",
                  isHighlighted
                    ? "bg-primary/15 hover:bg-primary/20"
                    : "hover:bg-muted/40",
                ),
            // 드래그 중인 본인 카드는 흐릿하게 — 어디서 떨어질지 시각적으로
            // 분명히 하고, 동시에 자기 카드에 떨어지는 사고를 막는다(드롭존
            // 자체도 disable 하지만 대비 시각으로 한 번 더).
            isDragging && "opacity-40",
          )}
          style={
            isGrid
              ? { width: layout.thumbWidth, flexShrink: 0, position: "relative" }
              : {
                  position: "relative",
                  gridTemplateColumns: listGridColumns(layout.thumbWidth),
                  columnGap: LIST_COLUMN_GAP,
                }
          }
        >
          {/* 삽입 표시줄 — 다른 카드를 이 카드 *직전* 위치로 이동시킬 때.
              그리드 뷰는 카드 왼쪽에 가는 수직 라인(다음 카드의 앞), 리스트
              뷰는 행 위쪽에 가는 수평 라인(다음 행의 앞)으로 의미를 살린다.
              카드 자체를 가리지 않고 인접 카드 hover 와도 안 겹친다. */}
          {showInsertionLine ? (
            isGrid ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-20 w-[3px] bg-primary"
                style={{ left: -7 }}
              />
            ) : (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] bg-primary"
              />
            )
          ) : null}
          {isGrid ? (
            <>
              <div
                className={cn(
                  "relative flex items-center justify-center overflow-hidden bg-muted/30 transition-shadow",
                  // Eagle 스타일 선택 시각화: 안쪽 inset 링은 다양한 색상의 썸네일 위에
                  // 묻혀버려, 카드 외곽으로 3px 솔리드 + 1px 어두운 외곽선(대비 보강)을
                  // 함께 그린다. ring 은 box-shadow 기반이라 overflow-hidden 에
                  // 클리핑되지 않아 깔끔하게 카드 바깥쪽에 표시된다.
                  isHighlighted && "ring-1 ring-primary ring-offset-[1px] ring-offset-background",
                  !isHighlighted && "group-hover:ring-1 group-hover:ring-inset group-hover:ring-primary/40",
                )}
                style={{ width: layout.thumbWidth, height: layout.thumbHeight, flexShrink: 0 }}
              >
                <LibraryMediaThumbnail
                  item={item}
                  Icon={Icon}
                  onAspect={(w, h) => reportAspect(item.id, w, h)}
                />
                {/* 선택 오버레이 — 어두운 썸네일에서도 보더만으론 부족할 수 있어
                    옅은 primary 틴트를 위에 올린다. pointer-events-none 으로
                    hover/click 동작은 그대로 통과. */}
                {isHighlighted ? (
                  <div className="pointer-events-none absolute inset-0 bg-primary/15 mix-blend-normal" />
                ) : null}
                {/* AI 베리에이션 생성 중 — 원본 카드 위 로딩 오버레이. */}
                {generating ? (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/55">
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  </div>
                ) : null}
                {/* ── 좌측 배지 스택 (Kind / Favorite / Pinned)
                    위에서부터 활성 배지만 차곡차곡 쌓는다. 이전엔 left-2
                    top-{2|8|14} 로 슬롯 좌표를 직접 박아 빈 슬롯이 떠 있는
                    문제가 있었는데, flex-col + gap-1 로 자동 정렬.

                    showBadges 마스터 토글이 꺼져 있으면 스택 자체를 렌더하지
                    않아 DOM 노드가 줄어든다 — 그리드 수백 장의 카드에 절대
                    위치 div 가 사라지면 페인트 비용도 함께 감소. */}
                {showBadges ? (
                  <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
                    {showTypeLabel ? (
                      <Badge className="h-5 px-1.5 text-micro" variant="secondary">
                        {resolveFormatLabel(item)}
                      </Badge>
                    ) : null}
                    {item.is_favorite ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-primary/90 text-primary-foreground"
                        title={t("library.grid.favorite")}
                        aria-label={t("library.grid.favorite")}
                      >
                        <Star className="h-3 w-3 fill-current" />
                      </Badge>
                    ) : null}
                    {item.pinned_at ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-primary/90 text-primary-foreground"
                        title={t("library.grid.pinned")}
                        aria-label={t("library.grid.pinned")}
                      >
                        <Pin className="h-3 w-3 fill-current" />
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
                {/* ── 우측 배지 스택 (Duplicate / Trash / Used / Notes)
                    TRASH 가 항상 우측 최상단에서 시작하도록 stack 화. 이전엔
                    right-2 top-8 로 하드코딩되어 휴지통 화면처럼 위쪽 슬롯이
                    비어 있을 때 두 번째 줄에 떠 보이는 문제가 있었음. Notes
                    배지의 복잡한 cn() 위치 분기도 함께 사라짐.

                    좌측 스택과 마찬가지로 showBadges 마스터 토글로 전체 스택을
                    숨길 수 있다. */}
                {showBadges ? (
                  <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
                    {item.variation_of ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-foreground/80 text-background"
                        title={t("library.grid.variationBadge")}
                        aria-label={t("library.grid.variationBadge")}
                      >
                        <Network className="h-3 w-3" />
                      </Badge>
                    ) : null}
                    {item.content_hash && (duplicateCounts.get(item.content_hash) ?? 0) > 1 ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-amber-500/90 text-black"
                        title={t("library.grid.duplicateCandidate")}
                        aria-label={t("library.grid.duplicateCandidate")}
                      >
                        <Copy className="h-3 w-3" />
                      </Badge>
                    ) : null}
                    {item.deleted_at ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-destructive text-destructive-foreground"
                        title={t("library.grid.inTrash")}
                        aria-label={t("library.grid.inTrash")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Badge>
                    ) : (usageCounts?.[item.id] ?? 0) > 0 ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-primary/85 text-primary-foreground"
                        title={t("library.grid.usedInTargets", { n: usageCounts![item.id] })}
                        aria-label={t("library.grid.usedInTargets", { n: usageCounts![item.id] })}
                      >
                        <Link2 className="mr-0.5 h-3 w-3" />
                        {usageCounts![item.id]}
                      </Badge>
                    ) : null}
                    {/* 코멘트 뱃지 — 이전엔 video 만 표시했지만, image/gif/webp 의
                        region/frame 노트도 모두 같은 timestamp_notes 배열에 저장되므로
                        자료 종류와 무관하게 노트가 있으면 동일 뱃지를 노출한다.
                        showAnnotation 토글이 꺼져 있으면 카운트와 무관하게 숨김. */}
                    {showAnnotation
                      && (item.kind === "video"
                        || item.kind === "gif"
                        || item.kind === "webp"
                        || item.kind === "image"
                        || item.kind === "doc")
                      && item.timestamp_notes.length > 0 ? (
                      <Badge
                        className="h-5 px-1 text-micro bg-primary/85 text-primary-foreground"
                        title={t("library.grid.notesCount", { n: item.timestamp_notes.length })}
                        aria-label={t("library.grid.notesCount", { n: item.timestamp_notes.length })}
                      >
                        <MessageSquare className="mr-0.5 h-3 w-3" />
                        {item.timestamp_notes.length}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
                {showBadges && (item.kind === "video" || item.kind === "youtube") && item.duration_sec ? (
                  <span
                    className={cn(
                      "absolute right-2 bg-black/70 px-1.5 py-0.5 font-mono text-2xs text-white transition-[bottom] duration-150",
                      item.kind === "video" ? "bottom-2 group-hover:bottom-8" : "bottom-2",
                    )}
                  >
                    {formatDuration(item.duration_sec)}
                  </span>
                ) : null}
              </div>
              {/* 라벨 — block-level div 하나로 단순화. 이전엔 `<div flex justify-center><span truncate text-center>` 였는데
                  span 이 inline 이라 텍스트가 짧을 땐 span 폭=텍스트 폭이 되어 text-center 가 무효가 되고,
                  텍스트가 길어서 span 이 flex 가용 폭까지 늘어날 때만 text-center 가 적용되는 비일관 동작이 있었음.
                  block 요소에 truncate + text-center 를 직접 걸면 짧은 텍스트는 정확히 가운데,
                  긴 텍스트는 컨테이너 폭 가득 채운 채로 ellipsis 처리되어 시각적으로 항상 안정적.
                  lineHeight = GRID_LABEL_HEIGHT 로 단일 라인 텍스트의 수직 정렬도 함께 해결.

                  showName 토글이 꺼져 있으면 라벨 자체를 렌더하지 않는다 — 그러면
                  같은 행 안의 카드 높이가 GRID_LABEL_HEIGHT 만큼 짧아지는 게 아니라
                  썸네일만 보이는 컴팩트한 그리드가 된다 (Eagle 의 "Show Name" off
                  동작과 동일). */}
              {showName ? (
                <div
                  className={cn(
                    "w-full truncate px-1.5 text-center text-caption",
                    isHighlighted
                      ? "font-semibold text-primary"
                      : "text-text-secondary group-hover:text-foreground",
                  )}
                  style={{ height: GRID_LABEL_HEIGHT, lineHeight: `${GRID_LABEL_HEIGHT}px` }}
                  title={item.title}
                >
                  {item.title}
                </div>
              ) : null}
            </>
          ) : (
            /* ───────── 리스트(표) 뷰 행 ─────────
             *
             * sticky 헤더와 동일한 grid template 6 컬럼 위에 thumb · Name ·
             * Dimensions · Extension · File Size · Date Added 를 펼친다.
             * 메타 4 컬럼은 우측 정렬 + tabular-nums 폰트로 숫자/단위가
             * 세로로 정렬돼 한눈에 비교하기 쉽다. 그리드 뷰의 절대 위치
             * 배지 스택은 시각 노이즈가 큰데 비해 행이 좁아 의미가 적어,
             * 작은 인라인 아이콘 한 줄(즐겨찾기 · 핀 · 사용 · 노트 · 휴지통)
             * 로 압축. 종류/MIME 정보는 Extension 컬럼이 단독으로 표현. */
            <>
              <div
                className={cn(
                  "relative flex items-center justify-center overflow-hidden bg-muted/30",
                  isHighlighted && "ring-1 ring-primary",
                )}
                style={{ width: layout.thumbWidth, height: layout.thumbHeight, flexShrink: 0 }}
              >
                <LibraryMediaThumbnail
                  item={item}
                  Icon={Icon}
                  onAspect={(w, h) => reportAspect(item.id, w, h)}
                />
                {/* 길이 배지 — 비디오/YouTube 만, 작게 한 줄로. 그리드 뷰의
                    호버 슬라이드 트릭은 리스트 뷰에선 의미가 없어 제거. */}
                {(item.kind === "video" || item.kind === "youtube") && item.duration_sec ? (
                  <span className="pointer-events-none absolute bottom-0.5 right-0.5 bg-black/75 px-1 py-0 font-mono text-nano leading-none text-white">
                    {formatDuration(item.duration_sec)}
                  </span>
                ) : null}
              </div>
              {/* Name 컬럼 — 좌측 작은 아이콘 row (즐겨찾기/핀/사용/노트/휴지통/
                  중복 후보) 와 truncate 제목. 메타 컬럼의 fixed-width 와 달리
                  Name 만 1fr 로 늘어나 가용 폭을 모두 차지하고, 좁아지면
                  ellipsis 로 줄어든다. */}
              <div className="flex min-w-0 items-center gap-1.5">
                {item.is_favorite ? (
                  <Star
                    className="h-3 w-3 flex-shrink-0 fill-primary text-primary"
                    aria-label={t("library.grid.favorite")}
                  />
                ) : null}
                {item.pinned_at ? (
                  <Pin
                    className="h-3 w-3 flex-shrink-0 fill-primary text-primary"
                    aria-label={t("library.grid.pinned")}
                  />
                ) : null}
                <span
                  className={cn(
                    "truncate text-xs",
                    isHighlighted
                      ? "font-semibold text-foreground"
                      : "text-foreground/90 group-hover:text-foreground",
                  )}
                  title={item.title}
                >
                  {item.title}
                </span>
                {item.content_hash && (duplicateCounts.get(item.content_hash) ?? 0) > 1 ? (
                  <Copy
                    className="h-3 w-3 flex-shrink-0 text-amber-500"
                    aria-label={t("library.grid.duplicateCandidate")}
                  />
                ) : null}
                {item.deleted_at ? (
                  <Trash2
                    className="h-3 w-3 flex-shrink-0 text-destructive"
                    aria-label={t("library.grid.inTrash")}
                  />
                ) : (usageCounts?.[item.id] ?? 0) > 0 ? (
                  <span
                    className="flex flex-shrink-0 items-center gap-0.5 text-2xs font-mono text-primary"
                    title={t("library.grid.usedInTargets", { n: usageCounts![item.id] })}
                  >
                    <Link2 className="h-3 w-3" />
                    {usageCounts![item.id]}
                  </span>
                ) : null}
                {(item.kind === "video"
                  || item.kind === "gif"
                  || item.kind === "webp"
                  || item.kind === "image")
                  && item.timestamp_notes.length > 0 ? (
                  <span
                    className="flex flex-shrink-0 items-center gap-0.5 text-2xs font-mono text-primary"
                    title={t("library.grid.notesCount", { n: item.timestamp_notes.length })}
                  >
                    <MessageSquare className="h-3 w-3" />
                    {item.timestamp_notes.length}
                  </span>
                ) : null}
              </div>
              {/* Dimensions / Extension / File Size / Date Added — 모두 Pretendard
                  본문 폰트로 통일(이전엔 숫자 컬럼이 font-mono). 자릿수 차이로
                  들쭉날쭉 보이지 않도록 `tabular-nums` 만 살린다 — Pretendard 의
                  OpenType `tnum` feature 가 켜져 등폭 숫자가 된다.
                  Extension 컬럼은 `extensionFromItem` 이 이미 자연 표기
                  ("webp"/"gif"/"YouTube"/"Pinterest")로 돌려주므로 CSS uppercase
                  강제를 제거했다. */}
              <div className="truncate text-right text-caption text-muted-foreground tabular-nums">
                {formatDimensions(item)}
              </div>
              <div
                className="truncate text-right text-caption text-muted-foreground"
                title={item.mime_type ?? undefined}
              >
                {extensionFromItem(item)}
              </div>
              <div className="truncate text-right text-caption text-muted-foreground tabular-nums">
                {formatBytes(item.file_size) || "—"}
              </div>
              <div className="truncate text-right text-caption text-muted-foreground tabular-nums">
                {formatDateTime(item.created_at)}
              </div>
            </>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-72 max-w-96 rounded-none">
        <ContextMenuLabel className="block truncate text-caption" title={item.title}>{item.title}</ContextMenuLabel>
        <ContextMenuSeparator />
        {(item.kind === "link" || item.kind === "youtube") && (
          <ContextMenuItem disabled={!item.source_url} onSelect={() => actions.onOpenSourceUrl(item)}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            {t("library.grid.ctx.openInBrowser")}
          </ContextMenuItem>
        )}
        {item.kind !== "link" && item.kind !== "youtube" && (
          <ContextMenuItem disabled={!item.file_url && !item.thumbnail_url} onSelect={() => actions.onOpenDefault(item)}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            {t("library.grid.ctx.openDefault")}
            <ContextMenuShortcut>Shift+Enter</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!item.file_url && !item.thumbnail_url} onSelect={() => actions.onShowInFolder(item)}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.openFileLocation")}
          <ContextMenuShortcut>Ctrl+Enter</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!item.file_url && !item.thumbnail_url} onSelect={() => actions.onCopyFilePath(item)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.copyFilePath")}
          <ContextMenuShortcut>Ctrl+Alt+C</ContextMenuShortcut>
        </ContextMenuItem>
        {/* Eagle 식 "Copy" — Ctrl/Cmd+C 의 우클릭 메뉴 진입점. 단일
            PNG/JPEG 은 비트맵으로, 그 외 미디어는 OS 파일 복사(CF_HDROP)
            로, URL 자료(link/youtube) 는 source_url 텍스트로 클립보드에
            올린다. 다중 선택이면 selection 전체 기준. 외부 앱
            (Slack/Discord/탐색기) 에 Ctrl+V 로 파일·이미지·URL 페이스트. */}
        <ContextMenuItem onSelect={() => actions.onCopySelection()}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.copyN", { n: selectedCount }) : t("library.grid.ctx.copy")}
          <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onCopyTags(item)}>
          <Tags className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.copyTags")}
          <ContextMenuShortcut>Alt+T</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasCopiedTags} onSelect={() => actions.onPasteTags(item)}>
          <Tags className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.pasteTags")}
          <ContextMenuShortcut>Ctrl+Alt+T</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onTogglePin(item)}>
          <Pin className="mr-2 h-3.5 w-3.5" />
          {item.pinned_at ? t("library.grid.ctx.unpinFromTop") : t("library.grid.ctx.pinToTop")}
          <ContextMenuShortcut>Alt+P</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onRename(item)}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.renameSimple")}
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onDuplicate(item)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.duplicateSimple")}
          <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
        </ContextMenuItem>
        {/* AI 베리에이션 — Phase 1 은 정지 이미지(image/webp)만. gif/video/doc/
            youtube/link 는 비활성. */}
        <ContextMenuItem
          disabled={
            Boolean(item.deleted_at)
            || !(item.kind === "image" || item.kind === "webp")
            || !item.file_url
          }
          onSelect={() => actions.onCreateVariation(item)}
        >
          <Network className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.createVariation")}
          <ContextMenuShortcut>Alt+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={folderRows.length === 0 || Boolean(item.deleted_at)} onSelect={() => actions.onAddToFolder(item)}>
          <FolderInput className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.addNToFolder", { n: selectedCount }) : t("library.grid.ctx.addToFolder")}
        </ContextMenuItem>
        <ContextMenuItem disabled={folderRows.length === 0 || Boolean(item.deleted_at)} onSelect={() => actions.onMoveToFolder(item)}>
          <FolderInput className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.moveNToFolder", { n: selectedCount }) : t("library.grid.ctx.moveToFolderSimple")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!activeFolderTag || Boolean(item.deleted_at)} onSelect={() => actions.onRemoveFromActiveFolder(item)}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.removeFromThisFolder")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onExportSelected(item)}>
          <Download className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.exportNAsPack", { n: selectedCount }) : t("library.grid.ctx.exportSelected")}
        </ContextMenuItem>
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onExportSelectedAsHtml(item)}>
          <Download className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.exportNAsHtml", { n: selectedCount }) : t("library.grid.ctx.exportSelectedAsHtml")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!getImageSearchSourceUrl(item)}>
            <ScanSearch className="mr-2 h-3.5 w-3.5" />
            {t("library.grid.ctx.searchByImage")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {IMAGE_SEARCH_ENGINES.map((engine) => (
              <ContextMenuItem
                key={engine.id}
                onSelect={() => actions.onSearchByImage(item, engine.id)}
              >
                {t(engine.labelKey)}
                {engine.id === "google-lens" ? (
                  <ContextMenuShortcut>Alt+S</ContextMenuShortcut>
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {/* doc(문서/PDF/오디오/zip)은 시각 분석 대상이 아니라 비활성. */}
        <ContextMenuItem disabled={Boolean(item.deleted_at) || item.kind === "doc"} onSelect={() => actions.onClassify(item)}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1
            ? t("library.grid.ctx.reclassifyAiN", { n: selectedCount })
            : t("library.grid.ctx.reclassifyAi")}
          <ContextMenuShortcut>Alt+R</ContextMenuShortcut>
        </ContextMenuItem>
        {/* 이미 분석된 제안 태그를 실제 태그에 적용(LLM 재호출 없음). 재분류와
            달리 기존 ai_suggestions 를 그대로 머지만 하므로 빠르고 비용 0. */}
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onAcceptSuggestions(item)}>
          <Tags className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1
            ? t("library.grid.ctx.applySuggestedTagsN", { n: selectedCount })
            : t("library.grid.ctx.applySuggestedTags")}
        </ContextMenuItem>
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onRegenerateThumbnail(item)}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.regenerateThumbnail")}
          <ContextMenuShortcut>Alt+G</ContextMenuShortcut>
        </ContextMenuItem>
        {/* Eagle 식 Custom thumbnail — Regenerate Thumbnail 의 자유도 버전.
            Regenerate 는 *원본에서 자동으로* poster 를 다시 뽑는 반면, 아래
            두 항목은 사용자가 *임의의 이미지* 로 cover 를 덮어쓴다. trash
            상태에서는 disabled. */}
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onSetCoverFromFile(item)}>
          <FileImage className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.customThumbFromFile")}
          <ContextMenuShortcut>Alt+U</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={Boolean(item.deleted_at)} onSelect={() => actions.onSetCoverFromClipboard(item)}>
          <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
          {t("library.grid.ctx.customThumbFromClipboard")}
          <ContextMenuShortcut>Ctrl+Alt+U</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={
            !item.content_hash
            || (duplicateCounts.get(item.content_hash) ?? 0) < 2
            || Boolean(item.deleted_at)
          }
          onSelect={() => actions.onMergeDuplicates(item)}
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          {selectedCount > 1 ? t("library.grid.ctx.mergeSelected") : t("library.grid.ctx.mergeAll")}
          <ContextMenuShortcut>Alt+M</ContextMenuShortcut>
        </ContextMenuItem>
        {/* 그리드 숨김(전역) — 삭제 아님. 캔버스/검색/생성 입력엔 그대로 남고
            그리드 목록에서만 가린다. 휴지통 항목엔 노출 안 함. Eye/EyeOff 아이콘은
            상단 lucide-react import 에서 가져온다. */}
        {!item.deleted_at ? (
          <ContextMenuItem
            onSelect={() => (gridHidden ? actions.onUnhideFromGrid(item) : actions.onHideFromGrid(item))}
          >
            {gridHidden ? <Eye className="mr-2 h-3.5 w-3.5" /> : <EyeOff className="mr-2 h-3.5 w-3.5" />}
            {gridHidden
              ? t("library.grid.ctx.unhideFromGrid")
              : selectedCount > 1
                ? t("library.grid.ctx.hideNFromGrid", { n: selectedCount })
                : t("library.grid.ctx.hideFromGrid")}
            <ContextMenuShortcut>H</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {item.deleted_at ? (
          <>
            <ContextMenuItem onSelect={() => actions.onRestore(item)}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              {selectedCount > 1 ? t("library.grid.ctx.restoreN", { n: selectedCount }) : t("library.grid.ctx.restoreSimple")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onPermanentlyDelete(item)} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {selectedCount > 1 ? t("library.grid.ctx.permDeleteN", { n: selectedCount }) : t("library.grid.ctx.permDeleteSimple")}
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem onSelect={() => actions.onMoveToTrash(item)} className="text-destructive focus:text-destructive">
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {selectedCount > 1 ? t("library.grid.ctx.moveNToTrash", { n: selectedCount }) : t("library.grid.ctx.moveToTrashSimple")}
            <ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* Brief/Agent/Conti 추가 — link/doc 자료는 시각적으로 *씬에 부착되는*
            형태가 아니라 사이드 자료라, 일관되게 비활성. 후속 Phase 4 에서
            doc 을 Brief 첨부 정도까지 허용하는 것을 검토. */}
        <ContextMenuItem disabled={!canAddToProject || item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)} onSelect={() => actions.onAddToBrief(item)}>
          {t("library.grid.ctx.addToBrief")}
          <ContextMenuShortcut>Alt+B</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canAddToProject || item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)} onSelect={() => actions.onAddToAgent(item)}>
          {t("library.grid.ctx.addToAgent")}
          <ContextMenuShortcut>Alt+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canAddToProject || item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)} onSelect={() => actions.onAddToConti(item)}>
          {t("library.grid.ctx.addToConti")}
          <ContextMenuShortcut>Alt+C</ContextMenuShortcut>
        </ContextMenuItem>
        {/* Promote to Asset — 정지 이미지이거나 썸네일이 있는 자료(gif/video/URL
            포함)에서 노출. 비-이미지 kind 는 썸네일을 에셋 사진으로 쓴다. 에셋
            승격은 단건만 의미가 있어 다중 선택 시에는 숨긴다. */}
        {(item.kind === "image" || item.kind === "webp" || Boolean(item.thumbnail_url)) && selectedCount <= 1 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!canAddToProject || !(item.thumbnail_url || item.file_url) || Boolean(item.deleted_at)}
              onSelect={() => actions.onPromoteToAsset(item)}
            >
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              {t("library.grid.ctx.promoteToAsset")}
              <ContextMenuShortcut>Alt+E</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface LibraryGridProps {
  items: ReferenceItem[];
  selectedId: string | null;
  selectedIds: Set<string>;
  duplicateCounts: Map<string, number>;
  /** 현재 AI 베리에이션 생성 중인 원본 id 들 — 그 카드에 로딩 오버레이. */
  generatingIds?: ReadonlySet<string>;
  /** referenceId → 이 자료가 (프로젝트, target) 쌍에서 몇 번 쓰이고 있는지.
   *  값이 없거나 0 이면 뱃지를 숨긴다 — 새 자료에 시각적 노이즈를 만들지 않기 위함. */
  usageCounts?: Record<string, number>;
  loading: boolean;
  error: string | null;
  isDragging: boolean;
  gridSize: number;
  viewMode: LibraryViewMode;
  /** 현재 정렬 키/방향. 리스트 뷰의 컬럼 헤더가 active 표시(▲/▼) 와 클릭
   *  토글을 위해 읽는다. 그리드 뷰는 시각적으로 영향 받지 않지만 같은 prop
   *  으로 두 뷰의 정렬 상태가 분리되지 않도록 한다. */
  sortKey: LibrarySortKey;
  sortOrder: LibrarySortOrder;
  /** 컬럼 헤더 클릭으로 정렬 키 변경. 토올바 sort 드롭다운과 같은 setter 를
   *  공유 — 두 진입점이 단일 상태를 가리킨다. */
  onSortKeyChange: (key: LibrarySortKey) => void;
  onSortOrderChange: (order: LibrarySortOrder) => void;
  /** 자료 추가가 의미 있는 뷰인지. false 면 드래그 오버레이 / 드롭 핸들러 /
   *  empty-state 의 Files·Folder 버튼을 모두 비활성화한다. 기본은 true. */
  viewSupportsUpload?: boolean;
  /** 현재 quick filter — empty-state 의 안내 문구를 뷰별로 자연스럽게 바꾸기
   *  위해서만 사용. 미지정 시 일반 메시지로 폴백. */
  quickFilter?: QuickFilter;
  onSelect: (id: string, event?: MouseEvent<HTMLElement>) => void;
  onDoubleClick?: (id: string) => void;
  /** 카드 간 재정렬 — native DnD onDrop 이 호출. dnd-kit 시절의 동일 시그니처
   *  를 잇는다. 부모(LibraryPage) 는 `handleReorderReferences(ids, targetId)`
   *  를 그대로 연결하면 된다. */
  onReorderReferences?: (ids: string[], targetId: string) => void;
  onMarqueeSelect?: (ids: string[], mode: "replace" | "add") => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
  onDragStateChange: (dragging: boolean) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  hasCopiedTags: boolean;
  onOpenDefault: (item: ReferenceItem) => void;
  onOpenSourceUrl: (item: ReferenceItem) => void;
  onShowInFolder: (item: ReferenceItem) => void;
  onCopyFilePath: (item: ReferenceItem) => void;
  /** Eagle 식 "Copy" — Ctrl/Cmd+C 와 동일하게 selection 을 OS 클립보드에
   *  자료 종류별 최적 페이로드(비트맵/파일/텍스트) 로 올린다. 우클릭
   *  메뉴에서도 호출 가능하도록 노출. */
  onCopySelection: () => void;
  onCopyTags: (item: ReferenceItem) => void;
  onPasteTags: (item: ReferenceItem) => void;
  folderRows: LibraryFolderRow[];
  activeFolderTag: string | null;
  onAddToFolder: (item: ReferenceItem) => void;
  onMoveToFolder: (item: ReferenceItem) => void;
  onRemoveFromActiveFolder: (item: ReferenceItem) => void;
  onExportSelected: (item: ReferenceItem) => void;
  onExportSelectedAsHtml: (item: ReferenceItem) => void;
  onTogglePin: (item: ReferenceItem) => void;
  onDuplicate: (item: ReferenceItem) => void;
  /** AI 베리에이션 — 원본 이미지를 소스로 구도/스타일 변형을 생성해 새
   *  레퍼런스로 저장한다. 정지 이미지(image/webp)만 대상. */
  onCreateVariation: (item: ReferenceItem) => void;
  onRename: (item: ReferenceItem) => void;
  onSearchByImage: (item: ReferenceItem, engineId?: ImageSearchEngineId) => void;
  onClassify: (item: ReferenceItem) => void;
  /** 이미 분석된 AI 제안 태그를 실제 태그에 적용(LLM 호출 없음). 다중 선택
   *  시 선택 전체에 일괄 적용. */
  onAcceptSuggestions: (item: ReferenceItem) => void;
  onRegenerateThumbnail: (item: ReferenceItem) => void;
  /** Eagle 식 "Custom thumbnail (Select file)" — 로컬 이미지 파일을 골라
   *  이 자료의 cover 로 박는다. 부모(LibraryPage) 가 hidden file input 을
   *  띄우고, 선택된 파일을 setReferenceCoverFromBlob 으로 적용. */
  onSetCoverFromFile: (item: ReferenceItem) => void;
  /** Eagle 식 "Custom thumbnail (From clipboard)" — 현재 OS 클립보드의 첫
   *  image/* 항목을 cover 로 박는다. 클립보드에 이미지가 없으면 토스트로
   *  실패 안내. */
  onSetCoverFromClipboard: (item: ReferenceItem) => void;
  onMergeDuplicates: (item: ReferenceItem) => void;
  onMoveToTrash: (item: ReferenceItem) => void;
  onRestore: (item: ReferenceItem) => void;
  onPermanentlyDelete: (item: ReferenceItem) => void;
  onAddToBrief: (item: ReferenceItem) => void;
  onAddToAgent: (item: ReferenceItem) => void;
  onAddToConti: (item: ReferenceItem) => void;
  onPromoteToAsset: (item: ReferenceItem) => void;
  /** 그리드 숨김(전역)된 id 집합 — 카드별 메뉴 상태/흐림 표시에 사용. */
  gridHiddenIds: ReadonlySet<string>;
  onHideFromGrid: (item: ReferenceItem) => void;
  onUnhideFromGrid: (item: ReferenceItem) => void;
  canAddToProject: boolean;
  /** 그리드 안에서 <img>/<video> 가 자연 해상도를 처음 보고할 때 1회 호출.
   *  부모(LibraryPage) 가 DB 의 width/height 가 비어 있던 항목을 lazy
   *  backfill 하는 데 사용한다. Shape 필터(`aspectBuckets`) 정확도를 위해
   *  필요. 호출은 매 mount 마다 가능하므로 부모 쪽에서 세션 단위 dedupe
   *  필요. */
  onItemDimensionsMeasured?: (id: string, width: number, height: number) => void;
}

export function LibraryGrid({
  items,
  selectedId,
  selectedIds,
  duplicateCounts,
  generatingIds,
  usageCounts,
  loading,
  error,
  isDragging,
  gridSize,
  viewMode,
  sortKey,
  sortOrder,
  onSortKeyChange,
  onSortOrderChange,
  viewSupportsUpload = true,
  quickFilter,
  onSelect,
  onDoubleClick,
  onReorderReferences,
  onMarqueeSelect,
  onChooseFiles,
  onChooseFolder,
  onDragStateChange,
  onDrop,
  hasCopiedTags,
  onOpenDefault,
  onOpenSourceUrl,
  onShowInFolder,
  onCopyFilePath,
  onCopySelection,
  onCopyTags,
  onPasteTags,
  folderRows,
  activeFolderTag,
  onAddToFolder,
  onMoveToFolder,
  onRemoveFromActiveFolder,
  onExportSelected,
  onExportSelectedAsHtml,
  onTogglePin,
  onDuplicate,
  onCreateVariation,
  onRename,
  onSearchByImage,
  onClassify,
  onAcceptSuggestions,
  onRegenerateThumbnail,
  onSetCoverFromFile,
  onSetCoverFromClipboard,
  onMergeDuplicates,
  onMoveToTrash,
  onRestore,
  onPermanentlyDelete,
  onAddToBrief,
  onAddToAgent,
  onAddToConti,
  onPromoteToAsset,
  gridHiddenIds,
  onHideFromGrid,
  onUnhideFromGrid,
  canAddToProject,
  onItemDimensionsMeasured,
}: LibraryGridProps) {
  const t = useT();
  const containerRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  /* ── Eagle 식 "썸네일 영역 보기 옵션" ─────────────────────────
   * 우클릭 컨텍스트 메뉴(아래 wrapper) 의 체크박스 세 개를 통해 사용자가
   * 끄고 켤 수 있는 카드 시각 옵션. 같은 윈도우(CustomEvent) 와 다른
   * 윈도우(storage) 모두 즉시 반영 — 동일 라이브러리를 두 창에서 열고
   * 있을 때 한쪽 토글이 다른 쪽에도 즉시 적용된다. */
  const showName = useLibraryShowName();
  const showTypeLabel = useLibraryShowTypeLabel();
  const showAnnotation = useLibraryShowAnnotation();
  const showBadges = useLibraryShowBadges();
  /* GIF/animated WebP/APNG 의 자동 재생 정책 — Settings 와 같은 dual-channel
   * (CustomEvent + storage) 로 LibraryMediaThumbnail 까지 즉시 전파된다.
   * 그리드 빈 영역 ContextMenu 의 토글이 이 값을 직접 쓰고, 카드 안의
   * useAnimatedThumbnailsAutoplay 가 같은 채널을 구독해 자동으로 리렌더. */
  const animatedThumbnailsAutoplay = useAnimatedThumbnailsAutoplay();
  const [marquee, setMarquee] = useState<{
    startClientX: number;
    startClientY: number;
    currentClientX: number;
    currentClientY: number;
    startContentX: number;
    startContentY: number;
    currentContentX: number;
    currentContentY: number;
    mode: "replace" | "add";
  } | null>(null);
  const [intersectingIds, setIntersectingIds] = useState<Set<string>>(new Set());
  // 그리드 컨테이너 픽셀 폭. 0 은 "아직 측정 전" — 첫 useEffect 후 바로
  // 실제 폭으로 채워진다. Justified-rows 는 이 값과 gridSize(=목표 행 높이)
  // 만 있으면 매 프레임 행 배열을 결정 가능 — 기존의 hysteresis 정책이
  // 더 이상 필요하지 않다. (자연 비율 기반이라 작은 폭 변화엔 scale
  // factor 가 매끄럽게 따라가고, 큰 변화엔 행 break 가 새로 잡힌다.)
  const [containerWidth, setContainerWidth] = useState(0);

  // ── 자연 비율 학습 캐시 ──────────────────────────────────────
  // DB 의 width/height 가 비어 있는 legacy 항목은 처음에 kind 폴백 비율
  // (image=4:3, 그 외=16:9) 로 layout 되지만, 실제 미디어가 로드되면
  // <img onLoad> / <video onLoadedMetadata> 가 진짜 naturalWidth/Height 를
  // 보고하고, 이 map 에 저장돼 다음 layout 에서 정확한 비율로 재배치된다.
  // 결과: 9:16 portrait 이미지가 더 이상 4:3 박스에 잘려 정방형처럼
  // 보이지 않는다.
  const [learnedAspects, setLearnedAspects] = useState<Map<string, number>>(() => new Map());

  const reportAspect = useCallback((id: string, w: number, h: number) => {
    if (!w || !h) return;
    const ratio = Math.max(0.3, Math.min(4, w / h));
    setLearnedAspects((prev) => {
      // 같은 값이면 새 Map 만들지 않음 — useMemo 하위가 불필요하게 다시 안 돌게.
      const existing = prev.get(id);
      if (existing !== undefined && Math.abs(existing - ratio) < 0.001) return prev;
      const next = new Map(prev);
      next.set(id, ratio);
      return next;
    });
    // 부모에게도 raw pixel dimension 을 전달 — DB backfill 용. ratio 와 별개로
    // 정수 픽셀 값 자체가 필요해서 클램프 전 원본을 그대로 넘긴다.
    onItemDimensionsMeasured?.(id, w, h);
  }, [onItemDimensionsMeasured]);

  const resolvedAspect = useCallback(
    (item: ReferenceItem): number => {
      const learned = learnedAspects.get(item.id);
      if (learned !== undefined) return learned;
      return aspectOf(item);
    },
    [learnedAspects],
  );

  useEffect(() => {
    if (!marquee) return;

    const updateSelection = (event: globalThis.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const currentContentX = event.clientX - containerRect.left + container.scrollLeft;
      const currentContentY = event.clientY - containerRect.top + container.scrollTop;
      const rect = {
        left: Math.min(marquee.startClientX, event.clientX),
        right: Math.max(marquee.startClientX, event.clientX),
        top: Math.min(marquee.startClientY, event.clientY),
        bottom: Math.max(marquee.startClientY, event.clientY),
      };
      const edge = 48;
      if (event.clientY < containerRect.top + edge) container.scrollTop -= Math.max(4, edge - (event.clientY - containerRect.top));
      if (event.clientY > containerRect.bottom - edge) container.scrollTop += Math.max(4, edge - (containerRect.bottom - event.clientY));

      const nextIds = new Set<string>();
      for (const item of items) {
        const node = cardRefs.current.get(item.id);
        if (!node) continue;
        const cardRect = node.getBoundingClientRect();
        const intersects = cardRect.left < rect.right
          && cardRect.right > rect.left
          && cardRect.top < rect.bottom
          && cardRect.bottom > rect.top;
        if (intersects) nextIds.add(item.id);
      }
      setIntersectingIds(nextIds);
      setMarquee((current) => current ? {
        ...current,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        currentContentX,
        currentContentY,
      } : current);
    };

    const finishSelection = () => {
      onMarqueeSelect?.([...intersectingIds], marquee.mode);
      setMarquee(null);
      setIntersectingIds(new Set());
    };

    document.addEventListener("mousemove", updateSelection);
    document.addEventListener("mouseup", finishSelection, { once: true });
    return () => {
      document.removeEventListener("mousemove", updateSelection);
      document.removeEventListener("mouseup", finishSelection);
    };
  }, [intersectingIds, items, marquee, onMarqueeSelect]);

  // 그리드 컨테이너 폭 추적.
  //
  // Justified-rows 는 폭이 바뀌면 행 안의 카드들이 자연 비율 그대로 함께
  // 스케일된다 — 컬럼 수 같은 별도 상태를 유지할 필요가 없고, 진동 방지용
  // hysteresis 도 불필요. ResizeObserver 가 호출될 때마다 단순히 새 폭을
  // 저장하고, 행 배열은 useMemo 가 받아서 새로 계산.
  useEffect(() => {
    if (viewMode !== "grid" || items.length === 0) return;
    const grid = gridRef.current;
    if (!grid) return;
    setContainerWidth(grid.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? grid.clientWidth;
      setContainerWidth(width);
    });
    observer.observe(grid);
    return () => observer.disconnect();
    // items.length === 0 → > 0 전이 시 그리드 div 가 처음 마운트되므로
    // 그 boolean 만 deps 로 두고, items 자체 길이/순서 변경엔 재실행하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, items.length === 0]);

  // 행 배열 — items / 컨테이너 폭 / 슬라이더 (목표 행 높이) / 학습된 자연
  // 비율이 바뀔 때마다 재계산. gridSize (140~260) 를 그대로 픽셀 단위 목표
  // 행 높이로 매핑. resolvedAspect 가 학습된 비율을 우선 반영하므로 첫
  // 페인트 → 이미지 로드 → 정확한 비율 반영의 1회 layout shift 가 발생.
  const justifiedRows = useMemo(
    () => layoutJustifiedRows(items, containerWidth, GRID_GAP, gridSize, resolvedAspect),
    [items, containerWidth, gridSize, resolvedAspect],
  );

  const handleMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || loading || error || items.length === 0 || viewMode !== "grid") return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-library-card='true']")) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startContentX = event.clientX - rect.left + container.scrollLeft;
    const startContentY = event.clientY - rect.top + container.scrollTop;
    event.preventDefault();
    setIntersectingIds(new Set());
    setMarquee({
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      startContentX,
      startContentY,
      currentContentX: startContentX,
      currentContentY: startContentY,
      mode: event.shiftKey || event.ctrlKey || event.metaKey ? "add" : "replace",
    });
  };

  const marqueeStyle = marquee
    ? {
      left: Math.min(marquee.startContentX, marquee.currentContentX),
      top: Math.min(marquee.startContentY, marquee.currentContentY),
      width: Math.abs(marquee.currentContentX - marquee.startContentX),
      height: Math.abs(marquee.currentContentY - marquee.startContentY),
    }
    : undefined;

  /* registerCardRef — LibraryCard 가 자기 button 노드를 marquee 의
   * cardRefs Map 에 등록/해제. node 가 null 이면 unmount 정리. */
  const registerCardRef = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  }, []);

  /* 카드 액션 번들 — useMemo 로 안정적 참조 유지. 부모(LibraryPage)가
   * useCallback 으로 각 핸들러를 안정화해 두므로, 이 객체 자체도 그
   * 핸들러들이 바뀔 때만 재생성된다. */
  const cardActions = useMemo<LibraryCardActions>(
    () => ({
      onSelect,
      onDoubleClick,
      onReorderBefore: onReorderReferences,
      onOpenDefault,
      onOpenSourceUrl,
      onShowInFolder,
      onCopyFilePath,
      onCopySelection,
      onCopyTags,
      onPasteTags,
      onAddToFolder,
      onMoveToFolder,
      onRemoveFromActiveFolder,
      onExportSelected,
      onExportSelectedAsHtml,
      onTogglePin,
      onDuplicate,
      onCreateVariation,
      onRename,
      onSearchByImage,
      onClassify,
      onAcceptSuggestions,
      onRegenerateThumbnail,
      onSetCoverFromFile,
      onSetCoverFromClipboard,
      onMergeDuplicates,
      onMoveToTrash,
      onRestore,
      onPermanentlyDelete,
      onAddToBrief,
      onAddToAgent,
      onAddToConti,
      onPromoteToAsset,
      onHideFromGrid,
      onUnhideFromGrid,
    }),
    [
      onAddToAgent,
      onAddToBrief,
      onAddToConti,
      onAddToFolder,
      onHideFromGrid,
      onUnhideFromGrid,
      onClassify,
      onAcceptSuggestions,
      onCopyFilePath,
      onCopySelection,
      onCopyTags,
      onDoubleClick,
      onReorderReferences,
      onDuplicate,
      onCreateVariation,
      onExportSelected,
      onExportSelectedAsHtml,
      onMergeDuplicates,
      onMoveToFolder,
      onMoveToTrash,
      onOpenDefault,
      onOpenSourceUrl,
      onPasteTags,
      onPermanentlyDelete,
      onPromoteToAsset,
      onRegenerateThumbnail,
      onRemoveFromActiveFolder,
      onRename,
      onRestore,
      onSearchByImage,
      onSelect,
      onSetCoverFromClipboard,
      onSetCoverFromFile,
      onShowInFolder,
      onTogglePin,
    ],
  );

  /* id → 드래그 페이로드(파일 URL · source URL · 썸네일 · 제목) 빠른 조회.
   * native HTML5 dragstart 핸들러 안에서 다중 선택 전체의 자료를 OS 로
   * 인계할 때 쓴다.
   *
   * ⚠ kind 별로 "끌고 나갈 본체" 가 다르다:
   *   - image/webp/gif/video : 실제 파일이 본체 → fileUrl 만 운반.
   *   - link/youtube        : URL 이 본체. file_url 은 Behance·YouTube 의
   *                            *썸네일* 일 뿐이라 그걸 외부로 끌면 사용자가
   *                            기대한 링크가 아닌 썸네일이 복사된다(버그).
   *                            따라서 sourceUrl 만 운반 → 메인이 임시 `.url`
   *                            인터넷 바로가기 파일로 변환.
   */
  const dragSourceById = useMemo(() => {
    const m = new Map<
      string,
      {
        fileUrl: string | null;
        sourceUrl: string | null;
        thumbnailUrl: string | null;
        title: string;
        /** kind/mime_type 기반 추정 — DownloadURL setData 의 `mime:filename:url`
         *  중 mime 부분으로 사용. null 이면 OLE-only 경로로 fallback. */
        mimeType: string | null;
        /** Chromium DownloadURL 채널이 외부 destination 에 떨어뜨릴 때 파일
         *  이름. 확장자가 mime 과 일치하도록 본 title 에서 sanitize. */
        downloadFilename: string | null;
      }
    >();
    for (const it of items) {
      const isLinkKind = it.kind === "link" || it.kind === "youtube";
      const fileUrl = isLinkKind ? null : (it.file_url ?? null);
      const mime = (it.mime_type ?? "").toLowerCase() || guessMimeFromUrl(fileUrl);
      const ext = extensionForMime(mime, fileUrl);
      const baseName = sanitizeDownloadFilename(it.title ?? "untitled");
      const filename = ext
        ? (baseName.toLowerCase().endsWith(ext.toLowerCase()) ? baseName : baseName + ext)
        : baseName;
      m.set(it.id, {
        fileUrl,
        sourceUrl: isLinkKind ? (it.source_url ?? null) : null,
        thumbnailUrl: it.thumbnail_url ?? null,
        title: it.title ?? "link",
        mimeType: !isLinkKind && mime ? mime : null,
        downloadFilename: !isLinkKind && fileUrl ? filename : null,
      });
    }
    return m;
  }, [items]);

  /** 카드 한 장을 그린다. <LibraryCard /> 자체가 native HTML5 DnD 를
   *  잡는 React 컴포넌트라 여기선 단지 props 만 조립해 넘기면 된다. */
  const renderItemCard = (
    item: ReferenceItem,
    layout: { mode: "grid" | "list"; thumbWidth: number; thumbHeight: number },
  ) => {
    const isSelected = selectedIds.has(item.id) || selectedId === item.id;
    const isHighlighted = isSelected || intersectingIds.has(item.id);
    const selectedCount = selectedIds.has(item.id) ? selectedIds.size : 1;
    // dragIds — 카드가 선택돼 있으면 selection 전체를 함께 옮기고, 아니면
    // 자기 한 장만. (드래그 시작 시점에 카드를 자동 선택하지는 않는다 —
    // 사용자가 의도하지 않은 selection 변경을 막기 위함.)
    const dragIds = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
    return (
      <LibraryCard
        key={item.id}
        item={item}
        layout={layout}
        isHighlighted={isHighlighted}
        selectedCount={selectedCount}
        dragIds={dragIds}
        dragSourceById={dragSourceById}
        duplicateCounts={duplicateCounts}
        usageCounts={usageCounts}
        folderRows={folderRows}
        activeFolderTag={activeFolderTag}
        hasCopiedTags={hasCopiedTags}
        canAddToProject={canAddToProject}
        registerCardRef={registerCardRef}
        reportAspect={reportAspect}
        actions={cardActions}
        showName={showName}
        showTypeLabel={showTypeLabel}
        showAnnotation={showAnnotation}
        showBadges={showBadges}
        generating={Boolean(generatingIds?.has(item.id))}
        gridHidden={gridHiddenIds.has(item.id)}
      />
    );
  };

  /* 자료 추가가 의미 없는 quick filter (Untagged · Recently Used ·
     Unclassified · Duplicate Candidates · Trash) 에서는 그리드 영역의
     드래그 오버레이 / 드롭 / empty-state CTA 를 모두 비활성화한다. 사용자가
     "Untagged 에서 새로 업로드"같이 모순된 동작을 시도해 자료가 엉뚱한 곳에
     떨어지는 것을 막기 위함. 사이드바 Add 메뉴는 별도이므로 영향 없음.

     ⚠ 가드: 라이브러리 카드 자체의 native DnD 가 시작되면 그리드 자체도
     자기 자신의 dragenter/dragover 를 받는다(이벤트 버블링). 그때 외부
     파일 드롭과 동일한 시각/처리를 깨우면 "내 카드를 빈 그리드 영역에
     떨어뜨려도 파일 업로드 다이얼로그가 떠 보이는" 오인 사고가 난다.
     dataTransfer.types 에 INTERNAL_DRAG_MIME 가 있거나 사이드 채널에
     active drag 가 있으면 그리드 영역 dropzone 을 비활성. */
  const isInternalDrag = (event: DragEvent<HTMLElement>): boolean => {
    const types = event.dataTransfer?.types;
    if (types) {
      for (let i = 0; i < types.length; i += 1) {
        if (types[i] === INTERNAL_DRAG_MIME) return true;
      }
    }
    return getActiveLibraryDrag() !== null;
  };
  const dragHandlers = viewSupportsUpload
    ? {
        onDragEnter: (event: DragEvent<HTMLElement>) => {
          if (isInternalDrag(event)) return;
          event.preventDefault();
          onDragStateChange(true);
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (isInternalDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          onDragStateChange(true);
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (isInternalDrag(event)) return;
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onDragStateChange(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          if (isInternalDrag(event)) return;
          onDrop(event);
        },
      }
    : {};
  /* empty-state 의 안내 문구를 quick filter 별로 자연스럽게 — Trash 는
     "All clean.", Recently Used 는 "최근 사용 항목 없음" 같은 식. 이 외
     컨텍스트에서는 기존 일반 메시지 그대로. */
  const emptyStateCopy = !viewSupportsUpload
    ? (() => {
        switch (quickFilter) {
          case "untagged":
            return { title: t("library.grid.emptyUntaggedTitle"), body: t("library.grid.emptyUntaggedBody") };
          case "recentlyUsed":
            return { title: t("library.grid.emptyRecentTitle"), body: t("library.grid.emptyRecentBody") };
          case "unclassified":
            return { title: t("library.grid.emptyUnclassifiedTitle"), body: t("library.grid.emptyUnclassifiedBody") };
          case "duplicates":
            return { title: t("library.grid.emptyDuplicatesTitle"), body: t("library.grid.emptyDuplicatesBody") };
          case "trash":
            return { title: t("library.grid.emptyTrashTitle"), body: t("library.grid.emptyTrashBody") };
          default:
            return { title: t("library.grid.emptyDefaultTitle"), body: null as string | null };
        }
      })()
    : null;

  return (
    /* Drop-zone 오버레이는 *스크롤되지 않는* 부모(div) 에 absolute 로 얹어야
       스크롤 위치와 무관하게 항상 프리뷰 영역 전체를 덮는다. 이전엔
       overflow-y-auto section 안에 absolute inset-5 로 두어, 스크롤이
       내려간 상태에서 드롭하면 오버레이가 컨텐츠 좌표계(스크롤 위쪽)에
       머물러 화면에는 보이지 않거나 일부만 보이는 문제가 있었다.
       wrapper 가 relative + 같은 크기를 차지하고, 실제 스크롤은 안쪽
       section 이 담당하도록 분리. dragHandlers 는 section 에 그대로 두고,
       overlay 는 pointer-events-none 이라 이벤트가 그대로 통과한다.

       Eagle 식 "썸네일 영역 보기" 옵션은 빈 영역 우클릭 시 노출되는
       ContextMenu 로 동작한다. 카드 위 우클릭은 카드 자체의 내부 ContextMenu
       (LibraryCard 안) 가 stopPropagation 으로 가로채므로, 이 외곽 메뉴는
       항상 *카드가 없는 영역* 에서만 열린다 — Radix ContextMenuTrigger 가
       nested 트리거의 contextmenu 이벤트를 자동으로 격리. */
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <div className="relative h-full min-h-0">
    <section
      ref={containerRef}
      className={cn(
        "relative h-full min-h-0 overflow-y-auto px-5 py-5 transition-colors select-none",
        viewSupportsUpload && isDragging && "bg-primary/[0.04]",
      )}
      onMouseDown={handleMouseDown}
      {...dragHandlers}
    >
      {marquee ? (
        /* 드래그 선택 박스 — 레퍼런스 갤러리(예: Eagle) 처럼 얇은 점선 +
           거의 안 보이는 채움. 굵은 솔리드 외곽은 마우스 이동 시
           시각적으로 무거워 보여서, 1px dashed 로 두고 채움도 5% 로
           낮춰 그 아래 썸네일이 그대로 보이도록 했다. */
        <div
          className="pointer-events-none absolute z-30 rounded-none border border-dashed border-primary bg-primary/5"
          style={marqueeStyle}
        />
      ) : null}

      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-mono text-caption">{t("library.grid.loading")}</span>
        </div>
      ) : error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-[360px] flex-col items-center justify-center rounded-none border border-dashed border-border-subtle text-center">
          <Library className="mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-base font-semibold">{emptyStateCopy?.title ?? t("library.grid.emptyNoReferences")}</h2>
          <p className="mt-2 max-w-[360px] text-xs leading-relaxed text-muted-foreground">
            {emptyStateCopy?.body ?? t("library.grid.emptyDropHint")}
          </p>
          {viewSupportsUpload ? (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button onClick={onChooseFiles} className="h-9 gap-2 text-xs">
                <Upload className="h-4 w-4" />
                {t("library.grid.files")}
              </Button>
              <Button variant="outline" onClick={onChooseFolder} className="h-9 gap-2 text-xs">
                <FolderOpen className="h-4 w-4" />
                {t("library.grid.folder")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        viewMode === "grid" ? (
          // Justified-rows: 행마다 flex 컨테이너 + 각 카드는 exact width × height.
          // 첫 페인트(containerWidth=0) 에서는 justifiedRows 가 빈 배열이라
          // 잠깐 비어 보이지만, 같은 사이클의 ResizeObserver 측정 후 즉시 교체.
          <div ref={gridRef} className="space-y-3">
            {justifiedRows.map((row, rowIdx) => (
              <div
                key={`row-${rowIdx}`}
                className="flex"
                style={{ gap: GRID_GAP }}
              >
                {row.items.map((item) => renderItemCard(item, {
                  mode: "grid",
                  thumbWidth: resolvedAspect(item) * row.height,
                  thumbHeight: row.height,
                }))}
              </div>
            ))}
          </div>
        ) : (
          /* 리스트(표) 뷰 — Eagle 스타일의 sticky 헤더 + 균일 grid 행.
           *
           * 헤더는 스크롤 컨테이너(section, py-5) 의 시각적 상단에 정확히
           * 붙도록 `top: -20` 으로 section 의 padding-top 을 상쇄하고,
           * `-mx-5` 로 좌우 padding 도 가로질러 카드 그리드와 폭을 통일한다.
           * 카드와 헤더 모두 `listGridColumns(listThumb.thumbWidth)` 로 같은
           * grid template 을 공유 — 슬라이더로 thumb 폭이 바뀌어도 두 곳의
           * 컬럼 폭이 동시에 갱신돼 정렬이 무너지지 않는다. */
          (() => {
            const listThumb = listThumbSize(gridSize);
            const listCols = listGridColumns(listThumb.thumbWidth);
            /* 각 컬럼이 매핑되는 sortKey + "처음 클릭했을 때 적용될 방향".
             *
             * Eagle/Finder 류의 표 정렬 컨벤션: 텍스트 컬럼(Name, Extension)
             * 은 첫 클릭 시 asc(A→Z), 수치/날짜 컬럼(Dimensions, File Size,
             * Date Added) 은 desc(큰→작은, 최신→오래된) 가 자연스럽다.
             * 이미 active 상태인 컬럼을 다시 누르면 방향만 토글. */
            type ListColumn = {
              label: string;
              key: LibrarySortKey;
              defaultOrder: LibrarySortOrder;
              align: "left" | "right";
            };
            const columns: ListColumn[] = [
              { label: t("library.grid.col.name"), key: "name", defaultOrder: "asc", align: "left" },
              { label: t("library.grid.col.dimensions"), key: "dimensions", defaultOrder: "desc", align: "right" },
              { label: t("library.grid.col.extension"), key: "extension", defaultOrder: "asc", align: "right" },
              { label: t("library.grid.col.fileSize"), key: "size", defaultOrder: "desc", align: "right" },
              { label: t("library.grid.col.dateAdded"), key: "recent", defaultOrder: "desc", align: "right" },
            ];
            const onHeaderClick = (col: ListColumn) => {
              if (sortKey === col.key) {
                onSortOrderChange(sortOrder === "asc" ? "desc" : "asc");
              } else {
                onSortKeyChange(col.key);
                onSortOrderChange(col.defaultOrder);
              }
            };
            return (
              <div ref={gridRef} className="flex flex-col">
                <div
                  className="sticky z-10 -mx-5 mb-1 -mt-5 border-b border-border-subtle bg-background/95 px-7 backdrop-blur-sm"
                  style={{ top: -20 }}
                >
                  <div
                    className="grid items-center py-2 text-caption font-medium text-muted-foreground"
                    style={{ gridTemplateColumns: listCols, columnGap: LIST_COLUMN_GAP }}
                  >
                    <span />
                    {columns.map((col) => {
                      const isActive = sortKey === col.key;
                      const ArrowIcon = sortOrder === "asc" ? ArrowUp : ArrowDown;
                      return (
                        <button
                          key={col.key}
                          type="button"
                          onClick={() => onHeaderClick(col)}
                          title={
                            isActive
                              ? t("library.grid.col.sortedAria", {
                                  label: col.label,
                                  order: sortOrder === "asc"
                                    ? t("library.grid.col.ascending")
                                    : t("library.grid.col.descending"),
                                })
                              : t("library.grid.col.sortByAria", { label: col.label })
                          }
                          /* Title Case 그대로 — 이전엔 `uppercase tracking-wider`
                             로 모두 대문자로 강제 표기했지만, 가독성 + 본문
                             텍스트(기본 문장형) 와의 톤 일치를 위해 원문 그대로
                             둔다. 폰트 크기는 10→11 로 살짝 올려 대문자 시각
                             부피가 사라진 만큼을 보상. */
                          className={cn(
                            "group/sort flex items-center gap-1 truncate text-caption font-medium transition-colors",
                            col.align === "right" && "justify-end",
                            isActive
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{col.label}</span>
                          {/* active 컬럼에는 현재 방향, 비활성 컬럼에는 hover
                              시 살짝 보이는 ↕ 힌트(연한 ↓)로 클릭 가능함을
                              시각화. opacity 전환만으로 layout shift 가 없다. */}
                          <ArrowIcon
                            className={cn(
                              "h-3 w-3 flex-shrink-0 transition-opacity",
                              isActive
                                ? "opacity-100 text-primary"
                                : "opacity-0 group-hover/sort:opacity-40",
                            )}
                            strokeWidth={2.5}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
                {items.map((item) => renderItemCard(item, { mode: "list", ...listThumb }))}
              </div>
            );
          })()
        )
      )}
    </section>
    {viewSupportsUpload && isDragging ? (
      /* Option B — 두 겹 레이어로 디졸브:
           1) 전체를 덮는 dim/blur 레이어 → 아래 레퍼런스 썸네일을 죽인다
           2) 가운데 점선 박스 → 명확한 드롭 타깃 시각화
         두 레이어 모두 animate-in fade-in 으로 부드럽게 등장하고, pointer-events-none
         이라 드래그/드롭 이벤트는 그대로 section 으로 통과한다. */
      <>
        <div
          className="pointer-events-none absolute inset-0 z-10 bg-background/70 backdrop-blur-md animate-in fade-in duration-150"
        />
        <div
          className="pointer-events-none absolute inset-5 z-20 flex items-center justify-center rounded-none border-2 border-dashed border-primary/80 bg-primary/[0.04] animate-in fade-in duration-150"
        >
          <div className="text-center">
            <Upload className="mx-auto mb-3 h-9 w-9 text-primary" />
            <div className="text-base font-semibold">{t("library.grid.dropToSave")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t("library.grid.dropToSaveHint")}</div>
          </div>
        </div>
      </>
    ) : null}
    </div>
    </ContextMenuTrigger>
    {/* 그리드 빈 영역 우클릭 메뉴 — Eagle 식 "썸네일 영역 보기" 패널.
        세 가지 토글이 각각 카드의 시각 요소(파일명/종류 배지/노트 배지) 를
        끄고 켠다. onSelect 의 event.preventDefault 로 체크 후에도 메뉴를
        닫지 않고 그대로 두어, 사용자가 여러 옵션을 연달아 바꿀 수 있게
        한다 — Eagle 의 동일 패널과 같은 UX. */}
    <ContextMenuContent className="min-w-56 rounded-none">
      <ContextMenuLabel className="text-caption">{t("library.grid.thumbnailDisplay")}</ContextMenuLabel>
      <ContextMenuSeparator />
      <MenuCheckboxItem checked={showName} icon={Type} onToggle={() => saveLibraryShowName(!showName)}>
        {t("library.grid.showName")}
      </MenuCheckboxItem>
      {/* 마스터 스위치 — 아래의 두 granular 토글(Show extension label /
          Show annotation) 과 카드 위 모든 시각 배지(즐겨찾기/핀/중복/사용/
          휴지통/길이) 를 한 번에 끄고 켠다. 끄면 granular 토글은 시각적
          으로 영향이 없어 보이지만(이미 다 숨겨져 있어서), 상태는 유지되어
          마스터를 다시 켰을 때 이전 granular 설정이 그대로 복원된다. */}
      <MenuCheckboxItem checked={showBadges} icon={Network} onToggle={() => saveLibraryShowBadges(!showBadges)}>
        {t("library.grid.showBadges")}
      </MenuCheckboxItem>
      <ContextMenuSeparator />
      <MenuCheckboxItem
        checked={showTypeLabel}
        disabled={!showBadges}
        icon={Square}
        onToggle={() => saveLibraryShowTypeLabel(!showTypeLabel)}
      >
        {t("library.grid.showExtension")}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={showAnnotation}
        disabled={!showBadges}
        icon={MessageSquare}
        onToggle={() => saveLibraryShowAnnotation(!showAnnotation)}
      >
        {t("library.grid.showAnnotation")}
      </MenuCheckboxItem>
      <ContextMenuSeparator />
      {/* GIF / animated WebP / APNG 자동 재생 토글 — Settings 페이지의
          동명 옵션과 동일한 storage 키를 공유한다. 켜면 호버 없이도 그리드
          전체의 애니메이션 썸네일이 항상 루프 재생되고, 끄면 정적 포스터를
          기본으로 두고 호버 시에만 재생한다. 다른 토글들과 마찬가지로
          preventDefault 로 메뉴를 닫지 않아 연달아 비교/체크가 가능. */}
      <MenuCheckboxItem
        checked={animatedThumbnailsAutoplay}
        icon={Film}
        onToggle={() => saveAnimatedThumbnailsAutoplay(!animatedThumbnailsAutoplay)}
      >
        {t("library.grid.autoplayAnimated")}
      </MenuCheckboxItem>
    </ContextMenuContent>
    </ContextMenu>
  );
}
