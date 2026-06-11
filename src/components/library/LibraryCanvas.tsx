/**
 * Library Canvas — PureRef 스타일 무한 평면 뷰.
 *
 * 핵심 원칙(플랜 §1):
 *   - 폴더 콘텐츠는 grid/list/canvas 어느 뷰에서든 동일하다.
 *   - 캔버스는 단지 "ref 가 평면 위 어디에 놓이는가" 의 위치 메타데이터를
 *     시각화한다. ref 의 추가/삭제는 폴더 차원이고 캔버스가 건드리지 않는다.
 *   - 신규 ref(reconciliation 결과 layout 에 없음) 는 자동 배치된다.
 *   - 사라진 ref(layout 에 있지만 items 에 없음) 는 자동으로 layout 에서 정리된다.
 *
 * 단축키 정책(플랜 §4.7):
 *   - Delete/Enter/Ctrl+D/Ctrl+C/F2/화살표는 *전역* LibraryPage 핸들러에
 *     위임한다 (caller 가 처리). 캔버스 viewport 안에서 가로채지 않는다.
 *   - 캔버스 전용 단축키만 viewport keydown 에서 처리:
 *       Space=focus selection toggle, Ctrl+Space=fit all,
 *       Ctrl+0=100%, Ctrl+Z/Ctrl+Shift+Z=undo/redo,
 *       [/]=z-order, Alt+Shift+H/V=flip, Ctrl+L=lock, N=new note.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  AlignCenter,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Bold,
  BringToFront,
  Clipboard,
  Contrast,
  Crop,
  Eye,
  EyeOff,
  FileText,
  Film,
  FlipHorizontal,
  FlipVertical,
  Focus,
  Grid3x3,
  Group,
  ImageDown,
  Italic,
  Keyboard,
  LayoutGrid,
  Link as LinkIcon,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Map as MapIcon,
  Maximize2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MoveRight,
  Network,
  Palette,
  Pin,
  Redo2,
  RotateCw,
  Search,
  SendToBack,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Trash2,
  Ungroup,
  Underline,
  Undo2,
  Unlock,
  X,
  Youtube,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorPicker } from "./ColorPicker";
import { MenuCheckboxItem } from "./MenuCheckboxItem";
import { Input } from "@/components/ui/input";
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

/** 노트 첨부 URL 을 OS 기본 브라우저로 열기. referenceLibrary 의
 *  `openReferenceSourceUrl` 과 동일한 엔드포인트(`/shell/open-external`) 를
 *  쓰지만 임의 URL 을 받을 수 있도록 슬림화. http(s) 외 스킴은 메인 프로세스
 *  레벨에서 거부되므로 호출자가 추가 검사 없이 위임. */
async function openExternalUrl(url: string): Promise<void> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}/shell/open-external`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}
import {
  CANVAS_LAYOUT_CHANGED_EVENT,
  type CanvasCamera,
  type CanvasConnection,
  type CanvasGenNode,
  type CanvasItemCrop,
  type CanvasItemTransform,
  type CanvasLayout,
  type CanvasNote,
  type ConnectionAnchor,
  type ConnectionLabelStyle,
  type ConnectionLinkType,
  type ConnectionNodeKind,
  type ConnectionStyle,
  EMPTY_LAYOUT,
  clearCanvasLayout,
  getCanvasLayout,
  isBlankCanvasNote,
  setCanvasLayout,
} from "@/lib/canvasLayout";
import {
  ALL_SLOTS,
  HANDLES,
  SLOT_UV,
  anchorOutwardNormal,
  cameraToFit,
  cameraToTransform,
  canvasToScreen,
  computeGridSnap,
  computeSnap,
  findPlacementSpot,
  itemAABB,
  localToCanvas,
  nearestSlot,
  placementSize,
  pointInItem,
  rotateByHandle,
  resizeByHandle,
  screenToCanvas,
  slotOfAnchor,
  slotPoints,
  unionBBox,
  visibleItemAABB,
  type AnchorSlot,
  zoomAt,
  type HandleId,
  type Point,
  type Rect,
  type SnapGuide,
} from "@/lib/canvasGeometry";
import {
  type CanvasGenerationInput,
  detectReferenceKind,
  generateCanvasImage,
  isDocKind,
  isMediaKind,
  withReferenceVersion,
  type GenerationProvenance,
  type ReferenceItem,
} from "@/lib/referenceLibrary";
import {
  getFeatureSpec,
  getGptQualityDefault,
  getImageModelDefault,
  type GptQuality,
  IMAGE_GEN_MODEL_LABELS,
  modelIsGpt,
} from "@/lib/imageGenPreference";
import { saveAnimatedThumbnailsAutoplay, useAnimatedThumbnailsAutoplay } from "@/lib/animationPreferences";
import {
  saveLibraryShowAnnotation,
  saveLibraryShowBadges,
  saveLibraryShowTypeLabel,
  useLibraryShowAnnotation,
  useLibraryShowBadges,
  useLibraryShowTypeLabel,
} from "@/lib/libraryGridDisplayPreferences";
import { resolveTypeLabel } from "@/lib/linkPlatform";
import { INTERNAL_DRAG_MIME } from "@/lib/libraryDragChannel";
import { useT } from "@/lib/uiLanguage";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatShortcut, formatTitleShortcuts } from "@/lib/shortcutLabel";

/* ──────────────────────────────────────────────────────────────
 * Props
 * ────────────────────────────────────────────────────────────── */

export interface LibraryCanvasProps {
  /** LibraryPage 의 filteredItems — doc 은 내부에서 자동 제외. */
  items: ReferenceItem[];
  /** Library 전역 *가장 최근 undoBar* 액션을 *consume + run* 시도하는 함수.
   *  반환값 true 면 canvas 자신의 layout undo 대신 페이지 단위 undo (예:
   *  방금 trash 한 ref 의 restore) 가 발동됐다는 뜻이라, viewport 핸들러는
   *  자신의 dispatch({type:"undo"}) 를 건너뛰고 return 한다. false 면 페이지
   *  슬롯이 비었거나 만료된 상태이므로 평소대로 canvas layout undo 로 폴백.
   *
   *  prop 으로 받는 이유: 둘 다 window/viewport keydown 으로 같은 키를 받지만,
   *  토스트 슬롯의 *진짜 소유자* 는 LibraryPage 다 — canvas 는 *읽기만* 한다.
   *  미지정 시 polyfill 로 항상 false 를 반환해 기존 layout undo 만 동작. */
  tryRunLatestUndo?: () => boolean;
  /** 필터 무관 *라이브러리 전체에 존재하는* 항목 id 집합 (trash 포함, 즉
   *  영구 삭제된 row 만 빠진다). reconciliation 이 layout entry 를 청소하는
   *  *유일한* 기준이며, trash 상태(=soft-delete, `deleted_at` 만 설정)는
   *  여기에 *남아 있다* — 그래야 사용자가 toast 의 되돌리기 / 글로벌 Ctrl+Z
   *  로 restore 했을 때 layout entry 가 사라진 적이 없으므로 *원래 자리*
   *  그대로 복귀한다.
   *
   *  ⚠️ 의미 변경 이력 (이전 이름: `allLiveItemIds`):
   *  과거엔 deleted_at 도 제외하는 정의여서 trash 직후 reconciliation 이
   *  layout entry 를 즉시 지웠고, restore 시 *새 위치* 로 자동 배치되는
   *  회귀가 있었다.
   *
   *  미지정 시 `items` 자체 id 집합으로 fallback (기존 동작 호환). */
  allKnownItemIds?: ReadonlySet<string>;
  /** 폴더 컨텍스트 키 (예: `tag:folder:Reference/Motion`). LibraryPage 에서
   *  `folderContextKey(folderPath)` 또는 `deriveLibraryContextKey` 로 만들어 전달. */
  folderContextKey: string;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, event?: ReactMouseEvent<HTMLElement>) => void;
  onMarqueeSelect: (ids: string[], mode: "replace" | "add") => void;
  /** ref id 를 받음 — grid/list 의 onDoubleClick 과 동일 시그니처(인스펙터/
   *  프리뷰가 selectedId 로 찾음). */
  onDoubleClick?: (id: string) => void;
  /** OS 에서 캔버스에 미디어 파일을 떨어뜨렸을 때 호출. 캔버스가 doc /
   *  blocked 를 사전 차단하므로 *통과 파일* 만 넘긴다. 호출자(LibraryPage)
   *  는 grid 와 동일한 `handleFiles` 파이프로 처리하면 됨. 신규 ref 는
   *  reconciliation 이 자동 배치하되, 캔버스 내부의 `pendingDropAnchorRef`
   *  가 5s TTL 로 드롭 좌표를 anchor 로 잡는다. */
  onCanvasFileDrop?: (files: File[]) => void;
  /** 파일 없이 URL 텍스트만 드롭한 경우 (예: 브라우저에서 이미지 URL).
   *  `createLinkReference` 로 link/youtube ref 생성을 위임. */
  onCanvasUrlDrop?: (url: string) => void;
  /** 몰입 모드(`)에서 우상단 floating 'Exit immersive' 버튼을 노출시키기
   *  위한 콜백. 부모(LibraryPage)가 immersive 상태를 보유. undefined 면 버튼
   *  안 그림 (= 캔버스만 단독 사용 케이스). */
  immersive?: boolean;
  onToggleImmersive?: () => void;
  /** 프로젝트 연동 액션 — 그리드 우클릭 메뉴와 동일한 핸들러를 캔버스 카드
   *  컨텍스트 메뉴에서도 재사용한다. 모두 단일 item 시그니처지만 LibraryPage
   *  쪽에서 현재 선택(selectionSnapshot)을 반영해 다중 처리한다. 미지정이면
   *  해당 메뉴 항목은 no-op (캔버스 단독 사용 케이스). */
  onAddToBrief?: (item: ReferenceItem) => void;
  onAddToAgent?: (item: ReferenceItem) => void;
  onAddToConti?: (item: ReferenceItem) => void;
  onPromoteToAsset?: (item: ReferenceItem) => void;
  onMoveToTrash?: (item: ReferenceItem) => void;
  /** AI 베리에이션 — 그리드 우클릭과 동일. 정지 이미지에서만 활성. */
  onCreateVariation?: (item: ReferenceItem) => void;
  /** 변형 플라이아웃이 열린 상태에서 캔버스 이미지를 참조 드롭존 위로 끌어다
   *  놓았을 때 — 그 항목들을 변형 참조로 주입(이동 대신). */
  onInjectToVariation?: (ids: string[]) => void;
  /** 변형 플라이아웃이 *실제로 열려 있는지*. true 일 때만 캔버스 이미지 이동을
   *  멈추고 "참조로 가져오기" 제스처로 전환한다(닫혀 있으면 자유 이동). */
  variationFlyoutOpen?: boolean;
  /** 현재 AI 베리에이션 생성 중인 원본 id 들 — 그 카드에 로딩 오버레이. */
  generatingIds?: ReadonlySet<string>;
  /** 캔버스 생성 노드가 새 이미지를 만들었을 때 — 부모(LibraryPage)의
   *  upsertUploadedItem 으로 위임해 리스트/선택에 즉시 반영한다. 캔버스 배치는
   *  노드 옆에 내부에서 직접 dispatch 하므로 부모는 리스트 반영만 담당. */
  onItemCreated?: (item: ReferenceItem) => void;
}

/* ──────────────────────────────────────────────────────────────
 * Reducer — 캔버스 상태(레이아웃 + 카메라 + 노트) + undo/redo
 *
 * pointerdown 시 push 한 스냅샷이 undo 단위. 드래그 중간 변경은 transient
 * 라 undo 에 안 들어가고, pointerup 시 한 번 commit 으로 끝낸다.
 * ────────────────────────────────────────────────────────────── */

interface CanvasState {
  layout: CanvasLayout;
  /** undo 스택 — 가장 최근 commit 된 layout 들. 50 개 cap. */
  past: CanvasLayout[];
  /** redo 스택 — undo 로 빠진 layout 들. */
  future: CanvasLayout[];
  /** 영구화 트리거 — `transient` 액션은 *증가시키지 않는다*. 그래야 드래그
   *  중간 프레임마다 localStorage 에 쓰지 않으면서도, pointerup 시점의 commit
   *  은 정확히 한 번 저장된다. save effect 의 deps 에 이 카운터를 두고
   *  state.layout 자체는 ref 로 감추면 transient 발동을 피할 수 있다. */
  version: number;
}

type CanvasAction =
  | { type: "load"; layout: CanvasLayout }
  | { type: "set"; layout: CanvasLayout; commit?: boolean }
  | { type: "transient"; layout: CanvasLayout }
  | { type: "commit" }
  | { type: "undo" }
  | { type: "redo" };

const UNDO_CAP = 50;

/** gen 결과 아이템의 provenance(GenerationProvenance) 를 꺼낸다 — 없으면 null.
 *  `ai_suggestions.generation` 은 자유 JSON 이라 ReferenceAiSuggestions 타입에
 *  없으므로 record 접근으로 판정. gen 결과 점선 억제 / 노드 우측 배치에 쓴다. */
function genProvenanceOf(it: { ai_suggestions?: Record<string, unknown> | null }): GenerationProvenance | null {
  const g = it.ai_suggestions?.generation;
  return g && typeof g === "object" ? (g as GenerationProvenance) : null;
}

/** 고정 포트 앵커 — gen 노드/프롬프트 카드는 입·출력 방향이 정해져 있으므로
 *  자동 nearestSlot 대신 변 중앙으로 못박는다(레퍼런스 노드 UI 패리티).
 *  null 이면 override 없음(기존 자동 앵커 유지).
 *    - gen + linkType "output": 우측 중앙(MR) — 결과로 나가는 출력 포트
 *    - gen + 그 외(입력): 좌측 중앙(ML) — 입력 포트
 *    - prompt note: 우측 중앙(MR) — 프롬프트는 출력 성격
 *  anchorLocked(사용자 명시 고정)가 우선이므로 그 분기 이후에만 적용한다. */
function fixedPortAnchor(
  kind: ConnectionNodeKind,
  linkType: ConnectionLinkType | undefined,
  isPromptNote: boolean,
): ConnectionAnchor | null {
  if (kind === "gen") return linkType === "output" ? SLOT_UV.MR : SLOT_UV.ML;
  if (kind === "note" && isPromptNote) return SLOT_UV.MR;
  return null;
}

function cloneLayout(l: CanvasLayout): CanvasLayout {
  return {
    items: { ...l.items },
    notes: l.notes.map((n) => ({ ...n })),
    view: l.view ? { ...l.view } : undefined,
    nextZ: l.nextZ,
    // connection 은 undo/redo 시에도 유지돼야 한다. 누락 시 dispatch("set") 후
    // undo 하면 link 가 통째로 사라지는 회귀가 났던 자리.
    connections: l.connections ? l.connections.map((c) => ({ ...c })) : [],
    // gen 노드 / 숨긴 파생 엣지도 undo 스냅샷에 포함돼야 한다. 누락 시
    // undo/redo·드래그취소(reducer.undo) 때 gen 노드가 통째로 사라지는
    // 데이터 유실 회귀가 났던 자리. params 는 한 단계 더 딥카피.
    genNodes: l.genNodes
      ? l.genNodes.map((g) => ({ ...g, params: g.params ? { ...g.params } : undefined }))
      : [],
    hiddenDerivedEdges: l.hiddenDerivedEdges ? [...l.hiddenDerivedEdges] : [],
    showGrid: l.showGrid,
    gridSize: l.gridSize,
  };
}

function reducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case "load":
      // 폴더 전환/외부 변경. version 증가시켜 save effect 가 idempotent 하게 호출되도록.
      return { layout: action.layout, past: [], future: [], version: state.version + 1 };
    case "set": {
      const past = action.commit !== false
        ? [...state.past, cloneLayout(state.layout)].slice(-UNDO_CAP)
        : state.past;
      // commit=false (reconciliation 자동 배치 등) 도 결과는 저장돼야 다음 진입 시
      // 자동 배치가 반복되지 않음 → version 항상 증가.
      return {
        layout: action.layout,
        past,
        future: action.commit !== false ? [] : state.future,
        version: state.version + 1,
      };
    }
    case "transient":
      // 드래그 중간 프레임 — 영구화 트리거 회피. version 그대로.
      return { ...state, layout: action.layout };
    case "commit":
      return {
        ...state,
        past: [...state.past, cloneLayout(state.layout)].slice(-UNDO_CAP),
        future: [],
        version: state.version + 1,
      };
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        // 카메라(view) 만은 *현재 값을 그대로 유지* — undo 가 사용자의 시야를
        // 함께 점프시키지 않도록. items/notes/connections/grid 만 되돌아간다.
        // 동일 reference 를 다시 박아서 [folderContextKey, state.layout.view]
        // 의존성을 가진 카메라 sync effect 가 *발화하지 않음* 도 함께 보장.
        layout: { ...prev, view: state.layout.view },
        past: state.past.slice(0, -1),
        future: [cloneLayout(state.layout), ...state.future].slice(0, UNDO_CAP),
        version: state.version + 1,
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        // undo 와 동일 — redo 도 카메라는 현재 자리에 그대로 둔다.
        layout: { ...next, view: state.layout.view },
        past: [...state.past, cloneLayout(state.layout)].slice(-UNDO_CAP),
        future: rest,
        version: state.version + 1,
      };
    }
    default:
      return state;
  }
}

const DEFAULT_CAMERA: CanvasCamera = { tx: 0, ty: 0, scale: 1 };

/* ──────────────────────────────────────────────────────────────
 * v2 신규 — PNG 내보내기 / 색 클러스터에 쓰이는 순수 헬퍼들. 모듈
 * 스코프라 React 컴포넌트 리렌더와 분리.
 * ────────────────────────────────────────────────────────────── */

/** 노트 배경 키 → hex 색 (PNG 내보내기 시 ctx.fillStyle 직접 지정용).
 *  NOTE_BG_CLASSES 의 Tailwind 클래스를 reverse 한 근사값. */
const NOTE_BG_HEX: Record<string, string> = {
  yellow: "#fef9c3",
  blue: "#dbeafe",
  green: "#dcfce7",
  pink: "#fce7f3",
  purple: "#f3e8ff",
  gray: "#f4f4f5",
  white: "#ffffff",
};

/** 둥근 사각형 path — 캔버스 2D context 에 직접 등록. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** rect 영역의 픽셀을 grayscale / invert 처리. tainted canvas 면 throw —
 *  caller 가 catch 로 흡수. 둘 다 false 면 no-op. */
function applyPixelEffectsToRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  grayscale: boolean,
  invert: boolean,
): void {
  if (!grayscale && !invert) return;
  const iw = Math.max(1, Math.round(w));
  const ih = Math.max(1, Math.round(h));
  const data = ctx.getImageData(x, y, iw, ih);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i];
    let g = px[i + 1];
    let b = px[i + 2];
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    if (grayscale) {
      const k = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      r = k; g = k; b = k;
    }
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  ctx.putImageData(data, x, y);
}

/* ──────────────────────────────────────────────────────────────
 * Hit-test 결과 — 모듈 스코프로 둬서 sub-component (NoteLinkAnchor) 가
 * prop 타입에서 참조할 수 있게.
 * ────────────────────────────────────────────────────────────── */

type HitResult =
  | { kind: "none" }
  | { kind: "item"; id: string }
  | { kind: "note"; id: string }
  | { kind: "gen"; id: string };

/** 신규 노트(메모/프롬프트/라벨) 기본 폰트 크기(캔버스 px). AI 생성 노드의
 *  본문/라벨 폰트(~10px) 와 시각적으로 통일되도록 작게 잡는다. 사용자는
 *  NoteToolbar 의 폰트 크기로 언제든 키울 수 있다. (이전 기본값 30px 는 캔버스
 *  위에서 과도하게 컸다.) */
const DEFAULT_NOTE_FONT_SIZE = 12;

/* ──────────────────────────────────────────────────────────────
 * 드래그 상태 — pointer 이벤트 사이클 동안만 유지되는 ref
 * ────────────────────────────────────────────────────────────── */

type DragMode =
  | { kind: "idle" }
  | { kind: "pan"; startScreen: Point; startCamera: CanvasCamera }
  | { kind: "marquee"; startCanvas: Point; currentCanvas: Point; mode: "replace" | "add" }
  | {
      kind: "move";
      startPointer: Point;
      startTransforms: Record<string, CanvasItemTransform>;
      startNotes: Record<string, CanvasNote>;
      /** 함께 이동하는 선택된 gen 노드의 시작 좌표 스냅샷. id → {x,y}. */
      startGenNodes: Record<string, { x: number; y: number }>;
      axis: "x" | "y" | null;
    }
  | {
      kind: "resize";
      targetId: string;
      isNote: boolean;
      handle: HandleId;
      startPointer: Point;
      startTransform: CanvasItemTransform;
    }
  | {
      kind: "rotate";
      targetId: string;
      isNote: boolean;
      startPointer: Point;
      startTransform: CanvasItemTransform;
    }
  | {
      /** 다중 선택 union bbox 의 핸들 드래그 — *비율 유지* uniform scale.
       *  anchor 는 핸들 반대편 점(코너 핸들은 대각, 엣지 핸들은 반대편 엣지
       *  중앙)으로 drag 동안 고정. 모든 대상 항목은 anchor 기준 비례 변환.
       *  PureRef 다중 선택과 동일 정책 — 비율 자유 변형은 제공하지 않는다. */
      kind: "group-scale";
      handle: HandleId;
      anchor: Point;
      startPointer: Point;
      /** drag 시작 시점의 모든 대상 (locked 제외) 스냅샷. id → snapshot. */
      startItems: Record<string, CanvasItemTransform>;
      /** 노트 전용 스냅샷 — width / fontSize / x / y 가 비례 갱신된다. */
      startNotes: Record<string, { x: number; y: number; width: number; fontSize: number; rotation: number }>;
    };

/* ──────────────────────────────────────────────────────────────
 * Component
 * 폴더 단위 PureRef 스타일 캔버스. 자유 배치/변형/노트/카메라 영구화.
 * ────────────────────────────────────────────────────────────── */

export function LibraryCanvas(props: LibraryCanvasProps) {
  const {
    items,
    allKnownItemIds,
    tryRunLatestUndo,
    folderContextKey,
    selectedIds,
    onSelect,
    onMarqueeSelect,
    onDoubleClick,
    onCanvasFileDrop,
    onCanvasUrlDrop,
    immersive,
    onToggleImmersive,
    onAddToBrief,
    onAddToAgent,
    onAddToConti,
    onPromoteToAsset,
    onMoveToTrash,
    onCreateVariation,
    onInjectToVariation,
    variationFlyoutOpen,
    generatingIds,
    onItemCreated,
  } = props;
  const t = useT();
  const { toast } = useToast();
  const animationAutoplay = useAnimatedThumbnailsAutoplay();
  const showBadges = useLibraryShowBadges();
  const showTypeLabel = useLibraryShowTypeLabel();
  const showAnnotation = useLibraryShowAnnotation();
  // 변형 플라이아웃이 열린 동안 캔버스 이미지를 끌면 이동 대신 "참조로 가져오기"
  // 제스처가 된다 — 커서를 따라가는 carry 고스트 정보(라벨/개수/좌표).
  const [carryDrag, setCarryDrag] = useState<{ label: string; count: number; x: number; y: number } | null>(null);
  /** 생성 노드별 in-memory 실행 상태(진행/에러). durable 하지 않게 두어 새로고침
   *  시 "running" 잔류를 피한다(성공 시 node.status="done" 만 layout 에 기록). */
  const [genRunState, setGenRunState] = useState<Record<string, { running?: boolean; error?: string }>>({});

  // doc 은 캔버스에 노출하지 않음(플랜 §2). 정렬은 zIndex 로 캔버스 자체가 결정.
  //
  // ⚠️ visibleItems 는 *doc/deleted 차단* 만 한다. transform.hidden 은 layout
  // 에 들어 있어 layout 선언 전인 여기서는 못 보고, 또 layout 의존성으로 묶이면
  // 캐시가 깨져 성능이 떨어진다. hidden 필터는 *render / hit-test / marquee* 시점
  // 에 layout.items[id].hidden 으로 분기 — 작은 surgical 조건만 들어가면 충분.
  const visibleItems = useMemo(
    () => items.filter((it) => !isDocKind(it.kind) && !it.deleted_at),
    [items],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  /** pointer 이벤트 동안만 살아있는 가변 상태 — setState 회피. */
  const dragRef = useRef<DragMode>({ kind: "idle" });
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  /** 노트 편집 모드. 더블클릭 시 진입, blur/Esc 시 종료. 같은 시점에 *한 노트만*
   *  편집 가능 — 다른 노트로 더블클릭하면 자연스럽게 이전 노트 blur → 새 노트
   *  편집으로 전환된다. selectedNoteIds 와의 연동 effect 는 그 state 가 아래에서
   *  선언된 *후* (TDZ 회피) 에 위치한다. */
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  /** 현재 선택된 connection id. 라인 좌클릭 → 선택. 선택 시 ConnectionToolbar
   *  + ConnectionAnchorEditor (8 슬롯 핸들) 가 함께 노출. ESC / 빈 캔버스 클릭 /
   *  다른 라인 클릭 / 객체 선택 시 해제. */
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  /** 노트 wrapper 의 실측 border-box 높이 캐시.
   *
   *  정적 추정값 `Math.max(40, fontSize * 2.5)` 은 wrap 된 노트나 fontSize
   *  커진 1줄 노트에서 SelectionOverlay 의 점선 박스가 시각 노트 박스와
   *  어긋나게 만들었다. CanvasNoteView 가 ResizeObserver 로 wrapper 의
   *  border-box 높이를 측정해 이 ref Map 에 보고 → SelectionOverlay /
   *  마퀴 / hitTest 가 모두 같은 값을 사용해 시각적으로 일치한다.
   *
   *  ref 로 보유하고 version state 를 함께 둬서:
   *    - getNoteHeight 는 closure 무관 항상 fresh 값 (event handler 들이
   *      dep 갱신 없이 정확)
   *    - selectionTransforms 등 useMemo 는 version 변동 시 재계산 */
  const noteHeightsRef = useRef<Map<string, number>>(new Map());
  const [noteHeightsVersion, setNoteHeightsVersion] = useState(0);
  const updateNoteHeight = useCallback((noteId: string, h: number) => {
    if (!Number.isFinite(h) || h <= 0) return;
    const cur = noteHeightsRef.current.get(noteId);
    // 0.5px 미만 변동은 무시 — 서브픽셀 jitter 가 setState 폭주를 일으키지 않게.
    if (cur !== undefined && Math.abs(cur - h) < 0.5) return;
    noteHeightsRef.current.set(noteId, h);
    setNoteHeightsVersion((v) => v + 1);
  }, []);
  const getNoteHeight = useCallback(
    (note: CanvasNote): number => {
      // fallback 식: line-height 1.2 + py-1 패딩 8px = fontSize * 1.2 + 8.
      // 정확히 wrapper minHeight 와 동일 — 첫 프레임(ResizeObserver 측정 전) 의
      // 추정치가 실제 렌더 후 값과 일치해 SelectionOverlay / 마퀴 등이 박스
      // 경계와 빗나가지 않는다.
      return noteHeightsRef.current.get(note.id) ?? Math.max(20, note.fontSize * 1.2 + 8);
    },
    [],
  );
  /** Drag-to-connect — 객체 가장자리 anchor 에서 끌어 다른 객체에 연결 중인
   *  미리보기. null 이면 연결 모드 비활성. from/to 는 캔버스 좌표 (line 그리기용),
   *  fromKind/fromId/fromAnchor 는 drop 시 connection 생성에 사용. */
  const [linkingPreview, setLinkingPreview] = useState<{
    fromKind: "note" | "item";
    fromId: string;
    fromAnchor: ConnectionAnchor;
    from: Point;
    to: Point;
  } | null>(null);

  /** drag-to-create — anchor 에서 끌어 *빈 공간* 에 놓았을 때 그 자리에 새 노드를
   *  만드는 퀵 추가 메뉴(노드 에디터 v2). null 이면 비활성. canvasPt 는 새 노드가
   *  놓일 캔버스 좌표, screenX/Y 는 메뉴를 띄울 화면 좌표. from 은 새 노드와 자동
   *  연결할 출발 끝점. */
  const [quickAdd, setQuickAdd] = useState<{
    /** 새 노드와 자동 연결할 출발 끝점. drag-to-empty 경로에서만 채워진다.
     *  빈 캔버스 더블클릭 등 *독립 생성* 경로에서는 undefined → 연결 없이 노드만. */
    from?: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor };
    canvasPt: Point;
    screenX: number;
    screenY: number;
  } | null>(null);

  /** Link mode — drag-to-connect 활성화 토글.
   *
   *  L 키로 진입/종료, drop 직후 (성공/취소 무관) 자동 종료, ESC 로도 종료.
   *  linkMode 가 false 면 ObjectLinkAnchor 미렌더 → 평소 캔버스 조작에 방해
   *  안 됨. true 면 단일 선택된 객체에 hover anchor 가 등장.
   *
   *  객체 선택 변경에는 영향 받지 않음 — 모드는 그대로 유지되고 새 객체에서
   *  자연스럽게 anchor 가 추적된다. 단일 선택 자체가 없으면 anchor 가 그려질
   *  대상이 없어 시각적으로만 비활성. */
  const [linkMode, setLinkMode] = useState(false);

  // Space 패닝 모드는 제거됐다 — Alt+클릭 / 미들마우스 만으로도 pan 이 충분히
  // 일관되고, Space 는 짧은 탭 = focusSelection 한 가지 동작만 유지한다. 이전엔
  // `spaceHeldRef / spaceHeld / spaceDownTsRef / spaceDraggedRef` 로 hold-pan +
  // tap 을 동시에 구현했지만, 사용자 실제 사용 빈도와 발견성 측면에서 Alt 패턴
  // 만 두는 게 단순하다.
  /** 노트 단일-탭(드래그 없는 클릭) → 편집 모드 진입을 위한 의도 기록.
   *
   *  더블클릭 패턴은 사용자가 두 번째 클릭 사이 마우스가 살짝만 움직여도
   *  브라우저가 `dblclick` 발화를 취소해 "간혹 편집이 안 켜진다" 라는 버그가
   *  잦았다. 대신 *한 번의 클릭 + 의미 있는 드래그 없음* 으로 편집을 켜는
   *  Finder/PureRef 식 패턴을 채택 — pointerdown 시점에 의도를 기록하고
   *  pointerup 에서 시작/현재 스크린 좌표 차이를 보고 임계값(4px) 이하면
   *  편집 모드 진입, 그 외엔 일반 드래그로 마무리.
   *
   *  shift+click 은 의도에서 제외 — 다중 선택 누적이 본 목적이므로 편집으로
   *  넘기지 않는다. 더블클릭 핸들러는 fallback 으로 그대로 유지. */
  const noteTapIntentRef = useRef<{ id: string; screen: { x: number; y: number } } | null>(null);
  /** "캔버스 레이아웃 초기화" 확인 다이얼로그 노출 여부. 브라우저 native
   *  confirm 은 OS 스타일이 튀어 캔버스 모달 디자인과 어긋났고, 키보드/포커스
   *  복귀 처리도 일관성이 떨어졌다. shadcn AlertDialog 로 대체. */
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  /** OS 파일을 캔버스에 호버 중인지 — dashed 오버레이 가시성. */
  const [isOsDragHover, setIsOsDragHover] = useState(false);
  /** v2 — 미니맵 표시 여부. localStorage 영구화 없이 세션 한정 (개인 취향이고
   *  자주 토글하지 않는다). 처음엔 켜져 있어 발견성 확보. */
  const [showMinimap, setShowMinimap] = useState(true);
  /** 단축키 치트시트 패널(우측 상단) 표시 여부 — 세션 한정, 기본 꺼짐. */
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** v2 — 검색바 표시 여부. 켜지면 ref 카드들이 검색어 매칭에 따라 dim. */
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 드롭 좌표 + 타임스탬프 — reconciliation 이 5s 안에 한 번 소비.
   *  값이 살아 있을 동안 새로 들어오는 ref 는 카메라 중앙이 아닌 드롭 좌표
   *  근처에서 cascade 된다. PureRef 의 "drop where the mouse is" 와 일관. */
  const pendingDropAnchorRef = useRef<{ pt: Point; ts: number } | null>(null);
  const DROP_ANCHOR_TTL_MS = 5000;

  /** Viewport rect 캐시 — SelectionOverlay/마퀴/snap guides 가 매 render 마다
   *  inline `getBoundingClientRect()` 를 부르면 layout read 가 누적된다.
   *  ResizeObserver + window resize 로 한 번씩만 갱신. */
  const [viewportRect, setViewportRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const update = () => setViewportRect(vp.getBoundingClientRect());
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(vp);
      window.addEventListener("scroll", update, true);
      return () => {
        ro.disconnect();
        window.removeEventListener("scroll", update, true);
      };
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 초기 로드 + 폴더 컨텍스트 변경 시 layout 재로드
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    layout: getCanvasLayout(folderContextKey),
    past: [],
    future: [],
    version: 0,
  }));
  useEffect(() => {
    dispatch({ type: "load", layout: getCanvasLayout(folderContextKey) });
  }, [folderContextKey]);

  // 자기 자신이 발화한 CANVAS_LAYOUT_CHANGED_EVENT 를 무시하기 위한 source 토큰.
  // save effect 가 setCanvasLayout 으로 발화한 이벤트가 아래 listener 로 돌아오면
  // dispatch({type:"load"}) → version++ → 다시 save → 무한 루프가 된다.
  // 인스턴스 고유 Symbol 을 비교해 cycle 차단.
  const saveSourceRef = useRef<symbol>(Symbol("LibraryCanvas"));

  // 다른 윈도우/탭(storage 이벤트) 또는 cascade 유틸이 같은 폴더 layout 을
  // 바꿨을 때 동기화. 자기 자신의 변경은 saveSourceRef 비교로 skip.
  useEffect(() => {
    const onCanvasChange = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: unknown }>).detail;
      if (detail?.source === saveSourceRef.current) return;
      const fresh = getCanvasLayout(folderContextKey);
      dispatch({ type: "load", layout: fresh });
    };
    const onStorage = () => {
      const fresh = getCanvasLayout(folderContextKey);
      dispatch({ type: "load", layout: fresh });
    };
    window.addEventListener(CANVAS_LAYOUT_CHANGED_EVENT, onCanvasChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CANVAS_LAYOUT_CHANGED_EVENT, onCanvasChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [folderContextKey]);

  // Camera 는 layout.view 와 독립적으로 유지(잦은 변경) → layout commit 시점에만 함께 저장
  const [camera, setCamera] = useState<CanvasCamera>(() => state.layout.view ?? DEFAULT_CAMERA);
  useEffect(() => {
    setCamera(state.layout.view ?? DEFAULT_CAMERA);
  }, [folderContextKey, state.layout.view]);

  // 카메라가 움직이는 중인지 추적 — plane 의 will-change 동적 토글에 사용. 매
  // 카메라 setState 마다 effect 가 발화해 idle timer 를 리셋한다. 220ms 동안
  // 변화 없으면 false 로 떨어져 plane 이 재페인트 → 줌인 텍스트/이미지가 sharp.
  // setIsCameraInteracting(true) 가 이미 true 일 때는 React 가 bail-out 하므로
  // 추가 re-render 없음.
  const [isCameraInteracting, setIsCameraInteracting] = useState(false);
  const cameraIdleTimerRef = useRef<number | null>(null);
  useEffect(() => {
    setIsCameraInteracting(true);
    if (cameraIdleTimerRef.current) window.clearTimeout(cameraIdleTimerRef.current);
    cameraIdleTimerRef.current = window.setTimeout(() => {
      setIsCameraInteracting(false);
      cameraIdleTimerRef.current = null;
    }, 220);
    return () => {
      if (cameraIdleTimerRef.current) {
        window.clearTimeout(cameraIdleTimerRef.current);
        cameraIdleTimerRef.current = null;
      }
    };
  }, [camera]);

  /* ────────────────────────────────────────────────────────
   * Reconciliation — items 와 layout 의 diff. neuueeue ref 자동 배치, 사라진
   * ref 는 layout 에서 정리.
   * ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const visibleIds = new Set(visibleItems.map((it) => it.id));
    const layout = state.layout;
    let mutated = false;
    const nextItems = { ...layout.items };

    // 사라진 ref 정리 — *영구 삭제* (DB row 가 사라져 items 배열에서 빠진)
    // 자료만 layout 에서 제거한다. 단순 trash(deleted_at 설정) 는 items 안에
    // 그대로 살아 있어 pruneSet 에 포함되므로 layout entry 가 보존되고, 사용자가
    // toast 되돌리기 / Ctrl+Z 로 restore 하면 *원래 자리* 로 즉시 복귀.
    // 필터로 일시 가려진 항목(하위폴더 토글, 검색 등) 도 같은 이유로 보존.
    //
    // ⚠️ 과거 회귀: 부모가 내려보내던 `allLiveItemIds` 는 deleted_at 까지
    // 제외하는 정의여서 trash 직후 layout entry 가 즉시 지워지고, restore 시
    // findPlacementSpot 이 *새 위치* 를 자동 부여하던 문제가 있었다. 이름을
    // `allKnownItemIds` 로 바꾸고 의미를 trash 포함으로 정정.
    const pruneSet = allKnownItemIds ?? visibleIds;
    for (const id of Object.keys(nextItems)) {
      if (!pruneSet.has(id)) {
        delete nextItems[id];
        mutated = true;
      }
    }

    // 신규 ref 자동 배치 — 드롭 직후라면 드롭 좌표를 anchor 로, 아니면
    // 카메라 중앙. 드롭 anchor 는 한 reconciliation 패스에서만 살고 그 안에서
    // 한 번이라도 신규 ref 가 배치되면 소비된다.
    const vp = viewportRef.current?.getBoundingClientRect();
    const viewportCenterCanvas: Point = vp
      ? screenToCanvas(
          { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 },
          vp,
          camera,
        )
      : { x: 0, y: 0 };
    const dropAnchor = pendingDropAnchorRef.current;
    const useDropAnchor =
      dropAnchor !== null && Date.now() - dropAnchor.ts < DROP_ANCHOR_TTL_MS;
    const placementAnchor: Point = useDropAnchor && dropAnchor
      ? dropAnchor.pt
      : viewportCenterCanvas;
    const viewportSizeCanvas = vp
      ? { width: vp.width / camera.scale, height: vp.height / camera.scale }
      : { width: 1200, height: 800 };

    const existingRects: Rect[] = Object.values(nextItems).map(itemAABB);
    let nextZ = layout.nextZ;
    let placedAny = false;

    for (const it of visibleItems) {
      if (nextItems[it.id]) continue;
      const size = placementSize({ width: it.width, height: it.height, kind: it.kind });
      // 배치 anchor 우선순위:
      //   1) gen 결과면 *생성 노드 우측* — "노드에서 결과가 나간다" 시각.
      //      (genNodeId 의 노드가 layout 에 있을 때만; 없으면 폴백)
      //   2) variation_of 부모가 캔버스에 있으면 그 우측("부모 옆에 자식").
      //   3) 그 외 드롭/뷰포트 anchor.
      const prov = genProvenanceOf(it);
      const genNode = prov?.genNodeId
        ? (layout.genNodes ?? []).find((g) => g.id === prov.genNodeId)
        : undefined;
      const parentT = it.variation_of ? nextItems[it.variation_of] : undefined;
      const anchorBox = genNode
        ? { x: genNode.x, y: genNode.y, w: genNode.w, h: genNode.h }
        : parentT
          ? { x: parentT.x, y: parentT.y, w: parentT.w, h: parentT.h }
          : null;
      const itemAnchor: Point = anchorBox
        ? { x: anchorBox.x + anchorBox.w + size.w / 2 + 24, y: anchorBox.y + anchorBox.h / 2 }
        : placementAnchor;
      const spot = findPlacementSpot(
        { viewportCenterCanvas: itemAnchor, viewportSizeCanvas, existing: existingRects },
        size,
      );
      const transform: CanvasItemTransform = {
        x: spot.x,
        y: spot.y,
        w: size.w,
        h: size.h,
        rotation: 0,
        zIndex: nextZ,
      };
      nextItems[it.id] = transform;
      existingRects.push({ x: spot.x, y: spot.y, ...size });
      nextZ += 1;
      mutated = true;
      placedAny = true;
    }

    // 드롭 anchor 는 한 번 사용되면 즉시 소비 — 다음 reconciliation 부터는
    // 카메라 중앙 기본으로 복귀.
    if (placedAny && useDropAnchor) {
      pendingDropAnchorRef.current = null;
    }

    if (mutated) {
      // reconciliation 은 *데이터 정리* 일 뿐 사용자 액션이 아니므로 undo 에
      // 들어가면 안 된다 — commit=false.
      dispatch({
        type: "set",
        layout: { ...layout, items: nextItems, nextZ },
        commit: false,
      });
    }
    // visibleItems 의 *id 집합* 만 의존하면 *외부에서 layout 이 통째로 비워진*
    // 케이스(예: "캔버스 레이아웃 초기화" → dispatch load EMPTY)에서 reconcile
    // 이 다시 안 돌아 항목이 안 보이는 회귀가 났다. state.version 을 함께 두면:
    //   - transient(드래그 프레임) 는 version 미증가 → 추가 패스 없음
    //   - load/set/commit/undo/redo 시점만 패스 1회 추가
    //   - 패스 내부 dispatch 는 mutated=false 면 no-op → 무한 루프 안 됨
    // (시각 항목 객체 identity 변동에 의한 잡노이즈 reconcile 은 id-join 으로
    // 그대로 차단)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleItems.map((it) => it.id).join("|"), folderContextKey, state.version, allKnownItemIds]);

  /* ────────────────────────────────────────────────────────
   * Layout / camera 자동 저장 — *분리* 패턴
   *
   * 이전 구현은 layout commit 와 camera 변경을 같은 effect 에서 처리해 매
   * 휠 틱마다 localStorage 에 쓰는 비용이 발생했다 (화면 가운데 회전 휠
   * 한 번만 굴려도 60+ writes). 또 그 이전엔 400ms debounce 가 폴더 전환
   * race 두 종을 만들어 사용자의 최근 배치가 사라지는 사고가 있었다.
   *
   * 분리:
   *   1) layout commit (`state.version` 증가) → *즉시* 저장. 영구화는
   *      pointerup 시점 한 번뿐이라 부담 없음.
   *   2) camera (pan/zoom) → 1s idle debounce + unmount flush. 사용자가
   *      뷰를 멈추고 1초 가만히 있으면 카메라만 쓰고, 그 사이의 모든
   *      변경은 swallow.
   * state.layout 은 ref 로 감추어 transient 가 effect 를 트리거하지 않게
   * (useLayoutEffect 가 paint 전에 ref 갱신).
   */
  const layoutRef = useRef(state.layout);
  useLayoutEffect(() => {
    layoutRef.current = state.layout;
  });
  // (1) Layout commit 즉시 저장
  useEffect(() => {
    setCanvasLayout(
      folderContextKey,
      { ...layoutRef.current, view: camera },
      saveSourceRef.current,
    );
    // camera 는 *현재 값* 만 같이 넣어주면 된다. 카메라 전용 effect 가 idle
    // 후에 한 번 더 덮어쓰지만 결과는 동일하므로 영구 차이 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderContextKey, state.version]);
  // (2) Camera idle debounce — 1s
  const cameraSaveTimerRef = useRef<number | null>(null);
  const cameraRef = useRef(camera);
  useLayoutEffect(() => {
    cameraRef.current = camera;
  });
  useEffect(() => {
    if (cameraSaveTimerRef.current) window.clearTimeout(cameraSaveTimerRef.current);
    cameraSaveTimerRef.current = window.setTimeout(() => {
      setCanvasLayout(
        folderContextKey,
        { ...layoutRef.current, view: cameraRef.current },
        saveSourceRef.current,
      );
      cameraSaveTimerRef.current = null;
    }, 1000);
    return () => {
      if (cameraSaveTimerRef.current) {
        window.clearTimeout(cameraSaveTimerRef.current);
      }
    };
  }, [folderContextKey, camera]);
  // unmount / 폴더 전환 시 pending 카메라 flush — 1s 안 idle 미달성한 변경 보존.
  // saveSourceRef.current 를 cleanup 에서 읽는 것은 *의도적*이다: cleanup 시점에
  // 가장 최근에 기록된 save source(`auto` / `user`) 로 flush 해야 history 가
  // 일관된다. ESLint 가 "ref 가 cleanup 전에 바뀔 수 있다" 고 경고하지만 그게
  // 정확히 원하는 동작 — effect 시작 시 snapshot 을 잡으면 stale 한 source 로
  // 저장돼 audit log 가 어긋난다.
  useEffect(() => {
    return () => {
      if (cameraSaveTimerRef.current) {
        window.clearTimeout(cameraSaveTimerRef.current);
        setCanvasLayout(
          folderContextKey,
          { ...layoutRef.current, view: cameraRef.current },
          // eslint-disable-next-line react-hooks/exhaustive-deps
          saveSourceRef.current,
        );
      }
    };
  }, [folderContextKey]);

  /* ────────────────────────────────────────────────────────
   * Helpers
   * ──────────────────────────────────────────────────────── */

  const getVp = useCallback((): DOMRect | null => {
    return viewportRef.current?.getBoundingClientRect() ?? null;
  }, []);

  const screenPt = useCallback(
    (e: { clientX: number; clientY: number }): Point => ({ x: e.clientX, y: e.clientY }),
    [],
  );

  const cursorCanvas = useCallback(
    (e: { clientX: number; clientY: number }): Point | null => {
      const vp = getVp();
      if (!vp) return null;
      return screenToCanvas(screenPt(e), vp, camera);
    },
    [camera, getVp, screenPt],
  );

  const itemsById = useMemo(
    () => new Map(visibleItems.map((it) => [it.id, it] as const)),
    [visibleItems],
  );

  // 실제 렌더되는 item id 집합 — 연결선/앵커/툴바가 삭제(휴지통)·필터로 사라진
  // 항목에 대해서도 layout.items 에 transform 이 보존돼 "유령" 으로 남는 것을 막는다.
  const visibleItemIds = useMemo(() => new Set(itemsById.keys()), [itemsById]);

  // 미니맵/오버뷰용 — *실제 캔버스에 그려지는* 항목만. layout.items 에는 필터/
  // 휴지통/다른 폴더로 인해 화면엔 안 보이지만 위치가 보존된 transform 이 남을
  // 수 있는데, 미니맵이 그것까지 그리면 "미니맵엔 보이는데 화면엔 없는" 불일치가
  // 생긴다. 캔버스가 그리는 visibleItemIds 로 한정해 미니맵=캔버스 를 보장.
  const visibleLayoutItems = useMemo(() => {
    const out: Record<string, CanvasItemTransform> = {};
    for (const [id, tr] of Object.entries(state.layout.items)) {
      if (visibleItemIds.has(id)) out[id] = tr;
    }
    return out;
  }, [state.layout.items, visibleItemIds]);

  // 파생 베리에이션 엣지 — 둘 다 캔버스에 있고 child.variation_of === parent.id
  // 인 쌍을 암시적(점선) 엣지로 그린다. 저장하지 않으므로 리로드/필터에 무관하게
  // 항상 재계산되어 원본 → v1 → v2 계보가 노드 그래프처럼 보인다.
  const derivedVariationEdges = useMemo(() => {
    const present = new Set(visibleItems.map((it) => it.id));
    // 사용자가 우클릭으로 숨긴 파생 엣지는 제외. 키는 `${from}>${to}` (렌더 키와 동일).
    const hidden = new Set(state.layout.hiddenDerivedEdges ?? []);
    const edges: Array<{ from: string; to: string }> = [];
    for (const it of visibleItems) {
      // gen 결과(노드에서 만들어진 것)는 입력1→결과 점선 대신 gen→결과 *저장
      // 출력선* 으로 표시한다. variation_of 는 라이브러리 Variations 필터 호환을
      // 위해 유지하되 여기 자동 점선만 억제 — 입력1↔결과 점선/출력선 중복 방지.
      // genNodeId 가 있는 신규 결과만 억제 — 구버전 결과(출력선 미보유)는 기존
      // 계보 점선을 그대로 유지해 선이 사라지지 않게 한다.
      if (genProvenanceOf(it)?.genNodeId) continue;
      const parent = it.variation_of;
      if (parent && present.has(parent) && !hidden.has(`${parent}>${it.id}`)) {
        edges.push({ from: parent, to: it.id });
      }
    }
    return edges;
  }, [visibleItems, state.layout.hiddenDerivedEdges]);

  /** 파생(variation_of) 엣지 우클릭 해제 — 키(`${from}>${to}`)를 영속 숨김 목록에
   *  추가한다. 저장 연결이 아니라 자동 점선이라, 다시 보이게 하려면 원본/결과
   *  관계가 유지되는 한 수동 복구 UI 가 없다(현 범위에선 숨김만 지원). */
  const dismissDerivedEdge = useCallback((key: string) => {
    const layout = layoutRef.current;
    const existing = layout.hiddenDerivedEdges ?? [];
    if (existing.includes(key)) return;
    dispatch({ type: "set", layout: { ...layout, hiddenDerivedEdges: [...existing, key] } });
  }, []);

  // 현재 보이는 파생 엣지를 ref 로 보관 — 컨텍스트 액션 핸들러를 stable identity
  // (빈 deps) 로 유지하면서도 최신 엣지를 읽게 한다(itemContextActions 안정성).
  const derivedEdgesRef = useRef(derivedVariationEdges);
  derivedEdgesRef.current = derivedVariationEdges;

  /** 보이는 파생 엣지를 끝점으로 갖는 아이템 id 집합 — 메뉴 "모두 숨기기" 노출용. */
  const itemsWithVisibleLineage = useMemo(() => {
    const s = new Set<string>();
    for (const e of derivedVariationEdges) {
      s.add(e.from);
      s.add(e.to);
    }
    return s;
  }, [derivedVariationEdges]);

  /** 숨긴 파생 엣지를 끝점으로 갖는 아이템 id 집합 — 메뉴 "숨긴 점선 보이기" 노출용. */
  const itemsWithHiddenLineage = useMemo(() => {
    const s = new Set<string>();
    for (const key of state.layout.hiddenDerivedEdges ?? []) {
      const sep = key.indexOf(">");
      if (sep < 0) continue;
      s.add(key.slice(0, sep));
      s.add(key.slice(sep + 1));
    }
    return s;
  }, [state.layout.hiddenDerivedEdges]);

  /** 이 아이템을 끝점으로 갖는 *보이는* 파생 엣지 전부 숨김(우클릭 "모두 숨기기"). */
  const hideLineageForItem = useCallback((itemId: string) => {
    const layout = layoutRef.current;
    const keys = derivedEdgesRef.current
      .filter((e) => e.from === itemId || e.to === itemId)
      .map((e) => `${e.from}>${e.to}`);
    if (keys.length === 0) return;
    const existing = layout.hiddenDerivedEdges ?? [];
    const merged = [...new Set([...existing, ...keys])];
    if (merged.length === existing.length) return;
    dispatch({ type: "set", layout: { ...layout, hiddenDerivedEdges: merged } });
  }, []);

  /** 이 아이템을 끝점으로 갖는 *숨긴* 파생 엣지 전부 복원(우클릭 "숨긴 점선 보이기"). */
  const restoreLineageForItem = useCallback((itemId: string) => {
    const layout = layoutRef.current;
    const existing = layout.hiddenDerivedEdges ?? [];
    const next = existing.filter((key) => {
      const sep = key.indexOf(">");
      if (sep < 0) return true;
      return key.slice(0, sep) !== itemId && key.slice(sep + 1) !== itemId;
    });
    if (next.length === existing.length) return;
    dispatch({ type: "set", layout: { ...layout, hiddenDerivedEdges: next } });
  }, []);

  // selectedIds 는 ref 한정. 노트는 캔버스 로컬 선택.
  const [selectedNoteIds, setSelectedNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  // gen 노드도 라이브러리 item 이 아니라 캔버스 전용이므로 노트와 동일하게
  // 캔버스 로컬에서 선택 상태를 관리한다(부모로 올리지 않음).
  const [selectedGenIds, setSelectedGenIds] = useState<ReadonlySet<string>>(() => new Set());

  // 편집 중인 노트가 deselect 되거나 캔버스 다른 곳에서 selection 이 바뀌면
  // 편집 모드 자동 종료. 예: 다른 ref 클릭, 빈 공간 클릭 등.
  // selectedNoteIds 가 위에서 선언된 *후* 이어야 TDZ 회피.
  useEffect(() => {
    if (editingNoteId && !selectedNoteIds.has(editingNoteId)) {
      setEditingNoteId(null);
    }
  }, [editingNoteId, selectedNoteIds]);

  // 객체 / 노트 선택이 등장하면 connection 선택은 자동 해제 (상호배타).
  // 라인 선택 핸들러에서 다른 selection 들을 비우는 것과 짝이 되는 반대 방향.
  useEffect(() => {
    if (selectedConnectionId && (selectedIds.size > 0 || selectedNoteIds.size > 0 || selectedGenIds.size > 0)) {
      setSelectedConnectionId(null);
    }
  }, [selectedConnectionId, selectedIds, selectedNoteIds, selectedGenIds]);

  // connection 데이터에서 사라진 id 가 selected 로 남아 있으면 즉시 정리.
  useEffect(() => {
    if (!selectedConnectionId) return;
    const exists = (state.layout.connections ?? []).some((c) => c.id === selectedConnectionId);
    if (!exists) setSelectedConnectionId(null);
  }, [selectedConnectionId, state.layout.connections]);

  // 라인 선택 자동 해제 — connection UI (라인 hit path / 슬롯 핸들 / toolbar)
  // 가 *아닌* 영역에서 pointerdown 발생 시 해제. document 레벨이라 viewport
  // 바깥(사이드바·전역 툴바 등)을 클릭해도 동작. React 의 stopPropagation 은
  // 네이티브 이벤트 흐름을 막지 못하므로 `closest('[data-connection-ui]')`
  // 검사로 자기 자신 클릭은 제외.
  useEffect(() => {
    if (!selectedConnectionId) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest("[data-connection-ui]")) return;
      setSelectedConnectionId(null);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selectedConnectionId]);

  // genNodes 에서 사라진 id 가 selectedGenIds 에 남아 있으면 정리(노드 삭제 등).
  useEffect(() => {
    if (selectedGenIds.size === 0) return;
    const live = new Set((state.layout.genNodes ?? []).map((g) => g.id));
    let stale = false;
    for (const id of selectedGenIds) {
      if (!live.has(id)) { stale = true; break; }
    }
    if (!stale) return;
    setSelectedGenIds((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectedGenIds, state.layout.genNodes]);

  // drag-to-connect 의 시작 객체가 선택 해제되면 preview 도 클리어 — anchor
  // 가 사라졌는데 line 만 남아 있는 시각 잔재 방지.
  useEffect(() => {
    if (!linkingPreview) return;
    const stillSelected =
      linkingPreview.fromKind === "note"
        ? selectedNoteIds.has(linkingPreview.fromId)
        : selectedIds.has(linkingPreview.fromId);
    if (!stillSelected) setLinkingPreview(null);
  }, [linkingPreview, selectedNoteIds, selectedIds]);

  /** Drag-to-connect 가 다른 객체 위에서 pointerup 했을 때 호출. 같은 (from,to)
   *  쌍 (양방향 무관) 의 connection 이 이미 있으면 모두 제거(toggle off),
   *  아니면 새 connection 추가. */
  const toggleConnection = useCallback(
    (
      from: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
      to: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
    ) => {
      // 자기 자신에 연결 금지 (note→note 인 경우 같은 id, item→item 인 경우 같은 id).
      if (from.kind === to.kind && from.id === to.id) return;
      const existing = state.layout.connections ?? [];
      const isSamePair = (c: CanvasConnection) =>
        (c.from.kind === from.kind && c.from.id === from.id && c.to.kind === to.kind && c.to.id === to.id) ||
        (c.from.kind === to.kind && c.from.id === to.id && c.to.kind === from.kind && c.to.id === from.id);
      const hasExisting = existing.some(isSamePair);
      const next = hasExisting
        ? existing.filter((c) => !isSamePair(c))
        : [
            ...existing,
            {
              id: `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              from: { kind: from.kind, id: from.id, anchor: from.anchor },
              to: { kind: to.kind, id: to.id, anchor: to.anchor },
            },
          ];
      dispatch({ type: "set", layout: { ...state.layout, connections: next } });
    },
    [state.layout],
  );

  /** drag-to-connect 가 빈 공간에서 끝났을 때 — 퀵 추가 메뉴를 그 자리에 띄운다.
   *  ObjectLinkAnchor 의 pointerUp 에서 hit 가 없을 때 호출. */
  const handleLinkToEmpty = useCallback(
    (
      from: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
      canvasPt: Point,
      screen: { x: number; y: number },
    ) => {
      setQuickAdd({ from, canvasPt, screenX: screen.x, screenY: screen.y });
    },
    [],
  );

  /** 퀵 추가 메뉴 선택 → 새 노드(프롬프트 카드 / 라벨 노트 / 생성 노드) 를 그 자리에
   *  만들고 출발 끝점과 자동 연결. 입력 판정은 암시적(생성 노드에 연결됨 = 입력). */
  const createQuickAddNode = useCallback(
    (variant: "prompt" | "label" | "gen") => {
      const qa = quickAdd;
      if (!qa) return;
      const layout = layoutRef.current;
      const z = layout.nextZ;
      let newKind: ConnectionNodeKind;
      let newId: string;
      let notes = layout.notes;
      let genNodes = layout.genNodes ?? [];
      if (variant === "gen") {
        newKind = "gen";
        newId = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const node: CanvasGenNode = {
          id: newId,
          x: qa.canvasPt.x,
          y: qa.canvasPt.y,
          w: 220,
          h: 140,
          zIndex: z,
          outputKind: "image",
          status: "idle",
        };
        genNodes = [...genNodes, node];
      } else {
        newKind = "note";
        newId = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const note: CanvasNote = {
          id: newId,
          text: "",
          x: qa.canvasPt.x,
          y: qa.canvasPt.y,
          width: 200,
          fontSize: DEFAULT_NOTE_FONT_SIZE,
          rotation: 0,
          zIndex: z,
          bgColor: "transparent",
          color: "#ffffff",
          align: "left",
          role: variant === "prompt" ? "prompt" : undefined,
        };
        notes = [...notes, note];
      }
      // 출발 끝점(qa.from)이 있을 때만 자동 연결. 빈 캔버스 더블클릭 등 독립
      // 생성 경로(from 없음)에서는 연결 없이 노드만 만든다.
      const conn: CanvasConnection | null = qa.from
        ? {
            id: `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            from: { kind: qa.from.kind, id: qa.from.id, anchor: qa.from.anchor },
            to: { kind: newKind, id: newId },
            // 입력 판정은 암시적(생성 노드에 연결됨 = 입력, M4). linkType 미설정.
          }
        : null;
      dispatch({
        type: "set",
        layout: {
          ...layout,
          notes,
          genNodes,
          connections: conn ? [...(layout.connections ?? []), conn] : (layout.connections ?? []),
          nextZ: z + 1,
        },
      });
      // 새 노트는 즉시 선택해 바로 편집/이동 가능하게. gen 노드도 선택해 둬
      // 곧바로 이동/삭제/정렬 등 1급 동작이 가능하도록(다른 선택은 비운다).
      if (newKind === "note") {
        setSelectedNoteIds(new Set([newId]));
        setSelectedGenIds(new Set());
        if (variant !== "gen") setEditingNoteId(newId);
      } else {
        setSelectedGenIds(new Set([newId]));
        setSelectedNoteIds(new Set());
        onMarqueeSelect([], "replace");
      }
      setQuickAdd(null);
    },
    [quickAdd, onMarqueeSelect],
  );

  /** 생성 노드 이동 — 드래그 중에는 transient(undo 스택 안 쌓음), pointerup 시
   *  commit. layoutRef 로 최신 상태 읽어 stable. */
  const moveGenNode = useCallback((id: string, x: number, y: number, commit: boolean) => {
    const layout = layoutRef.current;
    const genNodes = (layout.genNodes ?? []).map((g) => (g.id === id ? { ...g, x, y } : g));
    dispatch({ type: commit ? "set" : "transient", layout: { ...layout, genNodes } });
  }, []);

  /** 생성 노드 삭제 — 노드 + 그 노드를 끝점으로 하는 모든 연결 제거. */
  const deleteGenNode = useCallback((id: string) => {
    const layout = layoutRef.current;
    const genNodes = (layout.genNodes ?? []).filter((g) => g.id !== id);
    const connections = (layout.connections ?? []).filter(
      (c) => !((c.from.kind === "gen" && c.from.id === id) || (c.to.kind === "gen" && c.to.id === id)),
    );
    dispatch({ type: "set", layout: { ...layout, genNodes, connections } });
  }, []);

  /** 생성 노드의 출력 종류 토글 — image ↔ video (선택 모델 종류 결정). 영상은
   *  Vertex API 부재로 보류 상태라 UI 에서 비활성이지만, 핸들러는 유지. */
  const setGenOutputKind = useCallback((id: string, outputKind: CanvasGenNode["outputKind"]) => {
    const layout = layoutRef.current;
    const genNodes = (layout.genNodes ?? []).map((g) => (g.id === id ? { ...g, outputKind } : g));
    dispatch({ type: "set", layout: { ...layout, genNodes } });
  }, []);

  /** 생성 노드의 모델 변경 — imageGenPreference("canvas") 옵션 중 하나. */
  const setGenModel = useCallback((id: string, model: string) => {
    const layout = layoutRef.current;
    const genNodes = (layout.genNodes ?? []).map((g) => (g.id === id ? { ...g, model } : g));
    dispatch({ type: "set", layout: { ...layout, genNodes } });
  }, []);

  /** 생성 노드의 params 머지(aspectRatio/imageSize/quality 등 자유 JSON). */
  const setGenParams = useCallback((id: string, patch: Record<string, unknown>) => {
    const layout = layoutRef.current;
    const genNodes = (layout.genNodes ?? []).map((g) =>
      g.id === id ? { ...g, params: { ...(g.params ?? {}), ...patch } } : g,
    );
    dispatch({ type: "set", layout: { ...layout, genNodes } });
  }, []);

  /** 생성 노드 실행(이미지 전용) — 노드에 연결된 라이브러리 이미지 + 프롬프트
   *  카드를 수집해 generateCanvasImage 를 호출한다. 입력 판정은 암시적: gen 노드를
   *  끝점으로 하는 모든 connection 의 반대쪽이 item(이미지)이면 입력 이미지,
   *  note(role=prompt)면 프롬프트로 모은다.
   *
   *  결과 배치: 결과 아이템은 variation_of=대표 입력 id 를 갖고 부모 items 에
   *  업서트되며, reconciliation 이 대표 입력 카드 *오른쪽* 에 자동 배치한다(842행).
   *  진행/에러 상태는 in-memory(genRunState) 로만 표시 — 새로고침 시 "running"
   *  잔류를 피한다. 성공 시 node.status="done" 만 durable 기록. */
  const runGenNode = useCallback(
    async (id: string) => {
      const layout = layoutRef.current;
      const node = (layout.genNodes ?? []).find((g) => g.id === id);
      if (!node) return;
      if (node.outputKind === "video") {
        toast({ variant: "destructive", title: t("library.canvas.gen.videoComingSoon") });
        return;
      }
      // 노드를 끝점으로 하는 연결의 반대쪽 끝점 수집.
      const others: { kind: ConnectionNodeKind; id: string }[] = [];
      for (const c of layout.connections ?? []) {
        if (c.from.kind === "gen" && c.from.id === id) others.push({ kind: c.to.kind, id: c.to.id });
        else if (c.to.kind === "gen" && c.to.id === id) others.push({ kind: c.from.kind, id: c.from.id });
      }
      const imageInputs: CanvasGenerationInput[] = [];
      const promptParts: string[] = [];
      let promptNoteId: string | undefined;
      for (const o of others) {
        if (o.kind === "item") {
          const it = itemsById.get(o.id);
          if (it && it.file_url && (it.kind === "image" || it.kind === "webp" || it.kind === "gif")) {
            imageInputs.push({ refId: it.id, fileUrl: it.file_url, thumbnailUrl: it.thumbnail_url });
          }
        } else if (o.kind === "note") {
          const note = layout.notes.find((n) => n.id === o.id);
          if (note?.role === "prompt" && note.text.trim()) {
            promptParts.push(note.text.trim());
            if (!promptNoteId) promptNoteId = note.id;
          }
        }
      }
      const prompt = promptParts.join("\n\n");
      if (imageInputs.length === 0) {
        toast({ variant: "destructive", title: t("library.canvas.gen.needImageInput") });
        return;
      }
      if (!prompt) {
        toast({ variant: "destructive", title: t("library.canvas.gen.needPrompt") });
        return;
      }
      const model = node.model ?? getImageModelDefault("canvas");
      const quality = modelIsGpt("canvas", model)
        ? ((node.params?.quality as GptQuality | undefined) ?? getGptQualityDefault("canvas"))
        : undefined;
      const imageSize = (node.params?.imageSize as string | undefined) ?? "1024x1536";
      const folderTags = folderContextKey.startsWith("tag:folder:")
        ? [folderContextKey.slice("tag:".length)]
        : undefined;
      const title = itemsById.get(imageInputs[0].refId)?.title;

      setGenRunState((prev) => ({ ...prev, [id]: { running: true } }));
      try {
        const created = await generateCanvasImage({
          prompt,
          model,
          quality,
          imageSize,
          imageInputs,
          promptNoteId,
          genNodeId: id,
          folderTags,
          title,
        });
        // 노드 status durable 기록(done) + gen→결과 저장연결(linkType:"output").
        // 결과는 노드 *우측* 에서 나가는 출력선으로 표시되며, 입력1→결과 파생
        // 점선은 derivedVariationEdges 에서 억제한다. created.id 의 transform 은
        // onItemCreated → reconciliation 이 배치하기 전이라 아직 없을 수 있으나,
        // ConnectionLayer 는 끝점 transform 이 생기면 자동으로 그 연결을 그린다.
        const cur = layoutRef.current;
        const genNodes = (cur.genNodes ?? []).map((g) => (g.id === id ? { ...g, status: "done" as const } : g));
        const outputConn: CanvasConnection = {
          id: `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          from: { kind: "gen", id },
          to: { kind: "item", id: created.id },
          linkType: "output",
        };
        const connections = [...(cur.connections ?? []), outputConn];
        dispatch({ type: "set", layout: { ...cur, genNodes, connections } });
        setGenRunState((prev) => ({ ...prev, [id]: {} }));
        onItemCreated?.(created);
        toast({ title: t("library.canvas.gen.done") });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setGenRunState((prev) => ({ ...prev, [id]: { error: message } }));
        toast({ variant: "destructive", title: t("library.canvas.gen.failed"), description: message });
      }
    },
    [itemsById, folderContextKey, onItemCreated, toast, t],
  );

  /** 특정 미디어(item) 와 연결된 모든 connection 을 한 번에 제거.
   *  우클릭 컨텍스트 메뉴 → "이 미디어의 모든 연결 해제" 액션의 백엔드.
   *
   *  layoutRef 로 최신 state 를 읽어 콜백 자체를 stable 하게 유지 — CanvasItemView
   *  의 React.memo 가 callback identity 를 비교하지 않기 때문에, useCallback
   *  의 deps 가 매 렌더 변하면 자식이 *옛 closure* 를 들고 있게 된다. ref 경유
   *  로 그 회귀를 차단. */
  const unlinkAllOfItem = useCallback((itemId: string) => {
    const layout = layoutRef.current;
    const conns = layout.connections ?? [];
    const next = conns.filter(
      (c) =>
        !(
          (c.from.kind === "item" && c.from.id === itemId) ||
          (c.to.kind === "item" && c.to.id === itemId)
        ),
    );
    if (next.length === conns.length) return;
    dispatch({ type: "set", layout: { ...layout, connections: next } });
  }, []);

  /** 연결 라인 우클릭 → "이 연결 해제". 단일 connection 만 id 매칭으로 제거.
   *  unlinkAllOfItem 과 동일하게 layoutRef 경유로 stable 유지. */
  const unlinkConnection = useCallback((connectionId: string) => {
    const layout = layoutRef.current;
    const conns = layout.connections ?? [];
    const next = conns.filter((c) => c.id !== connectionId);
    if (next.length === conns.length) return;
    dispatch({ type: "set", layout: { ...layout, connections: next } });
  }, []);

  /** ConnectionToolbar 의 모든 외형 변경 (color/thickness/lineStyle/end…)
   *  공용 mutator. style 객체만 부분 갱신. */
  const mutateConnection = useCallback(
    (connectionId: string, mut: (c: CanvasConnection) => CanvasConnection) => {
      const layout = layoutRef.current;
      const conns = layout.connections ?? [];
      const idx = conns.findIndex((c) => c.id === connectionId);
      if (idx < 0) return;
      const cur = conns[idx];
      const nxt = mut(cur);
      if (nxt === cur) return;
      const next = [...conns];
      next[idx] = nxt;
      dispatch({ type: "set", layout: { ...layout, connections: next } });
    },
    [],
  );

  /** ConnectionAnchorEditor 가 슬롯을 드래그해 다른 슬롯으로 이동시킬 때.
   *  end='from'|'to' 로 어느 끝점을 갱신할지 결정. anchor 는 8 슬롯 중 하나.
   *
   *  Toggle 정책:
   *   - 잠금 안 됨 (또는 잠금 슬롯과 다른 슬롯) → 새 슬롯에 *고정* (anchorLocked=true).
   *   - 이미 잠긴 슬롯과 *동일* 슬롯 다시 클릭 → *잠금 해제* (auto-anchor 로 복귀).
   *  ⚠️ 사용자가 명시적으로 슬롯을 지정하면 anchorLocked:true 로 마킹 → 객체
   *  이동에도 그 변에 그대로 고정. ConnectionLayer 의 auto-anchor 가 이 플래그
   *  를 보고 재계산을 건너뛴다. */
  const setConnectionAnchor = useCallback(
    (connectionId: string, end: "from" | "to", anchor: ConnectionAnchor) => {
      mutateConnection(connectionId, (c) => {
        const cur = end === "from" ? c.from : c.to;
        // 동일 슬롯을 다시 클릭하면 잠금 해제 — auto-anchor 로 복귀하여 객체
        // 이동 시 자연스럽게 가장 가까운 변으로 라인이 흐른다. anchor 자체는
        // 마지막 값으로 보존(다음 toggle 때 다시 잠그면 동일 슬롯 복원).
        if (
          cur.anchorLocked &&
          cur.anchor &&
          cur.anchor.u === anchor.u &&
          cur.anchor.v === anchor.v
        ) {
          const nextEnd = { ...cur };
          delete nextEnd.anchorLocked;
          return { ...c, [end]: nextEnd } as CanvasConnection;
        }
        return {
          ...c,
          [end]: { ...cur, anchor, anchorLocked: true },
        } as CanvasConnection;
      });
    },
    [mutateConnection],
  );

  // itemContextActions 는 새 v2 액션들(group/ungroup/hide/effect/crop/send-to-scene)
  // 을 같이 넘기는데, 이 함수들은 *아래쪽* 에서 정의되므로 TDZ 회피를 위해
  // 정의 시점을 그 모든 액션 뒤로 미뤘다. (이전엔 unlinkAllOfItem 하나라
  // 단순 useMemo 면 충분했음.) 실제 선언은 키보드 핸들러 직전.

  /** v2 — 숨겨진 ref 개수. 툴바 "모두 표시" 버튼 toggle 표시 + 검색바
   *  활성화 시 사용자에게 "N 개 숨김" 안내. */
  const hiddenCount = useMemo(() => {
    let n = 0;
    for (const tr of Object.values(state.layout.items)) if (tr.hidden) n += 1;
    return n;
  }, [state.layout.items]);

  /** v2 — 선택된 모든 ref 가 잠긴 상태인지. 빈 선택은 false (=미잠금 톤). */
  const selectionAllLocked = useMemo(() => {
    if (selectedIds.size === 0) return false;
    for (const id of selectedIds) {
      const tr = state.layout.items[id];
      if (!tr || !tr.locked) return false;
    }
    return true;
  }, [selectedIds, state.layout.items]);

  /** v2 — 검색 매칭 ID 집합. 빈 쿼리면 *모두 일치* (=dim 없음). 매칭은
   *  title / tags 에 대해 case-insensitive substring. 폴더 정보는 별도 필드가
   *  아니라 `tags` 배열의 `folder:Foo/Bar` 접두 문자열로 저장되므로 tags join
   *  한 번으로 자연스럽게 폴더 경로 매칭까지 함께 잡힌다(과거에 존재하지 않는
   *  `folder_path` 필드를 추가로 join 해 TS 에러를 발생시키던 자리 제거). */
  const searchMatchedIds = useMemo(() => {
    if (!searchActive || !searchQuery.trim()) return null;
    const q = searchQuery.trim().toLowerCase();
    const matched = new Set<string>();
    for (const it of items) {
      const hay = [it.title ?? "", it.tags.join(" ")].join(" ").toLowerCase();
      if (hay.includes(q)) matched.add(it.id);
    }
    return matched;
  }, [items, searchActive, searchQuery]);

  /** 현재 connections 에 *아이템 끝점* 이 한 번이라도 등장하는 id 의 집합.
   *  컨텍스트 메뉴의 "Unlink all" 항목 disabled 표시를 O(1) 로 결정한다.
   *  연결이 자주 바뀌지 않는 워크로드에서 재계산 비용은 무시 가능. */
  const connectedItemIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of state.layout.connections ?? []) {
      if (c.from.kind === "item") s.add(c.from.id);
      if (c.to.kind === "item") s.add(c.to.id);
    }
    return s;
  }, [state.layout.connections]);

  // 선택된 *변환 가능한* 객체들 (ref + 노트) 의 transform/bbox 리스트
  const selectionTransforms = useMemo(() => {
    const out: Array<{ id: string; isNote: boolean; t: CanvasItemTransform }> = [];
    for (const id of selectedIds) {
      const tr = state.layout.items[id];
      if (!tr) continue;
      // 카드가 *실제로 렌더되는* 항목만 선택 오버레이를 그린다. hidden(렌더 제외)
      // 이거나 현재 필터/휴지통/doc 등으로 visibleItems 에 없는 항목이 selectedIds
      // 에 남아 있으면, 카드는 없는데 선택 핸들 박스만 허공에 떠 지워지지도 않는
      // "유령 선택" 이 생긴다 — 그 케이스를 여기서 차단한다.
      if (tr.hidden) continue;
      if (!itemsById.has(id)) continue;
      out.push({ id, isNote: false, t: tr });
    }
    for (const note of state.layout.notes) {
      if (selectedNoteIds.has(note.id)) {
        out.push({
          id: note.id,
          isNote: true,
          t: {
            x: note.x,
            y: note.y,
            w: note.width,
            // 실측 wrapper border-box 높이 — 시각 노트 박스(ring)와 정확히 일치.
            // 측정 전이면 fallback(getNoteHeight) 이 정적 추정값으로 채운다.
            h: getNoteHeight(note),
            rotation: note.rotation,
            zIndex: note.zIndex,
          },
        });
      }
    }
    return out;
    // noteHeightsVersion 을 dep 에 포함시켜 ResizeObserver 가 새 높이를 보고
    // 한 직후 SelectionOverlay 등이 즉시 재계산되도록.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, selectedNoteIds, state.layout.items, state.layout.notes, noteHeightsVersion, itemsById]);

  const selectionBBox: Rect | null = useMemo(() => {
    // crop 적용된 ref 는 visible 영역으로 — focus / zoom-to-selection 시 보이는
    // 영역을 정확히 화면에 맞춤 (outer box 의 transparent margin 까지 zoom 하면
    // 보이는 이미지가 작아 보임).
    const rects = selectionTransforms.map((s) => visibleItemAABB(s.t));
    return unionBBox(rects);
  }, [selectionTransforms]);

  /* ────────────────────────────────────────────────────────
   * Wheel zoom — 커서 앵커, rAF batching
   *
   * SyntheticEvent 를 ref 에 보유하면 React 17+ 에서도 best practice 가
   * 아니다 (event.persist() 없이는 일부 필드가 nulled 될 수 있음). 변경
   * 후엔 필요한 숫자만 즉시 스냅샷 — {dy, x, y}.
   * ──────────────────────────────────────────────────────── */
  const wheelAccumRef = useRef<{
    pending: boolean;
    accumDy: number;
    lastX: number;
    lastY: number;
  }>({
    pending: false,
    accumDy: 0,
    lastX: 0,
    lastY: 0,
  });
  const handleWheel = useCallback(
    (e: ReactWheelEvent) => {
      e.preventDefault();
      // 사용자가 직접 wheel-zoom 했으면 focusSelection 의 "이전 카메라" 백업은
      // 더 이상 의미 없는 stale 값 → 비워서 다음 Space 가 stale snap-back 이
      // 아닌 *새 fit* 이 되게.
      previousCameraRef.current = null;
      lastFocusedSelectionKeyRef.current = null;
      wheelAccumRef.current.accumDy += e.deltaY;
      wheelAccumRef.current.lastX = e.clientX;
      wheelAccumRef.current.lastY = e.clientY;
      if (wheelAccumRef.current.pending) return;
      wheelAccumRef.current.pending = true;
      requestAnimationFrame(() => {
        const dy = wheelAccumRef.current.accumDy;
        const x = wheelAccumRef.current.lastX;
        const y = wheelAccumRef.current.lastY;
        wheelAccumRef.current.pending = false;
        wheelAccumRef.current.accumDy = 0;
        if (dy === 0) return;
        const vp = getVp();
        if (!vp) return;
        const factor = Math.pow(1.0015, -dy);
        setCamera((prev) => zoomAt({ ...prev }, { x, y }, vp, prev.scale * factor));
      });
    },
    [getVp],
  );

  /* ────────────────────────────────────────────────────────
   * Hit testing — pointerdown 위치에서 무엇이 잡혔는지
   * ──────────────────────────────────────────────────────── */

  const hitTest = useCallback(
    (canvasPt: Point): HitResult => {
      // 노트가 ref 보다 항상 위라고 가정하지 말고 zIndex 로 정렬해 위에서부터 검사
      const layers: Array<{ id: string; kind: "item" | "note" | "gen"; t: CanvasItemTransform; z: number }> = [];
      for (const [id, tr] of Object.entries(state.layout.items)) {
        // hidden 항목은 hit-test 에서도 통과 — 사용자에게 "안 보이는데 클릭됨"
        // 같은 유령 동작을 막는다. PureRef hide 와 동일 정책.
        if (tr.hidden) continue;
        layers.push({ id, kind: "item", t: tr, z: tr.zIndex });
      }
      // AI 생성 노드도 연결 대상(끝점) 으로 hit-test 에 포함 — 이미지/노트를
      // 드래그해 노드 위에 놓으면 입력 연결이 된다. 노드는 회전 없는 박스.
      for (const g of state.layout.genNodes ?? []) {
        if (g.hidden) continue;
        layers.push({
          id: g.id,
          kind: "gen",
          t: { x: g.x, y: g.y, w: g.w, h: g.h, rotation: 0, zIndex: g.zIndex },
          z: g.zIndex,
        });
      }
      // 노트 hit box 는 시각 영역보다 ±NOTE_HIT_PADDING 만큼 확장 — 작은
      // 폰트(14px) 의 비어 있는 노트는 시각 박스가 35~40px 라 정확히 클릭
      // 하기 어려웠다. 화면에 그려지는 영역은 그대로 두고 hit-test 만 넓혀
      // "노트 근처" 클릭이 자연스럽게 잡히도록.
      const NOTE_HIT_PADDING = 12;
      for (const note of state.layout.notes) {
        // 실측 wrapper 높이 사용 — 정적 추정 대신 자랑 wrap 된 노트도 정확히
        // 클릭 가능. SelectionOverlay 의 점선 박스 영역과 시각 노트 박스가
        // 같은 값을 공유하므로 사용자 인지와 일치.
        const noteH = getNoteHeight(note);
        layers.push({
          id: note.id,
          kind: "note",
          z: note.zIndex,
          t: {
            x: note.x - NOTE_HIT_PADDING,
            y: note.y - NOTE_HIT_PADDING,
            w: note.width + NOTE_HIT_PADDING * 2,
            h: noteH + NOTE_HIT_PADDING * 2,
            rotation: note.rotation,
            zIndex: note.zIndex,
          },
        });
      }
      layers.sort((a, b) => b.z - a.z);
      for (const l of layers) {
        if (pointInItem(canvasPt, l.t)) return { kind: l.kind, id: l.id };
      }
      return { kind: "none" };
    },
    [state.layout.items, state.layout.notes, state.layout.genNodes],
  );

  /* ────────────────────────────────────────────────────────
   * Pointer events — pan / marquee / move / resize / rotate
   * ──────────────────────────────────────────────────────── */

  const startMove = useCallback(
    (startPointer: Point, includeNotes = true) => {
      const startTransforms: Record<string, CanvasItemTransform> = {};
      const startNotes: Record<string, CanvasNote> = {};
      const startGenNodes: Record<string, { x: number; y: number }> = {};
      for (const id of selectedIds) {
        const tr = state.layout.items[id];
        if (tr && !tr.locked) startTransforms[id] = { ...tr };
      }
      if (includeNotes) {
        for (const note of state.layout.notes) {
          if (selectedNoteIds.has(note.id)) startNotes[note.id] = { ...note };
        }
      }
      for (const g of state.layout.genNodes ?? []) {
        if (selectedGenIds.has(g.id) && !g.locked) startGenNodes[g.id] = { x: g.x, y: g.y };
      }
      dragRef.current = {
        kind: "move",
        startPointer,
        startTransforms,
        startNotes,
        startGenNodes,
        axis: null,
      };
    },
    [selectedIds, selectedNoteIds, selectedGenIds, state.layout.items, state.layout.notes, state.layout.genNodes],
  );

  /** 주어진 groupId 에 속한 모든 아이템 / 노트 id 를 모은다. 클릭 선택 확장과
   *  단일-탭 그룹 유지에서 공유. groupId 가 없으면 빈 배열. */
  const collectGroupMembers = useCallback(
    (groupId: string | undefined | null): { itemIds: string[]; noteIds: string[] } => {
      if (!groupId) return { itemIds: [], noteIds: [] };
      const itemIds: string[] = [];
      const noteIds: string[] = [];
      for (const [id, tr] of Object.entries(state.layout.items)) {
        if (tr.groupId === groupId) itemIds.push(id);
      }
      for (const n of state.layout.notes) {
        if (n.groupId === groupId) noteIds.push(n.id);
      }
      return { itemIds, noteIds };
    },
    [state.layout],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 트랜스폼 핸들 / 노트 contentEditable 등은 자기 이벤트에서 stopPropagation
      const vp = getVp();
      if (!vp) return;
      const cp = cursorCanvas(e);
      if (!cp) return;

      // 미들 마우스(휠 클릭) 또는 Alt+LMB → pan. Space hold-to-pan 은 제거됨.
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault();
        // 직접 pan 시작 → focusSelection 의 stale "이전 카메라" 백업 무효화.
        // 다음 Space 가 stale snap-back 이 아닌 새 fit 으로 작동.
        previousCameraRef.current = null;
        lastFocusedSelectionKeyRef.current = null;
        dragRef.current = { kind: "pan", startScreen: screenPt(e), startCamera: { ...camera } };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      const hit = hitTest(cp);
      if (hit.kind === "none") {
        // 빈 공간 클릭 → 선택 해제 + 마퀴 시작
        const additive = e.shiftKey;
        if (!additive) {
          onMarqueeSelect([], "replace");
          setSelectedNoteIds(new Set());
          setSelectedGenIds(new Set());
        }
        dragRef.current = { kind: "marquee", startCanvas: cp, currentCanvas: cp, mode: additive ? "add" : "replace" };
        setMarqueeRect({ x: cp.x, y: cp.y, w: 0, h: 0 });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      if (hit.kind === "item") {
        // 이미 선택돼 있고 Shift 아니면 그냥 이동 시작; 아니면 selection 갱신 후 이동
        const alreadySelected = selectedIds.has(hit.id);
        // 그룹핑 자동 확장 — hit 한 아이템에 groupId 가 있으면 같은 groupId 의
        // 다른 아이템 *과 노트* 도 함께 잡힌다. Shift 누르면 그 외 기존 선택도 누적.
        const hitTr = state.layout.items[hit.id];
        const groupId = hitTr?.groupId;
        const { itemIds: groupItemIds, noteIds: groupNoteIds } = collectGroupMembers(groupId);
        const groupMates = groupItemIds.filter((id) => id !== hit.id);
        const hasGroup = groupMates.length > 0 || groupNoteIds.length > 0;
        if (!alreadySelected) {
          if (hasGroup) {
            // 그룹은 한 번에 묶음 선택 — onSelect 1회 호출로는 표현 불가하므로
            // onMarqueeSelect 로 통째로 set. 같은 그룹의 노트도 함께 선택한다.
            const base = e.shiftKey ? Array.from(selectedIds) : [];
            const next = new Set<string>(base);
            next.add(hit.id);
            for (const id of groupMates) next.add(id);
            onMarqueeSelect(Array.from(next), e.shiftKey ? "add" : "replace");
            setSelectedNoteIds((prev) => {
              const ns = new Set(e.shiftKey ? prev : []);
              for (const id of groupNoteIds) ns.add(id);
              return ns;
            });
          } else {
            onSelect(hit.id, e as unknown as ReactMouseEvent<HTMLElement>);
            if (!e.shiftKey) {
              setSelectedNoteIds(new Set());
              setSelectedGenIds(new Set());
            }
          }
        }
        // commit 한 스냅샷 — pointerup 까지 transient 로 흐르다 commit
        dispatch({ type: "commit" });
        // 새 선택을 반영한 후에 startMove. selectedIds 가 동기적으로 안 바뀌므로
        // 단일 카드 클릭 케이스를 위해 임시로 그 카드만 포함시킨다.
        const startTransforms: Record<string, CanvasItemTransform> = {};
        const startNotes: Record<string, CanvasNote> = {};
        const effectiveSelected: Set<string> = new Set(
          alreadySelected || e.shiftKey ? Array.from(selectedIds) : [],
        );
        if (!alreadySelected) effectiveSelected.add(hit.id);
        // 그룹 멤버도 함께 startTransforms 에 포함 — 첫 프레임부터 따라 움직임.
        for (const id of groupMates) effectiveSelected.add(id);
        for (const id of effectiveSelected) {
          const tr = state.layout.items[id];
          if (tr && !tr.locked) startTransforms[id] = { ...tr };
        }
        // 기존 선택 노트 + 같은 그룹의 노트도 함께 끌어가게 스냅샷에 포함.
        const effectiveNotes = new Set<string>(
          alreadySelected || e.shiftKey ? Array.from(selectedNoteIds) : [],
        );
        for (const id of groupNoteIds) effectiveNotes.add(id);
        for (const note of state.layout.notes) {
          if (effectiveNotes.has(note.id)) startNotes[note.id] = { ...note };
        }
        // 함께 선택된 gen 노드도 같이 끌어가게 스냅샷에 포함(마퀴로 묶인 경우).
        const startGenNodes: Record<string, { x: number; y: number }> = {};
        if (alreadySelected || e.shiftKey) {
          for (const g of state.layout.genNodes ?? []) {
            if (selectedGenIds.has(g.id) && !g.locked) startGenNodes[g.id] = { x: g.x, y: g.y };
          }
        }
        dragRef.current = {
          kind: "move",
          startPointer: cp,
          startTransforms,
          startNotes,
          startGenNodes,
          axis: null,
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      if (hit.kind === "note") {
        const alreadySelected = selectedNoteIds.has(hit.id);
        // 그룹핑 자동 확장 — hit 한 노트에 groupId 가 있으면 같은 그룹의 아이템
        // (이미지/영상) 과 다른 노트도 함께 잡힌다.
        const hitNote = state.layout.notes.find((n) => n.id === hit.id);
        const { itemIds: groupItemIds, noteIds: groupNoteIds } = collectGroupMembers(hitNote?.groupId);
        const groupMateNotes = groupNoteIds.filter((id) => id !== hit.id);
        // 같은 그룹의 ref 선택 — 그룹이 없으면 기존처럼 ref 선택을 해제한다.
        if (!e.shiftKey) {
          onMarqueeSelect(groupItemIds, "replace");
        } else if (groupItemIds.length > 0) {
          onMarqueeSelect(groupItemIds, "add");
        }
        setSelectedNoteIds((prev) => {
          const next = new Set(e.shiftKey ? prev : []);
          if (e.shiftKey && prev.has(hit.id)) next.delete(hit.id);
          else next.add(hit.id);
          for (const id of groupMateNotes) next.add(id);
          return next;
        });
        // shift 없이 클릭한 노트는 "탭 의도" 후보 — pointerup 에서 거의 안
        // 움직였으면 편집 모드로 진입 (dblclick 신뢰도 이슈 회피).
        if (!e.shiftKey) {
          noteTapIntentRef.current = { id: hit.id, screen: { x: e.clientX, y: e.clientY } };
        } else {
          noteTapIntentRef.current = null;
        }
        dispatch({ type: "commit" });
        // startMove 가 selectedNoteIds (React state) 를 읽지만 위 setSelectedNoteIds
        // 는 다음 렌더에서야 반영되므로, "미선택 노트를 처음 클릭 → 드래그" 케이스
        // 에서 stale closure 라 startNotes 가 비어 첫 시도가 안 움직이는 회귀가 있었다.
        // items 의 effectiveSelected 패턴처럼 *방금 hit 한 노트 + 기존 선택* 을 직접
        // 합쳐 dragRef 를 박는다.
        const effectiveNotes = new Set<string>(
          alreadySelected || e.shiftKey ? Array.from(selectedNoteIds) : [],
        );
        effectiveNotes.add(hit.id);
        for (const id of groupMateNotes) effectiveNotes.add(id);
        const startTransforms: Record<string, CanvasItemTransform> = {};
        const startNotes: Record<string, CanvasNote> = {};
        // shift 누른 상태에서 ref 까지 동시 선택돼 있었으면 함께 끌어가게.
        if (e.shiftKey) {
          for (const id of selectedIds) {
            const tr = state.layout.items[id];
            if (tr && !tr.locked) startTransforms[id] = { ...tr };
          }
        }
        // 같은 그룹의 아이템도 드래그 스냅샷에 포함 — 노트와 함께 움직이도록.
        for (const id of groupItemIds) {
          const tr = state.layout.items[id];
          if (tr && !tr.locked) startTransforms[id] = { ...tr };
        }
        for (const note of state.layout.notes) {
          if (effectiveNotes.has(note.id)) startNotes[note.id] = { ...note };
        }
        // shift 로 gen 노드까지 동시 선택돼 있었으면 함께 끌어가게.
        const startGenNodes: Record<string, { x: number; y: number }> = {};
        if (e.shiftKey) {
          for (const g of state.layout.genNodes ?? []) {
            if (selectedGenIds.has(g.id) && !g.locked) startGenNodes[g.id] = { x: g.x, y: g.y };
          }
        }
        dragRef.current = {
          kind: "move",
          startPointer: cp,
          startTransforms,
          startNotes,
          startGenNodes,
          axis: null,
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    [
      camera,
      collectGroupMembers,
      cursorCanvas,
      getVp,
      hitTest,
      onMarqueeSelect,
      onSelect,
      screenPt,
      selectedIds,
      selectedNoteIds,
      selectedGenIds,
      state.layout.genNodes,
      // startMove dep 는 제거됨 — 콜백 본문(handlePointerDown)이 startMove() 를
      // 직접 호출하지 않고 effectiveSelected/effectiveNotes + dragRef.current 를
      // 직접 set 해 같은 일을 한다. 주석/이전 deps 에 startMove 이름이 남아
      // 있어 보이지만 함수 호출이 없어 ESLint 도 "unnecessary dependency" 로 분류.
      state.layout.items,
      state.layout.notes,
    ],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag.kind === "idle") return;

      const vp = getVp();
      if (!vp) return;

      if (drag.kind === "pan") {
        const dx = e.clientX - drag.startScreen.x;
        const dy = e.clientY - drag.startScreen.y;
        setCamera({ ...drag.startCamera, tx: drag.startCamera.tx + dx, ty: drag.startCamera.ty + dy });
        return;
      }

      const cp = cursorCanvas(e);
      if (!cp) return;

      if (drag.kind === "marquee") {
        drag.currentCanvas = cp;
        const x = Math.min(drag.startCanvas.x, cp.x);
        const y = Math.min(drag.startCanvas.y, cp.y);
        const w = Math.abs(cp.x - drag.startCanvas.x);
        const h = Math.abs(cp.y - drag.startCanvas.y);
        setMarqueeRect({ x, y, w, h });
        return;
      }

      if (drag.kind === "move") {
        // 변형 플라이아웃이 열린 동안에는 캔버스 이동을 *완전히* 막고, 드래그를
        // "참조로 가져오기" 제스처로만 쓴다. 카드는 원위치 고정 + 커서를 따라가는
        // carry 고스트를 띄워, 단순히 끌어와 참조에 넣는 느낌을 준다.
        if (variationFlyoutOpen && onInjectToVariation) {
          const frozenItems = { ...state.layout.items };
          for (const [id, start] of Object.entries(drag.startTransforms)) {
            frozenItems[id] = { ...start };
          }
          const frozenNotes = state.layout.notes.map((n) => {
            const s = drag.startNotes[n.id];
            return s ? { ...n, x: s.x, y: s.y } : n;
          });
          setSnapGuides([]);
          const ids = Object.keys(drag.startTransforms);
          const first = ids[0] ? itemsById.get(ids[0]) : null;
          setCarryDrag({ label: first?.title ?? "", count: ids.length, x: e.clientX, y: e.clientY });
          dispatch({ type: "transient", layout: { ...state.layout, items: frozenItems, notes: frozenNotes } });
          return;
        }
        const dx = cp.x - drag.startPointer.x;
        const dy = cp.y - drag.startPointer.y;
        // Shift = 축 락 — 더 큰 변위 방향으로 고정
        let axis: "x" | "y" | null = drag.axis;
        if (e.shiftKey) {
          if (axis === null) axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          drag.axis = axis;
        } else {
          drag.axis = null;
          axis = null;
        }
        const useDx = axis === "y" ? 0 : dx;
        const useDy = axis === "x" ? 0 : dy;

        // 1차 이동
        const nextItems = { ...state.layout.items };
        const nextNotes = state.layout.notes.map((n) => {
          const start = drag.startNotes[n.id];
          if (!start) return n;
          return { ...n, x: start.x + useDx, y: start.y + useDy };
        });
        for (const [id, start] of Object.entries(drag.startTransforms)) {
          nextItems[id] = { ...start, x: start.x + useDx, y: start.y + useDy };
        }

        // 스냅 — 선택된 항목들의 합 bbox vs *움직이지 않는 모든 객체* 의 bbox.
        // 노트도 ref 와 같은 자격의 캔버스 객체 — snap 후보에 포함시켜야
        // 사용자가 노트 주위에 이미지를 정렬할 수 있다 (이전 회귀: 노트는
        // 후보에서 빠져 있어 "스냅 안 걸리는 객체" 처럼 보였음).
        // ⚠️ crop 적용된 ref 는 *시각적으로 보이는 영역* (visibleItemAABB) 으로
        // 스냅 후보 / moving bbox 모두 계산. outer box 로 잡히면 사용자가 보는
        // 가장자리와 스냅 가이드가 어긋난다.
        const movingIds = new Set([...Object.keys(drag.startTransforms), ...Object.keys(drag.startNotes)]);
        const otherRects: Rect[] = [];
        for (const [id, tr] of Object.entries(nextItems)) {
          if (!movingIds.has(id) && !tr.hidden) otherRects.push(visibleItemAABB(tr));
        }
        for (const n of nextNotes) {
          if (!movingIds.has(n.id)) {
            otherRects.push({ x: n.x, y: n.y, w: n.width, h: getNoteHeight(n) });
          }
        }
        const movingRects: Rect[] = [];
        for (const id of Object.keys(drag.startTransforms)) {
          if (nextItems[id]) movingRects.push(visibleItemAABB(nextItems[id]));
        }
        for (const n of nextNotes) {
          if (movingIds.has(n.id))
            movingRects.push({ x: n.x, y: n.y, w: n.width, h: getNoteHeight(n) });
        }
        const movingBBox = unionBBox(movingRects);
        let snapDx = 0;
        let snapDy = 0;
        if (movingBBox) {
          const snap = computeSnap(movingBBox, otherRects, 6 / camera.scale);
          snapDx = snap.dx;
          snapDy = snap.dy;
          setSnapGuides(snap.guides);
          // 배경 그리드가 켜져 있으면 *항상* 가장 가까운 grid 라인으로 quantize.
          // 객체 스냅 결과가 0 인 축에서만 적용 → 두 시스템 충돌 없이 공존
          // (다른 카드 가장자리에 정확히 맞물리는 동안엔 grid 가 끼어들지 X).
          // threshold 를 Infinity 로 둬 거리에 관계없이 매 프레임 가장 가까운
          // grid 칸으로 박힌다 — PureRef / Figma 의 "Snap to Grid" 표준 동작.
          // (Alt 는 이미 pan 단축키라 grid snap 해제 modifier 로 재사용 불가 →
          // 일시 해제하려면 그리드 자체를 토글한다.)
          if (state.layout.showGrid) {
            const gs = state.layout.gridSize ?? 32;
            const gSnap = computeGridSnap(movingBBox, gs, Infinity);
            // 객체 스냅이 *유의미한 값* 일 때만 grid 를 양보. 부동소수점 노이즈
            // (e.g. 0.0001)는 0 으로 취급 — 그렇지 않으면 객체 스냅이 사실상
            // 작동 안 하는 상황에서도 grid 가 못 끼어드는 회귀가 생긴다.
            if (Math.abs(snapDx) < 0.5) snapDx = gSnap.dx;
            if (Math.abs(snapDy) < 0.5) snapDy = gSnap.dy;
          }
        }
        if (snapDx !== 0 || snapDy !== 0) {
          for (const id of Object.keys(drag.startTransforms)) {
            const cur = nextItems[id];
            if (cur) nextItems[id] = { ...cur, x: cur.x + snapDx, y: cur.y + snapDy };
          }
          for (let i = 0; i < nextNotes.length; i += 1) {
            if (movingIds.has(nextNotes[i].id)) {
              nextNotes[i] = { ...nextNotes[i], x: nextNotes[i].x + snapDx, y: nextNotes[i].y + snapDy };
            }
          }
        }
        // 함께 선택된 gen 노드도 동일 변위(+스냅)로 이동. 스냅 bbox 계산에는
        // 포함하지 않아(노드는 snap 후보 아님) 선택 전체가 같은 양만큼 강체 이동.
        const genKeys = Object.keys(drag.startGenNodes);
        const nextGenNodes =
          genKeys.length > 0
            ? (state.layout.genNodes ?? []).map((g) => {
                const start = drag.startGenNodes[g.id];
                if (!start) return g;
                return { ...g, x: start.x + useDx + snapDx, y: start.y + useDy + snapDy };
              })
            : state.layout.genNodes;
        dispatch({
          type: "transient",
          layout: { ...state.layout, items: nextItems, notes: nextNotes, genNodes: nextGenNodes },
        });
        return;
      }

      if (drag.kind === "resize") {
        // Default: 비율 유지(uniform). Shift 누르면 자유 변형. PureRef 와 반대
        // 라 직관적 — *원본 비율을 깨려면* 명시적 액션 필요.
        const uniform = !e.shiftKey;
        // 노트는 height 가 컨텐츠로 자동 결정 → resize 의 *수직 성분* 은 의미 없음.
        // 모서리 핸들을 잡아도 좌우 (e/w) 만 적용해 y 좌표가 움직이지 않도록 한다.
        const effectiveHandle: HandleId = drag.isNote
          ? (drag.handle === "nw" || drag.handle === "sw" || drag.handle === "w"
              ? "w"
              : drag.handle === "ne" || drag.handle === "se" || drag.handle === "e"
                ? "e"
                : drag.handle)
          : drag.handle;
        // 노트는 uniform off — 폰트는 별도 조작 UI 가 있고, 폭만 자유롭게 늘려도
        // 컨텐츠 reflow 로 자연스럽게 처리됨.
        const useUniform = drag.isNote ? false : uniform;
        let next = resizeByHandle(drag.startTransform, drag.startPointer, cp, effectiveHandle, useUniform);
        // 배경 그리드 ON + 회전 0° 일 때만 *움직이는 엣지* 를 그리드로 스냅.
        // 회전된 객체는 world grid 와 local 엣지가 어긋나 스냅 의미 모호 → skip.
        if (state.layout.showGrid && drag.startTransform.rotation === 0) {
          const gs = state.layout.gridSize ?? 32;
          const cfg = HANDLES[effectiveHandle];
          // 핸들에 따라 어느 엣지가 움직이는지 결정.
          // hx=+1: right edge | hx=-1: left edge | hy=+1: bottom | hy=-1: top
          if (cfg.hx === 1) {
            const right = next.x + next.w;
            const sR = Math.round(right / gs) * gs;
            const dw = sR - right;
            next = { ...next, w: Math.max(24, next.w + dw) };
          } else if (cfg.hx === -1) {
            const sL = Math.round(next.x / gs) * gs;
            const dx = sL - next.x;
            next = { ...next, x: next.x + dx, w: Math.max(24, next.w - dx) };
          }
          if (cfg.hy === 1) {
            const bottom = next.y + next.h;
            const sB = Math.round(bottom / gs) * gs;
            const dh = sB - bottom;
            next = { ...next, h: Math.max(24, next.h + dh) };
          } else if (cfg.hy === -1) {
            const sT = Math.round(next.y / gs) * gs;
            const dy = sT - next.y;
            next = { ...next, y: next.y + dy, h: Math.max(24, next.h - dy) };
          }
          // 코너 + uniform 케이스: 두 엣지 모두 grid 로 갔지만 비율이 깨질 수
          // 있음. 더 작은 dim 을 기준으로 비율 재정렬해 시각 안정성 확보.
          if (uniform && cfg.hx !== 0 && cfg.hy !== 0) {
            const ratio = drag.startTransform.w / Math.max(1, drag.startTransform.h);
            const expectedH = next.w / ratio;
            // height 가 grid-aligned 라면 그대로, 아니면 width 기준으로 재계산.
            // 코너 핸들의 anchor 측 (cfg.ax / cfg.ay) 을 고정한 채 dim 만 보정.
            const dh = expectedH - next.h;
            if (cfg.hy === -1) next = { ...next, y: next.y - dh, h: expectedH };
            else next = { ...next, h: expectedH };
          }
        }
        if (drag.isNote) {
          const nextNotes = state.layout.notes.map((n) =>
            n.id === drag.targetId ? { ...n, x: next.x, y: next.y, width: next.w } : n,
          );
          dispatch({ type: "transient", layout: { ...state.layout, notes: nextNotes } });
        } else {
          dispatch({
            type: "transient",
            layout: { ...state.layout, items: { ...state.layout.items, [drag.targetId]: next } },
          });
        }
        return;
      }

      if (drag.kind === "rotate") {
        const next = rotateByHandle(drag.startTransform, drag.startPointer, cp, e.shiftKey);
        if (drag.isNote) {
          const nextNotes = state.layout.notes.map((n) =>
            n.id === drag.targetId ? { ...n, rotation: next.rotation } : n,
          );
          dispatch({ type: "transient", layout: { ...state.layout, notes: nextNotes } });
        } else {
          dispatch({
            type: "transient",
            layout: { ...state.layout, items: { ...state.layout.items, [drag.targetId]: next } },
          });
        }
        return;
      }

      if (drag.kind === "group-scale") {
        // 비율 유지 uniform scale. 코너 핸들은 대각선 거리비, 엣지 핸들은 해당
        // 축 거리비를 그대로 양 축에 동일 적용 → 항상 비율 보존(PureRef parity).
        // flip 방지를 위해 0.05 하한, 폭주 방지를 위해 50 상한.
        const isCorner = drag.handle === "nw" || drag.handle === "ne" || drag.handle === "se" || drag.handle === "sw";
        const isVerticalEdge = drag.handle === "e" || drag.handle === "w";
        const isHorizontalEdge = drag.handle === "n" || drag.handle === "s";
        let s = 1;
        if (isCorner) {
          const startD = Math.hypot(drag.startPointer.x - drag.anchor.x, drag.startPointer.y - drag.anchor.y);
          const curD = Math.hypot(cp.x - drag.anchor.x, cp.y - drag.anchor.y);
          s = startD > 0 ? curD / startD : 1;
        } else if (isVerticalEdge) {
          const sx0 = Math.abs(drag.startPointer.x - drag.anchor.x);
          const sx1 = Math.abs(cp.x - drag.anchor.x);
          s = sx0 > 0 ? sx1 / sx0 : 1;
        } else if (isHorizontalEdge) {
          const sy0 = Math.abs(drag.startPointer.y - drag.anchor.y);
          const sy1 = Math.abs(cp.y - drag.anchor.y);
          s = sy0 > 0 ? sy1 / sy0 : 1;
        }
        s = Math.max(0.05, Math.min(50, s));

        const scalePoint = (px: number, py: number): Point => ({
          x: drag.anchor.x + (px - drag.anchor.x) * s,
          y: drag.anchor.y + (py - drag.anchor.y) * s,
        });

        const nextItems = { ...state.layout.items };
        for (const [id, start] of Object.entries(drag.startItems)) {
          const cx0 = start.x + start.w / 2;
          const cy0 = start.y + start.h / 2;
          const nc = scalePoint(cx0, cy0);
          const nW = Math.max(8, start.w * s);
          const nH = Math.max(8, start.h * s);
          nextItems[id] = {
            ...start,
            x: nc.x - nW / 2,
            y: nc.y - nH / 2,
            w: nW,
            h: nH,
          };
        }
        const nextNotes = state.layout.notes.map((n) => {
          const start = drag.startNotes[n.id];
          if (!start) return n;
          // 노트는 측정 height 가 fontSize · width 로 결정되므로, x/y 변환에는
          // 시작 시점 height (현재 측정값)를 사용해 중심을 잡는다. 그 후 width /
          // fontSize 를 비례 갱신하면 wrapping 이 자연스럽게 따라간다.
          const hAtStart = noteHeightsRef.current.get(n.id) ?? Math.max(20, start.fontSize * 1.2 + 8);
          const cx0 = start.x + start.width / 2;
          const cy0 = start.y + hAtStart / 2;
          const nc = scalePoint(cx0, cy0);
          const nW = Math.max(40, start.width * s);
          const nFs = Math.max(8, start.fontSize * s);
          // 새 height 는 컨텐츠로 자동이지만, 중심 정합 위해 *추정* 높이로 y 잡음.
          // ResizeObserver 가 다음 프레임에 실측 → 정확히 보정.
          const nHEst = Math.max(28, nFs * 1.3 + 8);
          return {
            ...n,
            x: nc.x - nW / 2,
            y: nc.y - nHEst / 2,
            width: nW,
            fontSize: nFs,
          };
        });
        dispatch({ type: "transient", layout: { ...state.layout, items: nextItems, notes: nextNotes } });
      }
    },
    [camera.scale, cursorCanvas, getVp, itemsById, onInjectToVariation, variationFlyoutOpen, state.layout],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = { kind: "idle" };
      setSnapGuides([]);
      setCarryDrag(null);
      if (drag.kind === "idle") return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 일부 브라우저에서 capture 가 자동 해제될 수 있음 — 무시 */
      }

      if (drag.kind === "marquee") {
        const r = marqueeRect;
        setMarqueeRect(null);
        if (!r || (r.w < 2 && r.h < 2)) return; // 미세한 클릭은 무시
        const hitItems: string[] = [];
        for (const [id, tr] of Object.entries(state.layout.items)) {
          // hidden 항목은 마퀴에도 안 잡힘 — 보이지 않는 것을 선택해 의문을
          // 일으키는 동작 차단. show-all 후 다시 선택 가능.
          if (tr.hidden) continue;
          const a = itemAABB(tr);
          // AABB 교차로 판정 — 회전된 항목도 적절히 잡힘
          if (!(a.x + a.w < r.x || r.x + r.w < a.x || a.y + a.h < r.y || r.y + r.h < a.y)) {
            hitItems.push(id);
          }
        }
        // 노트도 마퀴에 잡힘 — 이전엔 ref 만 잡혀서 노트만 모인 영역에선
        // 마퀴가 아무 것도 선택 못 했다. AABB 는 노트의 *실측* 시각 박스
        // (width × getNoteHeight) 사용 — 회전은 무시(안정성 우선).
        const hitNoteIds: string[] = [];
        for (const note of state.layout.notes) {
          const noteH = getNoteHeight(note);
          const a: Rect = { x: note.x, y: note.y, w: note.width, h: noteH };
          if (!(a.x + a.w < r.x || r.x + r.w < a.x || a.y + a.h < r.y || r.y + r.h < a.y)) {
            hitNoteIds.push(note.id);
          }
        }
        // gen 노드도 마퀴에 잡힘 — x/y/w/h 가 곧 캔버스 좌표계 박스라 그대로 AABB.
        const hitGenIds: string[] = [];
        for (const g of state.layout.genNodes ?? []) {
          if (g.hidden) continue;
          const a: Rect = { x: g.x, y: g.y, w: g.w, h: g.h };
          if (!(a.x + a.w < r.x || r.x + r.w < a.x || a.y + a.h < r.y || r.y + r.h < a.y)) {
            hitGenIds.push(g.id);
          }
        }
        onMarqueeSelect(hitItems, drag.mode);
        setSelectedNoteIds((prev) => {
          // marquee mode 가 "add" (Shift) 면 누적, "replace" 면 새로 갈아끼움.
          // pointerdown 의 빈 공간 분기에서 이미 한 번 비웠지만, replace 분기
          // 에서도 동일하게 동작하도록 mode 별로 처리.
          const base = drag.mode === "add" ? new Set(prev) : new Set<string>();
          for (const id of hitNoteIds) base.add(id);
          return base;
        });
        setSelectedGenIds((prev) => {
          const base = drag.mode === "add" ? new Set(prev) : new Set<string>();
          for (const id of hitGenIds) base.add(id);
          return base;
        });
        return;
      }

      // 노트 단일-탭 처리 — 거의 안 움직였으면 *선택만 유지*. 편집 모드는
      // 더블클릭 전용으로 분리 (캔버스 앱 표준 패턴 — Figma / PureRef 동일).
      // 단일 클릭으로 곧장 편집에 들어가면 드래그-이동 의도까지 텍스트 selection
      // 으로 흡수돼 노트를 옮기기 어려웠다.
      if (drag.kind === "move" && noteTapIntentRef.current) {
        const intent = noteTapIntentRef.current;
        noteTapIntentRef.current = null;
        const dx = e.clientX - intent.screen.x;
        const dy = e.clientY - intent.screen.y;
        // 4px 화면 임계 — 자연스러운 클릭 마이크로 jitter 는 흡수하되 실제
        // 드래그 의도(>4px)는 통과시킨다. 휠 zoom 무관(screen 좌표).
        if (Math.hypot(dx, dy) < 4) {
          // pointerdown 의 commit 으로 push 된 *변화 없는* 스냅샷을 정리 — undo
          // 가 무의미한 스텝을 갖지 않도록. 어차피 transient 가 일어나지 않아
          // layout 자체엔 변화 없음.
          dragRef.current = { kind: "idle" };
          dispatch({ type: "undo" });
          // 그룹에 속한 노트면 그룹 전체 선택을 유지(단일 노트로 collapse 하면
          // pointerdown 에서 잡은 그룹 선택이 풀려버린다). 아니면 그 노트만.
          const tapped = state.layout.notes.find((n) => n.id === intent.id);
          const { itemIds, noteIds } = collectGroupMembers(tapped?.groupId);
          if (noteIds.length > 0 || itemIds.length > 0) {
            onMarqueeSelect(itemIds, "replace");
            setSelectedNoteIds(new Set(noteIds));
          } else {
            onMarqueeSelect([], "replace");
            setSelectedNoteIds(new Set([intent.id]));
          }
          // 편집 모드는 진입하지 않는다 — 더블클릭이 담당.
          return;
        }
      }
      // 탭 의도가 살아 있었지만 위 분기에 안 잡혔다면 (=다른 drag.kind) 정리.
      noteTapIntentRef.current = null;

      // 변형 플라이아웃 참조 드롭존 위에서 release → 이동 대신 참조 주입.
      // 드래그 중인 카드가 커서를 따라와 플라이아웃 위에 겹쳐 그려질 수 있으므로
      // elementFromPoint(최상단 1개)가 아니라 elementsFromPoint(그 점의 모든 요소)
      // 를 훑어 드롭존을 찾는다.
      if (drag.kind === "move" && variationFlyoutOpen && onInjectToVariation) {
        const overInject = document
          .elementsFromPoint(e.clientX, e.clientY)
          .some((el) => el.closest?.("[data-drop-variation-inject]") != null);
        if (overInject) {
          const ids = Object.keys(drag.startTransforms);
          if (ids.length > 0) {
            onInjectToVariation(ids);
            // 드래그 중 이미 원위치로 고정(handlePointerMove)했으므로 추가 undo 불필요.
            // 혹시 남아 있을 transient 를 정리하기 위해 시작 스냅샷으로 되돌린다.
            dispatch({ type: "undo" });
            return;
          }
        }
      }

      if (
        drag.kind === "move" ||
        drag.kind === "resize" ||
        drag.kind === "rotate" ||
        drag.kind === "group-scale"
      ) {
        // transient 결과를 *영구화 + save effect 트리거* 만 하기 위한 dispatch.
        // past 푸시는 *이미 pointerdown 시점 commit* 으로 끝났으므로 여기서
        // 다시 push 하면 안 된다. 과거 commit:true 였을 때는 같은 제스처가
        // past 에 두 스냅샷(L0 = pre-drag, L1 = post-drag)을 만들었고, 첫 undo
        // 가 L1→L1 로 사용자가 보기엔 "한 번 눌렀는데 동작 안 함" 회귀가 났다.
        // commit:false 면 past 는 보존되고 version 만 증가해 save effect 가
        // localStorage 에 정상 반영된다. future 도 pointerdown 의 commit 액션이
        // 이미 비웠으므로 일관.
        dispatch({ type: "set", layout: state.layout, commit: false });
      }
    },
    [collectGroupMembers, marqueeRect, onInjectToVariation, variationFlyoutOpen, onMarqueeSelect, state.layout],
  );

  // pan 시 capture 가 안 잡히는 경우 대비 — viewport 위에서 pointerleave 시 cleanup
  useEffect(() => {
    const onUp = () => {
      if (dragRef.current.kind !== "idle") {
        dragRef.current = { kind: "idle" };
        setSnapGuides([]);
        setMarqueeRect(null);
      }
      setCarryDrag(null);
      // 탭 의도도 함께 정리 — 정상 pointerup 이 아닌 시스템 cancel 에서 의도가
      // 살아남으면 다음 클릭이 의도치 않게 편집 모드로 가버린다.
      noteTapIntentRef.current = null;
    };
    window.addEventListener("pointercancel", onUp);
    return () => window.removeEventListener("pointercancel", onUp);
  }, []);

  /* ────────────────────────────────────────────────────────
   * Transform 핸들 onPointerDown (resize / rotate)
   * ──────────────────────────────────────────────────────── */

  const startResize = useCallback(
    (e: ReactPointerEvent, targetId: string, isNote: boolean, handle: HandleId) => {
      e.stopPropagation();
      e.preventDefault();
      const cp = cursorCanvas(e);
      if (!cp) return;
      const start = isNote
        ? (() => {
            const n = state.layout.notes.find((x) => x.id === targetId);
            if (!n) return null;
            return {
              x: n.x,
              y: n.y,
              w: n.width,
              h: getNoteHeight(n),
              rotation: n.rotation,
              zIndex: n.zIndex,
            } as CanvasItemTransform;
          })()
        : state.layout.items[targetId];
      if (!start || start.locked) return;
      dispatch({ type: "commit" });
      dragRef.current = { kind: "resize", targetId, isNote, handle, startPointer: cp, startTransform: { ...start } };
      // 캔버스 viewport 가 capture 를 받게 — 핸들 자체에 capture 걸면 viewport 가 못 받음
      const vp = viewportRef.current;
      vp?.setPointerCapture?.(e.pointerId);
    },
    [cursorCanvas, state.layout.items, state.layout.notes],
  );

  const startRotate = useCallback(
    (e: ReactPointerEvent, targetId: string, isNote: boolean) => {
      e.stopPropagation();
      e.preventDefault();
      const cp = cursorCanvas(e);
      if (!cp) return;
      const start = isNote
        ? (() => {
            const n = state.layout.notes.find((x) => x.id === targetId);
            if (!n) return null;
            return {
              x: n.x,
              y: n.y,
              w: n.width,
              h: getNoteHeight(n),
              rotation: n.rotation,
              zIndex: n.zIndex,
            } as CanvasItemTransform;
          })()
        : state.layout.items[targetId];
      if (!start || start.locked) return;
      dispatch({ type: "commit" });
      dragRef.current = { kind: "rotate", targetId, isNote, startPointer: cp, startTransform: { ...start } };
      const vp = viewportRef.current;
      vp?.setPointerCapture?.(e.pointerId);
    },
    [cursorCanvas, state.layout.items, state.layout.notes],
  );

  /** 다중 선택 union bbox 의 핸들 드래그 — 비율 유지 uniform group-scale.
   *
   *  - anchor 는 핸들 반대편 점(코너 핸들은 대각, 엣지 핸들은 반대편 엣지
   *    중앙)으로 drag 동안 고정. 모든 대상 항목은 anchor 기준 *uniform* 비례
   *    변환 — 가로/세로 비율이 깨지지 않는다 (PureRef parity).
   *  - locked 항목은 대상에서 제외하되 union bbox 계산에는 그대로 포함 — 잠금
   *    레이어가 끼어 있어도 그 자리는 고정이고 나머지만 스케일된다.
   *  - 노트는 width 와 fontSize 를 비례 갱신 (height 는 컨텐츠로 자동). 너무
   *    작은 fontSize 는 가독성 한계로 8px 하한.
   *  - drag 시작 직전에 `commit` 으로 pre-scale 스냅샷을 past 에 push →
   *    drag 중 transient → pointerup commit:false 로 영구화 (drag 일반 흐름과
   *    동일, undo 한 번에 원복). */
  const startGroupScale = useCallback(
    (e: ReactPointerEvent, handle: HandleId, bbox: Rect) => {
      e.stopPropagation();
      e.preventDefault();
      const cp = cursorCanvas(e);
      if (!cp) return;
      // 핸들 → anchor(반대편) 점 매핑.
      const anchorMap: Record<HandleId, Point> = {
        nw: { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
        n: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h },
        ne: { x: bbox.x, y: bbox.y + bbox.h },
        e: { x: bbox.x, y: bbox.y + bbox.h / 2 },
        se: { x: bbox.x, y: bbox.y },
        s: { x: bbox.x + bbox.w / 2, y: bbox.y },
        sw: { x: bbox.x + bbox.w, y: bbox.y },
        w: { x: bbox.x + bbox.w, y: bbox.y + bbox.h / 2 },
      };
      const anchor = anchorMap[handle];
      // 스냅샷 — locked 제외. selectionTransforms 는 이미 ref + 노트 모두 포함.
      const startItems: Record<string, CanvasItemTransform> = {};
      const startNotes: Record<string, { x: number; y: number; width: number; fontSize: number; rotation: number }> = {};
      for (const tg of selectionTransforms) {
        if (tg.isNote) {
          const n = state.layout.notes.find((x) => x.id === tg.id);
          if (!n) continue;
          startNotes[tg.id] = { x: n.x, y: n.y, width: n.width, fontSize: n.fontSize, rotation: n.rotation };
        } else {
          const cur = state.layout.items[tg.id];
          if (!cur || cur.locked) continue;
          startItems[tg.id] = { ...cur };
        }
      }
      if (Object.keys(startItems).length === 0 && Object.keys(startNotes).length === 0) return;
      dispatch({ type: "commit" });
      dragRef.current = {
        kind: "group-scale",
        handle,
        anchor,
        startPointer: cp,
        startItems,
        startNotes,
      };
      const vp = viewportRef.current;
      vp?.setPointerCapture?.(e.pointerId);
    },
    [cursorCanvas, selectionTransforms, state.layout.items, state.layout.notes],
  );

  /* ────────────────────────────────────────────────────────
   * Actions — flip / z-order / lock / align / distribute / notes / undo
   * ──────────────────────────────────────────────────────── */

  const mutateSelectedItems = useCallback(
    (mut: (t: CanvasItemTransform) => CanvasItemTransform) => {
      if (selectedIds.size === 0) return;
      const items = { ...state.layout.items };
      let changed = false;
      for (const id of selectedIds) {
        const cur = items[id];
        if (!cur || cur.locked) continue;
        const next = mut(cur);
        if (next !== cur) {
          items[id] = next;
          changed = true;
        }
      }
      if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
    },
    [selectedIds, state.layout],
  );

  const flipH = useCallback(() => mutateSelectedItems((t) => ({ ...t, flipH: !t.flipH })), [mutateSelectedItems]);
  const flipV = useCallback(() => mutateSelectedItems((t) => ({ ...t, flipV: !t.flipV })), [mutateSelectedItems]);

  const bringToFront = useCallback(() => {
    if (selectedIds.size === 0) return;
    const items = { ...state.layout.items };
    let z = state.layout.nextZ;
    let changed = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur) continue;
      items[id] = { ...cur, zIndex: z };
      z += 1;
      changed = true;
    }
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items, nextZ: z } });
  }, [selectedIds, state.layout]);

  const sendToBack = useCallback(() => {
    if (selectedIds.size === 0) return;
    const items = { ...state.layout.items };
    // 가장 작은 zIndex 아래로 — 음수도 허용. 단순화 위해 현존 최소 - 1 부터 cascade.
    let minZ = Infinity;
    for (const v of Object.values(items)) minZ = Math.min(minZ, v.zIndex);
    let z = Number.isFinite(minZ) ? minZ - selectedIds.size : -1;
    let changed = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur) continue;
      items[id] = { ...cur, zIndex: z };
      z += 1;
      changed = true;
    }
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [selectedIds, state.layout]);

  const toggleLock = useCallback(() => {
    if (selectedIds.size === 0) return;
    const items = { ...state.layout.items };
    // 하나라도 잠겨 있지 않으면 모두 잠금. 모두 잠겼으면 모두 해제.
    let anyUnlocked = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (cur && !cur.locked) {
        anyUnlocked = true;
        break;
      }
    }
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur) continue;
      items[id] = { ...cur, locked: anyUnlocked };
    }
    dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [selectedIds, state.layout]);

  type AlignKind = "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter";
  const alignSelection = useCallback(
    (kind: AlignKind) => {
      const targets = selectionTransforms;
      if (targets.length < 2) return;
      // visibleItemAABB 사용 — crop 적용된 ref 는 보이는 영역의 가장자리 기준으로
      // 정렬해야 시각적으로 맞아 보인다. (이전 itemAABB 는 outer box 기준이라
      // crop 된 ref 가 다른 ref 와 어긋나 보였음.)
      const ref = unionBBox(targets.map((tg) => visibleItemAABB(tg.t)));
      if (!ref) return;
      const items = { ...state.layout.items };
      const notes = [...state.layout.notes];
      for (const tg of targets) {
        const a = visibleItemAABB(tg.t);
        let dx = 0, dy = 0;
        switch (kind) {
          case "left": dx = ref.x - a.x; break;
          case "right": dx = ref.x + ref.w - (a.x + a.w); break;
          case "top": dy = ref.y - a.y; break;
          case "bottom": dy = ref.y + ref.h - (a.y + a.h); break;
          case "hcenter": dx = ref.x + ref.w / 2 - (a.x + a.w / 2); break;
          case "vcenter": dy = ref.y + ref.h / 2 - (a.y + a.h / 2); break;
        }
        if (tg.isNote) {
          const idx = notes.findIndex((n) => n.id === tg.id);
          if (idx >= 0) notes[idx] = { ...notes[idx], x: notes[idx].x + dx, y: notes[idx].y + dy };
        } else {
          const cur = items[tg.id];
          if (cur) items[tg.id] = { ...cur, x: cur.x + dx, y: cur.y + dy };
        }
      }
      dispatch({ type: "set", layout: { ...state.layout, items, notes } });
    },
    [selectionTransforms, state.layout],
  );

  const distributeSelection = useCallback(
    (axis: "h" | "v") => {
      const targets = selectionTransforms;
      if (targets.length < 3) return;
      // visible center 기반 — crop 적용된 ref 는 outer center 가 시각 중심과
      // 다르므로 visibleItemAABB.center 를 정렬 키로 사용해야 자연.
      const visCenter = (tg: typeof targets[number]): { x: number; y: number } => {
        const a = visibleItemAABB(tg.t);
        return { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      };
      const sorted = [...targets].sort((a, b) =>
        axis === "h" ? visCenter(a).x - visCenter(b).x : visCenter(a).y - visCenter(b).y,
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const firstCenter = axis === "h" ? visCenter(first).x : visCenter(first).y;
      const lastCenter = axis === "h" ? visCenter(last).x : visCenter(last).y;
      const span = lastCenter - firstCenter;
      const step = span / (sorted.length - 1);
      const items = { ...state.layout.items };
      const notes = [...state.layout.notes];
      for (let i = 1; i < sorted.length - 1; i += 1) {
        const tg = sorted[i];
        const targetCenter = firstCenter + step * i;
        const curCenter = axis === "h" ? visCenter(tg).x : visCenter(tg).y;
        const delta = targetCenter - curCenter;
        if (tg.isNote) {
          const idx = notes.findIndex((n) => n.id === tg.id);
          if (idx >= 0) {
            notes[idx] = axis === "h"
              ? { ...notes[idx], x: notes[idx].x + delta }
              : { ...notes[idx], y: notes[idx].y + delta };
          }
        } else {
          const cur = items[tg.id];
          if (cur) {
            items[tg.id] = axis === "h" ? { ...cur, x: cur.x + delta } : { ...cur, y: cur.y + delta };
          }
        }
      }
      dispatch({ type: "set", layout: { ...state.layout, items, notes } });
    },
    [selectionTransforms, state.layout],
  );

  /** 선택된 항목(ref + 노트) 을 PureRef Optimize 스타일로 빈틈없이 재배치.
   *
   *  v1 은 모든 항목을 *uniform 정사각 셀* 에 contain-fit 했다 → 비율이 다른
   *  항목은 셀 안에 가운데 떠 있어 "왜 중앙에 작게 놓였지" 라는 인상을 줬다.
   *  PureRef Ctrl+P 는 *원본 크기를 보존* 하면서 가변 행 높이의 shelf-pack
   *  으로 채우기 때문에 비율이 살아 있고 행 라인이 빈틈없이 떨어진다.
   *
   *  알고리즘:
   *    1) 대상 = 선택된 ref(locked 제외) + 선택된 노트.
   *    2) 각 항목의 AABB(회전 포함) 로 packing — 시각 박스 기준 정확히 맞물림.
   *    3) 높이 내림차순 정렬 → 같은 행에 비슷한 키 항목이 모여 깔끔.
   *    4) Shelf-pack — targetRowWidth(≈ √totalArea·1.3) 를 넘기 전까지 한
   *       행에 좌→우로 채우고, 넘으면 새 행. 각 행 높이 = 그 행 최대 항목 높이.
   *    5) 행 안에서 세로 중앙 정렬 — 키 차이가 큰 항목도 시각적으로 안정.
   *    6) 격자 중심을 현재 selection 중심으로 보정 → 시각이 같은 자리에 머무름.
   *
   *  노트는 width 만 고정이고 height 는 컨텐츠로 결정되므로 위치(x, y) 만
   *  옮기고 폭/높이는 손대지 않는다. zIndex 는 단조 증가로 tile 순서 유지.
   *
   *  단축키: `T` (기존) + `Ctrl/Cmd+P` (PureRef parity). */
  const tileSelection = useCallback(() => {
    const sel: Array<{ id: string; isNote: boolean; isGen?: boolean; t: CanvasItemTransform }> = [];
    for (const id of selectedIds) {
      const tr = state.layout.items[id];
      if (tr && !tr.locked) sel.push({ id, isNote: false, t: tr });
    }
    for (const note of state.layout.notes) {
      if (selectedNoteIds.has(note.id)) {
        sel.push({
          id: note.id,
          isNote: true,
          t: {
            x: note.x,
            y: note.y,
            w: note.width,
            h: getNoteHeight(note),
            rotation: note.rotation,
            zIndex: note.zIndex,
          },
        });
      }
    }
    // 선택된 gen 노드도 정렬 대상. 회전 없는 박스라 x/y/w/h 를 그대로 transform 으로.
    for (const g of state.layout.genNodes ?? []) {
      if (selectedGenIds.has(g.id) && !g.locked) {
        sel.push({
          id: g.id,
          isNote: false,
          isGen: true,
          t: { x: g.x, y: g.y, w: g.w, h: g.h, rotation: 0, zIndex: g.zIndex },
        });
      }
    }
    if (sel.length < 2) return;

    const gap = 24;
    // visible 영역 기준 packing — crop 된 ref 는 보이는 크기로 셀에 들어감.
    const aabbs = sel.map((s) => visibleItemAABB(s.t));
    const totalArea = aabbs.reduce((sum, r) => sum + r.w * r.h, 0);
    const widestItem = aabbs.reduce((mx, r) => (r.w > mx ? r.w : mx), 0);
    // targetRowWidth = √totalArea · 1.3 ≈ 가로가 약간 긴 비율. 가장 넓은
    // 항목보다는 작아질 수 없도록 max 로 보정 — 그렇지 않으면 첫 항목이
    // 단독 행으로 밀려나 row 수가 폭발한다.
    const targetRowWidth = Math.max(widestItem, Math.sqrt(Math.max(totalArea, 1)) * 1.3);

    // 정렬 인덱스 — 높이 내림차순. 동률은 폭 내림차순 보조 키.
    const order = sel.map((_, i) => i).sort((a, b) => {
      const dh = aabbs[b].h - aabbs[a].h;
      return dh !== 0 ? dh : aabbs[b].w - aabbs[a].w;
    });

    interface Row { idxs: number[]; rowW: number; rowH: number }
    const rows: Row[] = [];
    let row: Row = { idxs: [], rowW: 0, rowH: 0 };
    for (const i of order) {
      const w = aabbs[i].w;
      const h = aabbs[i].h;
      const wouldBe = row.idxs.length === 0 ? w : row.rowW + gap + w;
      if (row.idxs.length > 0 && wouldBe > targetRowWidth) {
        rows.push(row);
        row = { idxs: [i], rowW: w, rowH: h };
      } else {
        row.idxs.push(i);
        row.rowW = wouldBe;
        if (h > row.rowH) row.rowH = h;
      }
    }
    if (row.idxs.length > 0) rows.push(row);

    const gridW = rows.reduce((mx, r) => (r.rowW > mx ? r.rowW : mx), 0);
    const gridH = rows.reduce((sum, r) => sum + r.rowH, 0) + gap * Math.max(0, rows.length - 1);
    const sbox = unionBBox(aabbs);
    const sboxCx = sbox ? sbox.x + sbox.w / 2 : 0;
    const sboxCy = sbox ? sbox.y + sbox.h / 2 : 0;
    const anchorX = sboxCx - gridW / 2;
    const anchorY = sboxCy - gridH / 2;

    const items = { ...state.layout.items };
    const notes = [...state.layout.notes];
    const genNodes = [...(state.layout.genNodes ?? [])];
    let zCounter = state.layout.nextZ;

    let cursorY = anchorY;
    for (const r of rows) {
      let cursorX = anchorX;
      for (const i of r.idxs) {
        const s = sel[i];
        const aabb = aabbs[i];
        // 행 내부 *top-align* — 위에서부터 차곡차곡 쌓이는 인상.
        // 중앙 정렬은 키 작은 항목을 행 중앙에 띄워 "왜 중앙에 떴지" 라는
        // 인상을 줬다. top-align 으로 윗변이 한 라인으로 맞물려 PureRef 의
        // "shelf 위에 얹은" 시각 정돈이 더 정확히 재현된다.
        const aabbX = cursorX;
        const aabbY = cursorY;
        // AABB 중심 = item 중심. 회전 시 item.x 는 *unrotated* top-left 이므로
        // (cx - w/2, cy - h/2) 로 환산해야 회전 후 시각 박스가 AABB 와 일치.
        const cx = aabbX + aabb.w / 2;
        const cy = aabbY + aabb.h / 2;
        const itemX = cx - s.t.w / 2;
        const itemY = cy - s.t.h / 2;

        if (s.isGen) {
          const idx = genNodes.findIndex((g) => g.id === s.id);
          // gen 노드는 회전 0 이라 itemX/itemY 가 곧 박스 좌상단. zIndex 갱신.
          if (idx >= 0) genNodes[idx] = { ...genNodes[idx], x: itemX, y: itemY, zIndex: zCounter };
        } else if (s.isNote) {
          const idx = notes.findIndex((n) => n.id === s.id);
          if (idx >= 0) {
            // 노트는 width 고정·height 콘텐츠로 결정. 위치 + zIndex 만 갱신.
            notes[idx] = { ...notes[idx], x: itemX, y: itemY, zIndex: zCounter };
          }
        } else {
          const cur = items[s.id];
          if (cur) {
            items[s.id] = { ...cur, x: itemX, y: itemY, zIndex: zCounter };
          }
        }
        zCounter += 1;
        cursorX += aabb.w + gap;
      }
      cursorY += r.rowH + gap;
    }

    dispatch({
      type: "set",
      layout: { ...state.layout, items, notes, genNodes, nextZ: zCounter },
    });
  }, [selectedIds, selectedNoteIds, selectedGenIds, state.layout, getNoteHeight]);

  /* ────────────────────────────────────────────────────────
   * v2 신규 — 그룹핑 / 숨기기 / 효과 / 그리드 토글 / 클러스터 / Send to Scene
   *
   * 모든 액션은 reducer 의 set/transient 패턴을 그대로 따른다 — 즉 mutator
   * 안에서 새 layout 을 만들어 dispatch 하고, 그러면 undo/redo 와 자동
   * 영구화가 따라온다. selectedIds 는 상위(LibraryPage)가 들고 있고
   * selectedNoteIds 는 로컬 — 두 경로 모두 액션 안에서 갱신 가능.
   * ──────────────────────────────────────────────────────── */

  /** 선택 묶음을 하나의 hard group 으로 묶음. 새 groupId 발급 → 선택된 모든
   *  아이템 transform *과 노트* 에 같은 groupId 를 박는다. 아이템·노트를 섞어
   *  묶을 수 있고, 이미 그룹인 멤버는 새 groupId 로 덮어쓴다. 아이템·노트를
   *  합쳐 2개 이상이어야 그룹이 의미 있다. */
  const groupSelection = useCallback(() => {
    if (selectedIds.size + selectedNoteIds.size < 2) return;
    const newGid = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const items = { ...state.layout.items };
    let changed = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur) continue;
      items[id] = { ...cur, groupId: newGid };
      changed = true;
    }
    const notes = state.layout.notes.map((n) => {
      if (selectedNoteIds.has(n.id)) {
        changed = true;
        return { ...n, groupId: newGid };
      }
      return n;
    });
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items, notes } });
  }, [selectedIds, selectedNoteIds, state.layout]);

  /** 선택 묶음의 groupId 해제. 선택된 아이템·노트가 속한 그룹의 *모든* 멤버
   *  (아이템 + 노트) 에서 풀어 사용자가 의외의 그룹 잔재를 만나지 않게 한다. */
  const ungroupSelection = useCallback(() => {
    if (selectedIds.size === 0 && selectedNoteIds.size === 0) return;
    const items = { ...state.layout.items };
    const affectedGroups = new Set<string>();
    for (const id of selectedIds) {
      const t = items[id];
      if (t?.groupId) affectedGroups.add(t.groupId);
    }
    for (const n of state.layout.notes) {
      if (selectedNoteIds.has(n.id) && n.groupId) affectedGroups.add(n.groupId);
    }
    if (affectedGroups.size === 0) return;
    let changed = false;
    for (const [id, tr] of Object.entries(items)) {
      if (tr.groupId && affectedGroups.has(tr.groupId)) {
        const next = { ...tr };
        delete next.groupId;
        items[id] = next;
        changed = true;
      }
    }
    const notes = state.layout.notes.map((n) => {
      if (n.groupId && affectedGroups.has(n.groupId)) {
        changed = true;
        const next = { ...n };
        delete next.groupId;
        return next;
      }
      return n;
    });
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items, notes } });
  }, [selectedIds, selectedNoteIds, state.layout]);

  /** 선택된 *ref* 의 hidden 토글 — 하나라도 안 숨어 있으면 모두 숨김, 모두
   *  숨겨져 있으면 모두 표시. (선택이 비어 있을 수도 있어 호출자가 분기) */
  const toggleHideSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    const items = { ...state.layout.items };
    let anyVisible = false;
    for (const id of selectedIds) {
      if (items[id] && !items[id].hidden) { anyVisible = true; break; }
    }
    let changed = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur) continue;
      items[id] = { ...cur, hidden: anyVisible };
      changed = true;
    }
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [selectedIds, state.layout]);

  /** "모두 표시" — 폴더 안 모든 ref 의 hidden 해제. */
  const showAllHidden = useCallback(() => {
    const items = { ...state.layout.items };
    let changed = false;
    for (const [id, tr] of Object.entries(items)) {
      if (tr.hidden) {
        const next = { ...tr };
        delete next.hidden;
        items[id] = next;
        changed = true;
      }
    }
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [state.layout]);

  /** 선택된 ref 들의 transform 에 partial 효과 적용 — opacity/grayscale/
   *  invert/borderRadius/borderWidth/shadow. 토글류는 caller 가 reducer
   *  함수로 넘긴다. */
  const applyEffectToSelection = useCallback(
    (mut: (t: CanvasItemTransform) => CanvasItemTransform) => {
      if (selectedIds.size === 0) return;
      const items = { ...state.layout.items };
      let changed = false;
      for (const id of selectedIds) {
        const cur = items[id];
        if (!cur) continue;
        const nxt = mut(cur);
        if (nxt !== cur) {
          items[id] = nxt;
          changed = true;
        }
      }
      if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
    },
    [selectedIds, state.layout],
  );

  /** 선택된 ref 의 rotation 을 절대각(라디안)으로 set — 90/180/270 등 정수
   *  회전. 다중 선택 시 *각자의 중심* 을 유지. */
  const setSelectionRotation = useCallback((radians: number) => {
    if (selectedIds.size === 0) return;
    const items = { ...state.layout.items };
    let changed = false;
    for (const id of selectedIds) {
      const cur = items[id];
      if (!cur || cur.locked) continue;
      if (cur.rotation === radians) continue;
      items[id] = { ...cur, rotation: radians };
      changed = true;
    }
    if (changed) dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [selectedIds, state.layout]);

  /** 배경 그리드 ON/OFF 토글. layout 의 일부라 폴더별 영구화 + undo 가능. */
  const toggleBackgroundGrid = useCallback(() => {
    dispatch({
      type: "set",
      layout: { ...state.layout, showGrid: !state.layout.showGrid },
    });
  }, [state.layout]);

  /** 그리드 칸 크기 변경. 자주 변경되지 않지만 컨텍스트 메뉴에서 16/32/64
   *  프리셋 제공. layout 의 일부라 undo 가능. */
  const setGridSize = useCallback((size: number) => {
    if (!Number.isFinite(size) || size < 8) return;
    if (state.layout.gridSize === size) return;
    dispatch({
      type: "set",
      layout: { ...state.layout, gridSize: size },
    });
  }, [state.layout]);

  /** 캔버스 PNG 내보내기 — 현재 보이는 객체들의 union bbox 영역을
   *  off-screen canvas 에 합성해 PNG 파일로 다운로드.
   *
   *  설계 노트:
   *    - DOM-to-image 라이브러리(html2canvas) 는 cross-origin / video element
   *      / clip-path 에 약함이 있어, 더 단순하게 *원본 file_url* 을 직접 로드해
   *      off-screen canvas 에 그리는 방식을 채택.
   *    - 회전/플립/그레이스케일/인버트/투명도/모서리/그림자/clip-path 까지 모두
   *      반영. video 는 첫 프레임(=poster=thumbnail_url) 으로 캡쳐.
   *    - 노트는 텍스트로 ctx.fillText — 회전/배경/색까지 반영.
   *    - 이미지는 object-cover 로 그려 YouTube 등 비-1:1 썸네일의 종횡비가
   *      DOM 렌더(`object-cover`) 와 일치.
   *    - 노트 패딩(px-2 py-1 = 8/4 px) 을 정확히 맞춰 텍스트와 배경 크기가 시각과 동일.
   *    - connections 도 ConnectionLayer 와 동일 곡률/화살표/점선 스타일로 함께 렌더.
   *    - scope 파라미터: "all" 또는 "selection". "selection" 은 현재 selectedIds +
   *      selectedNoteIds 만 포함, 그 외(연결선 포함) 는 양 끝이 모두 scope 안에
   *      있을 때만 그린다. */
  const exportPng = useCallback(async (scope: "all" | "selection") => {
    // ── 폰트 로드 보장 ── Pretendard 가 CSS 로 로드돼 있어도 canvas API 는 *DOM 에서
    // 이미 그려진* 폰트만 즉시 사용 가능. 처음 export 가 호출되는 시점에 노트가 한
    // 번도 안 떠 있던 케이스에서 canvas 의 ctx.font 가 system-ui 로 fallback 돼
    // metrics 가 달라지는 회귀를 막는다. document.fonts.ready 는 모든 등록 폰트
    // 로드 완료 시 resolve.
    try {
      if (typeof document !== "undefined" && document.fonts?.ready) {
        await document.fonts.ready;
      }
    } catch {
      /* font loading API 미지원 환경 — fallback 폰트 사용 */
    }
    type DrawableItem = {
      kind: "item";
      id: string;
      transform: CanvasItemTransform;
      ref: ReferenceItem;
    };
    type DrawableNote = {
      kind: "note";
      id: string;
      transform: CanvasItemTransform;
      note: CanvasNote;
    };
    type Drawable = DrawableItem | DrawableNote;

    const drawable: Drawable[] = [];
    const itemsById = new Map(items.map((it) => [it.id, it] as const));
    // Scope 필터 — selection 일 때는 선택된 객체만 포함.
    const includeItem = (id: string) =>
      scope === "all" ? true : selectedIds.has(id);
    const includeNote = (id: string) =>
      scope === "all" ? true : selectedNoteIds.has(id);

    for (const [id, tr] of Object.entries(state.layout.items)) {
      if (tr.hidden) continue;
      if (!includeItem(id)) continue;
      const ref = itemsById.get(id);
      if (!ref) continue;
      drawable.push({ kind: "item", id, transform: tr, ref });
    }
    for (const note of state.layout.notes) {
      if (!includeNote(note.id)) continue;
      drawable.push({
        kind: "note",
        id: note.id,
        transform: {
          x: note.x, y: note.y, w: note.width, h: getNoteHeight(note),
          rotation: note.rotation, zIndex: note.zIndex,
        },
        note,
      });
    }
    if (drawable.length === 0) {
      toast({ title: t("library.canvas.export.empty") });
      return;
    }

    // BBox 계산 — 객체 박스만 기준. 연결선은 객체 사이로만 흐르므로
    // 객체 bbox 안에 거의 항상 들어옴 (곡률로 살짝 튀어 나갈 수는 있으나
    // PAD 가 흡수). 별도 padding 보강은 불필요.
    const PAD = 48;
    const rects = drawable.map((d) => itemAABB(d.transform));
    const bbox = unionBBox(rects);
    if (!bbox) return;

    // scope 안에 포함된 객체 id 집합 — 연결선의 양 끝이 모두 안에 있을
    // 때만 그리기 위해 사용.
    const inScopeItemIds = new Set<string>();
    const inScopeNoteIds = new Set<string>();
    for (const d of drawable) {
      if (d.kind === "item") inScopeItemIds.add(d.id);
      else inScopeNoteIds.add(d.id);
    }

    const canvas = document.createElement("canvas");
    const targetW = Math.min(4096, Math.max(64, Math.round(bbox.w + PAD * 2)));
    const targetH = Math.min(4096, Math.max(64, Math.round(bbox.h + PAD * 2)));
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) { toast({ variant: "destructive", title: t("library.canvas.export.failed") }); return; }
    // theme CSS 변수 → 실제 hex 해소. canvas 2d API 는 CSS var 를 직접 못 받아
    // 함수 시작 시 1회 읽어서 hsl() 문자열로 쓴다.
    const cs = getComputedStyle(document.documentElement);
    const themeBgHsl = `hsl(${cs.getPropertyValue("--background").trim()})`;
    // 연결선 기본색 — 중립 회색(라이브 캔버스 ConnectionLine 과 일치).
    const themeMutedHsl = `hsl(${cs.getPropertyValue("--muted-foreground").trim()})`;
    // 캔버스 viewport 와 같은 톤의 dark 배경. PNG 가 OS 다크/라이트 모드 양쪽에서
    // 자연스럽도록 --background 토큰 그대로 (이전엔 #1a1a1a 하드코딩).
    ctx.fillStyle = themeBgHsl;
    ctx.fillRect(0, 0, targetW, targetH);
    // MediaIslandBackground 는 export 에서 그리지 않는다 — DOM 에서는 *상대적
    // 톤차이* 만 만들어 island 처럼 보이지만, export 에서는 항상 가시적인 lighter
    // 박스로 떠 "프레임" 처럼 보이는 회귀. 객체 + 연결선만 dark 배경 위에 그린다.

    // 좌표 변환 헬퍼 — 캔버스 좌표 → 출력 이미지 좌표(bbox 기준 + PAD 오프셋)
    const toOut = (p: Point): Point => ({
      x: p.x - bbox.x + PAD,
      y: p.y - bbox.y + PAD,
    });

    drawable.sort((a, b) => a.transform.zIndex - b.transform.zIndex);

    const loadImage = (src: string): Promise<HTMLImageElement | null> =>
      new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });

    // ── 1) 객체 (items + notes) 그리기 ──
    for (const d of drawable) {
      const tr = d.transform;
      const cx = tr.x + tr.w / 2 - bbox.x + PAD;
      const cy = tr.y + tr.h / 2 - bbox.y + PAD;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tr.rotation);
      if (tr.flipH || tr.flipV) ctx.scale(tr.flipH ? -1 : 1, tr.flipV ? -1 : 1);
      if (typeof tr.opacity === "number") ctx.globalAlpha = Math.max(0, Math.min(1, tr.opacity));
      if (tr.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
      }

      if (d.kind === "item") {
        const src = d.ref.thumbnail_url || d.ref.file_url || "";
        const img = src ? await loadImage(src) : null;
        // 이미지 로딩 실패 / src 없음 → 그 카드는 *그리지 않음* (DOM 의 bg-muted
        // 카드 fallback 을 export 에 옮기면 회색 박스가 의도와 무관하게 떠
        // "내보내기에 회색 영역이 생긴다" 라는 회귀 발생. 비어 있는 게 더 정직).
        if (img) {
          // 1) user crop 적용 — natural 좌표계 기준 source 영역.
          const c = tr.crop;
          const cropL = c ? c.l : 0;
          const cropT = c ? c.t : 0;
          const cropR = c ? c.r : 0;
          const cropB = c ? c.b : 0;
          const sx0 = cropL * img.naturalWidth;
          const sy0 = cropT * img.naturalHeight;
          const sw0 = (1 - cropL - cropR) * img.naturalWidth;
          const sh0 = (1 - cropT - cropB) * img.naturalHeight;
          // 2) object-cover — sw0×sh0 영역을 tr.w×tr.h 박스에 비율 유지하며
          //    꽉 채우고 넘치는 부분은 중앙 기준 crop. DOM 의 `object-cover`
          //    동작과 1:1 일치. (이전엔 자유 stretch 라 YouTube 16:9 가
          //    카드의 다른 비율로 늘어났음.)
          const srcAspect = sw0 / Math.max(1, sh0);
          const dstAspect = tr.w / Math.max(1, tr.h);
          let sx: number, sy: number, sw: number, sh: number;
          if (srcAspect > dstAspect) {
            sh = sh0;
            sw = sh0 * dstAspect;
            sx = sx0 + (sw0 - sw) / 2;
            sy = sy0;
          } else {
            sw = sw0;
            sh = sw0 / dstAspect;
            sx = sx0;
            sy = sy0 + (sh0 - sh) / 2;
          }
          const r = tr.borderRadius ?? 0;
          ctx.save();
          if (r > 0) {
            ctx.beginPath();
            roundedRectPath(ctx, -tr.w / 2, -tr.h / 2, tr.w, tr.h, Math.min(r, tr.w / 2, tr.h / 2));
            ctx.clip();
          }
          try {
            ctx.drawImage(img, sx, sy, Math.max(1, sw), Math.max(1, sh), -tr.w / 2, -tr.h / 2, tr.w, tr.h);
          } catch {
            /* tainted canvas — 무시 */
          }
          ctx.restore();
          if (tr.grayscale || tr.invert) {
            try {
              applyPixelEffectsToRect(ctx, -tr.w / 2, -tr.h / 2, tr.w, tr.h, !!tr.grayscale, !!tr.invert);
            } catch { /* tainted — skip */ }
          }
          if ((tr.borderWidth ?? 0) > 0) {
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = tr.borderWidth ?? 0;
            ctx.strokeRect(-tr.w / 2, -tr.h / 2, tr.w, tr.h);
          }
        }
      } else {
        // 노트 — wrapper 의 Tailwind 클래스: rounded-sm(2px) + px-2 py-1(8/4 px) + shadow-sm.
        // 배경, 텍스트 모두 그 패딩 안에서 그려져 시각과 동일하게.
        const n = d.note;
        const PAD_X = 8;
        const PAD_Y = 4;
        const RADIUS = 2;
        const bgHex = (() => {
          if (!n.bgColor || n.bgColor === "transparent") return null;
          if (n.bgColor in NOTE_BG_HEX) return NOTE_BG_HEX[n.bgColor];
          if (/^#?[0-9a-f]{6}$/i.test(n.bgColor)) {
            return n.bgColor.startsWith("#") ? n.bgColor : `#${n.bgColor}`;
          }
          return null;
        })();
        if (bgHex) {
          ctx.fillStyle = bgHex;
          ctx.beginPath();
          roundedRectPath(ctx, -tr.w / 2, -tr.h / 2, tr.w, tr.h, RADIUS);
          ctx.fill();
        }
        ctx.fillStyle = n.color || "#ffffff";
        const fontWeight = n.bold ? "700" : "400";
        const fontStyle = n.italic ? "italic " : "";
        // font-family 는 wrapper 와 동일 — Pretendard 우선, fallback sans-serif.
        ctx.font = `${fontStyle}${fontWeight} ${n.fontSize}px Pretendard, system-ui, sans-serif`;
        // textBaseline="alphabetic" — CSS 기본값과 동일. baseline 위치를 명시 계산해
        // CSS 의 `line-height: 1.2` 시각 정렬과 정확히 일치시킨다. 이전 "top" 방식은
        // 폰트의 font-bounding-box 가 EM box 보다 약간 위에 있는 케이스에서 글자가
        // 박스 위쪽으로 밀려 하단 여백이 더 커 보였다.
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = n.align ?? "left";
        const innerLeft = -tr.w / 2 + PAD_X;
        const innerRight = tr.w / 2 - PAD_X;
        const innerTop = -tr.h / 2 + PAD_Y;
        const maxW = tr.w - PAD_X * 2;
        const ax =
          n.align === "center"
            ? 0
            : n.align === "right"
              ? innerRight
              : innerLeft;
        // CSS line box 시뮬레이션:
        //   - 한 줄의 box height = fontSize × 1.2
        //   - half-leading = (lineHeight - fontSize) / 2 만큼 box 안쪽 위·아래에 분배
        //   - baseline = line_box_top + half-leading + ascent
        //
        // ascent 는 폰트마다 다르므로 ctx.measureText 의 실측 fontBoundingBoxAscent
        // 사용. (Pretendard 가 canvas 에 로드되지 않은 환경에서는 fallback 폰트의
        // ascent 가 적용돼 시각 차이가 발생할 수 있어, 호출자(`exportPng`) 가
        // `document.fonts.ready` 를 await 한 뒤 진입한다.)
        const lh = n.fontSize * 1.2;
        const halfLeading = (lh - n.fontSize) / 2;
        const metricsProbe = ctx.measureText("Mg가힣");
        // 일부 구형 캔버스 구현은 fontBoundingBoxAscent 가 0 / undefined — 그 때는
        // 표준 sans-serif 추정치(0.83 em) fallback.
        const fontAscent =
          metricsProbe.fontBoundingBoxAscent && metricsProbe.fontBoundingBoxAscent > 0
            ? metricsProbe.fontBoundingBoxAscent
            : n.fontSize * 0.83;
        const tokens = n.text.split(/(\s+)/);
        let line = "";
        // 첫 줄 baseline.
        let yOff = innerTop + halfLeading + fontAscent;
        const flushLine = () => {
          if (line) ctx.fillText(line, ax, yOff);
          yOff += lh;
        };
        for (const tok of tokens) {
          const candidate = line + tok;
          if (ctx.measureText(candidate).width <= maxW) {
            line = candidate;
            continue;
          }
          if (line) {
            ctx.fillText(line, ax, yOff);
            yOff += lh;
            line = tok.trimStart();
          } else {
            // line 비었는데도 단어 1개 가 maxW 초과 — 글자 단위로 잘라 그림.
            let chunk = "";
            for (const ch of tok) {
              if (ctx.measureText(chunk + ch).width > maxW && chunk) {
                ctx.fillText(chunk, ax, yOff);
                yOff += lh;
                chunk = ch;
              } else {
                chunk += ch;
              }
            }
            line = chunk;
          }
        }
        if (line) flushLine();
      }
      ctx.restore();
    }

    // ── 2) 연결선 그리기 ── ConnectionLayer 와 동일 곡률/gap/화살표 정책.
    // 양 끝이 모두 scope 안에 있고 hidden 도 아닐 때만 그린다.
    const allConnections = state.layout.connections ?? [];
    const noteLookup = new Map<string, CanvasItemTransform>();
    for (const n of state.layout.notes) {
      noteLookup.set(n.id, {
        x: n.x, y: n.y, w: n.width, h: getNoteHeight(n),
        rotation: n.rotation, zIndex: n.zIndex,
      });
    }
    const lookupConnTransform = (
      kind: ConnectionNodeKind,
      id: string,
    ): CanvasItemTransform | null => {
      if (kind === "note") {
        if (!inScopeNoteIds.has(id)) return null;
        return noteLookup.get(id) ?? null;
      }
      // gen 노드 끝점은 M2/M4 에서 배선 — 그 전까지 해당 연결은 skip.
      if (kind === "gen") return null;
      if (!inScopeItemIds.has(id)) return null;
      const tr = state.layout.items[id];
      if (!tr || tr.hidden) return null;
      return tr;
    };

    const promptNoteIdsForExport = new Set<string>();
    for (const n of state.layout.notes) if (n.role === "prompt") promptNoteIdsForExport.add(n.id);
    for (const conn of allConnections) {
      const fromT = lookupConnTransform(conn.from.kind, conn.from.id);
      const toT = lookupConnTransform(conn.to.kind, conn.to.id);
      if (!fromT || !toT) continue;
      const toCenter: Point = { x: toT.x + toT.w / 2, y: toT.y + toT.h / 2 };
      const fromCenter: Point = { x: fromT.x + fromT.w / 2, y: fromT.y + fromT.h / 2 };
      // anchor 선택 — ConnectionLayer 와 *동일* 정책. anchorLocked=true 우선,
      // 다음 고정 포트(gen 입·출력 / prompt 출력), 그 외 nearestSlot 자동.
      const fromFixed = fixedPortAnchor(conn.from.kind, conn.linkType, promptNoteIdsForExport.has(conn.from.id));
      const toFixed = fixedPortAnchor(conn.to.kind, conn.linkType, promptNoteIdsForExport.has(conn.to.id));
      const fromAnchor =
        conn.from.anchorLocked && conn.from.anchor
          ? conn.from.anchor
          : fromFixed ?? nearestSlot(fromT, toCenter).anchor;
      const toAnchor =
        conn.to.anchorLocked && conn.to.anchor
          ? conn.to.anchor
          : toFixed ?? nearestSlot(toT, fromCenter).anchor;
      const fromPt = localToCanvas(fromT, fromAnchor);
      const toPt = localToCanvas(toT, toAnchor);
      // gap padding (ConnectionLayer 와 동일).
      const GAP_FROM = 4;
      const GAP_TO = 12;
      const dxv = toPt.x - fromPt.x;
      const dyv = toPt.y - fromPt.y;
      const len = Math.hypot(dxv, dyv);
      let fromAdj = fromPt;
      let toAdj = toPt;
      if (len > GAP_FROM + GAP_TO) {
        const ux = dxv / len;
        const uy = dyv / len;
        fromAdj = { x: fromPt.x + ux * GAP_FROM, y: fromPt.y + uy * GAP_FROM };
        toAdj = { x: toPt.x - ux * GAP_TO, y: toPt.y - uy * GAP_TO };
      }
      // 곡률 — ConnectionLayer 와 *동일* edge-tangent cubic bezier.
      //   - 각 끝점에서 anchor 의 outward normal 방향으로 control point 확장.
      //   - 변에서 라인이 수직으로 빠져나가 객체와 자연 합류.
      //   - ctrlLen = clamp(dist × 0.4, 24, 140). 짧은 거리(<48)는 직선 fallback.
      const dx = toAdj.x - fromAdj.x;
      const dy = toAdj.y - fromAdj.y;
      const dist = Math.hypot(dx, dy);
      const STRAIGHT_THRESHOLD = 48;
      const ctrlLen = Math.max(24, Math.min(140, dist * 0.4));
      const fromNormal = anchorOutwardNormal(fromT, fromAnchor);
      const toNormal = anchorOutwardNormal(toT, toAnchor);
      const ctrl1: Point = {
        x: fromAdj.x + fromNormal.x * ctrlLen,
        y: fromAdj.y + fromNormal.y * ctrlLen,
      };
      const ctrl2: Point = {
        x: toAdj.x + toNormal.x * ctrlLen,
        y: toAdj.y + toNormal.y * ctrlLen,
      };
      const isStraight = dist <= STRAIGHT_THRESHOLD;
      const style = conn.style ?? {};
      const color = style.color ?? themeMutedHsl; // 사용자 미지정 시 중립 회색
      const thickness = style.thickness ?? 2;
      const dashed = style.lineStyle === "dashed";
      const hasStartArrow = style.endStart === "arrow";
      const hasEndArrow = (style.endEnd ?? "arrow") === "arrow";

      const fromOut = toOut(fromAdj);
      const toOutPt = toOut(toAdj);
      const ctrl1Out = toOut(ctrl1);
      const ctrl2Out = toOut(ctrl2);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = thickness;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (dashed) ctx.setLineDash([thickness * 3, thickness * 2.2]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(fromOut.x, fromOut.y);
      if (isStraight) {
        ctx.lineTo(toOutPt.x, toOutPt.y);
      } else {
        ctx.bezierCurveTo(ctrl1Out.x, ctrl1Out.y, ctrl2Out.x, ctrl2Out.y, toOutPt.x, toOutPt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]); // 화살표는 실선

      // 화살표 — 끝점 접선 방향으로 작은 삼각형. cubic bezier 의 끝 접선:
      //   - end: ctrl2 → to 방향
      //   - start: ctrl1 → from 방향
      //   직선 fallback 일 땐 from→to / to→from.
      const arrowSize = Math.max(8, thickness * 4);
      const drawArrowAt = (tip: Point, tangentDX: number, tangentDY: number) => {
        const tlen = Math.hypot(tangentDX, tangentDY);
        if (tlen === 0) return;
        const ux = tangentDX / tlen;
        const uy = tangentDY / tlen;
        const px = -uy;
        const py = ux;
        const baseX = tip.x - ux * arrowSize;
        const baseY = tip.y - uy * arrowSize;
        const halfW = arrowSize * 0.6;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(baseX + px * halfW, baseY + py * halfW);
        ctx.lineTo(baseX - px * halfW, baseY - py * halfW);
        ctx.closePath();
        ctx.fill();
      };
      if (hasEndArrow) {
        const tdx = isStraight ? toOutPt.x - fromOut.x : toOutPt.x - ctrl2Out.x;
        const tdy = isStraight ? toOutPt.y - fromOut.y : toOutPt.y - ctrl2Out.y;
        drawArrowAt(toOutPt, tdx, tdy);
      }
      if (hasStartArrow) {
        const tdx = isStraight ? fromOut.x - toOutPt.x : fromOut.x - ctrl1Out.x;
        const tdy = isStraight ? fromOut.y - toOutPt.y : fromOut.y - ctrl1Out.y;
        drawArrowAt(fromOut, tdx, tdy);
      }
      ctx.restore();
    }

    canvas.toBlob((blob) => {
      if (!blob) { toast({ variant: "destructive", title: t("library.canvas.export.failed") }); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const suffix = scope === "selection" ? "selection" : "canvas";
      a.download = `preflow-${suffix}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast({ title: t("library.canvas.export.done") });
    }, "image/png");
  }, [items, selectedIds, selectedNoteIds, state.layout.items, state.layout.notes, state.layout.connections, getNoteHeight, t, toast]);

  /** 기존 호출처 호환 — 툴바 Download 가 호출하는 wrapper. 항상 전체 캔버스.
   *  선택 영역만 내보내려면 우클릭 메뉴 / Ctrl+Shift+E 사용. */
  const exportCanvasAsPng = useCallback(() => {
    return exportPng("all");
  }, [exportPng]);

  const addNote = useCallback(() => {
    const vp = getVp();
    const center: Point = vp
      ? screenToCanvas({ x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 }, vp, camera)
      : { x: 0, y: 0 };
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // 디폴트: 배경 투명 + 글자색 흰색. 다크 캔버스 위에 PureRef 식으로 텍스트만
    // 떠 있는 형태가 자료 위로 노트를 자연스럽게 얹기 좋다. 사용자가 가독성
    // 위해 노란 배경이 필요하면 NoteToolbar 의 배경 팔레트로 즉시 변경 가능.
    // 디폴트 폰트 — AI 생성 노드 폰트와 통일(작게). NoteToolbar 로 즉시 키울 수 있다.
    const DEFAULT_FS = DEFAULT_NOTE_FONT_SIZE;
    const note: CanvasNote = {
      id,
      text: "",
      x: center.x - 100,
      y: center.y - (DEFAULT_FS * 1.2 + 8) / 2,
      width: 200,
      fontSize: DEFAULT_FS,
      rotation: 0,
      zIndex: state.layout.nextZ,
      bgColor: "transparent",
      color: "#ffffff",
      align: "left",
    };
    dispatch({
      type: "set",
      layout: {
        ...state.layout,
        notes: [...state.layout.notes, note],
        nextZ: state.layout.nextZ + 1,
      },
    });
    setSelectedNoteIds(new Set([id]));
  }, [camera, getVp, state.layout]);

  /** 선택된 노트들의 서식을 일괄 수정. NoteToolbar 의 모든 토글이 이걸 호출. */
  const mutateSelectedNotes = useCallback(
    (mut: (n: CanvasNote) => CanvasNote) => {
      if (selectedNoteIds.size === 0) return;
      let changed = false;
      const nextNotes = state.layout.notes.map((n) => {
        if (!selectedNoteIds.has(n.id)) return n;
        const next = mut(n);
        if (next !== n) changed = true;
        return next;
      });
      if (changed) {
        dispatch({ type: "set", layout: { ...state.layout, notes: nextNotes } });
      }
    },
    [selectedNoteIds, state.layout],
  );

  // (이전 `linkNotesToSelection` 은 NoteToolbar 의 Link 버튼이 *URL 첨부* 로
  // 재용도화되면서 제거. 노트→ref 연결은 L 키 drag-to-connect 모드로 그대로
  // 이용 가능.)

  const fitAll = useCallback(() => {
    const all: Rect[] = [];
    // visible 영역 기준 — crop 된 ref 는 보이는 부분으로 fit. outer 까지 fit 하면
    // 카메라가 너무 멀어 보이는 콘텐츠가 작아 보임.
    // *실제 캔버스에 그려지는* 항목만(visibleLayoutItems) — 필터/휴지통/타 폴더로
    // 화면에 없는 transform 까지 fit 하면 빈 영역으로 카메라가 끌려간다.
    for (const tr of Object.values(visibleLayoutItems)) all.push(visibleItemAABB(tr));
    for (const n of state.layout.notes) {
      all.push({ x: n.x, y: n.y, w: n.width, h: getNoteHeight(n) });
    }
    // gen 노드도 캔버스 콘텐츠 — 전체맞춤 bbox 에 포함(누락 시 fit 에서 밀려남).
    for (const g of state.layout.genNodes ?? []) {
      if (g.hidden) continue;
      all.push({ x: g.x, y: g.y, w: g.w, h: g.h });
    }
    const bbox = unionBBox(all);
    if (!bbox) {
      setCamera(DEFAULT_CAMERA);
      return;
    }
    const vp = getVp();
    if (!vp) return;
    setCamera(cameraToFit(bbox, vp));
  }, [getVp, visibleLayoutItems, state.layout.notes, state.layout.genNodes]);

  const previousCameraRef = useRef<CanvasCamera | null>(null);
  /** 마지막으로 focus 한 *선택 집합* 의 stable key. 같은 선택에서 두 번째
   *  Space 만 토글 복귀로 인식하기 위함. 다르면 즉시 새 선택으로 fit.
   *  이전 구현은 previousCameraRef 만 봐서, 선택을 추가/변경한 직후 Space 가
   *  fit 이 아니라 *복귀* 로 작동 → 사용자가 다시 한 번 더 눌러야 하는 회귀가
   *  있었음 (PureRef 의 직관과 어긋남). */
  const lastFocusedSelectionKeyRef = useRef<string | null>(null);
  const focusSelection = useCallback(() => {
    if (!selectionBBox) return;
    const vp = getVp();
    if (!vp) return;
    // 선택 집합의 정렬 key — ref id + 노트 id. 정렬해 순서 무관 식별.
    const key =
      [...selectedIds].sort().join("|") +
      "::" +
      [...selectedNoteIds].sort().join("|");
    // 같은 선택에서의 두 번째 호출 → 이전 카메라 복귀.
    if (previousCameraRef.current && lastFocusedSelectionKeyRef.current === key) {
      setCamera(previousCameraRef.current);
      previousCameraRef.current = null;
      lastFocusedSelectionKeyRef.current = null;
      return;
    }
    // 처음 진입(=이전 카메라 백업 없음) 일 때만 *현재 카메라* 를 백업.
    // 이미 focus 중에 선택이 바뀐 경우엔 직전 fit 카메라가 아닌 *원래 카메라* 가
    // 보존돼 두 번째 Space 가 자연스럽게 환원으로 작동.
    if (!previousCameraRef.current) {
      previousCameraRef.current = { ...camera };
    }
    lastFocusedSelectionKeyRef.current = key;
    setCamera(cameraToFit(selectionBBox, vp, 96));
  }, [camera, getVp, selectedIds, selectedNoteIds, selectionBBox]);

  /** Zoom-to-selection (Z 키 / 메뉴) — focusSelection 과 비슷하지만 *토글 복귀
   *  로직 없이* 항상 새로 fit. previousCameraRef 도 항상 백업해 사용자가 직후
   *  Space 로 복귀 가능. */
  const zoomToSelection = useCallback(() => {
    if (!selectionBBox) return;
    const vp = getVp();
    if (!vp) return;
    previousCameraRef.current = { ...camera };
    lastFocusedSelectionKeyRef.current =
      [...selectedIds].sort().join("|") + "::" + [...selectedNoteIds].sort().join("|");
    setCamera(cameraToFit(selectionBBox, vp, 96));
  }, [camera, getVp, selectedIds, selectedNoteIds, selectionBBox]);

  /** Ctrl+V — 클립보드에서 이미지/URL/텍스트 받아 캔버스에 즉시 배치. 이미지는
   *  부모(LibraryPage)의 onCanvasFileDrop 으로, URL 은 onCanvasUrlDrop 으로 위임
   *  해 기존 업로드 파이프 재사용. 텍스트는 노트로 만들어 현재 카메라 중심에 배치.
   *  pendingDropAnchorRef 를 같이 박아 신규 ref 가 드롭 좌표(=뷰포트 중심)에서
   *  cascade 되도록 한다 (OS file drop 과 동일 anchor 인프라). */
  const pasteFromClipboard = useCallback(async () => {
    const vp = getVp();
    if (!vp) return;
    const center: Point = screenToCanvas(
      { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 },
      vp,
      camera,
    );
    pendingDropAnchorRef.current = { pt: center, ts: Date.now() };
    // navigator.clipboard.read 가 가능하면 우선 — 이미지 blob 도 가져올 수 있다.
    type ClipboardItemLike = { types: ReadonlyArray<string>; getType: (t: string) => Promise<Blob> };
    const nav = navigator as Navigator & { clipboard?: Clipboard & { read?: () => Promise<ClipboardItemLike[]> } };
    const clipboardRead = nav.clipboard?.read;
    try {
      if (clipboardRead) {
        const items = await clipboardRead.call(nav.clipboard);
        const fileList: File[] = [];
        let urlOrText = "";
        for (const it of items) {
          for (const type of it.types) {
            if (type.startsWith("image/")) {
              const blob = await it.getType(type);
              const ext = type.split("/")[1] || "png";
              fileList.push(new File([blob], `pasted-${Date.now()}.${ext}`, { type }));
            } else if (type === "text/plain" || type === "text/uri-list") {
              const blob = await it.getType(type);
              const txt = await blob.text();
              if (txt && txt.length > urlOrText.length) urlOrText = txt;
            }
          }
        }
        if (fileList.length > 0 && onCanvasFileDrop) {
          onCanvasFileDrop(fileList);
          return;
        }
        if (urlOrText) {
          const trimmed = urlOrText.trim();
          if (/^https?:\/\//i.test(trimmed) && onCanvasUrlDrop) {
            onCanvasUrlDrop(trimmed);
            return;
          }
          // URL 이 아니면 노트로 — 캔버스 중심에 그대로 배치.
          const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          const note: CanvasNote = {
            id,
            text: trimmed,
            x: center.x - 80,
            y: center.y - 20,
            width: 240,
            fontSize: DEFAULT_NOTE_FONT_SIZE,
            rotation: 0,
            zIndex: state.layout.nextZ,
            bgColor: "transparent",
            color: "#ffffff",
            align: "left",
          };
          dispatch({
            type: "set",
            layout: {
              ...state.layout,
              notes: [...state.layout.notes, note],
              nextZ: state.layout.nextZ + 1,
            },
          });
          setSelectedNoteIds(new Set([id]));
          return;
        }
      }
      // Fallback — readText 만이라도 시도.
      if (nav.clipboard?.readText) {
        const txt = await nav.clipboard.readText();
        if (txt.trim()) {
          const trimmed = txt.trim();
          if (/^https?:\/\//i.test(trimmed) && onCanvasUrlDrop) {
            onCanvasUrlDrop(trimmed);
          } else {
            const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            const note: CanvasNote = {
              id, text: trimmed,
              x: center.x - 80, y: center.y - 20,
              width: 240, fontSize: DEFAULT_NOTE_FONT_SIZE, rotation: 0,
              zIndex: state.layout.nextZ,
              bgColor: "transparent", color: "#ffffff", align: "left",
            };
            dispatch({
              type: "set",
              layout: {
                ...state.layout,
                notes: [...state.layout.notes, note],
                nextZ: state.layout.nextZ + 1,
              },
            });
            setSelectedNoteIds(new Set([id]));
          }
        } else {
          toast({ title: t("library.canvas.paste.empty") });
          pendingDropAnchorRef.current = null;
        }
      }
    } catch {
      toast({ variant: "destructive", title: t("library.canvas.paste.failed") });
      pendingDropAnchorRef.current = null;
    }
  }, [camera, getVp, onCanvasFileDrop, onCanvasUrlDrop, state.layout, t, toast]);

  /** Ctrl/Cmd+A — 캔버스 내 모든 ref + 노트를 일괄 선택.
   *  visibleItems 의 id 를 부모 onMarqueeSelect 에 replace 모드로 위임하면
   *  parent selectedIds 가 갱신되고, 노트 set 은 로컬에서 한 번에 갱신. */
  const selectAll = useCallback(() => {
    onMarqueeSelect(visibleItems.map((it) => it.id), "replace");
    // 빈 노트(보이지 않는 유령)는 선택에서 제외 — 선택 경계가 허공으로 늘어나는
    // 것을 막는다. 텍스트/배경/url/role 있는 실제 노트만 선택.
    setSelectedNoteIds(new Set(state.layout.notes.filter((n) => !isBlankCanvasNote(n)).map((n) => n.id)));
    // gen 노드도 전체 선택에 포함(숨김 제외).
    setSelectedGenIds(new Set((state.layout.genNodes ?? []).filter((g) => !g.hidden).map((g) => g.id)));
  }, [onMarqueeSelect, state.layout.notes, state.layout.genNodes, visibleItems]);

  /** Esc — 다단 unwind: 드래그 진행 중 → 그것만 취소. 그 외 선택이 있으면 →
   *  선택 해제. 그 외 immersive 모드 ON 이면 → immersive OFF. 모두 비어 있으면
   *  no-op (캔버스 자체는 그대로 유지).
   *  드래그 cancel 은 reducer.undo 로 직전 commit 상태로 되돌려 transient
   *  변경을 통째로 되돌리는 게 가장 깔끔하다(pointerdown 시 commit 박았음). */
  const cancelOrDeselect = useCallback(() => {
    // drag-to-create 퀵 추가 메뉴가 떠 있으면 가장 먼저 닫는다.
    if (quickAdd) {
      setQuickAdd(null);
      return;
    }
    // drag-to-connect 진행 중이면 가장 먼저 캔슬 — anchor 는 자체 pointerup
    // 핸들러로 종료되지만 Esc 로 즉시 끊고 싶을 때 안전망. linkMode 도 함께 종료.
    if (linkingPreview) {
      setLinkingPreview(null);
      setLinkMode(false);
      return;
    }
    // linkMode 만 켜진 상태(드래그 시작 전) → Esc 로 모드 종료.
    if (linkMode) {
      setLinkMode(false);
      return;
    }
    const drag = dragRef.current;
    if (drag.kind !== "idle") {
      dragRef.current = { kind: "idle" };
      setSnapGuides([]);
      setMarqueeRect(null);
      noteTapIntentRef.current = null;
      if (
        drag.kind === "move" ||
        drag.kind === "resize" ||
        drag.kind === "rotate" ||
        drag.kind === "group-scale"
      ) {
        // pointerdown 시 commit 한 스냅샷으로 복귀 → transient 변경 폐기.
        dispatch({ type: "undo" });
      }
      return;
    }
    if (selectedIds.size > 0 || selectedNoteIds.size > 0 || selectedGenIds.size > 0) {
      onMarqueeSelect([], "replace");
      setSelectedNoteIds(new Set());
      setSelectedGenIds(new Set());
      return;
    }
    // 라인 선택 해제 — 객체 선택 해제와 같은 우선순위(둘 다 선택 가능 X 이라
    // 분기 위치는 무관). ConnectionToolbar / AnchorEditor 가 함께 사라짐.
    if (selectedConnectionId) {
      setSelectedConnectionId(null);
      return;
    }
    // 선택도 비어 있으면 immersive 해제 — 단계별 unwind 의 마지막 단계.
    if (immersive && onToggleImmersive) {
      onToggleImmersive();
    }
  }, [immersive, linkMode, linkingPreview, quickAdd, onMarqueeSelect, onToggleImmersive, selectedConnectionId, selectedIds, selectedNoteIds, selectedGenIds]);

  /** 선택된 노트만 layout 에서 제거. ref 는 절대 건드리지 않는다
   *  (ref 삭제는 전역 Delete 핸들러가 trash 로 보냄). */
  const deleteSelectedNotes = useCallback(() => {
    if (selectedNoteIds.size === 0) return false;
    const nextNotes = state.layout.notes.filter((n) => !selectedNoteIds.has(n.id));
    if (nextNotes.length === state.layout.notes.length) return false;
    dispatch({ type: "set", layout: { ...state.layout, notes: nextNotes } });
    setSelectedNoteIds(new Set());
    return true;
  }, [selectedNoteIds, state.layout]);

  /** 선택된 gen 노드를 한 번의 dispatch 로 일괄 제거(+ 그 노드들을 끝점으로
   *  하는 연결도 함께). 단건 deleteGenNode 를 루프 돌면 undo 스텝이 쪼개지므로
   *  배치 버전을 둔다. ref/note 는 건드리지 않는다. */
  const deleteSelectedGenNodes = useCallback(() => {
    if (selectedGenIds.size === 0) return false;
    const genNodes = (state.layout.genNodes ?? []).filter((g) => !selectedGenIds.has(g.id));
    if (genNodes.length === (state.layout.genNodes ?? []).length) return false;
    const connections = (state.layout.connections ?? []).filter(
      (c) =>
        !((c.from.kind === "gen" && selectedGenIds.has(c.from.id))
          || (c.to.kind === "gen" && selectedGenIds.has(c.to.id))),
    );
    dispatch({ type: "set", layout: { ...state.layout, genNodes, connections } });
    setSelectedGenIds(new Set());
    return true;
  }, [selectedGenIds, state.layout]);

  /** 인라인 자르기 모드 — Photoshop / PureRef 스타일. cropEditingId 가 set 이면
   *  해당 아이템 위에 8 핸들 + 어두운 마스크 오버레이가 떠 즉시 편집 가능.
   *  Enter → commit, Esc → cancel, Right-click → reset (crop 제거). */
  const [cropEditingId, setCropEditingId] = useState<string | null>(null);
  const [cropDraft, setCropDraft] = useState<CanvasItemCrop | null>(null);

  const cropItem = useCallback((itemId: string) => {
    const cur = state.layout.items[itemId];
    if (!cur) return;
    setCropEditingId(itemId);
    // PureRef / Photoshop 스타일 — crop 모드 진입 시 *원본 크기* 캔버스를 보여주고
    // 핸들이 *밖으로도 확장* 가능하게 한다. 그래서 draft 는 원본(natural) 좌표계
    // 비율로 다룸. 기존 crop 이 있으면 그 위치에서 시작, 없으면 (0,0,0,0)=원본 전체.
    setCropDraft(cur.crop ?? { l: 0, t: 0, r: 0, b: 0 });
  }, [state.layout.items]);

  /** crop 적용 / 해제 (reset).
   *  - crop=null: 자르기 *완전 해제* — wrapper 를 원본 크기로 되돌림 (unbake).
   *  - crop!=null: 새 crop 으로 *bake* — wrapper 가 visible 영역 크기로 축소.
   *
   *  baked v2 데이터 모델에서 tr.w/h 는 visible 크기, crop 은 natural 의 어느
   *  부분을 보일지 비율. unbake 시 visible × crop 으로 원본 dim 역산. */
  const applyCrop = useCallback((itemId: string, crop: CanvasItemCrop | null) => {
    const cur = state.layout.items[itemId];
    if (!cur) return;
    const items = { ...state.layout.items };
    if (crop === null) {
      // 기존 crop 의 inverse — wrapper 를 원본 크기/위치로 복원.
      const next = { ...cur };
      if (cur.crop && cur.cropBaked) {
        const { l, t, r, b } = cur.crop;
        const spanX = 1 - l - r;
        const spanY = 1 - t - b;
        if (spanX > 0 && spanY > 0) {
          const origW = cur.w / spanX;
          const origH = cur.h / spanY;
          next.w = origW;
          next.h = origH;
          next.x = cur.x - l * origW;
          next.y = cur.y - t * origH;
        }
      }
      delete next.crop;
      delete next.cropBaked;
      items[itemId] = next;
    } else {
      items[itemId] = { ...cur, crop, cropBaked: true };
    }
    dispatch({ type: "set", layout: { ...state.layout, items } });
  }, [state.layout]);

  const commitCrop = useCallback(() => {
    if (!cropEditingId || !cropDraft) {
      setCropEditingId(null);
      setCropDraft(null);
      return;
    }
    const cur = state.layout.items[cropEditingId];
    if (!cur) {
      setCropEditingId(null);
      setCropDraft(null);
      return;
    }
    // draft 는 *natural 좌표계 절대값* (PureRef-식 풀-원본 편집). 그대로 사용.
    const hasCrop = cropDraft.l > 0 || cropDraft.t > 0 || cropDraft.r > 0 || cropDraft.b > 0;
    // 원본 캔버스 rect — 현재 transform 에서 기존 crop 을 unbake 해서 계산.
    let origX: number, origY: number, origW: number, origH: number;
    if (cur.crop && cur.cropBaked) {
      const { l, t, r, b } = cur.crop;
      const spanX = 1 - l - r;
      const spanY = 1 - t - b;
      origW = cur.w / spanX;
      origH = cur.h / spanY;
      origX = cur.x - l * origW;
      origY = cur.y - t * origH;
    } else {
      origX = cur.x;
      origY = cur.y;
      origW = cur.w;
      origH = cur.h;
    }
    const items = { ...state.layout.items };
    if (!hasCrop) {
      // 원본으로 복원 — crop 제거.
      const next = { ...cur, x: origX, y: origY, w: origW, h: origH };
      delete next.crop;
      delete next.cropBaked;
      items[cropEditingId] = next;
    } else {
      // 새 crop 으로 bake. 원본 × draft 만큼 wrapper 줄임.
      const newItem = {
        ...cur,
        x: origX + cropDraft.l * origW,
        y: origY + cropDraft.t * origH,
        w: origW * (1 - cropDraft.l - cropDraft.r),
        h: origH * (1 - cropDraft.t - cropDraft.b),
        crop: cropDraft,
        cropBaked: true,
      };
      // eslint-disable-next-line no-console
      console.log(
        `[crop-debug] commit | cur=(${cur.x.toFixed(1)},${cur.y.toFixed(1)},${cur.w.toFixed(1)},${cur.h.toFixed(1)}) baked=${cur.cropBaked} flipH=${cur.flipH} flipV=${cur.flipV} | orig=(${origX.toFixed(1)},${origY.toFixed(1)},${origW.toFixed(1)},${origH.toFixed(1)}) | draft={l:${cropDraft.l.toFixed(4)}, t:${cropDraft.t.toFixed(4)}, r:${cropDraft.r.toFixed(4)}, b:${cropDraft.b.toFixed(4)}} | new=(${newItem.x.toFixed(1)},${newItem.y.toFixed(1)},${newItem.w.toFixed(1)},${newItem.h.toFixed(1)})`
      );
      items[cropEditingId] = newItem;
    }
    dispatch({ type: "set", layout: { ...state.layout, items } });
    setCropEditingId(null);
    setCropDraft(null);
  }, [cropEditingId, cropDraft, state.layout]);

  const cancelCrop = useCallback(() => {
    setCropEditingId(null);
    setCropDraft(null);
  }, []);

  const resetCrop = useCallback(() => {
    if (cropEditingId) applyCrop(cropEditingId, null);
    setCropEditingId(null);
    setCropDraft(null);
  }, [applyCrop, cropEditingId]);

  /** 자식(CanvasItemView) 으로 내려보낼 컨텍스트 액션 묶음. v2 에서 액션이
   *  여러 개 늘었지만 stable identity 유지를 위해 한 객체로 묶는다. */
  const itemContextActions = useMemo<CanvasItemContextActions>(
    () => ({
      unlinkAll: unlinkAllOfItem,
      hideLineage: hideLineageForItem,
      restoreLineage: restoreLineageForItem,
      setRotation: setSelectionRotation,
      applyEffect: applyEffectToSelection,
      group: groupSelection,
      ungroup: ungroupSelection,
      toggleHide: toggleHideSelection,
      toggleLock,
      cropItem,
      addToBrief: (it) => onAddToBrief?.(it),
      addToAgent: (it) => onAddToAgent?.(it),
      addToConti: (it) => onAddToConti?.(it),
      promoteToAsset: (it) => onPromoteToAsset?.(it),
      moveToTrash: (it) => onMoveToTrash?.(it),
      createVariation: (it) => onCreateVariation?.(it),
    }),
    [
      applyEffectToSelection,
      cropItem,
      groupSelection,
      onAddToBrief,
      onAddToAgent,
      onAddToConti,
      onCreateVariation,
      onMoveToTrash,
      onPromoteToAsset,
      setSelectionRotation,
      toggleHideSelection,
      toggleLock,
      ungroupSelection,
      unlinkAllOfItem,
      hideLineageForItem,
      restoreLineageForItem,
    ],
  );

  /* ────────────────────────────────────────────────────────
   * Keyboard — 캔버스 전용 단축키만. 전역 핸들러와 안 겹침.
   * viewport 가 focus 일 때만 발동. 텍스트 편집 중에는 자동 무시.
   * ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const ctrl = e.ctrlKey || e.metaKey;
      // Esc — 드래그 중이면 그 드래그만 취소, 아니면 선택 해제.
      // 전역 핸들러는 Esc 를 previewMode 닫기에만 쓰므로 stopPropagation 으로
      // 캔버스 의도(취소/해제) 가 묵음 처리되지 않게 한다.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelOrDeselect();
        return;
      }
      // Delete/Backspace — 선택된 노트/ gen 노드가 있으면 그 캔버스 로컬 객체만
      // 지우고 전역 ref-trash 핸들러로 흘러가지 않게 차단. 둘 다 없으면 그대로
      // 위임 → 전역이 처리해 ref 가 trash 로 이동(grid 와 동일 동작).
      if (
        (e.key === "Delete" || e.key === "Backspace")
        && (selectedNoteIds.size > 0 || selectedGenIds.size > 0)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (selectedNoteIds.size > 0) deleteSelectedNotes();
        if (selectedGenIds.size > 0) deleteSelectedGenNodes();
        return;
      }
      // Ctrl/Cmd+A — 캔버스 내 모든 ref + 노트 선택.
      // 전역 핸들러가 Ctrl+A 를 별도 처리하지 않지만, 브라우저 기본 동작
      // (텍스트 select-all) 도 막아야 viewport 가 깜빡이지 않는다.
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopPropagation();
        selectAll();
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        /* Page 단위 *최근 undoBar* (trash 직후의 "되돌리기" 등) 가 살아
           있으면 그것을 먼저 consume — canvas focus 라도 사용자가 막
           실행한 액션의 되돌리기가 우선이다 ("화면에 보이는 것 = 되돌릴
           수 있는 것"). 슬롯이 비었거나 만료됐으면 false 가 돌아오고 평소
           대로 canvas layout undo 로 폴백. */
        if (tryRunLatestUndo?.()) return;
        dispatch({ type: "undo" });
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (ctrl && e.key === " ") {
        e.preventDefault();
        fitAll();
        return;
      }
      if (ctrl && e.key === "0") {
        e.preventDefault();
        const vpRect = getVp();
        if (vpRect) {
          setCamera((prev) => zoomAt(prev, { x: vpRect.left + vpRect.width / 2, y: vpRect.top + vpRect.height / 2 }, vpRect, 1));
        }
        return;
      }
      if (e.key === " " && !ctrl) {
        // 입력 컴포넌트(노트 contentEditable / input / textarea) focus 시엔
        // 띄어쓰기 입력으로 흘려보내기 — 가로채지 않음.
        const ae = document.activeElement as HTMLElement | null;
        const inEditable =
          editingNoteId !== null ||
          (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable));
        if (inEditable) return;
        e.preventDefault();
        // 키보드 auto-repeat 은 1회만 — focus 가 반복 호출돼도 결과는 동일하므로
        // 무해하지만, 사용자가 길게 눌렀을 때 의미 없는 호출을 줄인다.
        if (e.repeat) return;
        // Space 는 이제 *focusSelection* 한 가지 동작만 한다 — hold-to-pan 폐기.
        // Pan 은 Alt+클릭 또는 미들마우스로 통일.
        focusSelection();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleLock();
        return;
      }
      // L (no modifier) — drag-to-connect 모드 토글. 입력 컴포넌트 focus 시
      // 가로채지 않음 (소문자 l 입력으로 흘려보냄).
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "l") {
        const ae = document.activeElement as HTMLElement | null;
        const inEditable =
          editingNoteId !== null ||
          (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable));
        if (inEditable) return;
        e.preventDefault();
        setLinkMode((m) => !m);
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        bringToFront();
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        sendToBack();
        return;
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        flipH();
        return;
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        flipV();
        return;
      }
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        addNote();
        return;
      }
      // T — 선택 격자 정렬 (PureRef Optimize 와 유사). selection >=2 일 때만.
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        tileSelection();
        return;
      }
      // Ctrl/Cmd+P — PureRef parity. 브라우저 기본 Print 도 함께 차단.
      // 단축키 정책: 캔버스 viewport 가 focus 일 때만 발동(상위 guard 가 이미
      // input/textarea/contentEditable 을 걸러줌) → 일반 입력 컨텍스트에서는
      // 평소 Print 동작이 유지된다.
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        tileSelection();
        return;
      }
      // ── v2 신규 단축키 ──
      // Ctrl/Cmd+G — 하드 그룹핑. 기존 grid view 의 group 기능과 충돌 우려는
      // 없음(viewport focus 일 때만 발동). 2개 이상 선택 필요.
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.stopPropagation();
        groupSelection();
        return;
      }
      // Ctrl/Cmd+Shift+G — 그룹 해제.
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.stopPropagation();
        ungroupSelection();
        return;
      }
      // Z — Zoom-to-selection. 선택이 있을 때만 발동. 빈 상태는 fitAll 과 중복.
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (selectedIds.size === 0 && selectedNoteIds.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        zoomToSelection();
        return;
      }
      // H — 선택된 ref 숨기기 토글. 빈 선택은 "모두 표시" — 사용자가 어딘가
      // 숨어 있을 거라는 의도로 자연스럽게 풀린다.
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIds.size > 0) toggleHideSelection();
        else showAllHidden();
        return;
      }
      // Ctrl/Cmd+Alt+G — 흑백(딤드) 토글. 선택 전체에 적용(효과 메뉴와 동일 동작).
      if (ctrl && e.altKey && !e.shiftKey && e.key.toLowerCase() === "g") {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        applyEffectToSelection((tr) => ({ ...tr, grayscale: !tr.grayscale }));
        return;
      }
      // M — 미니맵 토글.
      if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        e.stopPropagation();
        setShowMinimap((s) => !s);
        return;
      }
      // Shift+C — 자르기. 단일 선택일 때만(자르기는 한 항목 대상).
      if (!ctrl && !e.altKey && e.shiftKey && e.key.toLowerCase() === "c") {
        if (selectedIds.size !== 1) return;
        const cropId = selectedIds.values().next().value as string | undefined;
        if (!cropId) return;
        e.preventDefault();
        e.stopPropagation();
        cropItem(cropId);
        return;
      }
      // Ctrl/Cmd+V — 클립보드 붙여넣기. 빈 캔버스 + 노트 contentEditable
      // 가드 (상단 input/textarea/contentEditable check 가 이미 걸러줌).
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        e.stopPropagation();
        void pasteFromClipboard();
        return;
      }
      // Ctrl/Cmd+E — 캔버스 PNG 내보내기 (전체).
      // Ctrl/Cmd+Shift+E — 선택 영역만 PNG 내보내기.
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        e.stopPropagation();
        void exportPng("all");
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIds.size > 0 || selectedNoteIds.size > 0) {
          void exportPng("selection");
        } else {
          // 선택이 없는데 Shift+Ctrl+E 누르면 전체로 폴백 (사용자가 의도 표현
          // 했는데 빈 결과 → silent fail 보다 동작 보장).
          void exportPng("all");
        }
        return;
      }
      // # (Shift+3) — 배경 그리드 토글. PureRef 가 쓰지 않는 키. 사용자가
      // 의도적으로 누를 가능성이 있는 다른 동작 없음.
      if (!ctrl && e.shiftKey && !e.altKey && (e.key === "#" || e.key === "3")) {
        e.preventDefault();
        e.stopPropagation();
        toggleBackgroundGrid();
        return;
      }
      // Ctrl/Cmd+F — 검색바 토글. 브라우저 기본 검색은 viewport focus 컨텍스트에서만 차단.
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setSearchActive((s) => {
          const next = !s;
          if (next) setTimeout(() => searchInputRef.current?.focus(), 0);
          else setSearchQuery("");
          return next;
        });
        return;
      }
    };
    // Space hold-to-pan 제거 — keyup / blur safety reset 도 함께 제거.
    vp.addEventListener("keydown", handler);
    return () => {
      vp.removeEventListener("keydown", handler);
    };
  }, [
    addNote,
    applyEffectToSelection,
    bringToFront,
    cancelOrDeselect,
    cropItem,
    deleteSelectedNotes,
    deleteSelectedGenNodes,
    editingNoteId,
    exportCanvasAsPng,
    exportPng,
    fitAll,
    flipH,
    flipV,
    focusSelection,
    getVp,
    groupSelection,
    pasteFromClipboard,
    selectAll,
    selectedIds,
    selectedNoteIds,
    selectedGenIds,
    sendToBack,
    showAllHidden,
    tileSelection,
    toggleBackgroundGrid,
    toggleHideSelection,
    toggleLock,
    tryRunLatestUndo,
    ungroupSelection,
    zoomToSelection,
  ]);

  /* ────────────────────────────────────────────────────────
   * 캔버스에 들어오면 viewport 에 자동 focus — 키보드 단축키 동작용
   * ──────────────────────────────────────────────────────── */
  useLayoutEffect(() => {
    viewportRef.current?.focus();
  }, [folderContextKey]);

  /* ────────────────────────────────────────────────────────
   * OS file drop — 이미지/영상 허용, doc / 폴더 거부
   * (플랜 §2.8). 캔버스 ref 카드 끼리 끌기는 PointerEvents 기반이라 native
   * HTML5 DnD 와 충돌하지 않지만, INTERNAL_DRAG_MIME 안전망으로 grid 의
   * 내부 DnD 가 캔버스 위로 흘러왔을 때 무시.
   * ──────────────────────────────────────────────────────── */

  const isInternalDrag = useCallback((e: ReactDragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (types) {
      for (let i = 0; i < types.length; i += 1) {
        if (types[i] === INTERNAL_DRAG_MIME) return true;
      }
    }
    return false;
  }, []);

  /** OS 파일 드래그인지 — dataTransfer.types 에 "Files" 가 있어야 한다.
   *  텍스트 드래그(노트 내부 텍스트, 외부 페이지의 텍스트 선택 등) 는
   *  text/plain · text/html 만 있고 Files 가 없어 false 반환 → OS drop 오버레이
   *  ("이미지나 영상을 놓으세요") 가 잘못 뜨지 않는다. */
  const isOsFileDrag = useCallback((e: ReactDragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    // URL 텍스트 드롭(브라우저에서 이미지 링크 끌어옴)도 캔버스가 link reference
    // 로 받으므로 오버레이를 띄울 가치가 있다. text/uri-list 까지는 허용.
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "text/uri-list") return true;
    }
    return false;
  }, []);

  const handleViewportDragEnter = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (isInternalDrag(e)) return;
      if (!isOsFileDrag(e)) return;
      e.preventDefault();
      setIsOsDragHover(true);
    },
    [isInternalDrag, isOsFileDrag],
  );

  const handleViewportDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (isInternalDrag(e)) return;
      if (!isOsFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      // hover 상태가 잠깐 떨어졌다 돌아올 때 깜빡임 방지 — over 에서도 true 유지.
      if (!isOsDragHover) setIsOsDragHover(true);
    },
    [isInternalDrag, isOsDragHover, isOsFileDrag],
  );

  const handleViewportDragLeave = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (isInternalDrag(e)) return;
      // viewport 자식으로 드나드는 micro-leave 무시 — relatedTarget 이 viewport
      // 안쪽 요소면 leave 가 아니라 자식 transition.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setIsOsDragHover(false);
    },
    [isInternalDrag],
  );

  const handleViewportDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
      setIsOsDragHover(false);

      // 1. 드롭 좌표(캔버스 좌표) 캡처. reconciliation 이 5s TTL 안에 한 번
      //    소비. 여러 파일을 한 번에 떨어뜨리면 같은 anchor 에서 cascade.
      const dropPt = cursorCanvas({ clientX: e.clientX, clientY: e.clientY });
      if (dropPt) {
        pendingDropAnchorRef.current = { pt: dropPt, ts: Date.now() };
      }

      // 2. 파일 + 폴더 분리. webkitGetAsEntry 가 있으면 그걸로, 없으면 fallback.
      const items = Array.from(e.dataTransfer.items ?? []);
      const allFiles: File[] = [];
      let hasFolder = false;
      let usedItemsApi = false;
      for (const it of items) {
        if (it.kind !== "file") continue;
        usedItemsApi = true;
        const entry = it.webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          hasFolder = true;
          continue;
        }
        const f = it.getAsFile();
        if (f) allFiles.push(f);
      }
      if (!usedItemsApi && e.dataTransfer.files.length > 0) {
        for (const f of Array.from(e.dataTransfer.files)) allFiles.push(f);
      }

      // 3. doc / blocked 차단 — 캔버스는 미디어만.
      const accepted: File[] = [];
      let docCount = 0;
      let blockedCount = 0;
      for (const f of allFiles) {
        try {
          const kind = detectReferenceKind(f);
          if (kind === "doc") {
            docCount += 1;
            continue;
          }
          accepted.push(f);
        } catch {
          // isBlockedReferenceExtension throw — exe/sh 등.
          blockedCount += 1;
        }
      }

      if (docCount > 0 || blockedCount > 0) {
        toast({
          variant: "destructive",
          title: t("library.canvas.docRejected"),
        });
      }

      // 4. URL fallback — 파일/폴더 모두 없을 때 텍스트 URL 시도.
      if (accepted.length === 0 && !hasFolder) {
        const text =
          e.dataTransfer.getData("text/uri-list") ||
          e.dataTransfer.getData("text/plain");
        if (text.trim() && onCanvasUrlDrop) {
          onCanvasUrlDrop(text.trim());
        } else {
          // 아무것도 처리 못 함 → anchor 도 의미 없음.
          pendingDropAnchorRef.current = null;
        }
        return;
      }

      // 5. 폴더 드롭은 v1 거부 — 명시 안내.
      if (hasFolder) {
        toast({
          variant: "destructive",
          title: t("library.canvas.folderRejected"),
        });
        if (accepted.length === 0) pendingDropAnchorRef.current = null;
      }

      if (accepted.length > 0 && onCanvasFileDrop) {
        onCanvasFileDrop(accepted);
      } else if (accepted.length === 0) {
        // 처리 가능한 파일이 없으면 anchor 유지가 의미 없음 — 즉시 폐기.
        pendingDropAnchorRef.current = null;
      }
    },
    [cursorCanvas, isInternalDrag, onCanvasFileDrop, onCanvasUrlDrop, t, toast],
  );

  /* ────────────────────────────────────────────────────────
   * Render
   * ──────────────────────────────────────────────────────── */

  // will-change 는 plane 을 GPU compositor layer 로 승격시켜 pan/zoom 을 부드럽게
  // 하지만, 그 대가로 layer 가 *현재 scale 의 비트맵* 으로 굳어 줌인 시 텍스트/
  // 이미지가 GPU 업스케일돼 흐려진다. 카메라가 활발히 변화 중일 때만 일시적으로
  // 켜두고, 정지 ~220ms 후 끄면 브라우저가 그 시점에 *현재 픽셀 그리드 기준* 으로
  // 한 번 재페인트 → 텍스트/벡터가 다시 sharp. 표준 dynamic-will-change 패턴.
  const planeStyle: CSSProperties = {
    transform: cameraToTransform(camera),
    transformOrigin: "0 0",
    willChange: isCameraInteracting ? "transform" : "auto",
  };

  // 빈 폴더 hint
  const showEmptyHint = visibleItems.length === 0 && state.layout.notes.length === 0;

  // 단일 노트 선택 시 floating 미니 툴바 노출. ref 와 노트 동시 선택은 미지원.
  const singleSelectedNote: CanvasNote | null = useMemo(() => {
    if (selectedNoteIds.size !== 1) return null;
    const id = selectedNoteIds.values().next().value as string | undefined;
    if (!id) return null;
    return state.layout.notes.find((n) => n.id === id) ?? null;
  }, [selectedNoteIds, state.layout.notes]);

  // 단일 객체(노트 or 미디어) 선택 — drag-to-connect anchor 노출 조건. 노트만
  // 또는 ref 만 1개씩 선택돼 있을 때 그 객체 정보를 반환.
  const singleSelectedTarget: {
    kind: "note" | "item";
    id: string;
    transform: CanvasItemTransform;
  } | null = useMemo(() => {
    if (selectedNoteIds.size === 1 && selectedIds.size === 0) {
      const noteId = selectedNoteIds.values().next().value as string | undefined;
      const note = noteId ? state.layout.notes.find((n) => n.id === noteId) : null;
      if (!note) return null;
      return {
        kind: "note",
        id: note.id,
        transform: {
          x: note.x,
          y: note.y,
          w: note.width,
          h: getNoteHeight(note),
          rotation: note.rotation,
          zIndex: note.zIndex,
        },
      };
    }
    if (selectedIds.size === 1 && selectedNoteIds.size === 0) {
      const itemId = selectedIds.values().next().value as string | undefined;
      const item = itemId ? state.layout.items[itemId] : null;
      if (!itemId || !item) return null;
      // 삭제(휴지통)·hidden·필터로 카드가 안 보이는데 layout transform 만 남은
      // 경우엔 anchor 점이 허공에 떠 "유령" 이 된다 — selectionTransforms 와
      // 동일하게 *실제 렌더되는* 항목만 통과시킨다.
      if (item.hidden || !itemsById.has(itemId)) return null;
      return { kind: "item", id: itemId, transform: item };
    }
    return null;
    // noteHeightsVersion 도 dep — 노트 높이 변동 시 anchor 위치 재계산.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteIds, selectedIds, state.layout.notes, state.layout.items, noteHeightsVersion, itemsById]);

  // 선택된 connection 의 양 끝점 transform + 라인 중점.
  // ConnectionAnchorEditor / ConnectionToolbar 노출 조건의 single source.
  const selectedConnectionInfo: {
    connection: CanvasConnection;
    fromTransform: CanvasItemTransform;
    toTransform: CanvasItemTransform;
    midpoint: Point;
  } | null = useMemo(() => {
    if (!selectedConnectionId) return null;
    const conn = (state.layout.connections ?? []).find((c) => c.id === selectedConnectionId);
    if (!conn) return null;
    const fromT =
      conn.from.kind === "note"
        ? (() => {
            const n = state.layout.notes.find((x) => x.id === conn.from.id);
            return n
              ? {
                  x: n.x,
                  y: n.y,
                  w: n.width,
                  h: getNoteHeight(n),
                  rotation: n.rotation,
                  zIndex: n.zIndex,
                }
              : null;
          })()
        : state.layout.items[conn.from.id] ?? null;
    const toT =
      conn.to.kind === "note"
        ? (() => {
            const n = state.layout.notes.find((x) => x.id === conn.to.id);
            return n
              ? {
                  x: n.x,
                  y: n.y,
                  w: n.width,
                  h: getNoteHeight(n),
                  rotation: n.rotation,
                  zIndex: n.zIndex,
                }
              : null;
          })()
        : state.layout.items[conn.to.id] ?? null;
    if (!fromT || !toT) return null;
    // 끝점 item 이 삭제(휴지통)·필터로 안 보이면 툴바/앵커 핸들을 띄우지 않는다
    // (layout.items 에 transform 이 보존돼 있어도 "유령" 으로 남지 않게).
    if (conn.from.kind === "item" && !itemsById.has(conn.from.id)) return null;
    if (conn.to.kind === "item" && !itemsById.has(conn.to.id)) return null;
    const fromCenter: Point = { x: fromT.x + fromT.w / 2, y: fromT.y + fromT.h / 2 };
    const toCenter: Point = { x: toT.x + toT.w / 2, y: toT.y + toT.h / 2 };
    // auto-anchor 로직 미러 — anchorLocked 우선, 다음 고정 포트(gen 입·출력 /
    // prompt 출력), 그 외 nearestSlot. ConnectionLayer 와 동일해야 toolbar /
    // anchor editor 가 라인의 시각 위치와 어긋나지 않는다.
    const fromIsPrompt =
      conn.from.kind === "note" && state.layout.notes.find((n) => n.id === conn.from.id)?.role === "prompt";
    const toIsPrompt =
      conn.to.kind === "note" && state.layout.notes.find((n) => n.id === conn.to.id)?.role === "prompt";
    const fromFixed = fixedPortAnchor(conn.from.kind, conn.linkType, !!fromIsPrompt);
    const toFixed = fixedPortAnchor(conn.to.kind, conn.linkType, !!toIsPrompt);
    const fromAnchor =
      conn.from.anchorLocked && conn.from.anchor
        ? conn.from.anchor
        : fromFixed ?? nearestSlot(fromT, toCenter).anchor;
    const toAnchor =
      conn.to.anchorLocked && conn.to.anchor
        ? conn.to.anchor
        : toFixed ?? nearestSlot(toT, fromCenter).anchor;
    const fromPt = localToCanvas(fromT, fromAnchor);
    const toPt = localToCanvas(toT, toAnchor);
    const midpoint: Point = { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 };
    return { connection: conn, fromTransform: fromT, toTransform: toT, midpoint };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedConnectionId,
    state.layout.connections,
    state.layout.notes,
    state.layout.items,
    itemsById,
    noteHeightsVersion,
  ]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <CanvasToolbar
        selectedCount={selectionTransforms.length}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
        onAddNote={addNote}
        onFlipH={flipH}
        onFlipV={flipV}
        onBringToFront={bringToFront}
        onSendToBack={sendToBack}
        onToggleLock={toggleLock}
        onAlign={alignSelection}
        onDistribute={distributeSelection}
        onTile={tileSelection}
        onFitAll={fitAll}
        onFocusSelection={focusSelection}
        onResetLayout={() => setResetDialogOpen(true)}
        onZoomIn={() => {
          const vp = getVp();
          if (!vp) return;
          setCamera((prev) => zoomAt(prev, { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 }, vp, prev.scale * 1.2));
        }}
        onZoomOut={() => {
          const vp = getVp();
          if (!vp) return;
          setCamera((prev) => zoomAt(prev, { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 }, vp, prev.scale / 1.2));
        }}
        scalePercent={Math.round(camera.scale * 100)}
        showGrid={!!state.layout.showGrid}
        onToggleGrid={toggleBackgroundGrid}
        onPaste={() => void pasteFromClipboard()}
        onExportPng={() => void exportCanvasAsPng()}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((s) => !s)}
        showShortcuts={showShortcuts}
        onToggleShortcuts={() => setShowShortcuts((s) => !s)}
        searchActive={searchActive}
        onToggleSearch={() => {
          setSearchActive((s) => {
            const next = !s;
            if (next) {
              // 검색바 열릴 때 자동 포커스 — 사용자가 즉시 타이핑 가능.
              setTimeout(() => searchInputRef.current?.focus(), 0);
            } else {
              setSearchQuery("");
            }
            return next;
          });
        }}
        onGroup={groupSelection}
        onUngroup={ungroupSelection}
        onShowAll={showAllHidden}
        onToggleHide={toggleHideSelection}
        hiddenCount={hiddenCount}
        selectionAllLocked={selectionAllLocked}
      />

      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div
        ref={viewportRef}
        tabIndex={0}
        className="relative flex-1 min-h-0 overflow-hidden bg-muted/20 outline-none"
        // 스페이스 hold 중엔 손바닥 커서, linkMode 면 십자 — 사용자가 어떤 모드
        // 인지 즉시 인지 가능. 활성 드래그까지 구분하려면 dragRef 를 봐야 하지만
        // ref 변경은 re-render 안 되므로 grab/grabbing 단일톤으로 간이 처리.
        style={{ cursor: linkMode ? "crosshair" : undefined }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onDragEnter={handleViewportDragEnter}
        onDragOver={handleViewportDragOver}
        onDragLeave={handleViewportDragLeave}
        onDrop={handleViewportDrop}
        onDoubleClick={(e) => {
          const cp = cursorCanvas(e);
          if (!cp) return;
          const hit = hitTest(cp);
          if (hit.kind === "item" && onDoubleClick) {
            onDoubleClick(hit.id);
          } else if (hit.kind === "note") {
            // 노트 더블클릭 → 편집 모드 진입. 단일 클릭은 hitTest 의 확장된
            // 노트 박스로 잡혀 selection + drag 가 시작되므로, 편집은 의도적
            // 으로 더블클릭으로 분리. canvas 앱들의 표준 패턴.
            setSelectedNoteIds(new Set([hit.id]));
            onMarqueeSelect([], "replace");
            setEditingNoteId(hit.id);
          } else if (hit.kind === "none") {
            // 빈 캔버스 더블클릭 → 그 자리에 quickAdd 메뉴(독립 생성). from 없이
            // 열어 드래그-투-커넥트 없이도 생성 노드/프롬프트/라벨을 바로 추가.
            setQuickAdd({ canvasPt: cp, screenX: e.clientX, screenY: e.clientY });
          }
        }}
      >
        <div ref={planeRef} style={planeStyle} className="absolute left-0 top-0">
          {/* 배경 모눈 — showGrid 가 켜진 폴더에서만. plane 안에 있어 camera
              transform 영향을 받아 줌인 시 모눈도 같이 확대. 다만 plane 은
              크기가 0×0(자식만큼 자동 확장)이라 SVG 가 자체 negative coordinates
              까지 그리도록 별도 컴포넌트로 분리. */}
          {state.layout.showGrid ? (
            <BackgroundGrid
              gridSize={state.layout.gridSize ?? 32}
              cameraScale={camera.scale}
            />
          ) : null}
          {/* 미디어 union 배경 — PureRef 의 island 처럼 캔버스 위 *모든 객체*
              (ref + 노트) 를 감싸는 하나의 옅은 박스. z-index 음수로 가장 뒤.
              빈 캔버스면 안 그림. */}
          <MediaIslandBackground
            items={state.layout.items}
            notes={state.layout.notes}
            genNodes={state.layout.genNodes}
            noteHeights={noteHeightsRef.current}
          />

          {/* Items — hidden 플래그가 켜진 항목은 렌더 제외 (hit-test/marquee 에서도
              제외돼 시각적 일관성 유지). 사용자가 "모두 표시" 또는 H 키로 풀기 전까지
              완전히 숨어 있는 상태 — PureRef 의 hide 동작과 동일. */}
          {visibleItems.map((item) => {
            const tr = state.layout.items[item.id];
            if (!tr) return null;
            if (tr.hidden) return null;
            // crop 편집 중인 아이템은 *기본 렌더 숨김* — CanvasCropEditor 가 별도로
            // 원본 크기 + 전체 이미지 + 핸들 을 그린다. 동시 렌더 시 위치/크기가
            // 안 맞아 시각이 겹쳐 보임.
            if (cropEditingId === item.id) return null;
            const selected = selectedIds.has(item.id);
            return (
              <CanvasItemView
                key={item.id}
                item={item}
                transform={tr}
                selected={selected}
                animationAutoplay={animationAutoplay}
                cameraScale={camera.scale}
                hasConnection={connectedItemIds.has(item.id)}
                hasVisibleLineage={itemsWithVisibleLineage.has(item.id)}
                hasHiddenLineage={itemsWithHiddenLineage.has(item.id)}
                contextActions={itemContextActions}
                cropEditing={false}
                showBadges={showBadges}
                showTypeLabel={showTypeLabel}
                showAnnotation={showAnnotation}
                generating={Boolean(generatingIds?.has(item.id))}
              />
            );
          })}
          {/* Notes */}
          {state.layout.notes.map((note) => {
            const selected = selectedNoteIds.has(note.id);
            const editing = editingNoteId === note.id;
            // 프롬프트 카드 출력 포트 연결 여부 — 점 채움/아웃라인 구분용.
            const portConnected =
              note.role === "prompt"
              && (state.layout.connections ?? []).some(
                (c) =>
                  (c.from.kind === "note" && c.from.id === note.id)
                  || (c.to.kind === "note" && c.to.id === note.id),
              );
            return (
              <CanvasNoteView
                key={note.id}
                note={note}
                selected={selected}
                editing={editing}
                portConnected={portConnected}
                onTextChange={(text) => {
                  // 편집 종료(blur) 시 빈 노트(텍스트/배경/url/role 없음)는 자동
                  // 삭제 — N 으로 만들고 안 적은 유령 노트가 누적되지 않게. 단,
                  // 연결(connection)의 끝점이면 링크가 깨지므로 보존.
                  const finalNote = { ...note, text };
                  const isConnected = (state.layout.connections ?? []).some(
                    (c) =>
                      (c.from.kind === "note" && c.from.id === note.id) ||
                      (c.to.kind === "note" && c.to.id === note.id),
                  );
                  if (isBlankCanvasNote(finalNote) && !isConnected) {
                    const nextNotes = state.layout.notes.filter((n) => n.id !== note.id);
                    dispatch({ type: "set", layout: { ...state.layout, notes: nextNotes } });
                    setSelectedNoteIds((prev) => {
                      const next = new Set(prev);
                      next.delete(note.id);
                      return next;
                    });
                    return;
                  }
                  const nextNotes = state.layout.notes.map((n) => (n.id === note.id ? { ...n, text } : n));
                  dispatch({ type: "set", layout: { ...state.layout, notes: nextNotes } });
                }}
                onEditEnd={() => setEditingNoteId((cur) => (cur === note.id ? null : cur))}
                onDelete={() => {
                  const nextNotes = state.layout.notes.filter((n) => n.id !== note.id);
                  dispatch({ type: "set", layout: { ...state.layout, notes: nextNotes } });
                  setSelectedNoteIds((prev) => {
                    const next = new Set(prev);
                    next.delete(note.id);
                    return next;
                  });
                }}
                onMeasured={updateNoteHeight}
              />
            );
          })}

          {/* AI 생성 노드(노드 에디터 v2) — 이미지 생성 실행 배선됨. 연결된
              라이브러리 이미지 + 프롬프트 카드를 입력으로 새 이미지를 생성한다.
              영상(Veo)은 Vertex API 부재로 보류(토글 비활성). */}
          {(state.layout.genNodes ?? []).map((node) => {
            // 연결된 입력 요약(미리보기용) — 순서가 곧 모델 전달 순서(첫 번째=원본).
            // runGenNode 와 *동일한* connections 순회 순서라 노드에 보이는 번호와
            // 실제 생성에 쓰이는 sourceImageUrl/referenceImageUrls 순서가 일치한다.
            const imageInputs: { id: string; thumb: string }[] = [];
            const promptBits: string[] = [];
            // 포트 연결 상태 — 입력(좌)/출력(우) 각각 하나라도 연결됐는지.
            let inputConnected = false;
            let outputConnected = false;
            for (const c of state.layout.connections ?? []) {
              const onNode =
                (c.from.kind === "gen" && c.from.id === node.id)
                || (c.to.kind === "gen" && c.to.id === node.id);
              if (!onNode) continue;
              // 결과 출력선(gen→결과)은 우측 출력 포트 — 입력 목록/입력 포트로
              // 세지 않는다(결과 이미지가 다음 실행의 입력으로 역류하지 않게).
              if (c.linkType === "output") {
                outputConnected = true;
                continue;
              }
              inputConnected = true;
              const other =
                c.from.kind === "gen" && c.from.id === node.id ? c.to : c.from;
              if (other.kind === "item") {
                const it = itemsById.get(other.id);
                if (it && it.file_url && (it.kind === "image" || it.kind === "webp" || it.kind === "gif")) {
                  imageInputs.push({ id: it.id, thumb: withReferenceVersion(it.thumbnail_url || it.file_url || "", it) });
                }
              } else if (other.kind === "note") {
                const n = state.layout.notes.find((nn) => nn.id === other.id);
                if (n?.role === "prompt" && n.text.trim()) promptBits.push(n.text.trim());
              }
            }
            return (
              <CanvasGenNodeView
                key={node.id}
                node={node}
                scale={camera.scale}
                selected={selectedGenIds.has(node.id)}
                inputConnected={inputConnected}
                outputConnected={outputConnected}
                imageInputs={imageInputs}
                promptPreview={promptBits.join("\n\n")}
                runState={genRunState[node.id]}
                onMove={moveGenNode}
                onDelete={deleteGenNode}
                onSetOutputKind={setGenOutputKind}
                onSetModel={setGenModel}
                onSetParams={setGenParams}
                onRun={runGenNode}
              />
            );
          })}

          {/* Connection 레이어 — items + notes 보다 *뒤에 렌더해 plane 의 z-stack
              상 위로* 올림. PureRef 처럼 라인이 미디어 위에 떠서 다른 객체에
              가려지지 않게. pointer-events 는 stroke hit path 외엔 none 이라
              기본 캔버스 조작과 충돌 X. SVG overflow:visible 로 plane 바깥도
              안 잘림. */}
          <ConnectionLayer
            connections={state.layout.connections ?? []}
            derivedEdges={derivedVariationEdges}
            visibleItemIds={visibleItemIds}
            notes={state.layout.notes}
            items={state.layout.items}
            genNodes={state.layout.genNodes}
            noteHeights={noteHeightsRef.current}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={(id) => {
              // 라인 선택은 객체 선택 / 노트 선택과 상호배타. 선택 진입 시 다른
              // 선택 모두 해제 — toolbar 도 자기끼리만 노출.
              onMarqueeSelect([], "replace");
              setSelectedNoteIds(new Set());
              setEditingNoteId(null);
              setSelectedConnectionId(id);
            }}
            onUnlinkConnection={(id) => {
              if (selectedConnectionId === id) setSelectedConnectionId(null);
              unlinkConnection(id);
            }}
            onDismissDerivedEdge={dismissDerivedEdge}
          />
        </div>

        {/* Selection overlay — plane 바깥에 둬서 카메라 scale 영향 받지 않게.
            crop 편집 중일 땐 selection 오버레이를 숨겨 crop UI 와 핸들 충돌 회피. */}
        {selectionTransforms.length > 0 && !cropEditingId ? (
          <SelectionOverlay
            transforms={selectionTransforms}
            camera={camera}
            viewportRect={viewportRect}
            onResizeStart={startResize}
            onRotateStart={startRotate}
            onGroupScaleStart={startGroupScale}
          />
        ) : null}

        {/* 인라인 자르기 편집 — Photoshop / PureRef 식. *원본 전체 이미지*를
            보여주고 그 위에 crop 영역을 정의 — 핸들이 밖으로도 확장 가능해
            이미 잘린 이미지도 원본 방향으로 키울 수 있다. Enter 커밋 / Esc 취소. */}
        {cropEditingId && viewportRect && cropDraft && state.layout.items[cropEditingId] ? (() => {
          const cur = state.layout.items[cropEditingId];
          // 원본(unbaked) rect 계산 — 현재 baked transform 에서 crop 역산.
          let origX: number, origY: number, origW: number, origH: number;
          if (cur.crop && cur.cropBaked) {
            const { l, t, r, b } = cur.crop;
            const spanX = 1 - l - r;
            const spanY = 1 - t - b;
            origW = cur.w / spanX;
            origH = cur.h / spanY;
            origX = cur.x - l * origW;
            origY = cur.y - t * origH;
          } else {
            origX = cur.x;
            origY = cur.y;
            origW = cur.w;
            origH = cur.h;
          }
          const ref = items.find((it) => it.id === cropEditingId);
          const imageSrc = ref ? (ref.thumbnail_url || ref.file_url || "") : "";
          return (
            <CanvasCropEditor
              originalRect={{ x: origX, y: origY, w: origW, h: origH }}
              imageSrc={imageSrc}
              draft={cropDraft}
              camera={camera}
              viewportRect={viewportRect}
              cursorCanvas={cursorCanvas}
              onDraftChange={setCropDraft}
              onCommit={commitCrop}
              onCancel={cancelCrop}
              onReset={resetCrop}
            />
          );
        })() : null}

        {/* 단일 노트 선택 시 floating 미니 툴바 — 노트 위쪽에 띄움.
            여러 노트 선택은 미지원(서식이 일관되지 않을 수 있음). */}
        {singleSelectedNote && viewportRect ? (
          <NoteToolbar
            note={singleSelectedNote}
            noteHeight={getNoteHeight(singleSelectedNote)}
            camera={camera}
            viewportRect={viewportRect}
            onMutate={mutateSelectedNotes}
          />
        ) : null}

        {/* 단일 객체(노트 or 미디어) 선택 시 가장자리 8 슬롯 anchor 점.
            ▶ v2: linkMode 단축키 없이도 *항상* 표시 → 발견성 확보. 평소엔
              작은 dot 으로 subtle 하게, hover/drag 시 강조. 객체 이동 클릭과
              충돌 없도록 anchor 자체에서 stopPropagation. */}
        {singleSelectedTarget && viewportRect ? (
          <ObjectLinkAnchor
            targetKind={singleSelectedTarget.kind}
            targetId={singleSelectedTarget.id}
            transform={singleSelectedTarget.transform}
            camera={camera}
            viewportRect={viewportRect}
            cursorCanvas={cursorCanvas}
            hitTest={hitTest}
            getNoteTransform={(noteId) => {
              const n = state.layout.notes.find((x) => x.id === noteId);
              if (!n) return null;
              return {
                x: n.x,
                y: n.y,
                w: n.width,
                h: getNoteHeight(n),
                rotation: n.rotation,
                zIndex: n.zIndex,
              };
            }}
            getItemTransform={(id) => state.layout.items[id] ?? null}
            getGenTransform={(id) => {
              const g = (state.layout.genNodes ?? []).find((x) => x.id === id);
              if (!g) return null;
              return { x: g.x, y: g.y, w: g.w, h: g.h, rotation: 0, zIndex: g.zIndex };
            }}
            onPreviewChange={setLinkingPreview}
            onLinkComplete={toggleConnection}
            onLinkToEmpty={handleLinkToEmpty}
            onDragEnd={() => setLinkMode(false)}
          />
        ) : null}

        {/* 선택된 connection 의 양 끝점 8 슬롯 핸들 — 활성 슬롯 강조 + drag 으로
            다른 슬롯에 재배치. */}
        {selectedConnectionInfo && viewportRect ? (
          <ConnectionAnchorEditor
            connection={selectedConnectionInfo.connection}
            fromTransform={selectedConnectionInfo.fromTransform}
            toTransform={selectedConnectionInfo.toTransform}
            camera={camera}
            viewportRect={viewportRect}
            onSetAnchor={setConnectionAnchor}
          />
        ) : null}

        {/* 선택된 connection 의 외형 toolbar — 라인 중점 위에 floating. */}
        {selectedConnectionInfo && viewportRect ? (
          <ConnectionToolbar
            connection={selectedConnectionInfo.connection}
            midpoint={selectedConnectionInfo.midpoint}
            camera={camera}
            viewportRect={viewportRect}
            onMutate={(mut) => mutateConnection(selectedConnectionInfo.connection.id, mut)}
            onUnlink={() => {
              setSelectedConnectionId(null);
              unlinkConnection(selectedConnectionInfo.connection.id);
            }}
          />
        ) : null}

        {/* Drag-to-connect 진행 중 미리보기 라인 — viewport 좌표계로 그려
            카메라 scale 영향 안 받음 (anchor → cursor 직선). */}
        {linkingPreview && viewportRect ? (
          <svg
            className="pointer-events-none absolute inset-0"
            style={{ overflow: "visible" }}
          >
            {(() => {
              const fromS = canvasToScreen(linkingPreview.from, viewportRect, camera);
              const toS = canvasToScreen(linkingPreview.to, viewportRect, camera);
              return (
                <line
                  x1={fromS.x - viewportRect.left}
                  y1={fromS.y - viewportRect.top}
                  x2={toS.x - viewportRect.left}
                  y2={toS.y - viewportRect.top}
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                />
              );
            })()}
          </svg>
        ) : null}

        {/* drag-to-create 퀵 추가 메뉴 — anchor 를 빈 공간에 놓으면 그 자리에 등장.
            바깥 클릭/Esc 로 닫힘. 항목 선택 시 노드 생성 + 자동 연결. */}
        {quickAdd && viewportRect ? (
          <>
            {/* 바깥 클릭 캐처 — 메뉴 밖을 누르면 취소. */}
            <div
              className="absolute inset-0 z-40"
              onPointerDown={(e) => {
                e.stopPropagation();
                setQuickAdd(null);
              }}
            />
            <div
              className="absolute z-50 min-w-44 border border-border bg-popover py-1 text-meta shadow-xl"
              style={{
                left: quickAdd.screenX - viewportRect.left,
                top: quickAdd.screenY - viewportRect.top,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("library.canvas.quickAdd.title")}
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                onClick={() => createQuickAddNode("prompt")}
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {t("library.canvas.quickAdd.promptCard")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                onClick={() => createQuickAddNode("label")}
              >
                <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
                {t("library.canvas.quickAdd.labelNote")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                onClick={() => createQuickAddNode("gen")}
              >
                <Network className="h-3.5 w-3.5 text-primary" />
                {t("library.canvas.quickAdd.genNode")}
              </button>
            </div>
          </>
        ) : null}

        {/* Marquee */}
        {marqueeRect && viewportRect ? (
          <div
            className="pointer-events-none absolute border border-primary/70 bg-primary/10"
            style={(() => {
              const tl = canvasToScreen({ x: marqueeRect.x, y: marqueeRect.y }, viewportRect, camera);
              const br = canvasToScreen({ x: marqueeRect.x + marqueeRect.w, y: marqueeRect.y + marqueeRect.h }, viewportRect, camera);
              return {
                left: tl.x - viewportRect.left,
                top: tl.y - viewportRect.top,
                width: br.x - tl.x,
                height: br.y - tl.y,
              };
            })()}
          />
        ) : null}

        {/* Snap guides */}
        {snapGuides.map((g, idx) => {
          const vp = viewportRect;
          if (!vp) return null;
          if (g.axis === "v") {
            const p = canvasToScreen({ x: g.pos, y: 0 }, vp, camera);
            return (
              <div
                key={idx}
                className="pointer-events-none absolute bg-zinc-500/70"
                style={{ left: p.x - vp.left, top: 0, width: 1, height: "100%" }}
              />
            );
          }
          const p = canvasToScreen({ x: 0, y: g.pos }, vp, camera);
          return (
            <div
              key={idx}
              className="pointer-events-none absolute bg-zinc-500/70"
              style={{ top: p.y - vp.top, left: 0, height: 1, width: "100%" }}
            />
          );
        })}

        {/* Empty hint */}
        {showEmptyHint ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {t("library.canvas.empty")}
          </div>
        ) : null}

        {/* OS file drop 오버레이 — dashed border + 중앙 안내. pointer-events
            none 으로 native onDrop 이 viewport 에 그대로 도달하게. */}
        {isOsDragHover ? (
          <div className="pointer-events-none absolute inset-2 rounded border-2 border-dashed border-primary/60 bg-primary/5 flex items-center justify-center">
            <div className="rounded bg-background/80 px-3 py-1.5 text-xs font-medium text-primary shadow-sm">
              {t("library.canvas.dropHint")}
            </div>
          </div>
        ) : null}

        {/* 몰입 모드 시 우상단 floating 'Exit immersive' 버튼 — 발견성 확보.
            backtick 단축키와 동일하게 부모 토글 콜백 호출. */}
        {immersive && onToggleImmersive ? (
          <Button
            variant="secondary"
            size="sm"
            className="absolute right-3 top-3 z-30 h-7 px-2 text-2xs shadow-sm"
            onClick={onToggleImmersive}
            title={t("library.canvas.exitImmersive")}
          >
            {t("library.canvas.exitImmersive")}
          </Button>
        ) : null}

        {/* linkMode 활성 시 좌상단 작은 인디케이터 — 사용자에게 "지금 링크
            모드" 라는 피드백 + 종료 단축키 안내. 클릭하면 즉시 종료. */}
        {linkMode ? (
          <button
            type="button"
            onClick={() => setLinkMode(false)}
            className="absolute left-3 top-3 z-30 flex items-center gap-1 rounded-md border border-primary/60 bg-primary/15 px-2 py-1 text-2xs font-medium text-primary shadow-sm hover:bg-primary/25"
            title={t("library.canvas.linkModeHint")}
          >
            <Link2 className="h-3 w-3" />
            {t("library.canvas.linkMode")}
          </button>
        ) : null}

        {/* v2 — 검색바. searchActive 일 때만 좌상단에 floating. Esc 로 닫기,
            Enter 로 첫 매치에 zoom-to-selection. 빈 쿼리에선 매칭 dim 없음. */}
        {searchActive ? (
          <div className={cn("absolute z-30 flex items-center gap-1 rounded-md border bg-card px-2 py-1 shadow-md",
            linkMode ? "left-32 top-3" : "left-3 top-3")}>
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              placeholder={t("library.canvas.searchPlaceholder")}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setSearchActive(false);
                  setSearchQuery("");
                  viewportRef.current?.focus();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (!searchMatchedIds || searchMatchedIds.size === 0) return;
                  // 첫 매치들에 zoom — onMarqueeSelect 로 부모 selection 갱신 후
                  // zoomToSelection 재사용.
                  onMarqueeSelect(Array.from(searchMatchedIds), "replace");
                  setSelectedNoteIds(new Set());
                  // 다음 tick 에 fit — selection 이 props 로 돌아온 직후.
                  setTimeout(() => zoomToSelection(), 30);
                }
              }}
              className="h-6 w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {searchMatchedIds ? (
              <span className="ml-1 font-mono text-2xs tabular-nums text-muted-foreground">
                {searchMatchedIds.size}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => { setSearchActive(false); setSearchQuery(""); viewportRef.current?.focus(); }}
              className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.close")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}

        {/* v2 — 검색 dim 오버레이. 매치되지 않은 ref 카드 위에 어두운 막을
            씌워 시각 강조. 카드 자체는 그대로 인터랙티브 — overlay 는
            pointer-events none. plane 좌표계 따라가게 plane 안에 그릴 수 있지만,
            카드별 위치 계산 비용을 피하려고 *카드 위 한 장의 dimming layer* 대신
            매치 안 된 카드 ID 집합을 prop 으로 내려 CanvasItemView 가 자체 opacity
            조절 — 그게 더 자연스럽지만 prop 추가가 부담이 크다. 임시: SelectionOverlay
            처럼 viewport 한 장의 SVG 로 *매치 카드만 강조* 하는 방식으로 v1 마감. */}
        {searchActive && searchMatchedIds && searchMatchedIds.size > 0 && viewportRect ? (
          <svg className="pointer-events-none absolute inset-0">
            {Array.from(searchMatchedIds).map((id) => {
              const tr = state.layout.items[id];
              if (!tr || tr.hidden) return null;
              const a = itemAABB(tr);
              const tl = canvasToScreen({ x: a.x, y: a.y }, viewportRect, camera);
              const br = canvasToScreen({ x: a.x + a.w, y: a.y + a.h }, viewportRect, camera);
              return (
                <rect
                  key={id}
                  x={tl.x - viewportRect.left}
                  y={tl.y - viewportRect.top}
                  width={br.x - tl.x}
                  height={br.y - tl.y}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  opacity={0.9}
                />
              );
            })}
          </svg>
        ) : null}

        {/* v2 — 미니맵. layout 에 콘텐츠가 있어야만 의미 — Minimap 자체에서
            빈 케이스를 return null 처리. */}
        {showMinimap ? (
          <Minimap
            items={visibleLayoutItems}
            notes={state.layout.notes}
            genNodes={state.layout.genNodes}
            noteHeights={noteHeightsRef.current}
            camera={camera}
            viewport={viewportRect}
            onJump={(canvasPt) => {
              const vp = getVp();
              if (!vp) return;
              // canvasPt 가 viewport 중심에 오도록 카메라 translate 재산출.
              const tx = vp.width / 2 - canvasPt.x * camera.scale;
              const ty = vp.height / 2 - canvasPt.y * camera.scale;
              setCamera({ tx, ty, scale: camera.scale });
            }}
          />
        ) : null}

        {/* 단축키 치트시트 — 우측 상단 토글 패널. */}
        {showShortcuts ? (
          <CanvasShortcutsPanel onClose={() => setShowShortcuts(false)} />
        ) : null}
      </div>
        </ContextMenuTrigger>
        {/* 캔버스 레벨 컨텍스트 메뉴 — viewport 빈 공간 우클릭. 카드/노트 우클릭은
            CanvasItemView 의 자체 ContextMenu 가 먼저 잡으므로 여기로 흘러오지
            않는다 (Radix asChild 패턴이 안쪽 트리거를 우선 처리). */}
        <ContextMenuContent className="min-w-56">
          <CanvasContextMenuItem onSelect={() => void pasteFromClipboard()}>
            <Clipboard className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.paste")}
            <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
          </CanvasContextMenuItem>
          <CanvasContextMenuItem onSelect={addNote}>
            <StickyNote className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.addNote")}
            <ContextMenuShortcut>N</ContextMenuShortcut>
          </CanvasContextMenuItem>
          <ContextMenuSeparator />
          <MenuCheckboxItem
            checked={!!state.layout.showGrid}
            icon={Grid3x3}
            onToggle={toggleBackgroundGrid}
          >
            {t("library.canvas.contextMenu.toggleGrid")}
            <ContextMenuShortcut>#</ContextMenuShortcut>
          </MenuCheckboxItem>
          {/* 그리드 크기 — 배경 그리드가 켜져 있을 때만 활성(서브메뉴 화살표 hover). */}
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!state.layout.showGrid}>
              {t("library.canvas.contextMenu.gridSize")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-32">
              <CanvasContextMenuItem onSelect={() => setGridSize(16)}>
                16 px{state.layout.gridSize === 16 ? " ✓" : ""}
              </CanvasContextMenuItem>
              <CanvasContextMenuItem onSelect={() => setGridSize(32)}>
                32 px{(state.layout.gridSize ?? 32) === 32 ? " ✓" : ""}
              </CanvasContextMenuItem>
              <CanvasContextMenuItem onSelect={() => setGridSize(64)}>
                64 px{state.layout.gridSize === 64 ? " ✓" : ""}
              </CanvasContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {/* GIF / animated WebP / APNG 자동 재생 토글 — 그리드 우클릭 메뉴
              및 Settings 의 동명 옵션과 동일한 storage 키(animationPreferences)
              를 공유하므로 캔버스에서 켜고 끄면 그리드 / 빅 프리뷰에도 즉시
              반영된다. */}
          <MenuCheckboxItem
            checked={animationAutoplay}
            icon={Film}
            onToggle={() => saveAnimatedThumbnailsAutoplay(!animationAutoplay)}
          >
            {t("library.grid.autoplayAnimated")}
          </MenuCheckboxItem>
          {/* 배지 표시 — 그리드와 동일 storage 키(showBadges)를 공유. 캔버스에서
              켜고 끄면 그리드에도 즉시 반영된다. */}
          <MenuCheckboxItem
            checked={showBadges}
            icon={Network}
            onToggle={() => saveLibraryShowBadges(!showBadges)}
          >
            {t("library.grid.showBadges")}
          </MenuCheckboxItem>
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
          <CanvasContextMenuItem onSelect={fitAll}>
            <Maximize2 className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.fitAll")}
            <ContextMenuShortcut>Ctrl+Space</ContextMenuShortcut>
          </CanvasContextMenuItem>
          <CanvasContextMenuItem onSelect={selectAll}>
            {t("library.canvas.contextMenu.selectAll")}
            <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
          </CanvasContextMenuItem>
          <CanvasContextMenuItem
            disabled={hiddenCount === 0}
            onSelect={showAllHidden}
          >
            <Eye className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.showAllHidden", { n: String(hiddenCount) })}
          </CanvasContextMenuItem>
          <ContextMenuSeparator />
          <CanvasContextMenuItem onSelect={() => void exportPng("all")}>
            <ImageDown className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.exportPng")}
            <ContextMenuShortcut>Ctrl+E</ContextMenuShortcut>
          </CanvasContextMenuItem>
          <CanvasContextMenuItem
            disabled={selectedIds.size === 0 && selectedNoteIds.size === 0}
            onSelect={() => void exportPng("selection")}
          >
            <ImageDown className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.exportSelectionPng")}
            <ContextMenuShortcut>Ctrl+Shift+E</ContextMenuShortcut>
          </CanvasContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Carry 고스트 — 변형 플라이아웃이 열린 동안 캔버스 이미지를 끌면 이동
          대신 "참조로 가져오기" 제스처임을 알려주는, 커서를 따라가는 라벨. */}
      {carryDrag ? (
        <div
          className="pointer-events-none fixed z-[60] flex items-center gap-1.5 border border-primary/60 bg-popover px-2 py-1 text-caption text-foreground shadow-lg"
          style={{ left: carryDrag.x + 14, top: carryDrag.y + 14, borderRadius: 0 }}
        >
          <Network className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[180px] truncate">
            {carryDrag.count > 1
              ? t("library.canvas.carryToVariation", { n: carryDrag.count })
              : carryDrag.label || t("library.canvas.carryToVariationOne")}
          </span>
        </div>
      ) : null}

      {/* 캔버스 레이아웃 초기화 확인 다이얼로그 — shadcn AlertDialog 로 OS 네이티브
          confirm 의 시각 불일치 + 키보드/포커스 복귀 비일관성을 해소. 확인 시
          저장된 layout 을 비우고, 비어진 상태에서 reconciliation effect 가 모든
          visibleItems 를 기본 위치로 재배치한다 (state.version 의존 추가로
          dispatch load 직후 즉시 발화 — 폴더를 떠났다 돌아와야 보이는 회귀 회피). */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent
          // Radix 기본은 닫힌 뒤 트리거(=툴바 버튼)로 focus 환원하지만, 이 경우
          // 캔버스 단축키(Ctrl+Z 등)가 viewport 의 keydown 핸들러로만 등록돼
          // 있어 트리거에 focus 가 머물면 Ctrl+Z 가 작동하지 않는다 → 명시적으로
          // viewport 로 focus 를 옮겨 즉시 undo/redo 가능하게 한다.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            viewportRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("library.canvas.resetLayoutConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.canvas.resetLayoutDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // 1. localStorage 정리 — *반드시* saveSourceRef 를 함께 넘긴다.
                //    `clearCanvasLayout` 은 write() 로 CANVAS_LAYOUT_CHANGED_EVENT
                //    를 발화하는데, source 가 없으면 같은 컴포넌트 instance 의
                //    listener 가 자기 변경에 반응해 `dispatch({type:"load", ...})`
                //    로 past/future 를 통째로 비운다 → 이어서 발화하는 set
                //    commit:true 가 푸시할 때는 이미 past 가 비어 있어 Ctrl+Z
                //    가 *원래 레이아웃* 이 아닌 *빈 레이아웃* 으로 돌아가는 버그
                //    가 있었음. source 일치 시 listener 가 self-skip 한다.
                clearCanvasLayout(folderContextKey, saveSourceRef.current);

                // 2. *모이는* 그리드 배치 + 항목이 보이도록 camera fit.
                //    기존 reconciliation cascade 는 첫 항목 중앙, 이후 top-left
                //    cascade 라 대각선으로 벌어지는 어색한 패턴이 나왔다. 또
                //    layout.view 를 undefined 로 두면 camera 가 DEFAULT 로 snap
                //    돼 사용자가 다른 곳을 보고 있다가 초기화하면 항목이 화면
                //    밖에 배치돼 *까만 화면* 으로 보였다. 여기서는:
                //      a. 모든 visibleItems 를 (0,0) 원점에서 shelf-pack 으로
                //         묶어 직사각형 그리드로 배치.
                //      b. 그 bbox 에 `cameraToFit` 으로 카메라를 맞춰 layout.view
                //         에 함께 저장 → 직후 camera effect 가 자동으로 그 카메라
                //         로 snap 한다. undo 시점에는 cloned pre-reset.view 로
                //         자연 환원.
                const sized = visibleItems.map((it) => ({
                  id: it.id,
                  size: placementSize({ width: it.width, height: it.height, kind: it.kind }),
                }));
                const placedItems: Record<string, CanvasItemTransform> = {};
                let nextZ = 1;
                let fitCamera: CanvasCamera | undefined;
                if (sized.length > 0) {
                  const gap = 24;
                  const totalArea = sized.reduce((sum, s) => sum + s.size.w * s.size.h, 0);
                  const widest = sized.reduce((mx, s) => (s.size.w > mx ? s.size.w : mx), 0);
                  // tileSelection 과 동일한 휴리스틱 — 가로가 약간 긴 1.3 배.
                  const targetRowWidth = Math.max(widest, Math.sqrt(Math.max(totalArea, 1)) * 1.3);
                  const order = [...sized].sort((a, b) => b.size.h - a.size.h);
                  interface Row { items: typeof order; rowW: number; rowH: number }
                  const rows: Row[] = [];
                  let row: Row = { items: [], rowW: 0, rowH: 0 };
                  for (const s of order) {
                    const w = s.size.w;
                    const h = s.size.h;
                    const wouldBe = row.items.length === 0 ? w : row.rowW + gap + w;
                    if (row.items.length > 0 && wouldBe > targetRowWidth) {
                      rows.push(row);
                      row = { items: [s], rowW: w, rowH: h };
                    } else {
                      row.items.push(s);
                      row.rowW = wouldBe;
                      if (h > row.rowH) row.rowH = h;
                    }
                  }
                  if (row.items.length > 0) rows.push(row);
                  const gridW = rows.reduce((mx, r) => (r.rowW > mx ? r.rowW : mx), 0);
                  const gridH = rows.reduce((sum, r) => sum + r.rowH, 0) + gap * Math.max(0, rows.length - 1);
                  // 원점 (0,0) 시작 — 카메라가 어차피 fit 되므로 절대 좌표는 무관.
                  const itemRects: Rect[] = [];
                  let cursorY = 0;
                  for (const r of rows) {
                    let cursorX = 0;
                    for (const s of r.items) {
                      placedItems[s.id] = {
                        x: cursorX,
                        y: cursorY,
                        w: s.size.w,
                        h: s.size.h,
                        rotation: 0,
                        zIndex: nextZ,
                      };
                      itemRects.push({ x: cursorX, y: cursorY, w: s.size.w, h: s.size.h });
                      nextZ += 1;
                      cursorX += s.size.w + gap;
                    }
                    cursorY += r.rowH + gap;
                  }
                  // 카메라 fit — 항목 bbox 가 viewport 안에 padding 96 으로 들어옴.
                  const vpRect = getVp();
                  if (vpRect) {
                    const bbox = unionBBox(itemRects);
                    if (bbox) {
                      fitCamera = cameraToFit(bbox, vpRect, 96);
                    }
                  }
                }

                // 3. dispatch "set" with commit:true → past 에 pre-reset 스냅샷
                //    push → Ctrl+Z 로 되돌리기 가능. (load 액션은 past 를 통째로
                //    비워 undo 불가능했던 회귀를 차단.)
                dispatch({
                  type: "set",
                  layout: {
                    items: placedItems,
                    notes: [],
                    view: fitCamera,
                    nextZ,
                    connections: [],
                    // gen 노드는 레이아웃 초기화에도 보존한다 — 캔버스 전용
                    // 자산이라 그리드 재배치로 통째로 날리면 데이터 유실.
                    // (입력 연결/프롬프트 노트는 초기화 의도대로 비워지므로
                    //  노드는 남되 재배선이 필요한 상태가 된다.)
                    genNodes: state.layout.genNodes ?? [],
                  },
                  commit: true,
                });

                // 4. 선택 상태도 정리 — 사라진 노트/연결을 가리키는 stale 선택은
                //    UI 가 어색해지는 원인.
                setSelectedNoteIds(new Set());
                setEditingNoteId(null);
                setSelectedConnectionId(null);
                onMarqueeSelect([], "replace");
              }}
            >
              {t("library.canvas.resetLayoutAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Sub-components
 * ────────────────────────────────────────────────────────────── */

/** 캔버스 미디어(item) 우클릭 시 노출할 액션의 묶음.
 *  지금은 unlinkAll 하나뿐이지만, 추후 lock/duplicate/sendToBack/delete 등을
 *  여기에 추가하면 자동으로 메뉴에 노출된다.
 *  parent (LibraryCanvas) 가 stable identity 의 단일 객체로 내려주므로
 *  CanvasItemView 의 React.memo 를 깨지 않는다. */
interface CanvasItemContextActions {
  /** 이 미디어를 끝점(from / to) 으로 갖는 모든 connection 을 제거. */
  unlinkAll: (itemId: string) => void;
  /** 이 미디어를 끝점으로 갖는 *보이는* 파생(계보) 점선 전부 숨김. */
  hideLineage: (itemId: string) => void;
  /** 이 미디어를 끝점으로 갖는 *숨긴* 파생(계보) 점선 전부 복원. */
  restoreLineage: (itemId: string) => void;
  /** 회전 0/90/180/270° 강제 — 컨텍스트 메뉴 "회전" 서브에서 호출. */
  setRotation: (radians: number) => void;
  /** opacity/grayscale/invert/border/shadow 토글 — 단일 transform mutator
   *  로 통합. caller 가 mutator 안에서 분기. */
  applyEffect: (mut: (t: CanvasItemTransform) => CanvasItemTransform) => void;
  /** 그룹/언그룹 — 메뉴에서도 단축키와 동등하게 노출. */
  group: () => void;
  ungroup: () => void;
  /** 숨기기 토글 — H 단축키와 동일. */
  toggleHide: () => void;
  /** 잠금 토글 — Ctrl+L 단축키와 동일. 선택 전체에 적용. */
  toggleLock: () => void;
  /** 자르기 모드 진입 — v1 은 다이얼로그 한 번 띄워 상하좌우 % 입력. */
  cropItem: (itemId: string) => void;
  /** 프로젝트 연동 — 그리드 우클릭 메뉴와 동일. LibraryPage 핸들러를 그대로
   *  재사용하며 현재 선택(snapshot)을 반영해 다중 처리된다. */
  addToBrief: (item: ReferenceItem) => void;
  addToAgent: (item: ReferenceItem) => void;
  addToConti: (item: ReferenceItem) => void;
  promoteToAsset: (item: ReferenceItem) => void;
  moveToTrash: (item: ReferenceItem) => void;
  createVariation: (item: ReferenceItem) => void;
}

interface CanvasItemViewProps {
  item: ReferenceItem;
  transform: CanvasItemTransform;
  selected: boolean;
  /** Settings 의 "GIF·WebP 자동 재생" 토글. true 면 호버 의존 없이 항상 animated. */
  animationAutoplay: boolean;
  /** 카메라 scale — 비디오 카드 스크러버는 화면상 너무 작은 카드에서는 자동 hide. */
  cameraScale: number;
  /** connections 에 *이 item 의 id* 가 from/to 어느 한 쪽이라도 등장하면 true.
   *  컨텍스트 메뉴의 "Unlink all" 항목 disabled 표시에 사용. */
  hasConnection: boolean;
  /** 이 item 을 끝점으로 갖는 *보이는* 파생(계보) 점선이 있으면 true. 메뉴의
   *  "계보 점선 모두 숨기기" 노출/활성에 사용. */
  hasVisibleLineage: boolean;
  /** 이 item 을 끝점으로 갖는 *숨긴* 파생(계보) 점선이 있으면 true. 메뉴의
   *  "숨긴 계보 점선 보이기" 노출/활성에 사용. */
  hasHiddenLineage: boolean;
  /** 우클릭 메뉴에서 호출할 액션 묶음 (stable identity 권장). */
  contextActions: CanvasItemContextActions;
  /** crop 편집 중인지. true 면 clip-path 를 잠시 끄고 full 이미지를 보여줌
   *  (CanvasCropEditor 가 위에 dark mask + 핸들을 얹어 직접 자르기 UI 제공). */
  cropEditing?: boolean;
  /** 그리드와 동일한 "배지 표시" 마스터 토글 — 베리에이션/즐겨찾기/핀 배지. */
  showBadges?: boolean;
  /** 좌상단 종류/확장자 라벨 표시(showBadges 하위). */
  showTypeLabel?: boolean;
  /** 우상단 주석(노트) 배지 표시(showBadges 하위). */
  showAnnotation?: boolean;
  /** 이 카드를 원본으로 AI 베리에이션이 생성 중이면 true — 로딩 오버레이. */
  generating?: boolean;
}

/** 카드 내부 — image/webp/gif/video/url 분기. PureRef 와 동일한 패턴:
 *  static 이미지/url 은 단일 layer, gif/webp 는 still + animated dual-layer
 *  hover-swap, 비디오는 poster + hover-to-play + 하단 timeline.
 *
 *  React.memo 로 감싸 transient 드래그 동안 *움직이지 않는* 카드의 리렌더를
 *  차단. 500-item 폴더에서 한 카드 드래그 시 1개만 리렌더되어 transient 60Hz
 *  업데이트가 부드럽게 흐른다. */
function CanvasItemViewBase({
  item,
  transform,
  selected,
  animationAutoplay,
  cameraScale,
  hasConnection,
  hasVisibleLineage,
  hasHiddenLineage,
  contextActions,
  cropEditing,
  showBadges,
  showTypeLabel,
  showAnnotation,
  generating,
}: CanvasItemViewProps) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = item.kind === "video" && Boolean(item.file_url);
  const isImageLike = isMediaKind(item.kind) && item.kind !== "video";
  const isUrlLike = item.kind === "youtube" || item.kind === "link";

  // GIF / WebP / animated link og:image 자동 재생 — LibraryGrid 의 canAnimateOnHover
  // 와 동일 정책. 캔버스에서는 dual-layer <img> overlap (그리드의 image-mode
  // 회피 background-image trick 은 캔버스에 불필요).
  const canAnimate = Boolean(item.file_url) && (
    item.kind === "gif" ||
    item.kind === "webp" ||
    (item.kind === "link" && (item.mime_type === "image/gif" || item.mime_type === "image/webp"))
  );
  const showAnimated = canAnimate && (animationAutoplay || hovered || selected);

  // 비디오 timeline state — 호버 시에만 보임.
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // 그리드(LibraryMediaThumbnail) 와 동일한 호버 재생/스크럽 모델로 통일하기 위한
  // refs. scrubbingVideoRef 는 window pointermove 리스너에서 최신 스크럽 여부를
  // 동기로 읽고, seekInFlight/pendingSeek 는 빠른 드래그 seek 를 코얼레싱해
  // "드래그 위치 = 보이는 프레임" 이 어긋나지 않게 한다. hoveredRef 는 스크럽
  // 종료 시 아직 호버 중이면 재생을 재개할지 동기로 판단.
  const hoveredRef = useRef(false);
  const scrubbingVideoRef = useRef(false);
  const seekInFlightRef = useRef(false);
  const pendingSeekTimeRef = useRef<number | null>(null);

  // 호버/스크럽 중에만 비디오 프레임을 보여주고, 그 외엔 정지 썸네일(stillSrc)로
  // 돌아온다. <video> 는 opacity 로만 가리고 그 아래 정지 이미지를 항상 깔아두는
  // 그리드와 동일한 dual-layer 방식 — 한 번 재생한 <video> 는 poster 로 복귀하지
  // 않으므로(브라우저 사양) 호버 해제 후 마지막 프레임이 박히는 문제를 회피한다.
  // 그리드와 동일하게 selected 만으로는 재생하지 않는다(호버에서만 재생).
  const showVideoFrame = isVideo && (hovered || scrubbing);

  // 자료가 바뀌면 비디오 재생 상태를 초기화 — 같은 카드 컴포넌트가 다른 자료로
  // 재사용될 때 이전 영상의 duration/time/scrub 잔재가 남지 않게.
  useEffect(() => {
    scrubbingVideoRef.current = false;
    seekInFlightRef.current = false;
    pendingSeekTimeRef.current = null;
    setVideoDuration(0);
    setVideoTime(0);
    setScrubbing(false);
  }, [item.id, item.file_url, item.thumbnail_url]);

  const stillSrc = withReferenceVersion(item.thumbnail_url || item.file_url || "", item);
  const animatedSrc = item.file_url || stillSrc;
  // 화면상 카드 너비(=transform.w * cameraScale) — 비디오 timeline 자동 hide,
  // 고해상도 overlay swap 기준치로 함께 쓰인다. 줌인하면 한 카드가 1000px+ 로
  // 커질 수 있어, 썸네일(보통 short-edge ~256-512) 만으로는 픽셀화가 보임.
  const onScreenWidth = transform.w * cameraScale;
  // 고해상도 overlay — 카드가 화면상 일정 폭 이상으로 커지면 file_url(원본) 을
  // 그 위에 fade-in 시켜 thumbnail 의 픽셀화를 가린다. 작아지면 unmount → 메모리
  // 회수. canAnimate(GIF/WebP) 케이스는 어차피 animated layer 가 file_url 을
  // 그리므로 별도 highRes 불필요 (false 로 둠).
  const HIGH_RES_THRESHOLD_PX = 480;
  const wantHighRes =
    isImageLike &&
    !canAnimate &&
    Boolean(item.file_url) &&
    item.file_url !== item.thumbnail_url &&
    onScreenWidth >= HIGH_RES_THRESHOLD_PX;
  const highResSrc = wantHighRes ? withReferenceVersion(item.file_url ?? "", item) : null;
  const [highResLoaded, setHighResLoaded] = useState(false);
  useEffect(() => {
    // src 가 바뀌거나 highRes 가 꺼지면 loaded 플래그 리셋 → 다음 진입 시 깜빡임 없이 다시 fade-in.
    setHighResLoaded(false);
  }, [highResSrc]);
  const tx = transform.flipH ? -1 : 1;
  const ty = transform.flipV ? -1 : 1;
  // scale 은 *transform 의 w/h* 가 이미 렌더 크기를 결정하므로 1x 유지.
  // ⚠️ identity (1,1) 일 땐 transform 자체를 생략해야 한다 — 동일 결과지만 inner div
  // 가 transform 속성을 들고 있으면 GPU 합성 layer 가 분리되고, 그 안쪽에서 매우
  // 큰 % 값 (예: width: 355%, left: -156%) 이 일부 환경에서 정상 렌더되지 않는
  // 케이스가 있어 v2 crop image 가 비어 보이는 회귀 발생.
  const needFlip = transform.flipH || transform.flipV;
  const flipTransform: string | undefined = needFlip ? `scale(${tx}, ${ty})` : undefined;
  // v2 — per-item 시각 효과 합성. 모두 optional 이라 미지정 시 기존 외형과 동일.
  // filter 는 grayscale + invert 두 함수를 함께 적용 (둘 다 켜진 케이스 = 반전된
  // 흑백으로 자연스러운 합성). 사용자 opacity 는 wrapper opacity 에 별도 부여.
  const filters: string[] = [];
  // Grayscale 은 "약간 딤드된 흑백" 으로 — 순수 흑백보다 한 톤 가라앉혀 무드 보드
  // 에서 비활성/배경 자료처럼 차분하게 보이도록 brightness 를 함께 낮춘다.
  if (transform.grayscale) filters.push("grayscale(1)", "brightness(0.72)");
  if (transform.invert) filters.push("invert(1)");
  const wrapperStyle: CSSProperties = {
    position: "absolute",
    left: transform.x,
    top: transform.y,
    width: transform.w,
    height: transform.h,
    transform: `rotate(${transform.rotation}rad) translate3d(0,0,0)`,
    transformOrigin: "center",
    zIndex: transform.zIndex,
    // 자식 paint/layout 이 부모 reflow 를 트리거하지 않게 격리 — 500-item
    // 폴더에서 transient 시 다른 카드의 layout invalidate 를 줄인다.
    contain: "layout style paint",
    opacity: typeof transform.opacity === "number" ? Math.max(0, Math.min(1, transform.opacity)) : undefined,
    filter: filters.length > 0 ? filters.join(" ") : undefined,
    borderRadius: transform.borderRadius && transform.borderRadius > 0
      ? Math.min(transform.borderRadius, transform.w / 2, transform.h / 2)
      : undefined,
    overflow: "hidden",
    boxShadow: transform.shadow ? "0 6px 24px rgba(0,0,0,0.35)" : undefined,
    // 흰색 border 가 카드 가장자리에 직접 — Tailwind ring 과 달리 outset 이라
    // 카드 폭이 변하지 않는다 (border 가 박스에 inset 되도록 box-sizing 은 그대로).
    border: transform.borderWidth && transform.borderWidth > 0
      ? `${transform.borderWidth}px solid rgba(255,255,255,0.9)`
      : undefined,
    // crop 은 wrapper 자체가 *visible 크기* (baked) 이므로 clip-path 가 필요
    // 없다. 이미지 element 안쪽에서 width/height/left/top 으로 *natural 의 잘린
    // 부분만 wrapper 에 보이도록* 직접 배치 (cropImageStyle 헬퍼 — 아래).
  };

  // ── 비디오 호버 재생 / 타임라인 스크럽 — 그리드(LibraryMediaThumbnail) 포팅 ──
  // 호버 진입 시 재생만 시작(호버 state 는 카드 wrapper 가 관리).
  const playVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {
      /* 호버 프리뷰는 opportunistic — 큰 프리뷰 패널에 컨트롤이 따로 있다. */
    });
  };

  // 호버 해제 시 정지 + 첫 프레임으로 되돌림. 화면상으로는 showVideoFrame=false 가
  // 되어 정지 썸네일이 비치므로 마지막 프레임이 박히지 않는다.
  const pauseVideo = () => {
    const video = videoRef.current;
    setScrubbing(false);
    scrubbingVideoRef.current = false;
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        /* 일부 코덱에서 seek 가 막힐 수 있으나 표시 자체는 stillSrc 로 덮인다. */
      }
    }
    pendingSeekTimeRef.current = null;
    seekInFlightRef.current = false;
    setVideoTime(0);
  };

  // seek 전 항상 pause — 재생이 seek 위치를 덮어써 "드래그 위치 ≠ 프레임" 이
  // 되는 문제를 막는다. 빠른 드래그는 pendingSeek 로 합쳐 onSeeked 에서 flush.
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

  const seekVideoFromClientX = (clientX: number) => {
    const timeline = timelineRef.current;
    const duration = videoDuration || item.duration_sec || 0;
    if (!timeline || duration <= 0) return;
    const rect = timeline.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    seekVideoTo(Math.max(0, Math.min(1, ratio)) * duration);
  };

  // 타임라인 pointerdown — 스크럽 시작 + window 리스너 부착(얇은 바 밖으로 커서가
  // 나가도 계속 추적). 리스너는 자기 자신을 제거하는 자족 클로저라 add/remove
  // 인스턴스가 항상 일치한다. stopPropagation 으로 캔버스 pan/drag 와 분리.
  const onTimelineScrubStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    scrubbingVideoRef.current = true;
    setScrubbing(true);
    videoRef.current?.pause();
    seekVideoFromClientX(e.clientX);
    const onMove = (ev: globalThis.PointerEvent) => {
      if (!scrubbingVideoRef.current) return;
      ev.preventDefault();
      seekVideoFromClientX(ev.clientX);
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      seekVideoFromClientX(ev.clientX);
      scrubbingVideoRef.current = false;
      setScrubbing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // 스크럽이 끝나도 여전히 호버 중이면 재생 재개. 카드 밖에서 손을 뗐다면
      // (드래그 도중 mouseleave 로 pause 가 보류됐던 경우) 그리드처럼 첫 프레임
      // 으로 되돌리고 정지 썸네일로 복귀.
      if (hoveredRef.current) {
        void videoRef.current?.play().catch(() => undefined);
      } else {
        pauseVideo();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // 화면상 카드 너비가 80px 미만이면 timeline 자체가 가독성 떨어지고 잡음만
  // — 자동 hide. onScreenWidth 는 위쪽 고해상도 overlay 분기에서 이미 계산.
  const showVideoTimeline = isVideo && (hovered || scrubbing) && onScreenWidth >= 80;

  // 카드 본체 — ContextMenuTrigger 의 asChild 자식으로 들어간다. 분리해 두면
  // JSX 가 한 단계 덜 깊어져 가독성과 stable diff 에 유리.
  const card = (
    <div
      data-canvas-item-id={item.id}
      style={wrapperStyle}
      className={cn(
        "group select-none bg-card shadow-sm transition-shadow",
      )}
      onMouseEnter={() => {
        setHovered(true);
        hoveredRef.current = true;
        if (isVideo) playVideo();
      }}
      onMouseLeave={() => {
        setHovered(false);
        hoveredRef.current = false;
        // 스크럽 중(window 리스너 활성)일 땐 pause 를 미뤄 드래그가 끊기지 않게.
        if (isVideo && !scrubbingVideoRef.current) pauseVideo();
      }}
    >
      {/* AI 베리에이션 생성 중 — 원본 카드 위 로딩 오버레이. */}
      {generating ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/55">
          <Loader2 className="h-6 w-6 animate-spin text-white" />
        </div>
      ) : null}
      {/* 좌상단 — 종류/확장자 라벨 (showBadges 하위 showTypeLabel). */}
      {showBadges && showTypeLabel ? (
        <div className="pointer-events-none absolute left-1 top-1 z-30">
          <span className="flex h-5 items-center justify-center bg-secondary px-1.5 text-micro font-medium text-secondary-foreground">
            {resolveTypeLabel(item)}
          </span>
        </div>
      ) : null}
      {/* 우상단 배지 스택 — 베리에이션/즐겨찾기/핀 + 주석(노트). showBadges 마스터. */}
      {showBadges ? (
        <div className="pointer-events-none absolute right-1 top-1 z-30 flex flex-col items-end gap-1">
          {item.variation_of ? (
            <span
              className="flex h-5 items-center justify-center bg-foreground/80 px-1 text-background"
              title={t("library.grid.variationBadge")}
              aria-label={t("library.grid.variationBadge")}
            >
              <Network className="h-3 w-3" />
            </span>
          ) : null}
          {item.is_favorite ? (
            <span className="flex h-5 items-center justify-center bg-primary/90 px-1 text-primary-foreground">
              <Star className="h-3 w-3 fill-current" />
            </span>
          ) : null}
          {item.pinned_at ? (
            <span className="flex h-5 items-center justify-center bg-primary/90 px-1 text-primary-foreground">
              <Pin className="h-3 w-3 fill-current" />
            </span>
          ) : null}
          {showAnnotation && item.timestamp_notes.length > 0 ? (
            <span
              className="flex h-5 items-center justify-center gap-0.5 bg-primary/85 px-1 text-micro text-primary-foreground"
              title={t("library.grid.notesCount", { n: item.timestamp_notes.length })}
            >
              <MessageSquare className="h-3 w-3" />
              {item.timestamp_notes.length}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Selection / lock ring — wrapper 가 곧 visible 인 v2 baked 에서는 inset 0
          (wrapper 전체에 ring). legacy v1 (cropBaked 미설정 + crop 존재) 만 crop
          offset 으로 inset 해야 한다. */}
      {(selected || transform.locked) ? (() => {
        const useInset = !!transform.crop && !transform.cropBaked;
        const insetL = useInset ? (transform.crop?.l ?? 0) : 0;
        const insetT = useInset ? (transform.crop?.t ?? 0) : 0;
        const insetR = useInset ? (transform.crop?.r ?? 0) : 0;
        const insetB = useInset ? (transform.crop?.b ?? 0) : 0;
        return (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute",
              selected && "border-2 border-primary",
              !selected && transform.locked && "border-2 border-foreground/50",
            )}
            style={{
              left: `${insetL * 100}%`,
              top: `${insetT * 100}%`,
              right: `${insetR * 100}%`,
              bottom: `${insetB * 100}%`,
              zIndex: 20,
            }}
          />
        );
      })() : null}
      <div
        style={{ transform: flipTransform, width: "100%", height: "100%" }}
        className="relative overflow-hidden bg-muted"
      >
        {isImageLike ? (() => {
          // crop 적용된 v2 baked 이미지는 *holder div* 한 단계를 두고 그 안에서
          // img 를 100%×100% 로 깐다. holder 의 크기/위치는 *픽셀 절대값* 으로
          // 계산되어 큰 % 값 (예: width:355%, left:-156%) 으로 인한 일부 환경
          // 렌더링 누락 회피.
          //   - 자르기 없음 / 편집 중: holder = wrapper 동일 크기 (inset:0).
          //   - v2 baked: holder 가 origW×origH 픽셀, 음수 left/top 으로 잘리는
          //     좌상단을 밖으로 밀어냄. img 는 그 안에서 100%×100% + object-cover.
          const c = transform.crop;
          const useHolder = !!c && !cropEditing;
          let holderStyle: CSSProperties;
          if (useHolder && c) {
            const spanX = Math.max(0.001, 1 - c.l - c.r);
            const spanY = Math.max(0.001, 1 - c.t - c.b);
            const origW = transform.w / spanX;
            const origH = transform.h / spanY;
            holderStyle = {
              position: "absolute",
              left: -c.l * origW,
              top: -c.t * origH,
              width: origW,
              height: origH,
            };
          } else {
            holderStyle = { position: "absolute", inset: 0 };
          }
          const imgFill: CSSProperties = {
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            pointerEvents: "none",
          };
          return (
            <div style={holderStyle}>
              <img
                src={stillSrc}
                alt={item.title}
                draggable={false}
                className={cn(
                  "transition-opacity duration-150",
                  showAnimated && "opacity-0",
                )}
                style={imgFill}
              />
              {highResSrc ? (
                <img
                  src={highResSrc}
                  alt=""
                  aria-hidden
                  draggable={false}
                  onLoad={() => setHighResLoaded(true)}
                  className={cn(
                    "transition-opacity duration-150",
                    highResLoaded ? "opacity-100" : "opacity-0",
                  )}
                  style={imgFill}
                />
              ) : null}
              {canAnimate ? (
                <img
                  src={animatedSrc}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className={cn(
                    "transition-opacity duration-150",
                    showAnimated ? "opacity-100" : "opacity-0",
                  )}
                  style={imgFill}
                />
              ) : null}
            </div>
          );
        })() : isVideo ? (
          /* dual-layer — 정지 썸네일을 항상 깔고, 그 위 <video> 는 호버/스크럽
             시에만 opacity 로 띄운다. 호버가 끝나면 비디오가 사라지며 아래 정지
             이미지가 그대로 비쳐 항상 썸네일로 복귀한다(그리드와 동일). */
          <>
            {stillSrc ? (
              <img
                src={stillSrc}
                alt={item.title}
                draggable={false}
                className={cn(
                  "absolute inset-0 h-full w-full object-cover transition-opacity duration-150",
                  showVideoFrame && "opacity-0",
                )}
                style={{ pointerEvents: "none" }}
              />
            ) : null}
            <video
              ref={videoRef}
              src={item.file_url ?? undefined}
              poster={stillSrc || undefined}
              muted
              loop
              playsInline
              preload="auto"
              draggable={false}
              className={cn(
                "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150",
                showVideoFrame && "opacity-100",
              )}
              style={{ pointerEvents: "none" }}
              onLoadedMetadata={(ev) => {
                const v = ev.currentTarget;
                if (Number.isFinite(v.duration)) setVideoDuration(v.duration);
                setVideoTime(v.currentTime || 0);
              }}
              onTimeUpdate={(ev) => {
                if (!scrubbing) setVideoTime(ev.currentTarget.currentTime || 0);
              }}
              onSeeked={flushPendingSeek}
            />
          </>
        ) : isUrlLike ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted p-2 text-center">
            {item.thumbnail_url ? (
              <img
                src={stillSrc}
                alt={item.title}
                draggable={false}
                className="h-full w-full object-cover"
                style={{ pointerEvents: "none" }}
              />
            ) : (
              <>
                {item.kind === "youtube" ? (
                  <Youtube className="h-6 w-6 text-muted-foreground" />
                ) : (
                  <LinkIcon className="h-6 w-6 text-muted-foreground" />
                )}
                <div className="line-clamp-2 text-2xs text-muted-foreground">{item.title}</div>
              </>
            )}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
            <FileText className="h-6 w-6" />
          </div>
        )}
      </div>
      {/* 비디오 호버 timeline — 카드 transform 안에 같이 회전한다(rotated
          카드면 timeline 도 회전). pointerdown stopPropagation 으로 캔버스
          드래그와 분리. */}
      {showVideoTimeline ? (
        <div
          className="absolute inset-x-2 bottom-1.5 z-10 flex h-5 cursor-ew-resize items-center rounded bg-black/60 px-1 text-micro text-white opacity-100 transition-opacity"
          onPointerDown={onTimelineScrubStart}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => ev.stopPropagation()}
          title={t("library.grid.scrubHint")}
        >
          {/* timelineRef 는 *내부 진행 트랙* 에 둔다 — px-1 패딩과 우측 시간
              라벨이 차지하는 폭을 빼고 측정해야 드래그 위치가 보이는 진행
              바와 1:1 로 맞는다. pointerdown 은 잡기 쉬운 외곽 div(h-5)에서
              받아 트랙이 얇아도 편하게 스크럽되도록. */}
          <div ref={timelineRef} className="relative h-1 flex-1 rounded bg-white/30">
            <div
              className="absolute inset-y-0 left-0 rounded bg-primary"
              style={{ width: `${videoDuration > 0 ? (videoTime / videoDuration) * 100 : 0}%` }}
            />
          </div>
          <div className="ml-1.5 font-mono tabular-nums">
            {formatTime(videoTime)} / {formatTime(videoDuration)}
          </div>
        </div>
      ) : null}
      {/* 잠금 표시 — 우상단 배지 스택과 겹치지 않게 *카드 중앙* 에, 그리고
          선택됐을 때만 노출한다. 잠긴 카드라는 사실은 회색 외곽 ring 으로 항상
          알 수 있고, 중앙 아이콘은 선택 시 보조 확인용. */}
      {transform.locked && selected ? (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-foreground/80 text-background shadow-sm"
          style={{ borderRadius: 0 }}
          title={t("library.canvas.locked")}
          aria-label={t("library.canvas.locked")}
        >
          <Lock className="h-4 w-4" />
        </div>
      ) : null}
    </div>
  );

  return (
    <ContextMenu>
      {/* 우클릭 컨텍스트 메뉴 — 우선 "이 미디어의 모든 연결 해제" 한 항목만.
          향후 lock/duplicate/sendToBack/delete 등은 contextActions 에 키를
          추가하고 아래 ContextMenuContent 에 ContextMenuItem 한 줄을 더하면
          끝이도록 구조화. asChild 로 카드 div 자체가 트리거가 되어 left-button
          drag/select 동작은 그대로.

          ⚠️ Electron 회귀 회피: Radix Item 의 click → onSelect 체인이
          mousedown 까지만 도달하고 mouseup/click 이 메뉴 항목에 안 도달하는
          케이스가 확인됨 (Electron + 일부 OS 조합). 따라서 onSelect 대신
          onPointerDown 시점에 직접 액션을 실행하고, 메뉴 닫기는 Escape 키를
          document 에 dispatch 해 Radix 의 escape-keydown 리스너로 닫는다.
          Canvas viewport 의 Esc 핸들러는 viewport element 에 직접 attach 돼
          있어 document.dispatchEvent 와 격리되므로 부작용 없음. */}
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        {/* 회전 — 0/90/180/270 프리셋. 단일 아이템뿐 아니라 다중 선택 상태일
            때도 동일 동작(applyEffect 가 selectedIds 전부에 적용). */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <RotateCw className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.rotate")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-40">
            <CanvasContextMenuItem onSelect={() => contextActions.setRotation(0)}>
              0°
            </CanvasContextMenuItem>
            <CanvasContextMenuItem onSelect={() => contextActions.setRotation(Math.PI / 2)}>
              90°
            </CanvasContextMenuItem>
            <CanvasContextMenuItem onSelect={() => contextActions.setRotation(Math.PI)}>
              180°
            </CanvasContextMenuItem>
            <CanvasContextMenuItem onSelect={() => contextActions.setRotation(-Math.PI / 2)}>
              270°
            </CanvasContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {/* 효과 — 토글류. CSS filter / box-shadow / border-radius 가 즉시 반영.
            (아이콘은 Sparkles 대신 SlidersHorizontal — Sparkles 는 앱 전반에서
            AI 기능 표식으로 쓰이고 있어 일반 시각 효과와 의미 충돌.) */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.effects")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({ ...tr, grayscale: !tr.grayscale }))
              }
            >
              <Contrast className="mr-2 h-4 w-4" />
              {t("library.canvas.contextMenu.toggleGrayscale")}
              {transform.grayscale ? " ✓" : ""}
              <ContextMenuShortcut>Ctrl+Alt+G</ContextMenuShortcut>
            </CanvasContextMenuItem>
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({ ...tr, invert: !tr.invert }))
              }
            >
              <Palette className="mr-2 h-4 w-4" />
              {t("library.canvas.contextMenu.toggleInvert")}
              {transform.invert ? " ✓" : ""}
            </CanvasContextMenuItem>
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({ ...tr, shadow: !tr.shadow }))
              }
            >
              <Square className="mr-2 h-4 w-4" />
              {t("library.canvas.contextMenu.toggleShadow")}
              {transform.shadow ? " ✓" : ""}
            </CanvasContextMenuItem>
            <ContextMenuSeparator />
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({
                  ...tr,
                  opacity: tr.opacity === undefined || tr.opacity === 1 ? 0.5 : 1,
                }))
              }
            >
              {t("library.canvas.contextMenu.toggleOpacity")}
              {typeof transform.opacity === "number" && transform.opacity < 1 ? " (50%)" : ""}
            </CanvasContextMenuItem>
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({
                  ...tr,
                  borderRadius: tr.borderRadius && tr.borderRadius > 0 ? 0 : 12,
                }))
              }
            >
              {t("library.canvas.contextMenu.toggleRounded")}
              {transform.borderRadius && transform.borderRadius > 0 ? " ✓" : ""}
            </CanvasContextMenuItem>
            <CanvasContextMenuItem
              onSelect={() =>
                contextActions.applyEffect((tr) => ({
                  ...tr,
                  borderWidth: tr.borderWidth && tr.borderWidth > 0 ? 0 : 3,
                }))
              }
            >
              {t("library.canvas.contextMenu.toggleBorder")}
              {transform.borderWidth && transform.borderWidth > 0 ? " ✓" : ""}
            </CanvasContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <CanvasContextMenuItem onSelect={() => contextActions.cropItem(item.id)}>
          <Crop className="mr-2 h-4 w-4" />
          {t("library.canvas.contextMenu.crop")}
          <ContextMenuShortcut>Shift+C</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <CanvasContextMenuItem onSelect={() => contextActions.toggleHide()}>
          {transform.hidden ? <Eye className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
          {transform.hidden
            ? t("library.canvas.contextMenu.show")
            : t("library.canvas.contextMenu.hide")}
          <ContextMenuShortcut>H</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <CanvasContextMenuItem onSelect={() => contextActions.toggleLock()}>
          {transform.locked ? <Unlock className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
          {transform.locked ? t("library.canvas.unlock") : t("library.canvas.lock")}
          <ContextMenuShortcut>Ctrl+L</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <ContextMenuSeparator />
        <CanvasContextMenuItem onSelect={() => contextActions.group()}>
          <Group className="mr-2 h-4 w-4" />
          {t("library.canvas.contextMenu.group")}
          <ContextMenuShortcut>Ctrl+G</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <CanvasContextMenuItem onSelect={() => contextActions.ungroup()}>
          <Ungroup className="mr-2 h-4 w-4" />
          {t("library.canvas.contextMenu.ungroup")}
          <ContextMenuShortcut>Ctrl+Shift+G</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <ContextMenuSeparator />
        {/* AI 베리에이션 — 휴지통 바로 위에 배치. 정지 이미지(image/webp)에 파일이 있을 때만. */}
        <CanvasContextMenuItem
          disabled={
            Boolean(item.deleted_at)
            || !(item.kind === "image" || item.kind === "webp")
            || !item.file_url
          }
          onSelect={() => contextActions.createVariation(item)}
        >
          <Network className="mr-2 h-4 w-4" />
          {t("library.grid.ctx.createVariation")}
          <ContextMenuShortcut>Alt+V</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <ContextMenuSeparator />
        {/* 휴지통으로 이동 — 그리드 우클릭과 동일. 우클릭 카드가 선택에 포함돼
            있으면 선택 전체, 아니면 그 카드 단건(LibraryPage 가 snapshot 으로
            결정). Del 단축키도 캔버스 전역 Delete 핸들러와 동일 동작. */}
        <CanvasContextMenuItem
          onSelect={() => contextActions.moveToTrash(item)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("library.grid.ctx.moveToTrashSimple")}
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <ContextMenuSeparator />
        {/* Brief/Agent/Conti 추가 — link/doc/삭제됨 자료는 그리드와 동일하게
            비활성. Agent/에셋 승격은 기능 개발 전이지만 그리드와 같은 핸들러로
            연결만 해두어 추후 완성 시 함께 동작한다. */}
        <CanvasContextMenuItem
          disabled={item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)}
          onSelect={() => contextActions.addToBrief(item)}
        >
          {t("library.grid.ctx.addToBrief")}
          <ContextMenuShortcut>Alt+B</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <CanvasContextMenuItem
          disabled={item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)}
          onSelect={() => contextActions.addToAgent(item)}
        >
          {t("library.grid.ctx.addToAgent")}
          <ContextMenuShortcut>Alt+A</ContextMenuShortcut>
        </CanvasContextMenuItem>
        <CanvasContextMenuItem
          disabled={item.kind === "link" || item.kind === "doc" || Boolean(item.deleted_at)}
          onSelect={() => contextActions.addToConti(item)}
        >
          {t("library.grid.ctx.addToConti")}
          <ContextMenuShortcut>Alt+C</ContextMenuShortcut>
        </CanvasContextMenuItem>
        {item.kind === "image" || item.kind === "webp" || Boolean(item.thumbnail_url) ? (
          <>
            <ContextMenuSeparator />
            <CanvasContextMenuItem
              disabled={!(item.thumbnail_url || item.file_url) || Boolean(item.deleted_at)}
              onSelect={() => contextActions.promoteToAsset(item)}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {t("library.grid.ctx.promoteToAsset")}
              <ContextMenuShortcut>Alt+E</ContextMenuShortcut>
            </CanvasContextMenuItem>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!hasConnection}
          onPointerDown={(ev) => {
            if (ev.button !== 0 || !hasConnection) return;
            ev.preventDefault();
            ev.stopPropagation();
            contextActions.unlinkAll(item.id);
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          }}
        >
          <Link2Off className="mr-2 h-4 w-4" />
          {t("library.canvas.contextMenu.unlinkAll")}
        </ContextMenuItem>
        {/* 계보(파생) 점선 — 이 이미지를 끝점으로 갖는 자동 점선이 있을 때만 노출. */}
        {hasVisibleLineage ? (
          <ContextMenuItem
            onPointerDown={(ev) => {
              if (ev.button !== 0) return;
              ev.preventDefault();
              ev.stopPropagation();
              contextActions.hideLineage(item.id);
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            }}
          >
            <Link2Off className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.hideLineage")}
          </ContextMenuItem>
        ) : null}
        {hasHiddenLineage ? (
          <ContextMenuItem
            onPointerDown={(ev) => {
              if (ev.button !== 0) return;
              ev.preventDefault();
              ev.stopPropagation();
              contextActions.restoreLineage(item.id);
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            }}
          >
            <Network className="mr-2 h-4 w-4" />
            {t("library.canvas.contextMenu.restoreLineage")}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 캔버스 컨텍스트 메뉴 항목 — Electron 회귀 회피(onSelect 가 click 체인을
 *  타지 않는 케이스) 를 위해 onPointerDown 시점에 직접 실행하고 Escape 키를
 *  document 에 dispatch 해 Radix 의 외부 close 리스너로 메뉴 닫음. 모든 캔버스
 *  메뉴 항목이 동일 패턴이라 헬퍼로 추출. */
function CanvasContextMenuItem({
  onSelect,
  disabled,
  className,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ContextMenuItem
      disabled={disabled}
      className={className}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || disabled) return;
        ev.preventDefault();
        ev.stopPropagation();
        onSelect();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      }}
    >
      {children}
    </ContextMenuItem>
  );
}

/** 커스텀 equality — selected/animationAutoplay/cameraScale/hasConnection 변경
 *  은 통과, transform 은 필드별 비교(객체 참조만 다르고 내용 같으면 skip),
 *  item 은 참조 비교(폴더 내 같은 ref 면 같은 객체 유지).
 *  contextActions 는 parent 에서 useMemo 로 stable identity 를 유지하므로
 *  여기서는 비교하지 않는다(추가해도 항상 true). */
const CanvasItemView = memo(CanvasItemViewBase, (a, b) => {
  if (a.item !== b.item) return false;
  if (a.selected !== b.selected) return false;
  if (a.animationAutoplay !== b.animationAutoplay) return false;
  if (a.cameraScale !== b.cameraScale) return false;
  // hasConnection 이 바뀌면 컨텍스트 메뉴의 disabled 표시가 달라져야 한다.
  if (a.hasConnection !== b.hasConnection) return false;
  // 계보 점선 숨김/복원 가능 여부가 바뀌면 메뉴 항목 노출이 달라져야 한다.
  if (a.hasVisibleLineage !== b.hasVisibleLineage) return false;
  if (a.hasHiddenLineage !== b.hasHiddenLineage) return false;
  if (a.cropEditing !== b.cropEditing) return false;
  if (a.showBadges !== b.showBadges) return false;
  if (a.showTypeLabel !== b.showTypeLabel) return false;
  if (a.showAnnotation !== b.showAnnotation) return false;
  if (a.generating !== b.generating) return false;
  const ta = a.transform;
  const tb = b.transform;
  if (ta === tb) return true;
  // v2 신규 필드(opacity/grayscale/invert/border/shadow/crop/groupId/hidden) 도
  // 비교 — 사용자가 메뉴에서 효과를 토글했을 때 즉시 반영되어야 함. crop 은
  // 객체라 필드별 얕은 비교.
  const sameCrop = (() => {
    const ca = ta.crop;
    const cb = tb.crop;
    if (!ca && !cb) return true;
    if (!ca || !cb) return false;
    return ca.l === cb.l && ca.t === cb.t && ca.r === cb.r && ca.b === cb.b;
  })();
  return (
    ta.x === tb.x &&
    ta.y === tb.y &&
    ta.w === tb.w &&
    ta.h === tb.h &&
    ta.rotation === tb.rotation &&
    ta.flipH === tb.flipH &&
    ta.flipV === tb.flipV &&
    ta.zIndex === tb.zIndex &&
    ta.locked === tb.locked &&
    ta.opacity === tb.opacity &&
    ta.grayscale === tb.grayscale &&
    ta.invert === tb.invert &&
    ta.borderRadius === tb.borderRadius &&
    ta.borderWidth === tb.borderWidth &&
    ta.shadow === tb.shadow &&
    ta.cropBaked === tb.cropBaked &&
    ta.groupId === tb.groupId &&
    ta.hidden === tb.hidden &&
    sameCrop
  );
});

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface CanvasNoteViewProps {
  note: CanvasNote;
  selected: boolean;
  /** 프롬프트 카드 출력 포트에 연결선이 하나라도 있는지 — 포트 점 채움/아웃라인
   *  구분(미연결=붉은 아웃라인만, 연결=빨간 원 채움). 프롬프트 카드에만 의미. */
  portConnected?: boolean;
  /** 편집 모드 — 더블클릭 시 LibraryCanvas 가 켠다. true 일 때만 contentEditable
   *  활성 + 텍스트 커서. false 일 때는 클릭이 캔버스 드래그/선택으로 흘러간다. */
  editing: boolean;
  onTextChange: (text: string) => void;
  onEditEnd: () => void;
  onDelete: () => void;
  /** ResizeObserver 가 wrapper 의 border-box 높이를 측정해 부모(LibraryCanvas)
   *  에 보고. 부모는 이 값을 SelectionOverlay/마퀴/hitTest 등에 사용. */
  onMeasured?: (noteId: string, h: number) => void;
}

/** bgColor 키 → tailwind class 매핑 (legacy 프리셋 호환).
 *  신규 입력은 항상 hex 또는 "transparent" 로 들어오지만, 기존 노트가
 *  "yellow"/"blue"/... 같은 preset 키를 갖고 있을 수 있어 lookup 으로 폴백. */
const NOTE_BG_CLASSES: Record<string, string> = {
  yellow: "bg-yellow-100/95",
  blue: "bg-blue-100/95",
  green: "bg-green-100/95",
  pink: "bg-pink-100/95",
  purple: "bg-purple-100/95",
  gray: "bg-zinc-100/95",
  white: "bg-white/95",
  transparent: "bg-transparent",
};

/** legacy bgColor preset 키 → hex 변환 (NoteToolbar 의 swatch 표시용 +
 *  ColorPicker 의 value 로 넘길 hex). transparent / 알 수 없는 키는 null. */
function resolveNoteBgHex(bgColor: string | undefined): string | null {
  if (!bgColor) return "#fef9c3"; // 디폴트 yellow (legacy 노란 노트)
  if (bgColor === "transparent") return null;
  if (bgColor in NOTE_BG_HEX) return NOTE_BG_HEX[bgColor];
  if (/^#?[0-9a-f]{6}$/i.test(bgColor)) {
    return bgColor.startsWith("#") ? bgColor : `#${bgColor}`;
  }
  return null;
}

function CanvasNoteView({ note, selected, portConnected, editing, onTextChange, onEditEnd, onMeasured }: CanvasNoteViewProps) {
  const t = useT();
  // uncontrolled — contentEditable 의 IME 와 selection 안정성을 위해 React 상태에서 분리
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.textContent !== note.text) {
      ref.current.textContent = note.text;
    }
  }, [note.text]);

  // 편집 모드 진입 시 contentEditable 에 focus + 끝으로 caret 이동.
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current;
    el.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* selection API 가 없는 환경 — 무시 */
    }
  }, [editing]);

  // ResizeObserver — wrapper 의 border-box 높이를 측정해 부모에 보고.
  // 텍스트 wrap / fontSize 변동 / width resize 시 자동으로 트리거된다. CSS
  // transform(rotate)는 layout box 에 영향 없으므로 측정값은 캔버스 좌표
  // 기준 그대로 (= 카메라 scale 영향 X — plane 의 transform 만 적용되니까).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        let h: number | undefined;
        // borderBoxSize 가 있으면 우선 사용 (border + padding 포함). 없으면
        // contentRect 에 padding 추정 (py-1 = 8px) 더해 fallback.
        const sizes = entry.borderBoxSize;
        if (sizes && sizes.length > 0) {
          h = sizes[0].blockSize;
        } else {
          h = entry.contentRect.height + 8;
        }
        if (h !== undefined) onMeasured?.(note.id, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [note.id, onMeasured]);

  // bgColor 미지정 fallback: transparent (legacy 는 yellow 였으나 export 와 일관
  // 되지 않아 "DOM 에는 노란 노트, export 엔 안 보이거나 / export 엔 흰박스" 라는
  // 비대칭 회귀 발생). 신규 addNote 도 명시적으로 "transparent" 를 박는다.
  const bgClass = note.bgColor && NOTE_BG_CLASSES[note.bgColor]
    ? NOTE_BG_CLASSES[note.bgColor]
    : note.bgColor
      ? "" // hex / 알 수 없는 키 — inline 으로
      : NOTE_BG_CLASSES.transparent;
  const isHexBg = note.bgColor && !NOTE_BG_CLASSES[note.bgColor];

  const wrapperStyle: CSSProperties = {
    position: "absolute",
    left: note.x,
    top: note.y,
    width: note.width,
    // line-height 1.2 + py-1 패딩 8px 와 *정확히 일치* 하는 minHeight.
    // 이전엔 `1.3 + 8` 이라 line box(1.2)보다 0.1em 더 컸고, 그 잉여 공간이
    // *항상 아래쪽에* 깔려 "하단 여백이 더 커 보인다" 는 시각 불균형이 났다.
    // 작은 폰트(<10px) 의 클릭 영역 확보를 위해 절대 floor 20px 만 유지.
    minHeight: Math.max(20, note.fontSize * 1.2 + 8),
    lineHeight: 1.2,
    transform: `rotate(${note.rotation}rad)`,
    transformOrigin: "center",
    zIndex: note.zIndex,
    fontSize: note.fontSize,
    color: note.color ?? "inherit",
    fontWeight: note.bold ? 700 : 400,
    fontStyle: note.italic ? "italic" : "normal",
    textDecoration: note.underline ? "underline" : "none",
    textAlign: note.align ?? "left",
    // 편집 중이 아니면 wrapper 전체에 move 커서 — 노트가 끌어 옮길 수 있는
    // 객체임을 시각적으로 알린다. 편집 중에는 아래 contentEditable 의 text
    // 커서가 우선 적용.
    cursor: editing ? "text" : "move",
    ...(isHexBg ? { background: note.bgColor } : {}),
  };

  return (
    <div
      ref={wrapperRef}
      data-canvas-note-id={note.id}
      // 노트 wrapper 와 자식 텍스트 어디서든 native HTML5 drag 가 *절대* 시작되지
      // 않도록 차단. 안 그러면 텍스트 선택 → 드래그가 OS file-drop 시퀀스와 같은
      // 이벤트 흐름을 만들어 viewport 의 OS drop 오버레이("이미지나 영상을
      // 놓으세요")가 잘못 떠 버린다. draggable=false + onDragStart preventDefault
      // 둘 다 — 브라우저 마다 한 쪽만으로는 새는 케이스 있음.
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={wrapperStyle}
      className={cn(
        "text-foreground",
        // 프롬프트 카드(role=prompt): AI 생성 노드와 동일한 프레임 — 솔리드
        // 테두리 + popover 배경 + 헤더바 + 안쪽 텍스트 박스. (일반 노트는 기존
        // rounded 투명 노트 스타일 유지.)
        note.role === "prompt"
          ? "flex flex-col border border-primary/60 bg-popover/95 shadow-lg"
          : cn("rounded-sm px-2 py-1 shadow-sm", bgClass),
        // 다중 선택 중에도 ring 유지 — 잠금 레이어와 섞일 때 잠금/선택을
        // 색으로 분리해 보여주는 게 가장 빠른 식별 신호다.
        selected && "ring-2 ring-primary",
        !editing && !selected && note.role !== "prompt" && "hover:outline hover:outline-1 hover:outline-primary/40",
      )}
    >
      {/* 프롬프트 카드 우측 출력 포트 점 — 프롬프트는 gen 노드로 나가는 출력
          성격이라 우변 중앙(fixedPortAnchor 의 MR 와 동일). 노트는 렌더 높이와
          앵커 높이(noteHeights)가 일치하므로 top:50% 로 둬도 연결선과 맞는다.
          시각 전용(pointer-events 없음). */}
      {note.role === "prompt" ? (
        <span
          aria-hidden
          title={t("library.canvas.note.portPrompt")}
          className={cn(
            "pointer-events-none absolute top-1/2 right-0 h-2.5 w-2.5 -translate-y-1/2 translate-x-1/2 rounded-full border border-primary",
            portConnected ? "bg-primary" : "bg-background",
          )}
        />
      ) : null}
      {/* 프롬프트 카드 헤더 — AI 생성 노드와 동일한 헤더바(아이콘 + 라벨). */}
      {note.role === "prompt" ? (
        <div className="flex items-center gap-1 border-b border-primary/40 bg-primary/10 px-1.5 py-1">
          <Sparkles className="h-3 w-3 text-primary" />
          <span className="text-2xs font-semibold tracking-wide text-foreground">
            {t("library.canvas.note.rolePromptBadge")}
          </span>
        </div>
      ) : null}
      <div
        ref={ref}
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        draggable={false}
        onDragStart={(e) => { if (!editing) e.preventDefault(); }}
        className={cn(
          // min-h 를 제거 — inner div 가 line box 보다 클 필요가 없다.
          // wrapper minHeight 가 클릭 영역과 빈 노트 시각 보장.
          "w-full whitespace-pre-wrap break-words outline-none",
          editing ? "cursor-text" : "cursor-move select-none",
          // 프롬프트 카드: 헤더 아래 텍스트 박스 — 안쪽 패딩으로 입력 영역 확보.
          note.role === "prompt" && "px-1.5 py-1",
        )}
        onBlur={(e) => {
          onTextChange(e.currentTarget.textContent ?? "");
          onEditEnd();
        }}
        onKeyDown={(e) => {
          if (!editing) return;
          // Esc → 편집 종료(내용은 보존). 글로벌 Esc 핸들러가 selection 을
          // 비우는 것을 방지하기 위해 stopPropagation.
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).blur();
          }
        }}
        onPointerDown={(e) => {
          // 편집 중일 때만 캔버스 드래그 흡수 — 그렇지 않으면 클릭이 캔버스로
          // 흘러가 hit-test 를 통해 selection + drag 가 시작된다.
          if (editing) e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          // 더블클릭은 LibraryCanvas viewport 가 받아 setEditingNoteId 호출.
          // 여기선 stopPropagation 하지 않아야 한 번에 모드 진입.
          if (!editing) return;
          // 편집 중에 더블클릭은 *단어 선택* 표준 동작 — stopPropagation 으로
          // 캔버스의 더블클릭이 ref open 으로 오인되지 않게 차단.
          e.stopPropagation();
        }}
      />
      {/* URL 인디케이터 — 노트 우상단 작은 link 칩. 클릭 시 OS 기본 브라우저로
          첨부 URL 을 연다 (편집 모드와 무관). pointerDown stopPropagation 으로
          캔버스 드래그/선택 흡수와 분리. */}
      {note.url ? (
        <button
          type="button"
          className="absolute right-1 top-1 flex h-4 items-center gap-0.5 rounded bg-primary/90 px-1 text-nano font-medium text-primary-foreground shadow-sm hover:bg-primary"
          title={note.url}
          aria-label={note.url}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void openExternalUrl(note.url!).catch(() => {
              /* toast 는 toolbar 의 openNow 가 담당. 인디케이터 클릭의 실패는 silent. */
            });
          }}
        >
          <LinkIcon className="h-2.5 w-2.5" />
        </button>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * MediaIslandBackground — 캔버스 위 *모든 객체* (ref + 노트) 를 감싸는 옅은
 * 톤의 단일 배경 박스. PureRef 의 island bg 패턴. plane 안에 있어 카메라 zoom
 * 에 자연 비례한다.
 *
 * - 회전된 객체도 itemAABB 로 axis-aligned bbox 처리.
 * - 노트 높이는 noteHeights (실측) 우선, 없으면 fontSize 기반 fallback.
 * - PADDING 만큼 외곽 마진을 주어 가장자리 객체가 박스 경계에 닿지 않게.
 * - z-index 음수 + pointerEvents none — 항상 가장 뒤이며 클릭 흡수 X.
 * - items + notes 모두 0개면 null.
 * ────────────────────────────────────────────────────────────── */

interface MediaIslandBackgroundProps {
  items: Record<string, CanvasItemTransform>;
  notes: CanvasNote[];
  /** AI 생성 노드 — items/notes 와 함께 island 박스에 감싸진다(누락 시 노드가
   *  "캔버스 영역" 밖에 떠 보임). */
  genNodes?: CanvasGenNode[];
  /** 노트 실측 border-box 높이 — 측정 전 노트는 fontSize 기반 fallback 사용. */
  noteHeights: ReadonlyMap<string, number>;
}

function MediaIslandBackground({ items, notes, genNodes, noteHeights }: MediaIslandBackgroundProps) {
  const PADDING = 32;
  const rects: Rect[] = [];
  for (const tr of Object.values(items)) rects.push(itemAABB(tr));
  for (const n of notes) {
    const h = noteHeights.get(n.id) ?? Math.max(20, n.fontSize * 1.2 + 8);
    rects.push(
      itemAABB({
        x: n.x,
        y: n.y,
        w: n.width,
        h,
        rotation: n.rotation,
        zIndex: n.zIndex,
      }),
    );
  }
  for (const g of genNodes ?? []) {
    if (g.hidden) continue;
    rects.push({ x: g.x, y: g.y, w: g.w, h: g.h });
  }
  const bbox = unionBBox(rects);
  if (!bbox) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-md bg-foreground/[0.04]"
      style={{
        left: bbox.x - PADDING,
        top: bbox.y - PADDING,
        width: bbox.w + PADDING * 2,
        height: bbox.h + PADDING * 2,
        zIndex: -1,
      }}
    />
  );
}

/* ──────────────────────────────────────────────────────────────
 * ConnectionLayer — 캔버스 내 모든 connection 을 SVG 로 그리는 레이어. plane
 * 안에 있어 카메라 zoom 에 따라 굵기/길이가 자연 비례. from/to 는 노트/ref
 * 자유 조합 가능.
 *
 * Anchor 모델: 객체당 *8 anchor* (4 코너 + 4 변 중심) 로 양자화. 두 객체의
 * 캔버스 픽셀 dx/dy 비율로 결정 — `decideAnchor8` 참조.
 * 그룹핑(루트 효과): 같은 (객체, 변) 으로 가는 라인이 2개 이상이면 그 변의
 * *중심* 으로 모두 합쳐 한 점에서 갈라지는 트리 룩.
 * 사용자가 의도적으로 박은 *내부* anchor (변과 멀리)는 강한 신호로 보고 그대로
 * 유지, 그룹핑 대상에서 제외.
 * 끝점 객체가 사라졌으면 그 connection 은 무시 (안 그림).
 * ────────────────────────────────────────────────────────────── */

interface ConnectionLayerProps {
  connections: CanvasConnection[];
  /** 파생 베리에이션 엣지(item id 쌍) — variation_of 계보로 자동 그려지는 점선.
   *  저장되지 않고 선택/삭제도 불가(시각 전용). */
  derivedEdges?: Array<{ from: string; to: string }>;
  /** 실제 렌더되는 item id 집합 — 삭제/필터된 끝점의 연결선은 그리지 않는다. */
  visibleItemIds?: ReadonlySet<string>;
  notes: CanvasNote[];
  items: Record<string, CanvasItemTransform>;
  /** AI 생성 노드 — 연결 끝점이 gen 일 때 transform 조회용. */
  genNodes?: CanvasGenNode[];
  /** 노트의 실측 border-box 높이 — 측정 안 된 경우 fallback 으로 정적 추정. */
  noteHeights: ReadonlyMap<string, number>;
  /** 현재 선택된 connection.id — 라인 굵기/하이라이트 강조에 사용. */
  selectedConnectionId: string | null;
  /** 라인 left-click → connection 선택. ConnectionToolbar / AnchorEditor 노출. */
  onSelectConnection: (connectionId: string) => void;
  /** 라인 우클릭 → "이 연결 해제". 단일 connection.id 만 즉시 제거. */
  onUnlinkConnection: (connectionId: string) => void;
  /** 파생 엣지 우클릭 → 해제(숨김). 키는 `${from}>${to}`. */
  onDismissDerivedEdge?: (key: string) => void;
}

function ConnectionLayer({
  connections,
  derivedEdges,
  visibleItemIds,
  notes,
  items,
  genNodes,
  noteHeights,
  selectedConnectionId,
  onSelectConnection,
  onUnlinkConnection,
  onDismissDerivedEdge,
}: ConnectionLayerProps) {
  const t = useT();
  // 노트 id → transform 빠른 조회. height 는 측정값 우선.
  const noteMap = new Map<string, CanvasItemTransform>();
  for (const n of notes) {
    const h = noteHeights.get(n.id) ?? Math.max(20, n.fontSize * 1.2 + 8);
    noteMap.set(n.id, {
      x: n.x,
      y: n.y,
      w: n.width,
      h,
      rotation: n.rotation,
      zIndex: n.zIndex,
    });
  }
  // gen 노드 id → transform 빠른 조회.
  const genMap = new Map<string, CanvasItemTransform>();
  for (const g of genNodes ?? []) {
    // 캔버스 HIDE 된 gen 노드는 genMap 에서 제외 → 그 노드를 끝점으로 하는
    // 연결선도 자동 스킵(숨긴 노드는 선도 같이 숨김).
    if (g.hidden) continue;
    genMap.set(g.id, { x: g.x, y: g.y, w: g.w, h: g.h, rotation: 0, zIndex: g.zIndex });
  }
  // 프롬프트 카드(role=prompt) id 집합 — 고정 출력 포트 앵커 판정에 사용.
  const promptNoteIds = new Set<string>();
  for (const n of notes) if (n.role === "prompt") promptNoteIds.add(n.id);
  /** kind+id 로 transform 조회. 사라진 객체는 null 반환 → 그 connection skip.
   *  item 은 삭제(휴지통)·필터로 *안 보이는* 경우에도 layout.items 에 transform
   *  이 보존되므로, visibleItemIds 가 주어지면 보이는 항목만 통과시킨다.
   *  또한 캔버스 HIDE(tr.hidden) 된 항목은 카드가 안 그려지므로 연결선도 같이
   *  숨긴다(PNG 내보내기 경로와 동일 정책). */
  const lookupTransform = (kind: ConnectionNodeKind, id: string): CanvasItemTransform | null => {
    if (kind === "note") return noteMap.get(id) ?? null;
    if (kind === "gen") return genMap.get(id) ?? null;
    if (visibleItemIds && !visibleItemIds.has(id)) return null;
    const tr = items[id];
    if (!tr || tr.hidden) return null;
    return tr;
  };

  // 8-슬롯 모델 + Auto-anchor:
  //   - anchorLocked === true → 저장된 anchor 그대로 사용 (사용자가 명시 고정).
  //   - 그 외 → 매 render *상대 객체 중심* 기준 가장 가까운 슬롯으로 재계산.
  //     객체 이동 시 라인이 항상 가까운 변끼리로 흐름 → 부자연스러움 회피.
  const lines: Array<{ c: CanvasConnection; from: Point; to: Point; fromAnchor: ConnectionAnchor; toAnchor: ConnectionAnchor; fromT: CanvasItemTransform; toT: CanvasItemTransform; portFrom: boolean; portTo: boolean }> = [];
  for (const c of connections) {
    const fromT = lookupTransform(c.from.kind, c.from.id);
    const toT = lookupTransform(c.to.kind, c.to.id);
    if (!fromT || !toT) continue;
    const toCenter: Point = { x: toT.x + toT.w / 2, y: toT.y + toT.h / 2 };
    const fromCenter: Point = { x: fromT.x + fromT.w / 2, y: fromT.y + fromT.h / 2 };
    // 고정 포트(gen 입·출력 / prompt 출력)는 anchorLocked 다음 우선순위로 적용.
    // 그 외에는 기존 nearestSlot 자동 앵커.
    const fromFixed = fixedPortAnchor(c.from.kind, c.linkType, promptNoteIds.has(c.from.id));
    const toFixed = fixedPortAnchor(c.to.kind, c.linkType, promptNoteIds.has(c.to.id));
    const fromAnchor =
      c.from.anchorLocked && c.from.anchor
        ? c.from.anchor
        : fromFixed ?? nearestSlot(fromT, toCenter).anchor;
    const toAnchor =
      c.to.anchorLocked && c.to.anchor
        ? c.to.anchor
        : toFixed ?? nearestSlot(toT, fromCenter).anchor;
    const fromPt = localToCanvas(fromT, fromAnchor);
    const toPt = localToCanvas(toT, toAnchor);
    // 고정 포트(gen 노드 좌·우 / 프롬프트 우)로 끝나는 끝점은 포트 점에 그대로
    // 꽂히도록 gap 0 — 여러 입력선이 좌측 포트 하나로 모여 "묶여 보이게"
    // (출력과 동일). 아래 ConnectionLine 에서 그 끝점의 화살표도 생략한다.
    const fromIsPort = c.from.kind === "gen" || (c.from.kind === "note" && promptNoteIds.has(c.from.id));
    const toIsPort = c.to.kind === "gen" || (c.to.kind === "note" && promptNoteIds.has(c.to.id));
    // GAP padding — 양 끝을 from→to 방향으로 *바깥* 으로 밀어 화살표가 객체
    // 가장자리에 닿지 않게. 비대칭 적용:
    //   · GAP_FROM = 4  : 출발 객체와 라인 사이는 가까이 — 노트 텍스트와 라인이
    //     시각적으로 연속돼 "여기서 출발" 의도가 명확.
    //   · GAP_TO   = 12 : 도착 객체와 화살표 사이는 충분히 띄움 — 화살표 tip 이
    //     이미지 가장자리에 묻혀 안 보이는 회귀 방지.
    //   · 포트 끝점은 0 — 포트 점에 라인이 꽂힌다.
    const GAP_FROM = fromIsPort ? 0 : 4;
    const GAP_TO = toIsPort ? 0 : 12;
    const dxv = toPt.x - fromPt.x;
    const dyv = toPt.y - fromPt.y;
    const len = Math.hypot(dxv, dyv);
    let from = fromPt;
    let to = toPt;
    if (len > GAP_FROM + GAP_TO) {
      const ux = dxv / len;
      const uy = dyv / len;
      from = { x: fromPt.x + ux * GAP_FROM, y: fromPt.y + uy * GAP_FROM };
      to = { x: toPt.x - ux * GAP_TO, y: toPt.y - uy * GAP_TO };
    }
    lines.push({ c, from, to, fromAnchor, toAnchor, fromT, toT, portFrom: fromIsPort, portTo: toIsPort });
  }

  // 파생 베리에이션 엣지 — 실제 connection 과 동일한 anchor/GAP 정책으로 점을
  // 계산하되, 사용자가 명시 connection 으로 이미 이은 쌍은 중복 표시하지 않는다.
  const explicitItemPairs = new Set<string>();
  for (const c of connections) {
    if (c.from.kind === "item" && c.to.kind === "item") {
      explicitItemPairs.add(`${c.from.id}>${c.to.id}`);
      explicitItemPairs.add(`${c.to.id}>${c.from.id}`);
    }
  }
  const derivedLines: Array<{ key: string; from: Point; to: Point; fromAnchor: ConnectionAnchor; toAnchor: ConnectionAnchor; fromT: CanvasItemTransform; toT: CanvasItemTransform }> = [];
  for (const e of derivedEdges ?? []) {
    if (explicitItemPairs.has(`${e.from}>${e.to}`)) continue;
    const fromT = items[e.from];
    const toT = items[e.to];
    if (!fromT || !toT) continue;
    // 끝점 중 하나라도 캔버스 HIDE 면 계보 점선도 같이 숨긴다(연결선과 동일).
    if (fromT.hidden || toT.hidden) continue;
    const toCenter: Point = { x: toT.x + toT.w / 2, y: toT.y + toT.h / 2 };
    const fromCenter: Point = { x: fromT.x + fromT.w / 2, y: fromT.y + fromT.h / 2 };
    const fromAnchor = nearestSlot(fromT, toCenter).anchor;
    const toAnchor = nearestSlot(toT, fromCenter).anchor;
    const fromPt = localToCanvas(fromT, fromAnchor);
    const toPt = localToCanvas(toT, toAnchor);
    const GAP_FROM = 4;
    const GAP_TO = 12;
    const dxv = toPt.x - fromPt.x;
    const dyv = toPt.y - fromPt.y;
    const len = Math.hypot(dxv, dyv);
    let from = fromPt;
    let to = toPt;
    if (len > GAP_FROM + GAP_TO) {
      const ux = dxv / len;
      const uy = dyv / len;
      from = { x: fromPt.x + ux * GAP_FROM, y: fromPt.y + uy * GAP_FROM };
      to = { x: toPt.x - ux * GAP_TO, y: toPt.y - uy * GAP_TO };
    }
    derivedLines.push({ key: `${e.from}>${e.to}`, from, to, fromAnchor, toAnchor, fromT, toT });
  }

  if (lines.length === 0 && derivedLines.length === 0) return null;
  // SVG 자체는 pointer-events: none (캔버스 hit-test 우회). 우클릭 / 좌클릭
  // 선택을 받기 위한 hit path 만 자식에서 stroke 로 opt-in. 시각 라인은
  // pointer-events:none 이라 drag-through 동작은 영향 없음.
  return (
    <svg
      style={{
        position: "absolute",
        left: -100000,
        top: -100000,
        width: 200000,
        height: 200000,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {derivedLines.map((l) => (
        <DerivedEdgeLine
          key={`derived-${l.key}`}
          edgeKey={l.key}
          from={l.from}
          to={l.to}
          fromAnchor={l.fromAnchor}
          toAnchor={l.toAnchor}
          fromT={l.fromT}
          toT={l.toT}
          onDismiss={onDismissDerivedEdge}
          dismissLabel={t("library.canvas.derivedEdge.dismiss")}
        />
      ))}
      {lines.map((l) => (
        <ConnectionLine
          key={l.c.id}
          connection={l.c}
          from={l.from}
          to={l.to}
          fromAnchor={l.fromAnchor}
          toAnchor={l.toAnchor}
          fromT={l.fromT}
          toT={l.toT}
          portFrom={l.portFrom}
          portTo={l.portTo}
          selected={selectedConnectionId === l.c.id}
          onSelect={onSelectConnection}
          onUnlink={onUnlinkConnection}
          unlinkLabel={t("library.canvas.contextMenu.unlinkLine")}
        />
      ))}
    </svg>
  );
}

/** 파생 베리에이션 엣지 — variation_of 계보를 자동으로 보여주는 점선.
 *  실제 connection 과 동일한 edge-tangent bezier 를 쓰되 중립 색(muted)과 점선 +
 *  끝점 화살표로 "원본 → 변형" 방향을 표시한다. 시각 라인은 pointer none 이지만,
 *  좌우 ±7px 의 투명 hit path 를 깔아 *우클릭 → 해제(숨김)* 컨텍스트 메뉴를 받는다. */
function DerivedEdgeLine({
  edgeKey,
  from,
  to,
  fromAnchor,
  toAnchor,
  fromT,
  toT,
  onDismiss,
  dismissLabel,
}: {
  edgeKey: string;
  from: Point;
  to: Point;
  fromAnchor: ConnectionAnchor;
  toAnchor: ConnectionAnchor;
  fromT: CanvasItemTransform;
  toT: CanvasItemTransform;
  onDismiss?: (key: string) => void;
  dismissLabel: string;
}) {
  const fx = from.x + 100000;
  const fy = from.y + 100000;
  const tx2 = to.x + 100000;
  const ty2 = to.y + 100000;
  const dxv = tx2 - fx;
  const dyv = ty2 - fy;
  const dist = Math.hypot(dxv, dyv);
  const STRAIGHT_THRESHOLD = 48;
  const ctrlLen = Math.max(24, Math.min(140, dist * 0.4));
  const fromNormal = anchorOutwardNormal(fromT, fromAnchor);
  const toNormal = anchorOutwardNormal(toT, toAnchor);
  const ctrl1X = fx + fromNormal.x * ctrlLen;
  const ctrl1Y = fy + fromNormal.y * ctrlLen;
  const ctrl2X = tx2 + toNormal.x * ctrlLen;
  const ctrl2Y = ty2 + toNormal.y * ctrlLen;
  const d =
    dist <= STRAIGHT_THRESHOLD
      ? `M ${fx} ${fy} L ${tx2} ${ty2}`
      : `M ${fx} ${fy} C ${ctrl1X} ${ctrl1Y}, ${ctrl2X} ${ctrl2Y}, ${tx2} ${ty2}`;
  const markerId = `cn-derived-arrow-${Math.round(fx)}-${Math.round(fy)}-${Math.round(tx2)}-${Math.round(ty2)}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <g data-connection-ui="derived" style={{ color: "hsl(var(--muted-foreground))", cursor: "context-menu" }}>
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>
          {/* hit path — 좌우 ±7px 투명 stroke 로 우클릭 영역 확보. */}
          <path d={d} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
          {/* 시각 점선 — pointer none 이라 캔버스 드래그-through 안 막음. */}
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeOpacity={0.55}
            strokeDasharray="4 4"
            strokeLinecap="round"
            markerEnd={`url(#${markerId})`}
            pointerEvents="none"
          />
        </g>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem
          onPointerDown={(ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            onDismiss?.(edgeKey);
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          }}
        >
          <Link2Off className="mr-2 h-4 w-4" />
          {dismissLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 라인 한 가닥 + 우클릭 컨텍스트 메뉴.
 *
 *  ⚠️ Electron 회귀 회피: Radix Item 의 click → onSelect 체인이 mousedown 까지만
 *  도달하고 mouseup/click 이 메뉴 항목에 안 도달하는 케이스가 확인됨. 따라서
 *  onSelect 대신 onPointerDown 시점에 직접 액션을 실행하고, 메뉴 닫기는 Escape
 *  키를 document 에 dispatch 해 Radix 의 escape-keydown 리스너로 닫는다.
 *  ContextMenu Root 는 controlled `open` prop 을 미지원해 이 우회 외엔 방법이
 *  없다.
 *
 *  hit area: 동일 path 를 strokeWidth=14 transparent 로 한 장 더 깔아 1.5px 가시
 *  라인 좌우로 ±~7px 까지 우클릭이 잡힌다. */
interface ConnectionLineProps {
  connection: CanvasConnection;
  from: Point;
  to: Point;
  /** auto/lock 해소된 최종 anchor — edge-tangent 곡선 방향 계산에 사용. */
  fromAnchor: ConnectionAnchor;
  toAnchor: ConnectionAnchor;
  /** 객체 transform — anchor 의 outward normal 회전 계산용. */
  fromT: CanvasItemTransform;
  toT: CanvasItemTransform;
  /** 해당 끝점이 고정 포트(gen 노드 / 프롬프트 출력)인지 — 그 끝의 화살표를
   *  생략해 포트 점에 깔끔히 꽂히게 한다(여러 입력선이 한 포트로 묶여 보임). */
  portFrom?: boolean;
  portTo?: boolean;
  selected: boolean;
  onSelect: (connectionId: string) => void;
  onUnlink: (connectionId: string) => void;
  unlinkLabel: string;
}

function ConnectionLine({
  connection,
  from,
  to,
  fromAnchor,
  toAnchor,
  fromT,
  toT,
  portFrom,
  portTo,
  selected,
  onSelect,
  onUnlink,
  unlinkLabel,
}: ConnectionLineProps) {
  const id = connection.id;
  // Edge-tangent cubic bezier:
  //   - 각 끝점에서 *anchor 의 outward normal* 방향으로 control point 확장
  //   - 변에서 라인이 *수직으로* 빠져나가 자연스럽게 합류
  //   - 거리에 적응: control 거리 = clamp(dist × 0.4, 24, 140)
  //   - 매우 짧은 거리(<48px): 직선 fallback (곡률이 의미 없음)
  const fx = from.x + 100000;
  const fy = from.y + 100000;
  const tx2 = to.x + 100000;
  const ty2 = to.y + 100000;
  const dxv = tx2 - fx;
  const dyv = ty2 - fy;
  const dist = Math.hypot(dxv, dyv);
  const STRAIGHT_THRESHOLD = 48;
  const ctrlLen = Math.max(24, Math.min(140, dist * 0.4));

  // anchor 의 outward normal (회전 반영) — canvasGeometry 헬퍼.
  const fromNormal = anchorOutwardNormal(fromT, fromAnchor);
  const toNormal = anchorOutwardNormal(toT, toAnchor);

  // control 1: from 에서 fromNormal 방향으로 ctrlLen 만큼
  const ctrl1X = fx + fromNormal.x * ctrlLen;
  const ctrl1Y = fy + fromNormal.y * ctrlLen;
  // control 2: to 에서 toNormal 방향으로 ctrlLen 만큼
  const ctrl2X = tx2 + toNormal.x * ctrlLen;
  const ctrl2Y = ty2 + toNormal.y * ctrlLen;

  const d =
    dist <= STRAIGHT_THRESHOLD
      ? `M ${fx} ${fy} L ${tx2} ${ty2}`
      : `M ${fx} ${fy} C ${ctrl1X} ${ctrl1Y}, ${ctrl2X} ${ctrl2Y}, ${tx2} ${ty2}`;

  // 스타일 — 모두 optional. 미지정 시 기본값(중립 회색, 두께 2, 실선,
  // 끝점 화살표 ON, 시작점 화살표 OFF). dasharray 는 두께 비례라 라인이
  // 굵어져도 점선 모양이 시각적으로 안 깨짐.
  const s = connection.style ?? {};
  const color = s.color ?? "hsl(var(--muted-foreground))";
  const thickness = s.thickness ?? 2;
  const dashed = s.lineStyle === "dashed";
  const dasharray = dashed ? `${thickness * 3} ${thickness * 2.2}` : undefined;
  // 포트로 끝나는 끝점은 화살표 생략 — 포트 점이 곧 종단 표식이라 화살표가
  // 겹치면 지저분하고, 입력선들이 한 포트로 묶인 인상을 해친다.
  const hasStartArrow = s.endStart === "arrow" && !portFrom;
  const hasEndArrow = (s.endEnd ?? "arrow") === "arrow" && !portTo;
  // 라인별 unique marker — currentColor 상속으로 라인색에 자동 맞춤. defs 를
  // 라인 안에 두면 connection 추가/삭제 시 marker id 충돌 없음.
  const markerStartId = `cn-arrow-start-${id}`;
  const markerEndId = `cn-arrow-end-${id}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <g data-connection-ui="line" style={{ cursor: "context-menu", color }}>
          <defs>
            {hasStartArrow && (
              <marker
                id={markerStartId}
                viewBox="0 0 10 10"
                refX="1"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M10,0 L0,5 L10,10 z" fill="currentColor" />
              </marker>
            )}
            {hasEndArrow && (
              <marker
                id={markerEndId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            )}
          </defs>
          {/* hit path — 두께 비례, 좌클릭 = 선택, 더블클릭 = 연결 해제,
              우클릭 = 컨텍스트 메뉴 */}
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(14, thickness * 6)}
            pointerEvents="stroke"
            onPointerDown={(ev) => {
              if (ev.button === 0) {
                ev.stopPropagation();
                onSelect(id);
              }
            }}
            onDoubleClick={(ev) => {
              // 더블클릭 = 즉시 연결 해제. stopPropagation 필수 — 안 하면 viewport
              // 의 onDoubleClick 으로 버블링돼 hitTest=none 으로 quickAdd(노드 추가)
              // 메뉴까지 같이 떠 버린다.
              ev.stopPropagation();
              onUnlink(id);
            }}
          />
          {/* 시각 라인 — 선택 시 살짝 두껍게 + 불투명도 강화로 강조 */}
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={selected ? thickness + 0.5 : thickness}
            strokeOpacity={selected ? 1 : 0.85}
            strokeDasharray={dasharray}
            strokeLinecap="round"
            markerStart={hasStartArrow ? `url(#${markerStartId})` : undefined}
            markerEnd={hasEndArrow ? `url(#${markerEndId})` : undefined}
            pointerEvents="none"
          />
          {/* 라벨 — 라인 중앙. 글자 채우기(fill)·아웃라인 헤일로(stroke)·크기를
              labelStyle 로 조절. outline "none" 이면 헤일로 생략. rect 폭 측정
              없이 단순하게. */}
          {connection.label ? (() => {
            const ls = connection.labelStyle ?? {};
            const labelFontSize = ls.fontSize ?? 12;
            const labelFill = ls.fillColor ?? "currentColor";
            const hasHalo = ls.outlineColor !== "none";
            const haloColor = ls.outlineColor && ls.outlineColor !== "none"
              ? ls.outlineColor
              : "hsl(var(--background))";
            return (
              <text
                x={(fx + tx2) / 2}
                y={(fy + ty2) / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={labelFontSize}
                fill={labelFill}
                stroke={hasHalo ? haloColor : undefined}
                strokeWidth={hasHalo ? Math.max(2, labelFontSize / 4) : undefined}
                paintOrder="stroke"
                style={{ fontWeight: 600 }}
                pointerEvents="none"
              >
                {connection.label}
              </text>
            );
          })() : null}
        </g>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem
          onPointerDown={(ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            onUnlink(id);
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          }}
        >
          <Link2Off className="mr-2 h-4 w-4" />
          {unlinkLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** AI 생성 노드 뷰(노드 에디터 v2, 셸 단계).
 *  - 자체 pointer 핸들러로 드래그 이동(viewport marquee 와 충돌 안 나게 stopPropagation).
 *  - 출력 종류(image/video) 토글, 삭제 버튼.
 *  - 실행(▶)은 M4 에서 배선 — 지금은 비활성 placeholder.
 *  좌표는 캔버스(plane) 좌표계라 부모 plane 의 transform 으로 카메라가 적용된다. */
/** 생성 노드 사이즈(화면비) 옵션 — openai-image 의 imageSize 문자열로 그대로 전달.
 *  NB2 는 sizeToNB2Aspect 로 9:16/16:9/1:1 로 매핑된다. */
const GEN_SIZE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "1024x1536", labelKey: "library.canvas.gen.sizePortrait" },
  { value: "1536x1024", labelKey: "library.canvas.gen.sizeLandscape" },
  { value: "1024x1024", labelKey: "library.canvas.gen.sizeSquare" },
];

function CanvasGenNodeView({
  node,
  scale,
  selected,
  inputConnected,
  outputConnected,
  imageInputs,
  promptPreview,
  runState,
  onMove,
  onDelete,
  onSetOutputKind,
  onSetModel,
  onSetParams,
  onRun,
}: {
  node: CanvasGenNode;
  scale: number;
  /** 마퀴/Ctrl+A 등으로 이 노드가 선택됐는지 — 선택 ring 시각 피드백용. */
  selected: boolean;
  /** 좌측 입력 포트에 연결된 선이 하나라도 있는지 — 포트 점 채움/아웃라인 구분. */
  inputConnected: boolean;
  /** 우측 출력 포트(결과)에 연결된 선이 하나라도 있는지. */
  outputConnected: boolean;
  /** 연결된 입력 이미지(모델 전달 순서 = 첫 번째 원본). 번호/썸네일 표시용. */
  imageInputs: { id: string; thumb: string }[];
  promptPreview: string;
  runState?: { running?: boolean; error?: string };
  onMove: (id: string, x: number, y: number, commit: boolean) => void;
  onDelete: (id: string) => void;
  onSetOutputKind: (id: string, kind: CanvasGenNode["outputKind"]) => void;
  onSetModel: (id: string, model: string) => void;
  onSetParams: (id: string, patch: Record<string, unknown>) => void;
  onRun: (id: string) => void;
}) {
  const t = useT();
  const dragRef = useRef<{ startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
  const model = node.model ?? getImageModelDefault("canvas");
  const imageSize = (node.params?.imageSize as string | undefined) ?? "1024x1536";
  const quality = (node.params?.quality as GptQuality | undefined) ?? getGptQualityDefault("canvas");
  const isGpt = modelIsGpt("canvas", model);
  const modelOptions = getFeatureSpec("canvas").models;
  const running = !!runState?.running;
  const error = runState?.error;
  const isVideo = node.outputKind === "video";
  const hasPrompt = promptPreview.trim().length > 0;
  const imageCount = imageInputs.length;
  const canRun = !isVideo && imageCount > 0 && hasPrompt && !running;
  const stop = (e: ReactSyntheticEvent) => e.stopPropagation();
  return (
    <div
      data-canvas-gen-id={node.id}
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.w,
        minHeight: node.h,
        zIndex: node.zIndex,
      }}
      className={cn(
        "flex flex-col border border-primary/60 bg-popover/95 shadow-lg",
        selected && "ring-2 ring-primary",
      )}
      onPointerDown={(e) => {
        // 노드 본체 드래그 = 이동. 버튼/컨트롤은 자체 stopPropagation 으로 분리.
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startX: node.x, startY: node.y };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        e.stopPropagation();
        const dx = (e.clientX - d.startClientX) / (scale || 1);
        const dy = (e.clientY - d.startClientY) / (scale || 1);
        onMove(node.id, d.startX + dx, d.startY + dy, false);
      }}
      onPointerUp={(e) => {
        if (!dragRef.current) return;
        e.stopPropagation();
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        onMove(node.id, node.x, node.y, true);
        dragRef.current = null;
      }}
    >
      {/* 고정 입·출력 포트 점 — 좌변=입력, 우변=출력(Result). 연결선이 실제로
          붙는 위치(node.h 의 세로 중앙, fixedPortAnchor 의 ML/MR 와 동일)에 맞춰
          node.h/2 에 둔다. 시각 전용이라 pointer-events 없음(노드 드래그 방해 X).
          연결 안 됨 = 붉은 아웃라인만(bg-background), 하나라도 연결 = 빨간 원 채움. */}
      <span
        aria-hidden
        title={t("library.canvas.gen.portInput")}
        className={cn(
          "pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary",
          inputConnected ? "bg-primary" : "bg-background",
        )}
        style={{ left: 0, top: node.h / 2 }}
      />
      <span
        aria-hidden
        title={t("library.canvas.gen.portOutput")}
        className={cn(
          "pointer-events-none absolute h-2.5 w-2.5 -translate-y-1/2 translate-x-1/2 rounded-full border border-primary",
          outputConnected ? "bg-primary" : "bg-background",
        )}
        style={{ right: 0, top: node.h / 2 }}
      />
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-1 border-b border-primary/40 bg-primary/10 px-1.5 py-1">
        <span className="flex items-center gap-1 text-2xs font-semibold text-foreground">
          <Network className="h-3 w-3 text-primary" />
          {t("library.canvas.quickAdd.genNode")}
        </span>
        <button
          type="button"
          className="flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-destructive"
          title={t("common.delete")}
          onPointerDown={stop}
          onClick={(e) => { e.stopPropagation(); onDelete(node.id); }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {/* 본문 — 출력 종류 / 모델 / 사이즈 / 품질 / 입력 요약 / 실행 */}
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {/* 출력 종류 — 영상은 Vertex API 부재로 보류(비활성) */}
        <div className="flex gap-1">
          {(["image", "video"] as const).map((k) => {
            const disabled = k === "video";
            return (
              <button
                key={k}
                type="button"
                disabled={disabled}
                className={cn(
                  "flex-1 border px-1 py-0.5 text-2xs",
                  node.outputKind === k
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-muted-foreground/30 text-muted-foreground hover:bg-accent",
                  disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
                title={disabled ? t("library.canvas.gen.videoComingSoon") : undefined}
                onPointerDown={stop}
                onClick={(e) => { e.stopPropagation(); if (!disabled) onSetOutputKind(node.id, k); }}
              >
                {k === "image" ? t("library.canvas.gen.outImage") : t("library.canvas.gen.outVideo")}
              </button>
            );
          })}
        </div>

        {/* 모델 */}
        <select
          value={model}
          className="w-full border border-muted-foreground/30 bg-background px-1 py-0.5 text-2xs text-foreground"
          title={t("library.canvas.gen.model")}
          onPointerDown={stop}
          onChange={(e) => { e.stopPropagation(); onSetModel(node.id, e.target.value); }}
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {IMAGE_GEN_MODEL_LABELS[m.id] ?? m.id}
            </option>
          ))}
        </select>

        {/* 사이즈 + (GPT 한정) 품질 */}
        <div className="flex gap-1">
          <select
            value={imageSize}
            className="flex-1 border border-muted-foreground/30 bg-background px-1 py-0.5 text-2xs text-foreground"
            title={t("library.canvas.gen.size")}
            onPointerDown={stop}
            onChange={(e) => { e.stopPropagation(); onSetParams(node.id, { imageSize: e.target.value }); }}
          >
            {GEN_SIZE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.labelKey)}</option>
            ))}
          </select>
          {isGpt ? (
            <select
              value={quality}
              className="flex-1 border border-muted-foreground/30 bg-background px-1 py-0.5 text-2xs text-foreground"
              title={t("library.canvas.gen.quality")}
              onPointerDown={stop}
              onChange={(e) => { e.stopPropagation(); onSetParams(node.id, { quality: e.target.value }); }}
            >
              {(["low", "medium", "high"] as const).map((q) => (
                <option key={q} value={q}>{q}</option>
              ))}
            </select>
          ) : null}
        </div>

        {/* 입력 요약 — 번호 매긴 이미지 목록(전달 순서 = 1번이 원본) + 프롬프트.
            프롬프트에서 "이미지 2의 캐릭터" 처럼 번호로 지칭할 수 있게 한다. */}
        <div className="flex flex-col gap-1 border border-muted-foreground/20 bg-muted/30 px-1.5 py-1">
          {imageCount > 0 ? (
            <div className="flex flex-col gap-1">
              {imageInputs.map((img, i) => (
                <div key={img.id} className="flex items-center gap-1">
                  {img.thumb ? (
                    <img
                      src={img.thumb}
                      alt=""
                      draggable={false}
                      className="h-6 w-6 shrink-0 border border-muted-foreground/30 object-cover"
                    />
                  ) : (
                    <div className="h-6 w-6 shrink-0 border border-muted-foreground/30 bg-muted" />
                  )}
                  <span className="text-micro font-medium text-foreground">
                    {t("library.canvas.gen.imageN", { n: i + 1 })}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-micro text-muted-foreground">
              {t("library.canvas.gen.inputs", { count: 0 })}
            </span>
          )}
          <span className="line-clamp-2 text-micro text-foreground/80">
            {hasPrompt ? promptPreview : t("library.canvas.gen.noPrompt")}
          </span>
        </div>

        {/* 실행 + 상태 */}
        <button
          type="button"
          disabled={!canRun}
          className={cn(
            "flex items-center justify-center gap-1 border px-1 py-1 text-2xs",
            canRun
              ? "border-primary bg-primary/15 text-foreground hover:bg-primary/25"
              : "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/60",
          )}
          title={isVideo ? t("library.canvas.gen.videoComingSoon") : undefined}
          onPointerDown={stop}
          onClick={(e) => { e.stopPropagation(); if (canRun) onRun(node.id); }}
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {running ? t("library.canvas.gen.running") : t("library.canvas.gen.run")}
        </button>
        {error ? (
          <span className="line-clamp-2 text-micro text-destructive" title={error}>{error}</span>
        ) : node.status === "done" && !running ? (
          <span className="text-micro text-emerald-500">{t("library.canvas.gen.done")}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Note 미니 툴바 — 단일 노트 선택 시 노트 위쪽에 floating. viewport 좌표
 * 기준이라 카메라 scale 영향 안 받음(작은 노트라도 토글바는 항상 동일 크기).
 * ────────────────────────────────────────────────────────────── */

interface NoteToolbarProps {
  note: CanvasNote;
  /** 노트 wrapper 의 실측 border-box 높이 (캔버스 좌표). NoteToolbar 가 노트
   *  위쪽으로 떴을 때 화면 상단 클램프 fallback (= 노트 *아래쪽* 으로 이동) 의
   *  거리 계산에 사용. */
  noteHeight: number;
  camera: CanvasCamera;
  viewportRect: DOMRect;
  onMutate: (mut: (n: CanvasNote) => CanvasNote) => void;
}

function NoteToolbar({ note, noteHeight, camera, viewportRect, onMutate }: NoteToolbarProps) {
  const t = useT();
  const noteCenter: Point = { x: note.x + note.width / 2, y: note.y };
  const screenTopMid = canvasToScreen(noteCenter, viewportRect, camera);
  // anchor + 회전 핸들 위치를 모두 피한다:
  //   - TC anchor dot: 노트 상단에서 -10 px (8 px → -6~-14)
  //   - 회전 핸들: 노트 상단에서 -24 px (12 px → -18~-30)
  //   - 툴바 높이 ~34 px → 툴바 top -76 면 bottom -42, 회전 핸들 위 12 px 여유.
  // 화면 위로 잘리면 노트 *아래* 로 이동 — BC anchor (+14) 만 피하면 됨 (+18).
  const left = screenTopMid.x - viewportRect.left;
  let top = screenTopMid.y - viewportRect.top - 76;
  if (top < 4) top = screenTopMid.y - viewportRect.top + noteHeight * camera.scale + 18;

  return (
    <div
      className="absolute z-30 flex items-center gap-0.5 border bg-card px-1 py-1 text-caption shadow-md"
      style={{ left, top, transform: "translateX(-50%)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <NoteToggleButton
        active={!!note.bold}
        title={t("library.canvas.note.bold")}
        onClick={() => onMutate((n) => ({ ...n, bold: !n.bold }))}
      >
        <Bold className="h-3 w-3" />
      </NoteToggleButton>
      <NoteToggleButton
        active={!!note.italic}
        title={t("library.canvas.note.italic")}
        onClick={() => onMutate((n) => ({ ...n, italic: !n.italic }))}
      >
        <Italic className="h-3 w-3" />
      </NoteToggleButton>
      <NoteToggleButton
        active={!!note.underline}
        title={t("library.canvas.note.underline")}
        onClick={() => onMutate((n) => ({ ...n, underline: !n.underline }))}
      >
        <Underline className="h-3 w-3" />
      </NoteToggleButton>

      <Divider />

      <NoteToggleButton
        active={(note.align ?? "left") === "left"}
        title={t("library.canvas.note.align")}
        onClick={() => onMutate((n) => ({ ...n, align: "left" }))}
      >
        <AlignLeft className="h-3 w-3" />
      </NoteToggleButton>
      <NoteToggleButton
        active={note.align === "center"}
        title={t("library.canvas.note.align")}
        onClick={() => onMutate((n) => ({ ...n, align: "center" }))}
      >
        <AlignCenter className="h-3 w-3" />
      </NoteToggleButton>
      <NoteToggleButton
        active={note.align === "right"}
        title={t("library.canvas.note.align")}
        onClick={() => onMutate((n) => ({ ...n, align: "right" }))}
      >
        <AlignRight className="h-3 w-3" />
      </NoteToggleButton>

      <Divider />

      {/* 글자색 — 단일 swatch 트리거 → Popover 안에 풀 ColorPicker (HSV +
          프리셋 + hex 입력). PureRef 와 동일하게 사용자가 원하는 색을 자유롭게
          지정 가능. 텍스트는 항상 값이 필요하므로 allowClear=false. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 items-center gap-1 border border-muted-foreground/30 bg-card px-1 hover:bg-accent"
            title={t("library.canvas.note.color")}
            aria-label={t("library.canvas.note.color")}
          >
            <span className="text-micro font-medium text-muted-foreground">A</span>
            <span
              className="h-3 w-3 border border-muted-foreground/40"
              style={{ background: note.color || "#000000" }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="center"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ColorPicker
            value={note.color ?? "#000000"}
            onChange={(hex) => {
              if (!hex) return; // 텍스트는 null 무시 (allowClear=false 라 발화 안 됨)
              onMutate((n) => ({ ...n, color: hex }));
            }}
            allowClear={false}
            showClearPreset={false}
          />
        </PopoverContent>
      </Popover>

      <Divider />

      {/* 배경색 — 동일 패턴. 추가로 "투명" 옵션은 Clear 버튼으로 매핑 (onChange null
          → bgColor "transparent"). 체크무늬 트리거 swatch 로 투명 상태 시각화. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 items-center gap-1 border border-muted-foreground/30 bg-card px-1 hover:bg-accent"
            title={t("library.canvas.note.bgColor")}
            aria-label={t("library.canvas.note.bgColor")}
          >
            <span className="text-micro font-medium text-muted-foreground">BG</span>
            <span
              className="h-3 w-3 border border-muted-foreground/40"
              style={
                note.bgColor === "transparent" || !resolveNoteBgHex(note.bgColor)
                  ? {
                      background:
                        "repeating-linear-gradient(45deg, transparent 0 3px, rgba(120,120,120,0.5) 3px 4px)",
                    }
                  : { background: resolveNoteBgHex(note.bgColor) ?? "transparent" }
              }
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="center"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ColorPicker
            value={resolveNoteBgHex(note.bgColor)}
            onChange={(hex) => {
              if (hex) {
                onMutate((n) => ({ ...n, bgColor: hex }));
              } else {
                onMutate((n) => ({ ...n, bgColor: "transparent" }));
              }
            }}
            allowClear
            clearLabel={t("library.canvas.note.transparent")}
          />
        </PopoverContent>
      </Popover>

      <Divider />

      {/* 폰트 사이즈 — PureRef 스타일 숫자 입력. 6~200 px 범위, 스피너로 미세
          조절 또는 직접 타이핑. Enter / blur 시 적용, 빈 값/범위 밖은 무시. */}
      <NoteFontSizeInput
        value={note.fontSize}
        onChange={(v) => onMutate((n) => ({ ...n, fontSize: v }))}
        title={t("library.canvas.note.fontSize")}
      />

      <Divider />

      {/* 프롬프트 카드 토글 — 이 노트를 AI 생성 노드의 프롬프트 입력 카드로
          표시(노드 에디터 v2). 켜면 노트에 PROMPT 배지/테두리가 붙고, 생성 노드에
          `linkType:"input"` 연결로 텍스트를 공급한다. 다시 누르면 평범한 노트로. */}
      <NoteToggleButton
        active={note.role === "prompt"}
        title={t("library.canvas.note.rolePrompt")}
        onClick={() =>
          onMutate((n) => ({ ...n, role: n.role === "prompt" ? undefined : "prompt" }))
        }
      >
        <Sparkles className="h-3 w-3" />
      </NoteToggleButton>

      <Divider />

      {/* URL 첨부 — 노트에 외부 링크를 붙인다. http(s) 외 스킴은 메인에서 거부.
          (이전엔 노트→ref 연결 토글이었으나, 그 기능은 L 키 + drag 로 그대로 접근
          가능하므로 toolbar 슬롯을 *진짜 URL 첨부* 로 재용도화.) */}
      <NoteUrlButton
        note={note}
        onMutate={onMutate}
      />
    </div>
  );
}

/** 노트 URL 첨부 popover. 빈 상태 / URL 입력 / 저장된 URL 보기 3가지 모드.
 *  Enter 로 저장, Esc 로 popover 닫힘 (Radix 기본). 저장된 URL 은 외부 브라우저
 *  로 즉시 열기 + 편집 + 제거 가능. */
function NoteUrlButton({
  note,
  onMutate,
}: {
  note: CanvasNote;
  onMutate: (mut: (n: CanvasNote) => CanvasNote) => void;
}) {
  const t = useT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note.url ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  // popover 열릴 때마다 draft 를 현재 url 로 동기화 + autofocus.
  useEffect(() => {
    if (open) {
      setDraft(note.url ?? "");
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, note.url]);
  const hasUrl = !!note.url;

  const normalize = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // http(s) 스킴이 없으면 자동으로 https:// 붙임 — 사용자 입력 편의.
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[\w-]+\.[\w]/.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  };

  const save = () => {
    const url = normalize(draft);
    if (!url) {
      onMutate((n) => ({ ...n, url: undefined }));
      setOpen(false);
      return;
    }
    onMutate((n) => ({ ...n, url }));
    setOpen(false);
  };

  const openNow = async () => {
    if (!note.url) return;
    try {
      await openExternalUrl(note.url);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("library.canvas.note.openFailed"),
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const remove = () => {
    onMutate((n) => ({ ...n, url: undefined }));
    setDraft("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={hasUrl ? "default" : "ghost"}
          size="sm"
          className="h-6 rounded-none px-2"
          title={hasUrl ? t("library.canvas.note.editUrl") : t("library.canvas.note.attachUrl")}
        >
          <LinkIcon className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="center"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <div className="text-caption font-medium text-muted-foreground">
            {hasUrl
              ? t("library.canvas.note.urlAttached")
              : t("library.canvas.note.attachUrlTitle")}
          </div>
          <Input
            ref={inputRef}
            type="url"
            inputMode="url"
            value={draft}
            placeholder="https://..."
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            className="h-8 text-xs"
          />
          <div className="flex items-center justify-end gap-1">
            {hasUrl ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-caption text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={remove}
                >
                  {t("library.canvas.note.removeUrl")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-caption"
                  onClick={openNow}
                >
                  {t("library.canvas.note.openUrl")}
                </Button>
              </>
            ) : null}
            <Button
              variant="default"
              size="sm"
              className="h-7 px-3 text-caption"
              onClick={save}
              disabled={!draft.trim() && !hasUrl}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NoteToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "default" : "ghost"}
      size="sm"
      className="h-6 w-6 rounded-none p-0"
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  );
}

/** Photoshop / PureRef 식 인라인 자르기 편집기.
 *
 *  렌더 위치: viewport 좌표계 (camera scale 영향 없음) — 객체 박스를 screen
 *  좌표로 환산해 그 안쪽에 4 dark mask + crop 영역 border + 8 핸들 (코너 4, 변
 *  중앙 4) 을 그린다.
 *
 *  단축키:
 *    - Enter: commit (저장 후 종료)
 *    - Esc: cancel (변경 사항 폐기 후 종료)
 *    - Right-click on overlay: reset (crop 제거 후 종료) — 우클릭은 contextmenu
 *      preventDefault 로 캔버스 우클릭 메뉴 발화 안 되게 함.
 *
 *  드래그:
 *    - 4 코너: 가로/세로 동시 (해당 코너 위치)
 *    - 4 엣지: 단일 축
 *
 *  rotation > 0 / flip 적용된 객체에서도 사용 가능하지만 정확도가 떨어질 수
 *  있음 — UI 는 객체의 AABB 기준으로 그려진다. */
interface CanvasCropEditorProps {
  /** *원본(unbaked) wrapper* 의 canvas 좌표 — 핸들이 이 영역까지 자유롭게
   *  drag 되어 원본 방향으로 crop 확장 가능. */
  originalRect: { x: number; y: number; w: number; h: number };
  /** 원본 전체 이미지의 URL — overlay 안에 full 이미지 렌더해서 사용자가 잘릴
   *  영역과 잘릴 부분을 동시에 인지할 수 있게 한다. */
  imageSrc: string;
  /** 현재 draft crop (natural 좌표계 0..1 비율). */
  draft: CanvasItemCrop;
  camera: CanvasCamera;
  viewportRect: DOMRect;
  cursorCanvas: (e: { clientX: number; clientY: number }) => Point | null;
  onDraftChange: (next: CanvasItemCrop) => void;
  onCommit: () => void;
  onCancel: () => void;
  onReset: () => void;
}

function CanvasCropEditor({
  originalRect,
  imageSrc,
  draft,
  camera,
  viewportRect,
  cursorCanvas,
  onDraftChange,
  onCommit,
  onCancel,
  onReset,
}: CanvasCropEditorProps) {
  // 키보드 단축키 — mount 동안 document level 에 attach. capture phase 로
  // 캔버스 전역 Esc/Enter 보다 우선 동작.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCommit, onCancel]);

  // 원본 wrapper 의 4 코너 (canvas → screen). 이 box 가 crop 의 *최대 영역* —
  // 핸들이 이 안에서만 움직임. 이미 잘려 있던 wrapper 가 작아도 box 는 원본
  // 크기라 핸들을 밖으로 끌어 원본 방향 확장 가능.
  const tl = canvasToScreen({ x: originalRect.x, y: originalRect.y }, viewportRect, camera);
  const br = canvasToScreen(
    { x: originalRect.x + originalRect.w, y: originalRect.y + originalRect.h },
    viewportRect,
    camera,
  );
  const boxLeft = tl.x - viewportRect.left;
  const boxTop = tl.y - viewportRect.top;
  const boxRight = br.x - viewportRect.left;
  const boxBottom = br.y - viewportRect.top;
  const boxW = boxRight - boxLeft;
  const boxH = boxBottom - boxTop;

  // crop 영역 (screen px).
  const cropLeft = boxLeft + draft.l * boxW;
  const cropTop = boxTop + draft.t * boxH;
  const cropRight = boxRight - draft.r * boxW;
  const cropBottom = boxBottom - draft.b * boxH;
  const cropW = cropRight - cropLeft;
  const cropH = cropBottom - cropTop;

  // 핸들 드래그 — pointer event 흐름 표준. capture pointer / preventDefault.
  // "move" 는 crop 영역 *내부* drag — l/r, t/b 를 함께 평행이동.
  type DragState =
    | { handle: HandleId }
    | { handle: "move"; startLocalX: number; startLocalY: number; startCrop: CanvasItemCrop };
  const dragRef = useRef<DragState | null>(null);
  const startDrag = (e: ReactPointerEvent, handle: HandleId) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { handle };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const startMoveDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cp = cursorCanvas(e);
    if (!cp) return;
    const startLocalX = originalRect.w > 0 ? (cp.x - originalRect.x) / originalRect.w : 0;
    const startLocalY = originalRect.h > 0 ? (cp.y - originalRect.y) / originalRect.h : 0;
    dragRef.current = { handle: "move", startLocalX, startLocalY, startCrop: { ...draft } };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const cp = cursorCanvas(e);
    if (!cp) return;
    // cursor 위치를 *원본 wrapper 안에서의 비율* 로 변환 (0..1). 원본 밖으로
    // 끌면 0 또는 1 로 clamp.
    const localX = originalRect.w > 0 ? (cp.x - originalRect.x) / originalRect.w : 0;
    const localY = originalRect.h > 0 ? (cp.y - originalRect.y) / originalRect.h : 0;
    const clamp = (v: number) => Math.max(0, Math.min(0.95, v));
    const next = { ...draft };
    if (drag.handle === "move") {
      // 평행이동 — 시작 시점 대비 cursor 변화량만큼 l/r, t/b 를 같은 양 만큼 shift.
      // crop 박스 크기 (span) 는 유지. 0..1 범위를 벗어나지 않게 양쪽 동시 clamp.
      const dx = localX - drag.startLocalX;
      const dy = localY - drag.startLocalY;
      const spanX = 1 - drag.startCrop.l - drag.startCrop.r;
      const spanY = 1 - drag.startCrop.t - drag.startCrop.b;
      // l ∈ [0, 1-spanX], 동시에 r = 1 - spanX - l.
      const newL = Math.max(0, Math.min(1 - spanX, drag.startCrop.l + dx));
      const newT = Math.max(0, Math.min(1 - spanY, drag.startCrop.t + dy));
      next.l = newL;
      next.r = 1 - spanX - newL;
      next.t = newT;
      next.b = 1 - spanY - newT;
    } else {
      switch (drag.handle) {
        case "nw":
          next.l = clamp(Math.min(localX, 1 - next.r - 0.05));
          next.t = clamp(Math.min(localY, 1 - next.b - 0.05));
          break;
        case "n":
          next.t = clamp(Math.min(localY, 1 - next.b - 0.05));
          break;
        case "ne":
          next.r = clamp(Math.min(1 - localX, 1 - next.l - 0.05));
          next.t = clamp(Math.min(localY, 1 - next.b - 0.05));
          break;
        case "e":
          next.r = clamp(Math.min(1 - localX, 1 - next.l - 0.05));
          break;
        case "se":
          next.r = clamp(Math.min(1 - localX, 1 - next.l - 0.05));
          next.b = clamp(Math.min(1 - localY, 1 - next.t - 0.05));
          break;
        case "s":
          next.b = clamp(Math.min(1 - localY, 1 - next.t - 0.05));
          break;
        case "sw":
          next.l = clamp(Math.min(localX, 1 - next.r - 0.05));
          next.b = clamp(Math.min(1 - localY, 1 - next.t - 0.05));
          break;
        case "w":
          next.l = clamp(Math.min(localX, 1 - next.r - 0.05));
          break;
      }
    }
    onDraftChange(next);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // Photoshop 식 핸들 디자인:
  //   - 코너 4 곳: 두 변에 걸친 ㄱ 자(L 자) 두 막대 (각각 CORNER_ARM 길이)
  //   - 변 중앙 4 곳: 해당 변과 평행한 짧은 막대 (EDGE_LEN 길이)
  //   - 막대는 boundary line 중앙에 걸쳐 그려져 (절반은 안쪽, 절반은 바깥) 변
  //     자체와 시각적으로 정렬.
  //   - 색은 흰색 + 가는 검은 외곽선 (모든 이미지 위에서 가독 보장).
  //   - 핸들 클릭/드래그는 별도 invisible hit-area 가 받는다 — 시각 막대보다
  //     약간 큰 영역으로 click target 안정.
  const CORNER_ARM = 22;
  const THICK = 3;
  const EDGE_LEN = 32;
  const HIT_PAD = 4;
  const barCls = "absolute bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]";

  return (
    <div
      className="absolute inset-0 z-40"
      onContextMenu={(e) => {
        // 캔버스 우클릭 메뉴 발화 차단 + 원본 복원.
        e.preventDefault();
        e.stopPropagation();
        onReset();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* 원본 전체 이미지 — 사용자가 원본의 어디까지가 보이는지 확인 가능. crop
          영역 안쪽은 그대로, 바깥쪽은 어두운 mask 로 덮인다. */}
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute"
          style={{
            left: boxLeft,
            top: boxTop,
            width: boxW,
            height: boxH,
            objectFit: "cover",
          }}
        />
      ) : null}
      {/* 어두운 mask — crop 영역 외부 4 분할 박스. crop 영역 자체는 비워둠
          (= 원본 이미지 그대로 보임). pointerEvents none 으로 클릭 흡수 X. */}
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: boxLeft, top: boxTop, width: boxW, height: cropTop - boxTop }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: boxLeft, top: cropBottom, width: boxW, height: boxBottom - cropBottom }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: boxLeft, top: cropTop, width: cropLeft - boxLeft, height: cropH }}
      />
      <div
        className="pointer-events-none absolute bg-black/55"
        style={{ left: cropRight, top: cropTop, width: boxRight - cropRight, height: cropH }}
      />
      {/* crop 영역 border — primary 색 1px */}
      <div
        className="pointer-events-none absolute border border-primary"
        style={{ left: cropLeft, top: cropTop, width: cropW, height: cropH }}
      />

      {/* crop 영역 내부 평행이동 — invisible drag 잡이. 핸들보다 *아래* z 로 깔아
          가장자리 핸들 hit-area 가 우선되게. cursor: move 로 UX 시그널. */}
      <div
        className="absolute"
        style={{
          left: cropLeft,
          top: cropTop,
          width: cropW,
          height: cropH,
          cursor: "move",
        }}
        onPointerDown={startMoveDrag}
      />

      {/* ── 변 중앙 4 핸들 (먼저 그려서 코너 L 이 위에 덮음) ── */}
      {/* N (top edge) */}
      <div
        className={cn(barCls, "pointer-events-none")}
        style={{
          left: cropLeft + cropW / 2 - EDGE_LEN / 2,
          top: cropTop - THICK / 2,
          width: EDGE_LEN,
          height: THICK,
        }}
      />
      <div
        className="absolute"
        style={{
          left: cropLeft + cropW / 2 - EDGE_LEN / 2 - HIT_PAD,
          top: cropTop - THICK / 2 - HIT_PAD,
          width: EDGE_LEN + HIT_PAD * 2,
          height: THICK + HIT_PAD * 2,
          cursor: "ns-resize",
        }}
        onPointerDown={(e) => startDrag(e, "n")}
      />
      {/* S */}
      <div
        className={cn(barCls, "pointer-events-none")}
        style={{
          left: cropLeft + cropW / 2 - EDGE_LEN / 2,
          top: cropBottom - THICK / 2,
          width: EDGE_LEN,
          height: THICK,
        }}
      />
      <div
        className="absolute"
        style={{
          left: cropLeft + cropW / 2 - EDGE_LEN / 2 - HIT_PAD,
          top: cropBottom - THICK / 2 - HIT_PAD,
          width: EDGE_LEN + HIT_PAD * 2,
          height: THICK + HIT_PAD * 2,
          cursor: "ns-resize",
        }}
        onPointerDown={(e) => startDrag(e, "s")}
      />
      {/* W */}
      <div
        className={cn(barCls, "pointer-events-none")}
        style={{
          left: cropLeft - THICK / 2,
          top: cropTop + cropH / 2 - EDGE_LEN / 2,
          width: THICK,
          height: EDGE_LEN,
        }}
      />
      <div
        className="absolute"
        style={{
          left: cropLeft - THICK / 2 - HIT_PAD,
          top: cropTop + cropH / 2 - EDGE_LEN / 2 - HIT_PAD,
          width: THICK + HIT_PAD * 2,
          height: EDGE_LEN + HIT_PAD * 2,
          cursor: "ew-resize",
        }}
        onPointerDown={(e) => startDrag(e, "w")}
      />
      {/* E */}
      <div
        className={cn(barCls, "pointer-events-none")}
        style={{
          left: cropRight - THICK / 2,
          top: cropTop + cropH / 2 - EDGE_LEN / 2,
          width: THICK,
          height: EDGE_LEN,
        }}
      />
      <div
        className="absolute"
        style={{
          left: cropRight - THICK / 2 - HIT_PAD,
          top: cropTop + cropH / 2 - EDGE_LEN / 2 - HIT_PAD,
          width: THICK + HIT_PAD * 2,
          height: EDGE_LEN + HIT_PAD * 2,
          cursor: "ew-resize",
        }}
        onPointerDown={(e) => startDrag(e, "e")}
      />

      {/* ── 코너 4 곳: ㄱ 자 (L) — 두 막대 + 통합 hit area ── */}
      {/* NW (top-left): L extends right + down */}
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropLeft, top: cropTop - THICK / 2, width: CORNER_ARM, height: THICK }} />
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropLeft - THICK / 2, top: cropTop, width: THICK, height: CORNER_ARM }} />
      <div
        className="absolute"
        style={{
          left: cropLeft - HIT_PAD,
          top: cropTop - HIT_PAD,
          width: CORNER_ARM + HIT_PAD * 2,
          height: CORNER_ARM + HIT_PAD * 2,
          cursor: "nwse-resize",
        }}
        onPointerDown={(e) => startDrag(e, "nw")}
      />
      {/* NE (top-right): L extends left + down */}
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropRight - CORNER_ARM, top: cropTop - THICK / 2, width: CORNER_ARM, height: THICK }} />
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropRight - THICK / 2, top: cropTop, width: THICK, height: CORNER_ARM }} />
      <div
        className="absolute"
        style={{
          left: cropRight - CORNER_ARM - HIT_PAD,
          top: cropTop - HIT_PAD,
          width: CORNER_ARM + HIT_PAD * 2,
          height: CORNER_ARM + HIT_PAD * 2,
          cursor: "nesw-resize",
        }}
        onPointerDown={(e) => startDrag(e, "ne")}
      />
      {/* SE (bottom-right): L extends left + up */}
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropRight - CORNER_ARM, top: cropBottom - THICK / 2, width: CORNER_ARM, height: THICK }} />
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropRight - THICK / 2, top: cropBottom - CORNER_ARM, width: THICK, height: CORNER_ARM }} />
      <div
        className="absolute"
        style={{
          left: cropRight - CORNER_ARM - HIT_PAD,
          top: cropBottom - CORNER_ARM - HIT_PAD,
          width: CORNER_ARM + HIT_PAD * 2,
          height: CORNER_ARM + HIT_PAD * 2,
          cursor: "nwse-resize",
        }}
        onPointerDown={(e) => startDrag(e, "se")}
      />
      {/* SW (bottom-left): L extends right + up */}
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropLeft, top: cropBottom - THICK / 2, width: CORNER_ARM, height: THICK }} />
      <div className={cn(barCls, "pointer-events-none")} style={{ left: cropLeft - THICK / 2, top: cropBottom - CORNER_ARM, width: THICK, height: CORNER_ARM }} />
      <div
        className="absolute"
        style={{
          left: cropLeft - HIT_PAD,
          top: cropBottom - CORNER_ARM - HIT_PAD,
          width: CORNER_ARM + HIT_PAD * 2,
          height: CORNER_ARM + HIT_PAD * 2,
          cursor: "nesw-resize",
        }}
        onPointerDown={(e) => startDrag(e, "sw")}
      />
    </div>
  );
}

/** PureRef 스타일 폰트 크기 직접 입력. number input + 우측 ▲/▼ 스피너 +
 *  표시 단위 px. Enter 또는 blur 에서 적용. 범위 밖 / 비-숫자 입력은 무시. */
function NoteFontSizeInput({
  value,
  onChange,
  title,
}: {
  value: number;
  onChange: (next: number) => void;
  title: string;
}) {
  const MIN = 6;
  const MAX = 200;
  const [draft, setDraft] = useState<string>(String(value));
  // 외부 value 가 바뀌면 draft 동기화 (다른 곳에서 fontSize 변경 시).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(MIN, Math.min(MAX, n));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const bump = (delta: number) => {
    const next = Math.max(MIN, Math.min(MAX, value + delta));
    if (next !== value) onChange(next);
  };
  return (
    <div className="flex h-6 items-center gap-0.5 border border-muted-foreground/30 bg-background px-1" title={title}>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-1);
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="h-5 w-7 bg-transparent text-center font-mono text-caption tabular-nums outline-none"
        aria-label={title}
      />
      <span className="text-micro text-muted-foreground">px</span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * ObjectLinkAnchor — 단일 선택된 객체의 *8 슬롯* (4 코너 + 4 변 중심) 핸들.
 *
 * - L 모드 진입 시 객체 둘레에 8 점이 항상 떠 있음 (마우스 hover 추적 X).
 * - 슬롯 위에서 pointerdown → 그 슬롯이 from anchor 로 고정. drag 진행.
 * - drop 시 대상 객체에 hit → `nearestSlot` 로 가장 가까운 슬롯에 to anchor.
 *   같은 객체에 떨어지면 무시 (자기 자신 연결 방지).
 *
 * 슬롯 모델 핵심: anchor 가 *연속 좌표* 가 아니라 *한 점 8 후보 중 하나*
 * → 라인 시작/끝점이 시각적으로 예측 가능. 객체 이동 시에도 슬롯은 변하지
 * 않고 함께 이동 (자동 변경 X).
 * ────────────────────────────────────────────────────────────── */

interface ObjectLinkAnchorProps {
  targetKind: "note" | "item";
  targetId: string;
  transform: CanvasItemTransform;
  camera: CanvasCamera;
  viewportRect: DOMRect;
  cursorCanvas: (e: { clientX: number; clientY: number }) => Point | null;
  hitTest: (canvasPt: Point) => HitResult;
  /** 끝점 anchor 계산용 — hit 결과의 transform 을 부모에서 lookup. */
  getNoteTransform: (id: string) => CanvasItemTransform | null;
  getItemTransform: (id: string) => CanvasItemTransform | null;
  getGenTransform: (id: string) => CanvasItemTransform | null;
  onPreviewChange: (preview: {
    fromKind: "note" | "item";
    fromId: string;
    fromAnchor: ConnectionAnchor;
    from: Point;
    to: Point;
  } | null) => void;
  onLinkComplete: (
    from: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
    to: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
  ) => void;
  /** drag 가 *빈 공간* 에서 끝났을 때 — drag-to-create 퀵 추가 메뉴 트리거.
   *  canvasPt 는 놓인 캔버스 좌표, screen 은 화면 좌표(메뉴 위치). */
  onLinkToEmpty?: (
    from: { kind: ConnectionNodeKind; id: string; anchor: ConnectionAnchor },
    canvasPt: Point,
    screen: { x: number; y: number },
  ) => void;
  /** drag 가 종료된 직후 (성공/취소 무관) 호출. linkMode 자동 종료에 사용. */
  onDragEnd?: () => void;
}

function ObjectLinkAnchor({
  targetKind,
  targetId,
  transform,
  camera,
  viewportRect,
  cursorCanvas,
  hitTest,
  getNoteTransform,
  getItemTransform,
  getGenTransform,
  onPreviewChange,
  onLinkComplete,
  onLinkToEmpty,
  onDragEnd,
}: ObjectLinkAnchorProps) {
  const t = useT();
  const [drag, setDrag] = useState<{
    startSlot: AnchorSlot;
    startCanvas: Point;
    startAnchor: ConnectionAnchor;
  } | null>(null);

  // 8 슬롯의 화면 좌표 — 매 렌더 재계산 (8개라 무겁지 않음).
  // ⚠️ anchor dot 은 SelectionOverlay 의 *리사이즈 핸들* 과 같은 8 슬롯 위치라
  // 그대로 그리면 두 UI 가 정확히 겹쳐 리사이즈 클릭이 anchor 로 흡수된다.
  // outward normal 방향으로 *화면 픽셀* 만큼 바깥으로 밀어 두 UI 가 공존 가능
  // 하게 한다. (회전·스케일 무관 — direction 이라 그대로 보존.)
  //
  // 거리 산정:
  //   - 리사이즈 핸들: 8×8 박스, 슬롯 중심에. 박스 영역 ±4px.
  //   - 회전 핸들: 12×12 원, top-center 위 30px (ROTATE_GAP).
  //   - anchor dot: 8×8 원 (ANCHOR_PX). OUT_OFFSET = 10 → 중심 -10px, 영역 -6~-14.
  //   → 리사이즈 위쪽 -4 와 2px 여유, 회전 핸들 아래쪽 -24 와 10px 여유.
  //     두 UI 와 명확히 분리.
  const OUT_OFFSET_PX = 10;
  const slotsScreen = ALL_SLOTS.map((slot) => {
    const anchor = SLOT_UV[slot];
    const canvas = localToCanvas(transform, anchor);
    const baseScreen = canvasToScreen(canvas, viewportRect, camera);
    const normal = anchorOutwardNormal(transform, anchor);
    const screen: Point = {
      x: baseScreen.x + normal.x * OUT_OFFSET_PX,
      y: baseScreen.y + normal.y * OUT_OFFSET_PX,
    };
    return { slot, anchor, canvas, screen };
  });

  const label = t("library.canvas.note.linkSelection");
  // Default: 작은 dot (8px) 로 평소 시야 방해 최소화 + 회전 핸들(12px 흰 원)
  // 과 충돌하지 않게 더 작게. hover 시 1.5× 확대 + primary ring 으로 "여기서
  // 연결" 의도를 강하게 알린다. 드래그 중에도 동일 확대 상태 유지.
  const ANCHOR_PX = 8;

  return (
    <>
      {slotsScreen.map(({ slot, anchor, canvas, screen }) => {
        const left = screen.x - viewportRect.left - ANCHOR_PX / 2;
        const top = screen.y - viewportRect.top - ANCHOR_PX / 2;
        const isDragging = drag?.startSlot === slot;
        return (
          <div
            key={slot}
            role="button"
            aria-label={label}
            title={label}
            data-connection-ui="link-handle"
            className={cn(
              "absolute z-30 rounded-full border border-white/90 bg-primary/80 shadow-sm transition-transform",
              "hover:scale-150 hover:bg-primary hover:ring-2 hover:ring-primary/30",
              isDragging && "scale-150 bg-primary ring-2 ring-primary/40",
            )}
            style={{
              left,
              top,
              width: ANCHOR_PX,
              height: ANCHOR_PX,
              cursor: "crosshair",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setDrag({ startSlot: slot, startCanvas: canvas, startAnchor: anchor });
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                /* 일부 브라우저에서 capture 불가 — 무시 */
              }
              const cp = cursorCanvas(e) ?? canvas;
              onPreviewChange({
                fromKind: targetKind,
                fromId: targetId,
                fromAnchor: anchor,
                from: canvas,
                to: cp,
              });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.startSlot !== slot) return;
              e.stopPropagation();
              const cp = cursorCanvas(e);
              if (!cp) return;
              onPreviewChange({
                fromKind: targetKind,
                fromId: targetId,
                fromAnchor: drag.startAnchor,
                from: drag.startCanvas,
                to: cp,
              });
            }}
            onPointerUp={(e) => {
              if (!drag || drag.startSlot !== slot) return;
              e.stopPropagation();
              try {
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              const cp = cursorCanvas(e);
              const startInfo = drag;
              setDrag(null);
              onPreviewChange(null);
              // 성공 조건: cursor 가 valid 하고, 다른 객체에 hit, 그 객체 transform 존재.
              if (cp) {
                const hit = hitTest(cp);
                const isSelf = hit.kind === targetKind && hit.id === targetId;
                if (hit.kind !== "none" && !isSelf) {
                  const targetT =
                    hit.kind === "note"
                      ? getNoteTransform(hit.id)
                      : hit.kind === "gen"
                        ? getGenTransform(hit.id)
                        : getItemTransform(hit.id);
                  if (targetT) {
                    // 끝점은 대상 객체의 *가장 가까운 슬롯* 에 자동 흡착.
                    const endSnap = nearestSlot(targetT, cp);
                    onLinkComplete(
                      { kind: targetKind, id: targetId, anchor: startInfo.startAnchor },
                      { kind: hit.kind, id: hit.id, anchor: endSnap.anchor },
                    );
                  }
                } else if (hit.kind === "none" && onLinkToEmpty) {
                  // 빈 공간에 놓음 → drag-to-create 퀵 추가 메뉴.
                  onLinkToEmpty(
                    { kind: targetKind, id: targetId, anchor: startInfo.startAnchor },
                    cp,
                    { x: e.clientX, y: e.clientY },
                  );
                }
              }
              // drop 직후 — 성공/취소 무관 부모에 알림 (linkMode 자동 종료용).
              onDragEnd?.();
            }}
            onPointerCancel={(e) => {
              try {
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              setDrag(null);
              onPreviewChange(null);
              onDragEnd?.();
            }}
          />
        );
      })}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────
 * ConnectionAnchorEditor — 선택된 connection 의 양 끝점에 8 슬롯 핸들을
 * 띄우고, *현재 anchor* 슬롯을 강조 표시. 사용자가 활성 슬롯을 다른 슬롯으로
 * drag-drop 하면 그 끝의 anchor 가 갱신된다.
 *
 * UX:
 *   · 8 슬롯 모두 항상 dot 으로 표시 — 다른 슬롯으로 옮길 가능성을 시각화.
 *   · 활성 슬롯 = 라인이 *실제로* 박혀 있는 슬롯 — 더 큰 ring + primary 색.
 *   · 활성 슬롯 dot 위에서 pointerdown → 같은 객체 내 다른 슬롯으로 drag.
 *   · drop 시 가장 가까운 슬롯에 흡착, anchor 갱신.
 *   · 다른 슬롯 dot 도 클릭 가능 → 그 슬롯으로 즉시 이동 (drag 없이도).
 *
 * SelectionOverlay / NoteToolbar 와 동시 표시 가능 — 선택 상호배타 정책에서
 * 라인 선택은 객체 선택과 mutually exclusive 이므로 충돌 없음.
 * ────────────────────────────────────────────────────────────── */

interface ConnectionAnchorEditorProps {
  connection: CanvasConnection;
  fromTransform: CanvasItemTransform;
  toTransform: CanvasItemTransform;
  camera: CanvasCamera;
  viewportRect: DOMRect;
  onSetAnchor: (
    connectionId: string,
    end: "from" | "to",
    anchor: ConnectionAnchor,
  ) => void;
}

function ConnectionAnchorEditor({
  connection,
  fromTransform,
  toTransform,
  camera,
  viewportRect,
  onSetAnchor,
}: ConnectionAnchorEditorProps) {
  // 끝점별 8 슬롯 화면 좌표 + 활성 슬롯 식별.
  // 저장된 anchor 가 슬롯 위가 아닐 수 있어 (legacy 미마이그레이션 fallback)
  // `slotOfAnchor` 로 가장 가까운 슬롯을 활성으로 간주.
  const renderEnd = (
    end: "from" | "to",
    transform: CanvasItemTransform,
    storedAnchor: ConnectionAnchor | undefined,
    locked: boolean,
  ) => {
    // 빨간(active) 표시는 *잠긴 상태* 일 때만. 잠겨 있지 않으면 (auto) 모든 슬롯이
    // 비활성(흰색) 으로 보여 사용자가 "여기는 자유" 라는 시그널을 받음 + 클릭
    // 가능한 후보 슬롯이 8개 모두 동등하게 보임.
    const activeSlot = locked && storedAnchor ? slotOfAnchor(storedAnchor) : null;
    const slots = slotPoints(transform);
    const ANCHOR_PX = 14;
    return slots.map(({ slot, anchor, canvas }) => {
      const screen = canvasToScreen(canvas, viewportRect, camera);
      const left = screen.x - viewportRect.left - ANCHOR_PX / 2;
      const top = screen.y - viewportRect.top - ANCHOR_PX / 2;
      const isActive = activeSlot === slot;
      return (
        <div
          key={`${end}-${slot}`}
          role="button"
          aria-pressed={isActive}
          data-connection-ui="anchor-handle"
          className={cn(
            "absolute z-30 rounded-full border-2 transition-transform",
            "hover:scale-125 cursor-grab active:cursor-grabbing",
            isActive
              ? "border-white bg-primary shadow-lg ring-2 ring-primary/40 scale-110"
              : "border-primary/70 bg-card/90",
          )}
          style={{
            left,
            top,
            width: ANCHOR_PX,
            height: ANCHOR_PX,
          }}
          onPointerDown={(ev) => {
            // 항상 onSetAnchor 호출 — 핸들러가 toggle 로직 결정:
            //   · 잠긴 슬롯 클릭 → 잠금 해제 (auto-anchor 복귀)
            //   · 그 외 (비활성 / 잠금 안된 활성 슬롯) → 이 슬롯으로 잠금
            // drag 으로 다른 슬롯 이동은 pointerMove 에서 추가 onSetAnchor 발화.
            ev.stopPropagation();
            ev.preventDefault();
            onSetAnchor(connection.id, end, anchor);
            try {
              (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          }}
          onPointerMove={(ev) => {
            // pointerCapture 가 잡혔으면 다른 슬롯 위로 이동해도 이 핸들러 발화.
            // 화면 좌표에서 가장 가까운 *같은 객체의* 슬롯을 찾아 anchor 갱신.
            // 매 move 마다 갱신 — 슬롯이 자석처럼 따라 잡힘.
            ev.stopPropagation();
            const screenPt = { x: ev.clientX, y: ev.clientY };
            // viewport 밖이면 갱신 X
            if (
              screenPt.x < viewportRect.left ||
              screenPt.x > viewportRect.right ||
              screenPt.y < viewportRect.top ||
              screenPt.y > viewportRect.bottom
            ) {
              return;
            }
            // 화면 좌표 기준으로 가장 가까운 슬롯 — slotPoints 의 캔버스 좌표를
            // 화면 좌표로 변환해 거리 비교.
            let bestSlot: AnchorSlot = slot;
            let bestAnchor = anchor;
            let bestD = Infinity;
            for (const sp of slots) {
              const sScreen = canvasToScreen(sp.canvas, viewportRect, camera);
              const dx = screenPt.x - sScreen.x;
              const dy = screenPt.y - sScreen.y;
              const d = dx * dx + dy * dy;
              if (d < bestD) {
                bestD = d;
                bestSlot = sp.slot;
                bestAnchor = sp.anchor;
              }
            }
            const curStored = end === "from" ? connection.from.anchor : connection.to.anchor;
            const curSlot = curStored ? slotOfAnchor(curStored) : null;
            if (bestSlot !== curSlot) {
              onSetAnchor(connection.id, end, bestAnchor);
            }
          }}
          onPointerUp={(ev) => {
            try {
              (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
          }}
        />
      );
    });
  };

  return (
    <>
      {renderEnd("from", fromTransform, connection.from.anchor, !!connection.from.anchorLocked)}
      {renderEnd("to", toTransform, connection.to.anchor, !!connection.to.anchorLocked)}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────
 * ConnectionToolbar — 선택된 connection 의 외형 옵션. NoteToolbar 와 동일
 * 패턴 (viewport 좌표 기준 floating, scale 영향 안 받음).
 *
 * UI 섹션:
 *   1) 라인 스타일 — 실선 / 점선
 *   2) 끝점 화살표 — ON / OFF (시작점 화살표 토글은 후속 작업)
 *   3) 색상 — 8 swatches (NOTE_TEXT_PALETTE 재사용)
 *   4) 두께 — 1.5 / 2 / 3 / 4 단계
 *   5) 삭제 — 우클릭 메뉴와 별개로 즉시 unlink
 *
 * 위치: 라인 *중점* 위쪽 12px. 화면 위로 잘리면 *아래쪽* 으로 자동 클램프.
 * ────────────────────────────────────────────────────────────── */

interface ConnectionToolbarProps {
  connection: CanvasConnection;
  /** 라인 양 끝점의 *그려지는* 캔버스 좌표 — ConnectionLayer 의 GAP padding 후
   *  값. ConnectionToolbar 위치(중점) 계산에 그대로 사용. */
  midpoint: Point;
  camera: CanvasCamera;
  viewportRect: DOMRect;
  onMutate: (mut: (c: CanvasConnection) => CanvasConnection) => void;
  onUnlink: () => void;
}

// (이전 CONNECTION_LINE_PALETTE / CONNECTION_THICKNESS_STEPS 상수는 ColorPicker
//  popover + ConnectionThicknessInput 으로 대체되어 제거됨.)

function ConnectionToolbar({
  connection,
  midpoint,
  camera,
  viewportRect,
  onMutate,
  onUnlink,
}: ConnectionToolbarProps) {
  const t = useT();
  const screenMid = canvasToScreen(midpoint, viewportRect, camera);
  const left = screenMid.x - viewportRect.left;
  let top = screenMid.y - viewportRect.top - 44;
  if (top < 4) top = screenMid.y - viewportRect.top + 8; // 위로 잘리면 아래로

  const s = connection.style ?? {};
  const lineStyle = s.lineStyle ?? "solid";
  const hasArrow = (s.endEnd ?? "arrow") === "arrow";
  const color = s.color ?? "hsl(var(--muted-foreground))";
  const thickness = s.thickness ?? 2;

  const setStyle = (patch: Partial<ConnectionStyle>) => {
    onMutate((c) => ({ ...c, style: { ...(c.style ?? {}), ...patch } }));
  };

  // 디폴트 라인 색의 hex 표현 — ColorPicker 가 hsl() 함수형은 못 받으므로
  // 직접 hex 로 정규화. CSS var 기반 primary 는 picker swatch 가 trigger
  // 에서만 그려질 때 fallback 으로 사용.
  const colorForPicker = /^#[0-9a-f]{6}$/i.test(color) ? color : "#e11d48";

  // 라벨 외형 — 글자 크기 / 채우기(글자색) / 아웃라인(헤일로) 색.
  const labelStyle = connection.labelStyle ?? {};
  const setLabelStyle = (patch: Partial<ConnectionLabelStyle>) => {
    onMutate((c) => ({ ...c, labelStyle: { ...(c.labelStyle ?? {}), ...patch } }));
  };
  const labelFillForPicker =
    labelStyle.fillColor && /^#[0-9a-f]{6}$/i.test(labelStyle.fillColor)
      ? labelStyle.fillColor
      : colorForPicker;
  const labelOutlineForPicker =
    labelStyle.outlineColor && /^#[0-9a-f]{6}$/i.test(labelStyle.outlineColor)
      ? labelStyle.outlineColor
      : "#000000";

  return (
    <div
      data-connection-ui="toolbar"
      className="absolute z-30 flex items-center gap-0.5 border bg-card px-1 py-1 text-caption shadow-md"
      style={{ left, top, transform: "translateX(-50%)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 라인 스타일 토글 — 실선 / 점선 */}
      <NoteToggleButton
        active={lineStyle === "solid"}
        title={t("library.canvas.connection.solid")}
        onClick={() => setStyle({ lineStyle: "solid" })}
      >
        <Minus className="h-3 w-3" />
      </NoteToggleButton>
      <NoteToggleButton
        active={lineStyle === "dashed"}
        title={t("library.canvas.connection.dashed")}
        onClick={() => setStyle({ lineStyle: "dashed" })}
      >
        <MoreHorizontal className="h-3 w-3" />
      </NoteToggleButton>

      <Divider />

      {/* 끝 화살표 ON/OFF */}
      <NoteToggleButton
        active={hasArrow}
        title={t("library.canvas.connection.arrow")}
        onClick={() => setStyle({ endEnd: hasArrow ? "none" : "arrow" })}
      >
        <MoveRight className="h-3 w-3" />
      </NoteToggleButton>

      <Divider />

      {/* 색상 — Popover + ColorPicker 로 자유 색 지정 (PureRef 동등). 노트
          텍스트 색 picker 와 같은 인터랙션 패턴이라 학습 비용 0. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 items-center gap-1 border border-muted-foreground/30 bg-card px-1 hover:bg-accent"
            title={t("library.canvas.connection.color")}
            aria-label={t("library.canvas.connection.color")}
          >
            <span
              className="h-3 w-3 border border-muted-foreground/40"
              style={{ background: colorForPicker }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="center"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ColorPicker
            value={colorForPicker}
            onChange={(hex) => {
              if (!hex) return;
              setStyle({ color: hex });
            }}
            allowClear={false}
            showClearPreset={false}
          />
        </PopoverContent>
      </Popover>

      <Divider />

      {/* 두께 — 숫자 입력 (1~12 px). 4 단계 버튼보다 컴팩트하고 정확. */}
      <ConnectionThicknessInput
        value={thickness}
        onChange={(v) => setStyle({ thickness: v })}
        title={t("library.canvas.connection.thickness")}
      />

      <Divider />

      {/* 라벨 — 연결선 중앙에 표시되는 텍스트. Enter/blur 시 적용. */}
      <ConnectionLabelInput
        value={connection.label ?? ""}
        onChange={(v) => onMutate((c) => ({ ...c, label: v || undefined }))}
        title={t("library.canvas.connection.label")}
        placeholder={t("library.canvas.connection.labelPlaceholder")}
      />

      {/* 라벨 외형 옵션 — 라벨이 있을 때만 노출(글자 크기 / 채우기 색 / 아웃라인 색). */}
      {connection.label ? (
        <>
          <Divider />

          {/* 글자 크기 (8~96 px) */}
          <ConnectionThicknessInput
            value={labelStyle.fontSize ?? 12}
            onChange={(v) => setLabelStyle({ fontSize: v })}
            title={t("library.canvas.connection.labelFontSize")}
            min={8}
            max={96}
          />

          {/* 채우기(글자) 색 */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-5 items-center gap-1 border border-muted-foreground/30 bg-card px-1"
                style={{ borderRadius: 0 }}
                title={t("library.canvas.connection.labelFill")}
                aria-label={t("library.canvas.connection.labelFill")}
              >
                <span className="text-micro font-medium text-muted-foreground">A</span>
                <span
                  className="h-3 w-3 border border-muted-foreground/40"
                  style={{ background: labelFillForPicker }}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="center" onPointerDown={(e) => e.stopPropagation()}>
              <ColorPicker
                value={labelFillForPicker}
                onChange={(hex) => {
                  if (!hex) return;
                  setLabelStyle({ fillColor: hex });
                }}
                allowClear={false}
                showClearPreset={false}
              />
            </PopoverContent>
          </Popover>

          {/* 아웃라인(헤일로) 색 — Clear 로 "없음" 지정 가능 */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-5 items-center gap-1 border border-muted-foreground/30 bg-card px-1"
                style={{ borderRadius: 0 }}
                title={t("library.canvas.connection.labelOutline")}
                aria-label={t("library.canvas.connection.labelOutline")}
              >
                <span className="text-micro font-medium text-muted-foreground">O</span>
                <span
                  className="h-3 w-3 border border-muted-foreground/40"
                  style={
                    labelStyle.outlineColor === "none"
                      ? { background: "repeating-linear-gradient(45deg, transparent 0 3px, rgba(120,120,120,0.5) 3px 4px)" }
                      : { background: labelOutlineForPicker }
                  }
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="center" onPointerDown={(e) => e.stopPropagation()}>
              <ColorPicker
                value={labelStyle.outlineColor === "none" ? null : labelOutlineForPicker}
                onChange={(hex) => setLabelStyle({ outlineColor: hex ?? "none" })}
                allowClear
                clearLabel={t("library.canvas.connection.labelOutlineNone")}
              />
            </PopoverContent>
          </Popover>
        </>
      ) : null}

      <Divider />

      {/* 삭제 */}
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        title={t("library.canvas.contextMenu.unlinkLine")}
        onClick={onUnlink}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

/** 연결 라벨 입력 — Enter/blur 시 커밋(매 키 입력마다 undo 항목이 쌓이지 않게). */
function ConnectionLabelInput({
  value,
  onChange,
  title,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  title: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string>(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onChange(next);
  };
  return (
    <input
      type="text"
      value={draft}
      title={title}
      placeholder={placeholder}
      className="h-6 w-24 border border-muted-foreground/30 bg-background px-1 text-caption outline-none focus:border-primary"
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** 숫자 입력 — NoteFontSizeInput 와 동일 패턴. 기본 범위 1~12(라인 두께)이고,
 *  min/max 를 주면 다른 용도(라벨 글자 크기 등)로 재사용. */
function ConnectionThicknessInput({
  value,
  onChange,
  title,
  min = 1,
  max = 12,
}: {
  value: number;
  onChange: (next: number) => void;
  title: string;
  min?: number;
  max?: number;
}) {
  const MIN = min;
  const MAX = max;
  const [draft, setDraft] = useState<string>(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(MIN, Math.min(MAX, n));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const bump = (delta: number) => {
    const next = Math.max(MIN, Math.min(MAX, value + delta));
    if (next !== value) onChange(next);
  };
  return (
    <div className="flex h-6 items-center gap-0.5 border border-muted-foreground/30 bg-background px-1" title={title}>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 2))}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-1);
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="h-5 w-5 bg-transparent text-center font-mono text-caption tabular-nums outline-none"
        aria-label={title}
      />
      <span className="text-micro text-muted-foreground">px</span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Selection overlay — viewport 좌표계로 핸들 렌더 (scale 영향 안 받음)
 * ────────────────────────────────────────────────────────────── */

interface SelectionOverlayProps {
  transforms: Array<{ id: string; isNote: boolean; t: CanvasItemTransform }>;
  camera: CanvasCamera;
  viewportRect: DOMRect | null;
  onResizeStart: (e: ReactPointerEvent, targetId: string, isNote: boolean, handle: HandleId) => void;
  onRotateStart: (e: ReactPointerEvent, targetId: string, isNote: boolean) => void;
  /** 다중 선택 union bbox 의 핸들 드래그 시작. bbox 는 canvas 좌표 — handler
   *  가 그대로 anchor 계산에 사용한다. */
  onGroupScaleStart: (e: ReactPointerEvent, handle: HandleId, bbox: Rect) => void;
}

function SelectionOverlay({ transforms, camera, viewportRect, onResizeStart, onRotateStart, onGroupScaleStart }: SelectionOverlayProps) {
  if (!viewportRect || transforms.length === 0) return null;

  const toScreen = (p: Point): Point => {
    const s = canvasToScreen(p, viewportRect, camera);
    return { x: s.x - viewportRect.left, y: s.y - viewportRect.top };
  };

  // 다중 선택 — PureRef 패턴: 점선 union bbox + 8 핸들. 회전 핸들은 미제공
  // (그룹 회전은 항목별 회전 보존이 까다로워 별도 작업). 핸들 드래그는 항상
  // *비율 유지* uniform scale 로 동작 — 모든 항목의 가로/세로 비율이 보존된다.
  if (transforms.length > 1) {
    // visible 영역 기준 — crop 적용된 ref 의 *보이는 가장자리* 가 group bbox 의
    // edge 가 되도록. outer box 기준이면 group bbox 가 transparent 영역까지
    // 포함해 사용자가 보는 콘텐츠보다 크게 그려진다.
    const aabbs = transforms.map((tg) => visibleItemAABB(tg.t));
    const bbox = unionBBox(aabbs);
    if (!bbox) return null;
    const TL: Point = { x: bbox.x, y: bbox.y };
    const TR: Point = { x: bbox.x + bbox.w, y: bbox.y };
    const BR: Point = { x: bbox.x + bbox.w, y: bbox.y + bbox.h };
    const BL: Point = { x: bbox.x, y: bbox.y + bbox.h };
    const TC: Point = { x: bbox.x + bbox.w / 2, y: bbox.y };
    const BC: Point = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h };
    const LC: Point = { x: bbox.x, y: bbox.y + bbox.h / 2 };
    const RC: Point = { x: bbox.x + bbox.w, y: bbox.y + bbox.h / 2 };
    const TLs = toScreen(TL);
    const TRs = toScreen(TR);
    const BRs = toScreen(BR);
    const BLs = toScreen(BL);

    const HANDLE_SIZE = 8;
    const handleBaseStyle: CSSProperties = {
      position: "absolute",
      width: HANDLE_SIZE,
      height: HANDLE_SIZE,
      transform: "translate(-50%, -50%)",
      background: "white",
      border: "1px solid hsl(var(--primary))",
      pointerEvents: "auto",
    };
    const renderGroupHandle = (h: HandleId, p: Point, cursor: string) => {
      const s = toScreen(p);
      return (
        <div
          key={h}
          style={{ ...handleBaseStyle, left: s.x, top: s.y, cursor }}
          onPointerDown={(e) => onGroupScaleStart(e, h, bbox)}
        />
      );
    };

    return (
      <div className="pointer-events-none absolute inset-0">
        <svg className="absolute inset-0 h-full w-full pointer-events-none" style={{ overflow: "visible" }}>
          <polygon
            points={`${TLs.x},${TLs.y} ${TRs.x},${TRs.y} ${BRs.x},${BRs.y} ${BLs.x},${BLs.y}`}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        </svg>
        {renderGroupHandle("nw", TL, "nwse-resize")}
        {renderGroupHandle("n", TC, "ns-resize")}
        {renderGroupHandle("ne", TR, "nesw-resize")}
        {renderGroupHandle("e", RC, "ew-resize")}
        {renderGroupHandle("se", BR, "nwse-resize")}
        {renderGroupHandle("s", BC, "ns-resize")}
        {renderGroupHandle("sw", BL, "nesw-resize")}
        {renderGroupHandle("w", LC, "ew-resize")}
      </div>
    );
  }

  const { id, isNote, t } = transforms[0];
  // crop 적용된 ref 는 *보이는 영역* 가장자리에 핸들 위치. 사용자가 보는 이미지
  // 와 정확히 일치하는 핸들을 잡아 직관적. crop 없는 ref / 노트는 outer box.
  // v2 baked 에서는 t.w/h 가 이미 visible — crop 값을 inset 으로 더 적용하면
  // *시각 안쪽* 으로 또 줄여져 핸들이 image 가운데 떠버린다. cropBaked 면
  // inset 0 (= wrapper 가장자리). v1(legacy)만 crop offset 사용.
  const useInset = !!t.crop && !t.cropBaked;
  const cropL = useInset ? (t.crop?.l ?? 0) : 0;
  const cropT = useInset ? (t.crop?.t ?? 0) : 0;
  const cropR = useInset ? (t.crop?.r ?? 0) : 0;
  const cropB = useInset ? (t.crop?.b ?? 0) : 0;
  const visLeft = -t.w / 2 + cropL * t.w;
  const visRight = t.w / 2 - cropR * t.w;
  const visTop = -t.h / 2 + cropT * t.h;
  const visBottom = t.h / 2 - cropB * t.h;
  // 회전된 사각형의 4 코너를 캔버스 좌표로 산출 (visible 영역 기준)
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const corner = (dx: number, dy: number): Point => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  });
  const TL = corner(visLeft, visTop);
  const TR = corner(visRight, visTop);
  const BR = corner(visRight, visBottom);
  const BL = corner(visLeft, visBottom);
  const TC = corner((visLeft + visRight) / 2, visTop);
  const BC = corner((visLeft + visRight) / 2, visBottom);
  const LC = corner(visLeft, (visTop + visBottom) / 2);
  const RC = corner(visRight, (visTop + visBottom) / 2);
  // 회전 핸들 — visible 상단에서 24px 위.
  const ROTATE_GAP = 24 / camera.scale;
  const RT: Point = corner((visLeft + visRight) / 2, visTop - ROTATE_GAP);

  const HANDLE_SIZE = 8;
  const handleStyle: CSSProperties = {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    transform: "translate(-50%, -50%)",
    background: "white",
    border: "1px solid hsl(var(--primary))",
    pointerEvents: "auto",
  };

  const renderHandle = (id_: HandleId, p: Point, cursor: string) => {
    const s = toScreen(p);
    return (
      <div
        key={id_}
        style={{ ...handleStyle, left: s.x, top: s.y, cursor }}
        onPointerDown={(e) => onResizeStart(e, id, isNote, id_)}
      />
    );
  };

  // 박스 외곽선 (4 segments) 도 그릴 수 있지만 SVG 가 더 깔끔 — 핸들만 div 로
  const TLs = toScreen(TL), TRs = toScreen(TR), BRs = toScreen(BR), BLs = toScreen(BL);
  const RTs = toScreen(RT);
  const TCs = toScreen(TC);

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg className="absolute inset-0 h-full w-full pointer-events-none" style={{ overflow: "visible" }}>
        <polygon
          points={`${TLs.x},${TLs.y} ${TRs.x},${TRs.y} ${BRs.x},${BRs.y} ${BLs.x},${BLs.y}`}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        {/* 회전 핸들 connector — 객체 top-center 에서 회전 핸들까지 primary 색
            얇은 직선. anchor dot (작은 primary 원) 이 라인 위에 살짝 떠 있는
            형태로 자연스럽게 정리. */}
        <line x1={TCs.x} y1={TCs.y} x2={RTs.x} y2={RTs.y} stroke="hsl(var(--primary))" strokeWidth={1} />
      </svg>
      {renderHandle("nw", TL, "nwse-resize")}
      {/* 노트는 height 가 콘텐츠로 자동 결정 — 위/아래(n, s) 핸들을 끌어도
          width 만 갱신되는 resizeByHandle 결과 중 height 부분이 무시되어
          시각적으로 동작 안 함처럼 보였다. PureRef 의 텍스트 노트도 좌우
          핸들만 노출. 노트일 때는 n/s 를 숨기고 e/w + 4 corners 만 유지. */}
      {!isNote ? renderHandle("n", TC, "ns-resize") : null}
      {renderHandle("ne", TR, "nesw-resize")}
      {renderHandle("e", RC, "ew-resize")}
      {renderHandle("se", BR, "nwse-resize")}
      {!isNote ? renderHandle("s", BC, "ns-resize") : null}
      {renderHandle("sw", BL, "nesw-resize")}
      {renderHandle("w", LC, "ew-resize")}
      <div
        style={{
          ...handleStyle,
          left: RTs.x,
          top: RTs.y,
          cursor: "grab",
          borderRadius: "50%",
          width: 12,
          height: 12,
        }}
        onPointerDown={(e) => onRotateStart(e, id, isNote)}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Background grid — plane 안에서 카메라 transform 을 따라가는 모눈.
 *
 * plane 은 자식 크기에 따라 자동 확장되는 0×0 위치 기준 컨테이너이므로
 * SVG 도 viewBox + 매우 큰 음수~양수 범위를 그려 카메라가 어디로 이동하든
 * 빈 영역이 보이지 않게 한다. 패턴 셀 = gridSize. minor/major 두 단계로
 * 8 칸마다 짙은 선을 그어 시각적 referencing 보조.
 * ────────────────────────────────────────────────────────────── */

function BackgroundGrid({ gridSize, cameraScale }: { gridSize: number; cameraScale: number }) {
  // 줌아웃 시 minor 선이 너무 촘촘해 보여 — 일정 scale 이하로 떨어지면 minor
  // 격자는 생략하고 major 만 표시. screen-space 1 px 보다 작은 선은 모두
  // 사라지므로 굳이 그리지 않음.
  const minorVisible = cameraScale * gridSize >= 8;
  const major = gridSize * 8;
  // plane 은 무한 평면 — 매우 큰 SVG 한 장으로 viewBox 안쪽을 모두 채운다.
  // 100000 × 100000 px (캔버스 좌표) 면 일반 작업에선 절대 끝에 닿지 않는다.
  // SVG <pattern> 으로 한 셀만 그리고 repeat 시켜 메모리 비용도 무시 가능.
  const SIZE = 100000;
  const HALF = SIZE / 2;
  // 정렬(중요): SVG 좌상단이 plane 좌표 (-HALF, -HALF) 에 있고 pattern 이
  // 그 점을 (0,0) 으로 시작한다. HALF 가 gridSize 의 배수가 아니면 (예:
  // HALF=50000, gridSize=32 → 50000 mod 32 = 16) 격자선이 plane 원점에서
  // 16 px 어긋나 — 사용자가 "snap 은 됐는데 visual grid 에 안 붙는다" 라는
  // 인상을 받는다. pattern.x / pattern.y 에 offset 을 줘 격자선이 *plane 원점
  // 을 통과* 하도록 정렬한다. snap 계산이 plane 원점 기준으로 round 되므로
  // 두 시스템이 동일 grid 위에서 만난다.
  const minorOffset = HALF % gridSize;
  const majorOffset = HALF % major;
  const minorStroke = "rgba(180,180,180,0.10)";
  const majorStroke = "rgba(180,180,180,0.22)";
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: -HALF, top: -HALF, width: SIZE, height: SIZE, zIndex: -10 }}
    >
      <defs>
        {minorVisible ? (
          <pattern id="canvas-grid-minor" x={minorOffset} y={minorOffset} width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
            <path d={`M ${gridSize} 0 L 0 0 L 0 ${gridSize}`} fill="none" stroke={minorStroke} strokeWidth={1 / cameraScale} />
          </pattern>
        ) : null}
        <pattern id="canvas-grid-major" x={majorOffset} y={majorOffset} width={major} height={major} patternUnits="userSpaceOnUse">
          <path d={`M ${major} 0 L 0 0 L 0 ${major}`} fill="none" stroke={majorStroke} strokeWidth={1.5 / cameraScale} />
        </pattern>
      </defs>
      {minorVisible ? <rect x={0} y={0} width={SIZE} height={SIZE} fill="url(#canvas-grid-minor)" /> : null}
      <rect x={0} y={0} width={SIZE} height={SIZE} fill="url(#canvas-grid-major)" />
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Minimap — 우하단 200×120 오버뷰. 전체 콘텐츠 BBox + 현재 viewport rect
 * 를 축소 표시. 클릭/드래그로 카메라 평면 이동.
 *
 * 좌표계:
 *   - mini-rect (캔버스 BBox + 약간의 padding) 가 minimap 안쪽 영역에 fit.
 *   - viewport rect 는 카메라 (tx, ty, scale) 로 계산: 화면 보이는 영역을
 *     캔버스 좌표로 환산해 mini 비율 적용.
 * ────────────────────────────────────────────────────────────── */

interface MinimapProps {
  items: Record<string, CanvasItemTransform>;
  notes: CanvasNote[];
  /** AI 생성 노드 — items/notes 와 동일하게 콘텐츠 bbox 와 미니맵 점에 포함. */
  genNodes?: CanvasGenNode[];
  noteHeights: Map<string, number>;
  camera: CanvasCamera;
  viewport: DOMRect | null;
  onJump: (canvasPt: Point) => void;
}

function Minimap({ items, notes, genNodes, noteHeights, camera, viewport, onJump }: MinimapProps) {
  const MM_W = 200;
  const MM_H = 120;
  const PAD = 8;
  // 전체 콘텐츠 BBox.
  const rects: Rect[] = [];
  for (const tr of Object.values(items)) {
    if (tr.hidden) continue;
    rects.push(itemAABB(tr));
  }
  for (const n of notes) {
    rects.push({ x: n.x, y: n.y, w: n.width, h: noteHeights.get(n.id) ?? Math.max(20, n.fontSize * 1.2 + 8) });
  }
  for (const g of genNodes ?? []) {
    if (g.hidden) continue;
    rects.push({ x: g.x, y: g.y, w: g.w, h: g.h });
  }
  if (rects.length === 0 || !viewport) return null;
  const bbox = unionBBox(rects);
  if (!bbox) return null;
  // 카메라 viewport 의 캔버스 좌표 영역.
  const vpRect: Rect = {
    x: (-camera.tx) / camera.scale,
    y: (-camera.ty) / camera.scale,
    w: viewport.width / camera.scale,
    h: viewport.height / camera.scale,
  };
  // union — viewport 도 minimap 에 잡혀야 사용자가 자기 위치를 알 수 있다.
  const fullBox = unionBBox([bbox, vpRect]);
  if (!fullBox) return null;
  const innerW = MM_W - PAD * 2;
  const innerH = MM_H - PAD * 2;
  const scale = Math.min(innerW / fullBox.w, innerH / fullBox.h);
  const offsetX = PAD + (innerW - fullBox.w * scale) / 2 - fullBox.x * scale;
  const offsetY = PAD + (innerH - fullBox.h * scale) / 2 - fullBox.y * scale;
  const toMini = (r: Rect): Rect => ({
    x: r.x * scale + offsetX,
    y: r.y * scale + offsetY,
    w: Math.max(2, r.w * scale),
    h: Math.max(2, r.h * scale),
  });
  const handleJump = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const cx = (mx - offsetX) / scale;
    const cy = (my - offsetY) / scale;
    onJump({ x: cx, y: cy });
  };
  return (
    <div
      className="absolute right-3 bottom-3 z-20 rounded-md border border-border bg-card/95 p-1 shadow-md backdrop-blur-sm"
      style={{ width: MM_W, height: MM_H }}
    >
      <svg
        className="block h-full w-full cursor-pointer"
        viewBox={`0 0 ${MM_W} ${MM_H}`}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
          handleJump(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          handleJump(e);
        }}
      >
        {/* items */}
        {Object.values(items).map((tr, i) => {
          if (tr.hidden) return null;
          const m = toMini(itemAABB(tr));
          return <rect key={i} x={m.x} y={m.y} width={m.w} height={m.h} fill="rgba(255,255,255,0.4)" />;
        })}
        {notes.map((n, i) => {
          const m = toMini({
            x: n.x, y: n.y, w: n.width,
            h: noteHeights.get(n.id) ?? Math.max(20, n.fontSize * 1.2 + 8),
          });
          return <rect key={`n${i}`} x={m.x} y={m.y} width={m.w} height={m.h} fill="rgba(250,204,21,0.5)" />;
        })}
        {/* gen 노드 — 브랜드 레드 톤으로 items/notes 와 구분. */}
        {(genNodes ?? []).map((g, i) => {
          if (g.hidden) return null;
          const m = toMini({ x: g.x, y: g.y, w: g.w, h: g.h });
          return <rect key={`g${i}`} x={m.x} y={m.y} width={m.w} height={m.h} fill="rgba(249,66,58,0.6)" />;
        })}
        {/* viewport rect */}
        {(() => {
          const m = toMini(vpRect);
          return (
            <rect
              x={m.x}
              y={m.y}
              width={m.w}
              height={m.h}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
            />
          );
        })()}
      </svg>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Canvas 상단 도구 모음 — flip / z-order / lock / align / distribute / undo / fit
 * ────────────────────────────────────────────────────────────── */

interface CanvasToolbarProps {
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAddNote: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onToggleLock: () => void;
  onAlign: (kind: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter") => void;
  onDistribute: (axis: "h" | "v") => void;
  onTile: () => void;
  onFitAll: () => void;
  onFocusSelection: () => void;
  onResetLayout: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  scalePercent: number;
  // v2 신규
  showGrid: boolean;
  onToggleGrid: () => void;
  onPaste: () => void;
  onExportPng: () => void;
  showMinimap: boolean;
  onToggleMinimap: () => void;
  showShortcuts: boolean;
  onToggleShortcuts: () => void;
  searchActive: boolean;
  onToggleSearch: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onShowAll: () => void;
  onToggleHide: () => void;
  hiddenCount: number;
  /** 선택된 모든 ref 가 잠겨 있는지 — toolbar 잠금 버튼이 *현재 상태* 를
   *  반영해 active 표시. 빈 선택일 때는 false (=기본 미잠금 톤). */
  selectionAllLocked: boolean;
}

function CanvasToolbar(p: CanvasToolbarProps) {
  const t = useT();
  const disabled = p.selectedCount === 0;
  const disableMulti = p.selectedCount < 2;
  const disableDistribute = p.selectedCount < 3;
  // 잠금 토글 — 한 개라도 안 잠겨 있으면 모두 잠금. 모두 잠겨 있으면 모두 해제.
  // 단순히 selection 만으로는 *현재 모드* 를 알 수 없어 아이콘 단일톤(Lock/Unlock)
  // 으로 통일 — 현재는 항상 Unlock(=잠금 액션) 으로 표현해 사용자에게 *액션의
  // 결과* 가 아닌 *액션 자체* 를 보여준다 (Figma 도 같은 패턴).
  return (
    <div className="flex items-center gap-1 border-b bg-card px-2 py-1 text-caption">
      {/* 생성 */}
      <ToolButton title={`${t("library.canvas.addNote")} (N)`} onClick={p.onAddNote}>
        <StickyNote className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.paste")} (Ctrl+V)`} onClick={p.onPaste}>
        <Clipboard className="h-3.5 w-3.5" />
      </ToolButton>

      <Divider />

      {/* 변형 / 정돈 */}
      <ToolButton title={`${t("library.canvas.flipH")} (Alt+Shift+H)`} disabled={disabled} onClick={p.onFlipH}>
        <FlipHorizontal className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.flipV")} (Alt+Shift+V)`} disabled={disabled} onClick={p.onFlipV}>
        <FlipVertical className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.bringToFront")} (])`} disabled={disabled} onClick={p.onBringToFront}>
        <BringToFront className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.sendToBack")} ([)`} disabled={disabled} onClick={p.onSendToBack}>
        <SendToBack className="h-3.5 w-3.5" />
      </ToolButton>
      {/* 잠금 토글 — 모두 잠긴 상태면 Lock 아이콘 + 회색(중립) active 톤,
          평소(미잠금/혼합)는 Unlock 아이콘. 사용자가 *현재 상태* 와 *클릭 시 동작*
          을 동시에 인지 (Figma / Sketch 와 동일 패턴). */}
      <Button
        variant="ghost"
        size="sm"
        title={`${p.selectionAllLocked ? t("library.canvas.unlock") : t("library.canvas.lock")} (Ctrl+L)`}
        disabled={disabled}
        onClick={p.onToggleLock}
        className={cn(
          "h-7 w-7 p-0",
          p.selectionAllLocked
            ? "bg-foreground/15 text-foreground hover:bg-foreground/20 hover:text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {p.selectionAllLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
      </Button>
      <ToolButton title={`${t("library.canvas.group")} (Ctrl+G)`} disabled={disableMulti} onClick={p.onGroup}>
        <Group className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.ungroup")} (Ctrl+Shift+G)`} disabled={disabled} onClick={p.onUngroup}>
        <Ungroup className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        title={`${p.hiddenCount > 0 ? t("library.canvas.showAll") : t("library.canvas.hide")} (H)`}
        disabled={disabled && p.hiddenCount === 0}
        onClick={p.hiddenCount > 0 ? p.onShowAll : p.onToggleHide}
      >
        {p.hiddenCount > 0 ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </ToolButton>

      <Divider />

      {/* 정렬 / 분포 — lucide 의 전용 Align/Distribute 아이콘으로 통일.
          AlignStartVertical = 좌측 정렬 (왼쪽 세로선 기준), End = 우측 등. */}
      <ToolButton title={t("library.canvas.alignLeft")} disabled={disableMulti} onClick={() => p.onAlign("left")}>
        <AlignStartVertical className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("library.canvas.alignRight")} disabled={disableMulti} onClick={() => p.onAlign("right")}>
        <AlignEndVertical className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("library.canvas.alignTop")} disabled={disableMulti} onClick={() => p.onAlign("top")}>
        <AlignStartHorizontal className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("library.canvas.alignBottom")} disabled={disableMulti} onClick={() => p.onAlign("bottom")}>
        <AlignEndHorizontal className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("library.canvas.distributeH")} disabled={disableDistribute} onClick={() => p.onDistribute("h")}>
        <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("library.canvas.distributeV")} disabled={disableDistribute} onClick={() => p.onDistribute("v")}>
        <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.tile")} (Ctrl+P)`} disabled={disableMulti} onClick={p.onTile}>
        <LayoutGrid className="h-3.5 w-3.5" />
      </ToolButton>

      <Divider />

      {/* 뷰 토글 — stateful 버튼은 active 시 배경색으로 강조. 아이콘 색만으로는
          켜진 상태가 잘 안 보였다. ToggleButton 헬퍼로 패턴 통일. */}
      <ToggleToolButton
        title={`${p.showGrid ? t("library.canvas.gridOff") : t("library.canvas.gridOn")} (#)`}
        onClick={p.onToggleGrid}
        active={p.showGrid}
      >
        <Grid3x3 className="h-3.5 w-3.5" />
      </ToggleToolButton>
      <ToggleToolButton
        title={`${t("library.canvas.minimapToggle")} (M)`}
        onClick={p.onToggleMinimap}
        active={p.showMinimap}
      >
        <MapIcon className="h-3.5 w-3.5" />
      </ToggleToolButton>
      <ToggleToolButton
        title={t("library.canvas.shortcutsToggle")}
        onClick={p.onToggleShortcuts}
        active={p.showShortcuts}
      >
        <Keyboard className="h-3.5 w-3.5" />
      </ToggleToolButton>
      <ToggleToolButton
        title={`${t("library.canvas.search")} (Ctrl+F)`}
        onClick={p.onToggleSearch}
        active={p.searchActive}
      >
        <Search className="h-3.5 w-3.5" />
      </ToggleToolButton>
      <ToolButton title={`${t("library.canvas.exportPng")} (Ctrl+E)`} onClick={p.onExportPng}>
        <ImageDown className="h-3.5 w-3.5" />
      </ToolButton>

      <Divider />

      {/* History — Undo2/Redo2 는 좌/우 휘는 화살표라 방향이 한눈에 보임. */}
      <ToolButton title={`${t("library.canvas.undo")} (Ctrl+Z)`} disabled={!p.canUndo} onClick={p.onUndo}>
        <Undo2 className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={`${t("library.canvas.redo")} (Ctrl+Shift+Z)`} disabled={!p.canRedo} onClick={p.onRedo}>
        <Redo2 className="h-3.5 w-3.5" />
      </ToolButton>

      <div className="ml-auto flex items-center gap-1">
        <ToolButton title={`${t("library.canvas.fitAll")} (Ctrl+Space)`} onClick={p.onFitAll}>
          <Maximize2 className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton title={`${t("library.canvas.focusSelection")} (Z)`} disabled={disabled} onClick={p.onFocusSelection}>
          <Focus className="h-3.5 w-3.5" />
        </ToolButton>
        <Divider />
        <ToolButton title={t("library.canvas.zoomOut")} onClick={p.onZoomOut}>
          <ZoomOut className="h-3.5 w-3.5" />
        </ToolButton>
        <span className="min-w-10 text-center font-mono text-2xs tabular-nums text-muted-foreground">
          {p.scalePercent}%
        </span>
        <ToolButton title={t("library.canvas.zoomIn")} onClick={p.onZoomIn}>
          <ZoomIn className="h-3.5 w-3.5" />
        </ToolButton>
        <Divider />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-meta"
          onClick={p.onResetLayout}
          title={t("library.canvas.resetLayout")}
        >
          {t("library.canvas.resetLayout")}
        </Button>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px bg-border/70" />;
}

/** 단축키 치트시트 — 캔버스 우측 상단에 떠 있는 토글 패널. 툴바의 Keyboard
 *  버튼 / 패널 X 로 열고 닫는다. 동작 라벨은 기존 i18n 을 재사용. */
function CanvasShortcutsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const rows: Array<[string, string]> = [
    [t("library.canvas.addNote"), "N"],
    [t("library.canvas.paste"), "Ctrl+V"],
    [t("library.canvas.contextMenu.selectAll"), "Ctrl+A"],
    [t("library.canvas.tile"), "Ctrl+P"],
    [t("library.canvas.group"), "Ctrl+G"],
    [t("library.canvas.ungroup"), "Ctrl+Shift+G"],
    [t("library.canvas.lock"), "Ctrl+L"],
    [t("library.canvas.hide"), "H"],
    [t("library.canvas.contextMenu.crop"), "Shift+C"],
    [t("library.canvas.contextMenu.toggleGrayscale"), "Ctrl+Alt+G"],
    [t("library.canvas.flipH"), "Alt+Shift+H"],
    [t("library.canvas.flipV"), "Alt+Shift+V"],
    [t("library.canvas.bringToFront"), "]"],
    [t("library.canvas.sendToBack"), "["],
    [t("library.canvas.fitAll"), "Ctrl+Space"],
    [t("library.canvas.focusSelection"), "Z"],
    [t("library.canvas.zoom100"), "Ctrl+0"],
    [t("library.canvas.gridOn"), "#"],
    [t("library.canvas.minimapToggle"), "M"],
    [t("library.canvas.search"), "Ctrl+F"],
    [t("library.canvas.exportPng"), "Ctrl+E"],
    [t("library.canvas.undo"), "Ctrl+Z"],
    [t("library.canvas.redo"), "Ctrl+Shift+Z"],
  ];
  return (
    <div
      className="absolute right-2 top-2 z-30 w-60 border border-border bg-popover/95 shadow-xl backdrop-blur"
      style={{ borderRadius: 0 }}
      // 패널은 viewport 위에 떠 있는 오버레이 — pointerdown 이 viewport 로
      // 버블되면 marquee 시작 + setPointerCapture 로 포인터를 가로채 X 버튼의
      // click 이 영영 발화되지 않는다. 여기서 끊어 클릭이 정상 전달되게 한다.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 text-caption font-semibold">
          <Keyboard className="h-3.5 w-3.5" />
          {t("library.canvas.shortcutsTitle")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          style={{ borderRadius: 0 }}
          aria-label={t("common.close")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-2.5 py-1.5">
        {rows.map(([label, keys]) => (
          <div key={`${label}-${keys}`} className="flex items-center justify-between gap-3 py-[3px] text-caption">
            <span className="truncate text-foreground/80">{label}</span>
            <kbd
              className="shrink-0 border border-border bg-muted/50 px-1 font-mono text-2xs text-muted-foreground"
              style={{ borderRadius: 0 }}
            >
              {formatShortcut(keys)}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={formatTitleShortcuts(title)}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
    >
      {children}
    </Button>
  );
}

/** ToggleToolButton — stateful 토글 (grid/minimap/search) 전용 변형.
 *  active 상태일 때 배경 색을 입혀 *지금 켜져 있다* 가 한 눈에 보이게 한다.
 *  아이콘 색만으로는 켜진 상태와 hover 상태가 비슷해 발견성이 떨어졌다. */
function ToggleToolButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={formatTitleShortcuts(title)}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 p-0",
        active
          ? "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Button>
  );
}

export default LibraryCanvas;
