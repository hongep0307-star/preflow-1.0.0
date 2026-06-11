import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  MousePointer2,
  Type,
  Pen,
  Eraser,
  Undo2,
  Redo2,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  Loader2,
  Check,
  Crop,
  X,
  ImagePlus,
  Palette,
  SquareDashed,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useT } from "@/lib/uiLanguage";
import { formatTitleShortcuts } from "@/lib/shortcutLabel";

/* ━━━ Types ━━━ */
type ToolId = "select" | "text" | "pen" | "eraser" | "crop" | "image";
interface StrokePoint {
  x: number;
  y: number;
  /** 필압 0~1. 마우스는 1 고정. 스타일러스/터치는 실제 값. */
  p?: number;
}
interface Stroke {
  type: "path";
  points: StrokePoint[];
  color: string;
  size: number;
  isEraser?: boolean;
}
interface TextObject {
  type: "textobj";
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  width: number;
  height: number;
}
/** 알파 PNG 포함 일반 이미지 레이어. (x,y)는 top-left. */
interface ImageLayer {
  type: "image";
  id: string;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
type DrawAction = Stroke | TextObject | ImageLayer;
type SelectableObj = TextObject | ImageLayer;
type CropRatio = "free" | "16:9" | "9:16" | "1:1";
type HandleId = "tl" | "tc" | "tr" | "ml" | "mr" | "bl" | "bc" | "br";

/* ━━━ Constants ━━━ */
import { KR } from "@/lib/brand";
const DEFAULT_COLOR = "#ffffff"; // 브러시 & 텍스트 기본색 = 흰색
/** 자주 쓰는 컬러 프리셋. 흰색은 디폴트, 검은색은 윤곽/하이라이트, KR 은 브랜드.
 *  4번째 슬롯은 비워두고 커스텀 픽커로 보완 — 툴바 가로 폭 제약 때문. */
const COLOR_PRESETS = ["#ffffff", "#000000", KR, "#facc15"];
const TEXT_FONT_SIZES = [12, 16, 20, 28, 36, 48];
const MAX_UNDO = 20;
const HANDLE_SIZE = 8;
const BRUSH_MIN = 1;
const BRUSH_MAX = 60;
/** 필압 → 두께 변조 곡선: p 에 대한 min/max 스케일. 마우스는 1.0 고정. */
const PRESSURE_MIN = 0.35;
const PRESSURE_MAX = 1.0;
const CROP_RATIO_OPTIONS: { id: CropRatio; labelKey: string; staticLabel?: string }[] = [
  { id: "free", labelKey: "annot.cropFree" },
  { id: "16:9", labelKey: "", staticLabel: "16:9" },
  { id: "9:16", labelKey: "", staticLabel: "9:16" },
  { id: "1:1", labelKey: "", staticLabel: "1:1" },
];
const HANDLE_CURSOR: Record<string, string> = {
  tl: "nwse-resize",
  tc: "ns-resize",
  tr: "nesw-resize",
  ml: "ew-resize",
  mr: "ew-resize",
  bl: "nesw-resize",
  bc: "ns-resize",
  br: "nwse-resize",
};
let _idCounter = 0;
const genId = () => `txt_${Date.now()}_${_idCounter++}`;
let _imgIdCounter = 0;
const genImgId = () => `img_${Date.now()}_${_imgIdCounter++}`;
/** 업로드 이미지 다운스케일 상한 (긴 변 픽셀). 메모리/undo 스택 보호용. */
const MAX_IMAGE_LAYER_DIM = 2048;

/* ━━━ URL helpers ━━━ */
export const _originalUrlByScene = new Map<string, string>();
const isEditorUrl = (url: string | null | undefined) => !!url && /_editor_/i.test(url);
const deriveOriginalUrl = (currentUrl: string | null, imageHistory: string[]) => {
  if (!currentUrl) return null;
  if (!isEditorUrl(currentUrl)) return currentUrl;
  return imageHistory.find((u) => !isEditorUrl(u)) ?? imageHistory[imageHistory.length - 1] ?? currentUrl;
};

/* ━━━ Geometry helpers ━━━ */
const measureText = (ctx: CanvasRenderingContext2D, text: string, fontSize: number) => {
  ctx.font = `bold ${fontSize}px sans-serif`;
  const m = ctx.measureText(text);
  return { width: m.width, height: fontSize * 1.2 };
};
/** 오브젝트의 bounding rect (top-left 기준). 텍스트는 baseline 좌표를 top-left 로 변환. */
const getBoundsRect = (obj: SelectableObj): { x: number; y: number; w: number; h: number } => {
  if (obj.type === "textobj") return { x: obj.x, y: obj.y - obj.height, w: obj.width, h: obj.height };
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
};
const getHandlesForBounds = (b: { x: number; y: number; w: number; h: number }) => {
  const { x, y, w, h } = b;
  return [
    { id: "tl" as HandleId, x, y },
    { id: "tc" as HandleId, x: x + w / 2, y },
    { id: "tr" as HandleId, x: x + w, y },
    { id: "ml" as HandleId, x, y: y + h / 2 },
    { id: "mr" as HandleId, x: x + w, y: y + h / 2 },
    { id: "bl" as HandleId, x, y: y + h },
    { id: "bc" as HandleId, x: x + w / 2, y: y + h },
    { id: "br" as HandleId, x: x + w, y: y + h },
  ];
};
const getHandles = (obj: SelectableObj) => getHandlesForBounds(getBoundsRect(obj));
const hitTestHandle = (obj: SelectableObj, px: number, py: number, tol: number): HandleId | null => {
  for (const h of getHandles(obj)) if (Math.abs(px - h.x) <= tol && Math.abs(py - h.y) <= tol) return h.id;
  return null;
};
const hitTestObj = (obj: SelectableObj, px: number, py: number) => {
  const b = getBoundsRect(obj);
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ToolBtn / ActionBtn — 컴포넌트 외부에 정의 (★ 핵심 수정)
 * 컴포넌트 내부에 정의하면 매 렌더마다 새 타입 → React가
 * unmount/remount 반복 → 캔버스 state 리셋 → 그린 내용 사라짐
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
type IconComponent = React.ComponentType<{ className?: string }>;

const ToolBtn = ({
  isActive,
  icon: Icon,
  label,
  onClick,
}: {
  isActive: boolean;
  icon: IconComponent;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    title={label}
    // `transition-colors` 를 의도적으로 빼둔다. Tailwind 기본 트랜지션(약 150ms)이
    // active state 의 배경 전환에 걸리면, 같은 클릭으로 등장하는 브러시 사이즈/
    // 폰트 사이즈 패널은 즉시 보이는데 정작 도구 버튼의 붉은 박스만 한 박자
    // 늦게 채워져 "덜컥" 거리는 느낌이 났음. active toggle 은 즉시 반영되어야
    // 클릭 피드백이 일관적이다.
    className="p-1.5 rounded-none"
    style={{ background: isActive ? KR : "transparent", color: isActive ? "#fff" : "hsl(var(--foreground) / 0.5)" }}
  >
    <Icon className="w-4 h-4" />
  </button>
);

const ActionBtn = ({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    className="p-1.5 rounded-none transition-colors text-white/50 hover:text-white disabled:opacity-30"
  >
    <Icon className="w-4 h-4" />
  </button>
);

/* ━━━ Types ━━━ */
type VideoFormat = "vertical" | "horizontal" | "square";
interface Props {
  imageUrl: string | null;
  imageHistory: string[];
  canvasSize: { w: number; h: number };
  containerRef: React.RefObject<HTMLDivElement>;
  projectId: string;
  sceneId: string;
  sceneNumber: number;
  videoFormat?: VideoFormat;
  /** 씬의 conti_image_crop. 썸네일 safe-area 가이드를 컷 카드와 1:1 로 맞추는 데 사용. */
  contiImageCrop?: unknown;
  onApply: (url: string) => void;
  onRestore?: (originalUrl: string) => void;
}

const videoCropRatio = (vf?: VideoFormat): CropRatio =>
  vf === "horizontal" ? "16:9" : vf === "square" ? "1:1" : "9:16";

/* ━━━ Safe-frame (썸네일 크롭 가이드) ━━━
 * 에디터는 원본 natural 비율 전체를 보여주지만, 컷 카드 썸네일은
 * conti_image_crop + FORMAT_RATIO 로 cover-크롭한 영역만 보여준다. 그래서
 * 프레임 밖에 쓴 텍스트/드로잉은 썸네일에서 잘린다. 아래 헬퍼는 conti.ts 의
 * cropImageForFormat 와 동일한 cover 변환을 역산해, 디스플레이 좌표계에서
 * "썸네일에 실제로 보일 사각형"을 구한다.
 * SAFE_FRAME_RATIO 는 SortableContiCard / conti.ts 의 FORMAT_RATIO 와
 * 1:1 로 일치해야 한다. */
const SAFE_FRAME_RATIO: Record<VideoFormat, number> = {
  horizontal: 16 / 9,
  vertical: 9 / 16,
  square: 1,
};

type StoredCropV2 = { x?: number; y?: number; scale?: number; rotate?: number; ia?: number; _v?: number; fmt?: string };

/** conti.ts 의 getCropForFmtFromStored 와 동일 로직.
 *  CropMap({horizontal,vertical,square}) 또는 단일 CropState 모두 지원. */
const getStoredCropForFormat = (stored: unknown, fmt: VideoFormat): StoredCropV2 | null => {
  if (!stored || typeof stored !== "object") return null;
  const obj = stored as Record<string, any>;
  if ("horizontal" in obj || "vertical" in obj || "square" in obj) {
    const c = obj[fmt];
    return c && c._v === 2 ? (c as StoredCropV2) : null;
  }
  if (obj._v === 2 && (!obj.fmt || obj.fmt === fmt)) return obj as StoredCropV2;
  return null;
};

type SafePt = { x: number; y: number };

/** 디스플레이(에디터 표시) 좌표계에서 썸네일에 보일 4꼭짓점.
 *  cropImageForFormat 의 translate→scale→rotate→cover-drawImage 변환을 역산. */
const computeSafeFrameQuad = (
  dispW: number,
  dispH: number,
  imageAspect: number,
  crop: StoredCropV2 | null,
  fmt: VideoFormat,
): SafePt[] => {
  const cH = 1000;
  const cW = (SAFE_FRAME_RATIO[fmt] ?? 16 / 9) * cH;
  const cAspect = cW / cH;
  const x = crop?.x ?? 0;
  const y = crop?.y ?? 0;
  const baseScale = typeof crop?.scale === "number" ? crop.scale : 0.8;
  const s = Math.max(0.1, baseScale) + 0.2;
  const rad = ((crop?.rotate ?? 0) * Math.PI) / 180;
  let covW: number;
  let covH: number;
  if (imageAspect >= cAspect) {
    covH = cH;
    covW = cH * imageAspect;
  } else {
    covW = cW;
    covH = cW / imageAspect;
  }
  const Tx = cW / 2 + (x / 100) * cW;
  const Ty = cH / 2 + (y / 100) * cH;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const corners: SafePt[] = [
    { x: 0, y: 0 },
    { x: cW, y: 0 },
    { x: cW, y: cH },
    { x: 0, y: cH },
  ];
  return corners.map(({ x: bx, y: by }) => {
    const dx = (bx - Tx) / s;
    const dy = (by - Ty) / s;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const u = rx / covW;
    const v = ry / covH;
    return { x: (u + 0.5) * dispW, y: (v + 0.5) * dispH };
  });
};

/* ━━━ Component ━━━ */
export const AnnotationEditor = ({
  imageUrl,
  imageHistory,
  canvasSize,
  containerRef,
  projectId,
  sceneId,
  sceneNumber,
  videoFormat,
  contiImageCrop,
  onApply,
  onRestore,
}: Props) => {
  const t = useT();
  const derivedOriginal = deriveOriginalUrl(imageUrl, imageHistory);
  useEffect(() => {
    if (derivedOriginal && _originalUrlByScene.get(sceneId) !== derivedOriginal)
      _originalUrlByScene.set(sceneId, derivedOriginal);
  }, [sceneId, derivedOriginal]);

  /* ── state ── */
  const [tool, setTool] = useState<ToolId>("select");
  const [brushSize, setBrushSize] = useState(8);
  const [textFontSize, setTextFontSize] = useState(20);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [cropRatio, setCropRatio] = useState<CropRatio>(() => videoCropRatio(videoFormat));
  /** 썸네일 safe-area 가이드 표시 여부. 기본 ON — 프레임 밖 작업은 컷 카드에서 잘림. */
  const [showSafeFrame, setShowSafeFrame] = useState(true);
  const [actions, setActions] = useState<DrawAction[]>([]);
  const [redoStack, setRedoStack] = useState<DrawAction[]>([]);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [applying, setApplying] = useState(false);
  const [croppedImgSrc, setCroppedImgSrc] = useState<string | null>(null);
  const [cropHistory, setCropHistory] = useState<{ imgSrc: string | null; actions: DrawAction[] }[]>([]);
  const [textInput, setTextInput] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const textInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    mode: "move" | "resize";
    handleId?: HandleId;
    startX: number;
    startY: number;
    origObj: SelectableObj;
  } | null>(null);
  const [cropCursor, setCropCursor] = useState("crosshair");
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cropDrag, setCropDrag] = useState<{
    mode: "draw" | "move" | "handle";
    handleId?: HandleId;
    startX: number;
    startY: number;
    origRect: { x: number; y: number; w: number; h: number };
  } | null>(null);

  /* ── refs ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
  const currentStroke = useRef<StrokePoint[]>([]);
  const lastPoint = useRef<StrokePoint | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** ImageLayer src → 로드 완료된 HTMLImageElement. 재디코딩 방지. */
  const imageLayerCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  /** ImageLayer 로드 완료시 redraw 트리거용. */
  const [imageLayerTick, setImageLayerTick] = useState(0);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  /** 드래그앤드롭으로 외부 파일이 에디터 위에 떠있는 상태. 오버레이 표시용. */
  const [dragOverFiles, setDragOverFiles] = useState(false);
  /** 중첩된 child 의 dragenter/leave 로 인한 깜박임 방지용 카운터. */
  const dragCounterRef = useRef(0);

  /* ★ isDrawingRef — React 18 automatic batching 클로저 문제 해결
   * setIsDrawing(true)는 배치 업데이트라 같은 이벤트 사이클의
   * mousemove에서 아직 false로 읽힘 → ref로 즉시 동기 반영 */
  const isDrawingRef = useRef(false);

  const effectiveImageUrl = croppedImgSrc || imageUrl;

  /* ★ effectiveSize — keep the displayed editor image at its natural ratio.
   * ContiStudio's canvasSize follows the project format, but GPT images can be
   * 1:1, 2:3, or 3:2. Using that box directly visually stretches the image. */
  const effectiveSize = useMemo(() => {
    if (naturalSize.w <= 0 || naturalSize.h <= 0) return { w: 0, h: 0 };

    let maxW = canvasSize.w;
    let maxH = canvasSize.h;
    if (maxW <= 0 || maxH <= 0) {
      const ctr = containerRef.current;
      maxW = ctr ? Math.max(0, ctr.clientWidth - 48) : 800;
      maxH = ctr ? Math.max(0, ctr.clientHeight - 48) : 600;
    }

    const scale = Math.min(maxW / naturalSize.w, maxH / naturalSize.h);
    if (!Number.isFinite(scale) || scale <= 0) return { w: 0, h: 0 };
    return { w: Math.round(naturalSize.w * scale), h: Math.round(naturalSize.h * scale) };
  }, [canvasSize, naturalSize, containerRef]);

  /* ★ safeFrame — 컷 카드 썸네일에 실제로 보일 영역(디스플레이 좌표 4꼭짓점).
   * 에디터는 원본 전체를 보여주지만 썸네일은 format-ratio 로 cover-크롭하므로,
   * 프레임 밖에 그린 내용은 카드에서 잘린다. 사용자가 그 경계를 인지하도록
   * 가이드를 그린다. 에디터에서 직접 crop(croppedImgSrc) 한 뒤에는 저장된
   * conti_image_crop 이 더는 그 이미지에 대응하지 않으므로 기본 중앙 cover 로 본다. */
  const safeFrame = useMemo<SafePt[] | null>(() => {
    if (!showSafeFrame) return null;
    if (effectiveSize.w <= 0 || effectiveSize.h <= 0) return null;
    if (naturalSize.w <= 0 || naturalSize.h <= 0) return null;
    const fmt: VideoFormat = videoFormat ?? "vertical";
    const ia = naturalSize.w / naturalSize.h;
    const crop = croppedImgSrc ? null : getStoredCropForFormat(contiImageCrop, fmt);
    const quad = computeSafeFrameQuad(effectiveSize.w, effectiveSize.h, ia, crop, fmt);
    // 가시 영역이 사실상 이미지 전체면(잘림 없음) 가이드를 숨긴다.
    const W = effectiveSize.w;
    const H = effectiveSize.h;
    const eps = Math.max(1.5, Math.min(W, H) * 0.01);
    const coversAll =
      quad[0].x <= eps &&
      quad[0].y <= eps &&
      quad[1].x >= W - eps &&
      quad[1].y <= eps &&
      quad[2].x >= W - eps &&
      quad[2].y >= H - eps &&
      quad[3].x <= eps &&
      quad[3].y >= H - eps;
    return coversAll ? null : quad;
  }, [showSafeFrame, effectiveSize, naturalSize, contiImageCrop, videoFormat, croppedImgSrc]);

  /* ── image load ── */
  useEffect(() => {
    if (!effectiveImageUrl) return;
    setImgLoaded(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setImgLoaded(true);
    };
    img.src = effectiveImageUrl;
  }, [effectiveImageUrl]);

  /* ── text objects helper ── */
  const getTextObjects = useCallback(() => actions.filter((a): a is TextObject => a.type === "textobj"), [actions]);
  /** 선택 가능한(텍스트 + 이미지) 액션. */
  const getSelectableObjects = useCallback(
    () => actions.filter((a): a is SelectableObj => a.type === "textobj" || a.type === "image"),
    [actions],
  );
  const selectedObj: SelectableObj | null = selectedId
    ? (getSelectableObjects().find((o) => o.id === selectedId) ?? null)
    : null;

  /* ── image layer helpers ── */
  /** ImageLayer 의 src 를 HTMLImageElement 로 로드(1회 디코드), 캐시. 로드 완료시 redraw tick 증가. */
  const ensureImageLayerLoaded = useCallback((src: string): HTMLImageElement | null => {
    const cache = imageLayerCacheRef.current;
    const cached = cache.get(src);
    if (cached) return cached.complete ? cached : null;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setImageLayerTick((t) => t + 1);
    img.onerror = () => setImageLayerTick((t) => t + 1);
    img.src = src;
    cache.set(src, img);
    return img.complete ? img : null;
  }, []);

  /** actions 변경시 새로운 ImageLayer 들의 로딩을 트리거. */
  useEffect(() => {
    for (const a of actions) {
      if (a.type === "image") ensureImageLayerLoaded(a.src);
    }
  }, [actions, ensureImageLayerLoaded]);

  /** File → dataURL. 긴 변이 MAX_IMAGE_LAYER_DIM 초과시 다운스케일 + 알파 보존 PNG 로 재인코딩. */
  const fileToLayerDataUrl = useCallback(async (file: File): Promise<{ src: string; w: number; h: number }> => {
    const readerUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error ?? new Error("read"));
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode"));
      im.src = readerUrl;
    });
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const longest = Math.max(iw, ih);
    if (longest <= MAX_IMAGE_LAYER_DIM) return { src: readerUrl, w: iw, h: ih };
    const scale = MAX_IMAGE_LAYER_DIM / longest;
    const tw = Math.max(1, Math.round(iw * scale));
    const th = Math.max(1, Math.round(ih * scale));
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    c.getContext("2d")!.drawImage(img, 0, 0, tw, th);
    return { src: c.toDataURL("image/png"), w: tw, h: th };
  }, []);

  /** 이미지 레이어 추가. 캔버스 중앙에 긴 변 = 캔버스 50% 로 배치. */
  const addImageLayerFromFile = useCallback(
    async (file: File) => {
      try {
        const { src, w: iw, h: ih } = await fileToLayerDataUrl(file);
        const cv = canvasRef.current;
        if (!cv) return;
        const target = Math.max(cv.width, cv.height) * 0.5;
        const ratio = iw / ih;
        let w = target;
        let h = target;
        if (iw >= ih) {
          w = target;
          h = Math.round(target / ratio);
        } else {
          h = target;
          w = Math.round(target * ratio);
        }
        const x = Math.round((cv.width - w) / 2);
        const y = Math.round((cv.height - h) / 2);
        const id = genImgId();
        const layer: ImageLayer = { type: "image", id, src, x, y, w, h };
        ensureImageLayerLoaded(src);
        setActions((prev) => {
          setRedoStack([]);
          return [...prev.slice(-(MAX_UNDO - 1)), layer];
        });
        setTool("select");
        setSelectedId(id);
      } catch (err) {
        console.error("Image layer add failed:", err);
      }
    },
    [fileToLayerDataUrl, ensureImageLayerLoaded],
  );

  /** 툴바의 "Image" 버튼 클릭시 숨김 input 열기. */
  const openImagePicker = useCallback(() => {
    imageFileInputRef.current?.click();
  }, []);

  /* ── crop aspect ── */
  const getCropAspect = useCallback((): number | null => {
    if (cropRatio === "16:9") return 16 / 9;
    if (cropRatio === "9:16") return 9 / 16;
    if (cropRatio === "1:1") return 1;
    return null;
  }, [cropRatio]);

  /* ── brush cursor ── */
  const drawCursorAt = useCallback(
    (clientX: number, clientY: number) => {
      const cc = cursorCanvasRef.current;
      const cv = canvasRef.current;
      if (!cc || !cv) return;
      const rect = cv.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (cc.width !== Math.round(rect.width) || cc.height !== Math.round(rect.height)) {
        cc.width = Math.round(rect.width);
        cc.height = Math.round(rect.height);
      }
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const r = Math.max(2, (brushSize * (rect.width / cv.width)) / 2);
      const ctx = cc.getContext("2d")!;
      ctx.clearRect(0, 0, cc.width, cc.height);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "hsl(var(--foreground) / 0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    },
    [brushSize],
  );

  const clearCursor = useCallback(() => {
    const cc = cursorCanvasRef.current;
    if (!cc) return;
    cc.getContext("2d")?.clearRect(0, 0, cc.width, cc.height);
  }, []);

  /** 선택된 오브젝트 outline + 8 핸들. 텍스트/이미지 공통. */
  const drawSelectionOverlay = useCallback((ctx: CanvasRenderingContext2D, obj: SelectableObj) => {
    const b = getBoundsRect(obj);
    ctx.save();
    ctx.strokeStyle = KR;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    for (const h of getHandlesForBounds(b)) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeStyle = KR;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    }
    ctx.restore();
  }, []);

  /* ── redraw ── */
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !imgLoaded) return;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const a of actions) {
      if (a.type === "path" && a.points.length >= 1) {
        /* length >= 1 — 단일 클릭도 렌더 */
        ctx.save();
        ctx.globalCompositeOperation = a.isEraser ? "destination-out" : "source-over";
        const strokeColor = a.isEraser ? "rgba(0,0,0,1)" : a.color;
        if (a.points.length === 1) {
          const p0 = a.points[0];
          const r = (a.size * (p0.p ?? 1)) / 2;
          ctx.fillStyle = strokeColor;
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
        } else {
          // 필압 지원: 각 세그먼트를 평균 압력 기반 두께로 개별 stroke
          // 점 수가 적으면 일정 두께(size) 로 fallback
          ctx.strokeStyle = strokeColor;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          const hasPressure = a.points.some((pt) => pt.p !== undefined && pt.p !== 1);
          if (hasPressure) {
            for (let i = 1; i < a.points.length; i++) {
              const a0 = a.points[i - 1];
              const a1 = a.points[i];
              const pAvg = ((a0.p ?? 1) + (a1.p ?? 1)) / 2;
              ctx.lineWidth = Math.max(0.5, a.size * pAvg);
              ctx.beginPath();
              ctx.moveTo(a0.x, a0.y);
              ctx.lineTo(a1.x, a1.y);
              ctx.stroke();
            }
          } else {
            ctx.lineWidth = a.size;
            ctx.beginPath();
            ctx.moveTo(a.points[0].x, a.points[0].y);
            for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
            ctx.stroke();
          }
        }
        ctx.restore();
      } else if (a.type === "textobj") {
        ctx.fillStyle = a.color;
        ctx.font = `bold ${a.fontSize}px sans-serif`;
        ctx.fillText(a.text, a.x, a.y);
        if (a.id === selectedId) drawSelectionOverlay(ctx, a);
      } else if (a.type === "image") {
        const im = ensureImageLayerLoaded(a.src);
        if (im && im.complete && im.naturalWidth > 0) {
          ctx.drawImage(im, a.x, a.y, a.w, a.h);
        } else {
          ctx.save();
          ctx.fillStyle = "hsl(var(--foreground) / 0.04)";
          ctx.fillRect(a.x, a.y, a.w, a.h);
          ctx.strokeStyle = "hsl(var(--foreground) / 0.25)";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(a.x, a.y, a.w, a.h);
          ctx.setLineDash([]);
          ctx.restore();
        }
        if (a.id === selectedId) drawSelectionOverlay(ctx, a);
      }
    }
    if (currentStroke.current.length > 1 && tool === "pen") {
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "source-over";
      for (let i = 1; i < currentStroke.current.length; i++) {
        const a0 = currentStroke.current[i - 1];
        const a1 = currentStroke.current[i];
        const pAvg = ((a0.p ?? 1) + (a1.p ?? 1)) / 2;
        ctx.lineWidth = Math.max(0.5, brushSize * pAvg);
        ctx.beginPath();
        ctx.moveTo(a0.x, a0.y);
        ctx.lineTo(a1.x, a1.y);
        ctx.stroke();
      }
    }
    if (tool === "crop" && cropRect) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.strokeStyle = "hsl(var(--foreground) / 0.3)";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cropRect.x + (cropRect.w / 3) * i, cropRect.y);
        ctx.lineTo(cropRect.x + (cropRect.w / 3) * i, cropRect.y + cropRect.h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cropRect.x, cropRect.y + (cropRect.h / 3) * i);
        ctx.lineTo(cropRect.x + cropRect.w, cropRect.y + (cropRect.h / 3) * i);
        ctx.stroke();
      }
      for (const ch of [
        { x: cropRect.x, y: cropRect.y },
        { x: cropRect.x + cropRect.w / 2, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y },
        { x: cropRect.x, y: cropRect.y + cropRect.h / 2 },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h / 2 },
        { x: cropRect.x, y: cropRect.y + cropRect.h },
        { x: cropRect.x + cropRect.w / 2, y: cropRect.y + cropRect.h },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
      ]) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(ch.x - 4, ch.y - 4, 8, 8);
        ctx.strokeStyle = KR;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ch.x - 4, ch.y - 4, 8, 8);
      }
    }
    // `imageLayerTick` 은 콜백 본문에서 직접 참조되지 않지만, ImageLayer 가 비동기로
    // 디코드 완료될 때 이 값이 bump 되면서 redraw 의 identity 를 갱신하고, 하위
    // useEffect 가 다시 실행되어 캔버스에 새로 로드된 이미지를 반영한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    actions,
    imgLoaded,
    tool,
    color,
    brushSize,
    selectedId,
    cropRect,
    drawSelectionOverlay,
    ensureImageLayerLoaded,
    imageLayerTick,
  ]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !naturalSize.w) return;
    cv.width = naturalSize.w;
    cv.height = naturalSize.h;
    redraw();
  }, [naturalSize, redraw]);

  /* ★ toCanvas — clientX/clientY - rect 으로 계산.
   * Pointer 이벤트 (+ coalesced samples) 는 offsetX/Y 가 항상 정확하진 않으므로
   * rect 기반 변환으로 일관성 확보. rect.width=0 가드 유지. */
  const toCanvas = (clientX: number, clientY: number) => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    let cssX = clientX - rect.left;
    let cssY = clientY - rect.top;
    if (flipH) cssX = rect.width - cssX;
    if (flipV) cssY = rect.height - cssY;
    return { x: cssX * (cv.width / rect.width), y: cssY * (cv.height / rect.height) };
  };

  /* 필압 → 유효 압력.
   * - 마우스: 1.0 고정 (PointerEvent.pressure 는 버튼 눌렀을 때 0.5 기본 → 오해 방지)
   * - 스타일러스/터치: PRESSURE_MIN~MAX 범위로 매핑
   */
  const effectivePressure = (pointerType: string | undefined, rawPressure: number | undefined): number => {
    if (pointerType === "mouse" || pointerType === undefined) return 1;
    const p = typeof rawPressure === "number" && rawPressure > 0 ? rawPressure : 0.5;
    return Math.max(0, Math.min(1, PRESSURE_MIN + (PRESSURE_MAX - PRESSURE_MIN) * p));
  };

  /* ── snapshot helpers ── */
  const pushAction = (action: DrawAction) => {
    setActions((prev) => {
      setRedoStack([]);
      return [...prev.slice(-(MAX_UNDO - 1)), action];
    });
  };

  /* ── select handlers ── */
  const handleSelectDown = (p: { x: number; y: number }) => {
    const selObjs = getSelectableObjects();
    const cv = canvasRef.current;
    const tol = cv ? HANDLE_SIZE * (cv.width / (effectiveSize.w || cv.width)) : HANDLE_SIZE;
    if (selectedObj) {
      const hid = hitTestHandle(selectedObj, p.x, p.y, tol);
      if (hid) {
        setDragState({ mode: "resize", handleId: hid, startX: p.x, startY: p.y, origObj: { ...selectedObj } });
        return;
      }
      if (hitTestObj(selectedObj, p.x, p.y)) {
        setDragState({ mode: "move", startX: p.x, startY: p.y, origObj: { ...selectedObj } });
        return;
      }
    }
    // 위에서 아래로 쌓인 순서대로 hit-test (나중 추가 오브젝트가 상단)
    for (let i = selObjs.length - 1; i >= 0; i--) {
      if (hitTestObj(selObjs[i], p.x, p.y)) {
        setSelectedId(selObjs[i].id);
        setDragState({ mode: "move", startX: p.x, startY: p.y, origObj: { ...selObjs[i] } });
        return;
      }
    }
    setSelectedId(null);
  };

  const handleSelectMove = (p: { x: number; y: number }, opts?: { shiftKey?: boolean }) => {
    if (!dragState || !selectedObj) return;
    const shiftKey = !!opts?.shiftKey;
    const dx = p.x - dragState.startX,
      dy = p.y - dragState.startY;
    const orig = dragState.origObj;
    if (dragState.mode === "move") {
      if (orig.type === "textobj") {
        setActions((prev) =>
          prev.map((a) =>
            a.type === "textobj" && a.id === orig.id ? { ...orig, x: orig.x + dx, y: orig.y + dy } : a,
          ),
        );
      } else {
        setActions((prev) =>
          prev.map((a) =>
            a.type === "image" && a.id === orig.id ? { ...orig, x: orig.x + dx, y: orig.y + dy } : a,
          ),
        );
      }
      return;
    }
    if (dragState.mode === "resize" && dragState.handleId) {
      const hid = dragState.handleId;
      if (orig.type === "textobj") {
        // 텍스트는 코너 핸들로만 폰트 크기 스케일 (기존 동작 유지)
        if (["tl", "tr", "bl", "br"].includes(hid)) {
          const scaleRef = hid === "tl" || hid === "tr" ? -dy : dy;
          const scale = Math.max(0.3, 1 + scaleRef / orig.height);
          const newFs = Math.max(8, Math.round(orig.fontSize * scale));
          const cv = canvasRef.current;
          if (cv) {
            const m = measureText(cv.getContext("2d")!, orig.text, newFs);
            setActions((prev) =>
              prev.map((a) =>
                a.type === "textobj" && a.id === orig.id
                  ? { ...orig, fontSize: newFs, width: m.width, height: m.height }
                  : a,
              ),
            );
          }
        }
        return;
      }
      // ImageLayer 리사이즈: top-left 기준으로 각 핸들별 (x, y, w, h) 조정.
      // shiftKey = true 일 때
      //   - 코너 핸들: 원본 aspect 고정. dx/dy 중 더 큰 변화를 기준으로 다른 축 산출.
      //   - 사이드 핸들: 주 축은 그대로, 수직 축도 같은 비율로 함께 스케일 + 위아래(or 좌우) 대칭 중심 고정.
      let { x, y, w, h } = orig;
      const MIN = 16;
      const aspect = orig.w / Math.max(1, orig.h);
      const isCorner = hid === "tl" || hid === "tr" || hid === "bl" || hid === "br";

      if (shiftKey && isCorner) {
        const signX = hid === "tr" || hid === "br" ? 1 : -1;
        const signY = hid === "bl" || hid === "br" ? 1 : -1;
        // 두 축 중 변화가 큰 쪽을 "주 축"으로 삼아 다른 축을 aspect 로 파생.
        const wCand = Math.max(MIN, orig.w + signX * dx);
        const hCand = Math.max(MIN, orig.h + signY * dy);
        if (Math.abs(wCand - orig.w) * (1 / aspect) >= Math.abs(hCand - orig.h)) {
          w = wCand;
          h = Math.max(MIN, w / aspect);
        } else {
          h = hCand;
          w = Math.max(MIN, h * aspect);
        }
        // anchor(반대편 코너)를 고정해 x,y 재계산
        if (hid === "tl") {
          x = orig.x + (orig.w - w);
          y = orig.y + (orig.h - h);
        } else if (hid === "tr") {
          x = orig.x;
          y = orig.y + (orig.h - h);
        } else if (hid === "bl") {
          x = orig.x + (orig.w - w);
          y = orig.y;
        } else {
          x = orig.x;
          y = orig.y;
        }
      } else {
        switch (hid) {
          case "br":
            w = Math.max(MIN, orig.w + dx);
            h = Math.max(MIN, orig.h + dy);
            break;
          case "bl":
            w = Math.max(MIN, orig.w - dx);
            h = Math.max(MIN, orig.h + dy);
            x = orig.x + (orig.w - w);
            break;
          case "tr":
            w = Math.max(MIN, orig.w + dx);
            h = Math.max(MIN, orig.h - dy);
            y = orig.y + (orig.h - h);
            break;
          case "tl":
            w = Math.max(MIN, orig.w - dx);
            h = Math.max(MIN, orig.h - dy);
            x = orig.x + (orig.w - w);
            y = orig.y + (orig.h - h);
            break;
          case "tc":
            h = Math.max(MIN, orig.h - dy);
            y = orig.y + (orig.h - h);
            if (shiftKey) {
              // 대칭 스케일: 중심 고정
              w = Math.max(MIN, h * aspect);
              x = orig.x + (orig.w - w) / 2;
            }
            break;
          case "bc":
            h = Math.max(MIN, orig.h + dy);
            if (shiftKey) {
              w = Math.max(MIN, h * aspect);
              x = orig.x + (orig.w - w) / 2;
            }
            break;
          case "ml":
            w = Math.max(MIN, orig.w - dx);
            x = orig.x + (orig.w - w);
            if (shiftKey) {
              h = Math.max(MIN, w / aspect);
              y = orig.y + (orig.h - h) / 2;
            }
            break;
          case "mr":
            w = Math.max(MIN, orig.w + dx);
            if (shiftKey) {
              h = Math.max(MIN, w / aspect);
              y = orig.y + (orig.h - h) / 2;
            }
            break;
        }
      }
      setActions((prev) =>
        prev.map((a) => (a.type === "image" && a.id === orig.id ? { ...orig, x, y, w, h } : a)),
      );
    }
  };

  /* ── crop handlers ── */
  const handleCropDown = (p: { x: number; y: number }) => {
    if (cropRect) {
      const cr = cropRect,
        tol = 10;
      const corners = [
        { id: "tl" as HandleId, x: cr.x, y: cr.y },
        { id: "tr" as HandleId, x: cr.x + cr.w, y: cr.y },
        { id: "bl" as HandleId, x: cr.x, y: cr.y + cr.h },
        { id: "br" as HandleId, x: cr.x + cr.w, y: cr.y + cr.h },
      ];
      for (const h of corners) {
        if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) {
          setCropDrag({ mode: "handle", handleId: h.id, startX: p.x, startY: p.y, origRect: { ...cr } });
          return;
        }
      }
      if (p.x >= cr.x && p.x <= cr.x + cr.w && p.y >= cr.y && p.y <= cr.y + cr.h) {
        setCropDrag({ mode: "move", startX: p.x, startY: p.y, origRect: { ...cr } });
        return;
      }
    }
    setCropRect({ x: p.x, y: p.y, w: 0, h: 0 });
    setCropDrag({ mode: "draw", startX: p.x, startY: p.y, origRect: { x: p.x, y: p.y, w: 0, h: 0 } });
  };

  const handleCropMove = (p: { x: number; y: number }) => {
    if (!cropDrag) return;
    const cv = canvasRef.current;
    const maxW = cv?.width ?? naturalSize.w,
      maxH = cv?.height ?? naturalSize.h;
    const dx = p.x - cropDrag.startX,
      dy = p.y - cropDrag.startY;
    const orig = cropDrag.origRect,
      aspect = getCropAspect();
    if (cropDrag.mode === "draw") {
      const w = Math.abs(p.x - cropDrag.startX);
      let h: number;
      let y: number;
      const x = Math.min(cropDrag.startX, p.x);
      if (aspect !== null) {
        h = w / aspect;
        y = p.y >= cropDrag.startY ? cropDrag.startY : cropDrag.startY - h;
      } else {
        h = Math.abs(p.y - cropDrag.startY);
        y = Math.min(cropDrag.startY, p.y);
      }
      const cx = Math.max(0, x),
        cy = Math.max(0, y);
      setCropRect({ x: cx, y: cy, w: Math.min(Math.max(1, w), maxW - cx), h: Math.min(Math.max(1, h), maxH - cy) });
    } else if (cropDrag.mode === "move") {
      setCropRect({
        ...orig,
        x: Math.max(0, Math.min(orig.x + dx, maxW - orig.w)),
        y: Math.max(0, Math.min(orig.y + dy, maxH - orig.h)),
      });
    } else if (cropDrag.mode === "handle" && cropDrag.handleId) {
      const hid = cropDrag.handleId;
      let { x, y, w, h } = orig;
      if (aspect !== null) {
        if (hid === "br") {
          w = Math.max(20, orig.w + dx);
          h = w / aspect;
        } else if (hid === "bl") {
          w = Math.max(20, orig.w - dx);
          h = w / aspect;
          x = orig.x + orig.w - w;
        } else if (hid === "tr") {
          w = Math.max(20, orig.w + dx);
          h = w / aspect;
          y = orig.y + orig.h - h;
        } else {
          w = Math.max(20, orig.w - dx);
          h = w / aspect;
          x = orig.x + orig.w - w;
          y = orig.y + orig.h - h;
        }
      } else {
        if (hid === "br") {
          w = Math.max(20, orig.w + dx);
          h = Math.max(20, orig.h + dy);
        } else if (hid === "bl") {
          w = Math.max(20, orig.w - dx);
          h = Math.max(20, orig.h + dy);
          x = orig.x + orig.w - w;
        } else if (hid === "tr") {
          w = Math.max(20, orig.w + dx);
          h = Math.max(20, orig.h - dy);
          y = orig.y + orig.h - h;
        } else {
          w = Math.max(20, orig.w - dx);
          h = Math.max(20, orig.h - dy);
          x = orig.x + orig.w - w;
          y = orig.y + orig.h - h;
        }
      }
      setCropRect({ x, y, w, h });
    }
  };

  const applyCrop = () => {
    if (!cropRect || !imgRef.current) return;
    const cr = cropRect;
    setCropHistory((prev) => [...prev, { imgSrc: croppedImgSrc, actions: [...actions] }]);
    const out = document.createElement("canvas");
    out.width = cr.w;
    out.height = cr.h;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(imgRef.current, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w, cr.h);
    const cv = canvasRef.current;
    if (cv && actions.length > 0) {
      const tmp = document.createElement("canvas");
      tmp.width = cv.width;
      tmp.height = cv.height;
      const tc = tmp.getContext("2d")!;
      for (const a of actions) {
        if (a.type === "path" && a.points.length > 1) {
          tc.globalCompositeOperation = a.isEraser ? "destination-out" : "source-over";
          tc.strokeStyle = a.isEraser ? "rgba(0,0,0,1)" : a.color;
          tc.lineWidth = a.size;
          tc.lineCap = "round";
          tc.lineJoin = "round";
          tc.beginPath();
          tc.moveTo(a.points[0].x, a.points[0].y);
          for (let i = 1; i < a.points.length; i++) tc.lineTo(a.points[i].x, a.points[i].y);
          tc.stroke();
          tc.globalCompositeOperation = "source-over";
        } else if (a.type === "textobj") {
          tc.fillStyle = a.color;
          tc.font = `bold ${a.fontSize}px sans-serif`;
          tc.fillText(a.text, a.x, a.y);
        } else if (a.type === "image") {
          const im = imageLayerCacheRef.current.get(a.src);
          if (im && im.complete && im.naturalWidth > 0) tc.drawImage(im, a.x, a.y, a.w, a.h);
        }
      }
      ctx.drawImage(tmp, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w, cr.h);
    }
    setCroppedImgSrc(out.toDataURL("image/png"));
    setActions([]);
    setRedoStack([]);
    setCropRect(null);
    setTool("select");
  };

  /* ━━━ Pointer handlers ━━━
   * React Mouse events → Pointer events 마이그레이션:
   *   - 마우스 / 스타일러스 / 터치 통합 처리
   *   - setPointerCapture → 캔버스 밖으로 나가도 드래그 유지
   *   - getCoalescedEvents() → 빠른 이동 시 OS 가 모은 중간 샘플 복원 → 선 끊김 방지
   *   - pressure 채집 → per-point 두께 변조
   */

  const drawPenSegment = (
    ctx: CanvasRenderingContext2D,
    from: StrokePoint,
    to: StrokePoint,
    scale: number,
  ) => {
    const pAvg = ((from.p ?? 1) + (to.p ?? 1)) / 2;
    if (tool === "pen") {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, brushSize * pAvg);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "source-over";
    } else {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = Math.max(0.5, brushSize * scale * pAvg);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    if (tool === "eraser") ctx.globalCompositeOperation = "source-over";
  };

  const drawInitialDot = (ctx: CanvasRenderingContext2D, pt: StrokePoint, scale: number) => {
    ctx.save();
    const pressure = pt.p ?? 1;
    if (tool === "pen") {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(0.5, (brushSize * pressure) / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(0.5, (brushSize * scale * pressure) / 2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 마우스 우클릭/중간클릭 무시
    if (e.button !== 0 && e.button !== undefined) return;
    const canvasPos = toCanvas(e.clientX, e.clientY);
    const pressure = effectivePressure(e.pointerType, e.pressure);
    const p: StrokePoint = { x: canvasPos.x, y: canvasPos.y, p: pressure };

    if (tool === "crop") {
      handleCropDown(p);
      isDrawingRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 일부 브라우저/환경에서 capture 실패 → 무시 */
      }
      return;
    }
    if (tool === "select") {
      handleSelectDown(p);
      isDrawingRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (tool === "text") {
      const cv = canvasRef.current!;
      const rect = cv.getBoundingClientRect();
      setTextInput({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setTextValue("");
      setTimeout(() => textInputRef.current?.focus(), 50);
      (textInputRef as any)._canvasPos = p;
      return;
    }
    if (tool === "image") {
      // image 툴은 파일 업로드 전용 — 캔버스 입력으로 그리지 않음
      openImagePicker();
      return;
    }
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    isDrawingRef.current = true;
    currentStroke.current = [p];
    lastPoint.current = p;
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const rect = cv.getBoundingClientRect();
    const scale = rect.width > 0 ? cv.width / rect.width : 1;
    drawInitialDot(ctx, p, scale);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "pen" || tool === "eraser") drawCursorAt(e.clientX, e.clientY);
    if (tool === "crop") {
      const cp = toCanvas(e.clientX, e.clientY);
      if (cropDrag?.handleId) {
        setCropCursor(HANDLE_CURSOR[cropDrag.handleId] ?? "crosshair");
      } else if (cropRect) {
        const cr = cropRect,
          tol = 12;
        const ch = [
          { id: "tl", x: cr.x, y: cr.y },
          { id: "tc", x: cr.x + cr.w / 2, y: cr.y },
          { id: "tr", x: cr.x + cr.w, y: cr.y },
          { id: "ml", x: cr.x, y: cr.y + cr.h / 2 },
          { id: "mr", x: cr.x + cr.w, y: cr.y + cr.h / 2 },
          { id: "bl", x: cr.x, y: cr.y + cr.h },
          { id: "bc", x: cr.x + cr.w / 2, y: cr.y + cr.h },
          { id: "br", x: cr.x + cr.w, y: cr.y + cr.h },
        ].find((h) => Math.abs(cp.x - h.x) <= tol && Math.abs(cp.y - h.y) <= tol);
        if (ch) setCropCursor(HANDLE_CURSOR[ch.id]);
        else if (cp.x >= cr.x && cp.x <= cr.x + cr.w && cp.y >= cr.y && cp.y <= cr.y + cr.h) setCropCursor("move");
        else setCropCursor("crosshair");
      } else {
        setCropCursor("crosshair");
      }
    }
    if (!isDrawingRef.current) return;
    if (tool === "crop") {
      handleCropMove(toCanvas(e.clientX, e.clientY));
      return;
    }
    if (tool === "select") {
      handleSelectMove(toCanvas(e.clientX, e.clientY), { shiftKey: e.shiftKey });
      return;
    }
    const cv = canvasRef.current;
    if (!cv || !lastPoint.current) return;
    const ctx = cv.getContext("2d")!;
    const rect = cv.getBoundingClientRect();
    const scale = rect.width > 0 ? cv.width / rect.width : 1;

    // OS 가 한 프레임에 모은 중간 샘플들 — 빠른 드래그에서 점 끊김 제거
    const coalesced =
      typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [e.nativeEvent];
    for (const s of samples) {
      const pos = toCanvas((s as PointerEvent).clientX, (s as PointerEvent).clientY);
      const pr = effectivePressure((s as PointerEvent).pointerType ?? e.pointerType, (s as PointerEvent).pressure);
      const pt: StrokePoint = { x: pos.x, y: pos.y, p: pr };
      if (lastPoint.current) drawPenSegment(ctx, lastPoint.current, pt, scale);
      currentStroke.current.push(pt);
      lastPoint.current = pt;
    }
  };

  const handlePointerUp = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (tool === "crop") {
      setCropDrag(null);
      return;
    }
    if (tool === "select") {
      if (dragState) setDragState(null);
      return;
    }
    if ((tool === "pen" || tool === "eraser") && currentStroke.current.length > 0) {
      const cv = canvasRef.current;
      const rect = cv?.getBoundingClientRect();
      const scale = rect?.width ? cv!.width / rect.width : 1;
      pushAction({
        type: "path",
        points: [...currentStroke.current],
        color,
        size: tool === "eraser" ? brushSize * scale : brushSize,
        isEraser: tool === "eraser",
      });
    }
    currentStroke.current = [];
    lastPoint.current = null;
    redraw();
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    clearCursor();
    // setPointerCapture 가 걸려있으면 pointerleave 는 거의 오지 않음.
    // 안전장치로만 처리.
    if (!isDrawingRef.current) return;
    handlePointerUp(e);
  };

  /* ── text commit ── */
  const commitText = () => {
    if (!textValue.trim() || !textInput) {
      setTextInput(null);
      setEditingTextId(null);
      return;
    }
    const cv = canvasRef.current;
    const scale = naturalSize.w / (effectiveSize.w || naturalSize.w);
    const fs = textFontSize * scale;
    let w = 100,
      h = fs * 1.2;
    if (cv) {
      const m = measureText(cv.getContext("2d")!, textValue, fs);
      w = m.width;
      h = m.height;
    }
    if (editingTextId) {
      setActions((prev) =>
        prev.map((a) =>
          a.type === "textobj" && a.id === editingTextId
            ? { ...a, text: textValue, color, fontSize: fs, width: w, height: h }
            : a,
        ),
      );
      setEditingTextId(null);
    } else {
      const cp = (textInputRef as any)._canvasPos as { x: number; y: number } | undefined;
      if (!cp) {
        setTextInput(null);
        return;
      }
      pushAction({
        type: "textobj",
        id: genId(),
        text: textValue,
        x: cp.x,
        y: cp.y,
        fontSize: fs,
        color,
        width: w,
        height: h,
      });
    }
    setTextInput(null);
    setTextValue("");
  };

  /* ── undo/redo ── */
  const undo = () => {
    if (actions.length > 0) {
      setActions((prev) => {
        setRedoStack((r) => [...r, prev[prev.length - 1]]);
        return prev.slice(0, -1);
      });
      setSelectedId(null);
    } else if (cropHistory.length > 0) {
      const prev = cropHistory[cropHistory.length - 1];
      setCroppedImgSrc(prev.imgSrc);
      setActions(prev.actions);
      setRedoStack([]);
      setCropHistory((h) => h.slice(0, -1));
    }
  };
  const redo = () => {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      setActions((a) => [...a, prev[prev.length - 1]]);
      return prev.slice(0, -1);
    });
  };

  /* ★ 키보드 핸들러는 useEffect 한 번만 바인딩되므로 stale closure 방지용 ref */
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  useEffect(() => {
    undoRef.current = undo;
    redoRef.current = redo;
  });

  const prevColorRef = useRef(color);
  useEffect(() => {
    if (color !== prevColorRef.current && selectedId && tool === "select" && !editingTextId)
      setActions((prev) => prev.map((a) => (a.type === "textobj" && a.id === selectedId ? { ...a, color } : a)));
    prevColorRef.current = color;
  }, [color, selectedId, tool, editingTextId]);

  /* ── clear / apply ── */
  const hasAnnotations = actions.length > 0 || !!croppedImgSrc || flipH || flipV || cropHistory.length > 0;
  const originalUrl = derivedOriginal ?? _originalUrlByScene.get(sceneId) ?? null;
  const canRestore = !!(originalUrl && onRestore && (hasAnnotations || imageUrl !== originalUrl));

  const clearAll = () => {
    setActions([]);
    setRedoStack([]);
    setCropHistory([]);
    setCroppedImgSrc(null);
    setFlipH(false);
    setFlipV(false);
    setSelectedId(null);
    const cv = canvasRef.current;
    if (cv) cv.getContext("2d")!.clearRect(0, 0, cv.width, cv.height);
    if (originalUrl && onRestore) {
      _originalUrlByScene.set(sceneId, originalUrl);
      onRestore(originalUrl);
    }
  };

  const handleApply = async () => {
    if (!imgRef.current || !canvasRef.current || applying) return;
    setApplying(true);
    try {
      const out = document.createElement("canvas");
      out.width = naturalSize.w;
      out.height = naturalSize.h;
      const ctx = out.getContext("2d")!;
      if (flipH || flipV) {
        ctx.translate(flipH ? naturalSize.w : 0, flipV ? naturalSize.h : 0);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      }
      ctx.drawImage(imgRef.current, 0, 0, naturalSize.w, naturalSize.h);
      setSelectedId(null);
      for (const a of actions) {
        if (a.type === "path" && a.points.length >= 1) {
          ctx.save();
          ctx.globalCompositeOperation = a.isEraser ? "destination-out" : "source-over";
          const strokeColor = a.isEraser ? "rgba(0,0,0,1)" : a.color;
          if (a.points.length === 1) {
            const p0 = a.points[0];
            ctx.fillStyle = strokeColor;
            ctx.beginPath();
            ctx.arc(p0.x, p0.y, Math.max(0.5, (a.size * (p0.p ?? 1)) / 2), 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.strokeStyle = strokeColor;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            const hasPressure = a.points.some((pt) => pt.p !== undefined && pt.p !== 1);
            if (hasPressure) {
              for (let i = 1; i < a.points.length; i++) {
                const a0 = a.points[i - 1];
                const a1 = a.points[i];
                const pAvg = ((a0.p ?? 1) + (a1.p ?? 1)) / 2;
                ctx.lineWidth = Math.max(0.5, a.size * pAvg);
                ctx.beginPath();
                ctx.moveTo(a0.x, a0.y);
                ctx.lineTo(a1.x, a1.y);
                ctx.stroke();
              }
            } else {
              ctx.lineWidth = a.size;
              ctx.beginPath();
              ctx.moveTo(a.points[0].x, a.points[0].y);
              for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
              ctx.stroke();
            }
          }
          ctx.restore();
        } else if (a.type === "textobj") {
          ctx.fillStyle = a.color;
          ctx.font = `bold ${a.fontSize}px sans-serif`;
          ctx.fillText(a.text, a.x, a.y);
        } else if (a.type === "image") {
          // 저장 전에 모든 이미지 레이어 디코드 완료 보장
          let im = imageLayerCacheRef.current.get(a.src);
          if (!im || !im.complete || im.naturalWidth === 0) {
            im = await new Promise<HTMLImageElement>((res, rej) => {
              const n = new Image();
              n.crossOrigin = "anonymous";
              n.onload = () => res(n);
              n.onerror = () => rej(new Error("image layer decode"));
              n.src = a.src;
            });
            imageLayerCacheRef.current.set(a.src, im);
          }
          ctx.drawImage(im, a.x, a.y, a.w, a.h);
        }
      }
      const blob = await new Promise<Blob>((res, rej) =>
        out.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"),
      );
      const path = `${projectId}/scene_${sceneNumber}_editor_${Date.now()}.png`;
      const { error } = await supabase.storage
        .from("contis")
        .upload(path, blob, { contentType: "image/png", upsert: true });
      if (error) throw error;
      onApply(supabase.storage.from("contis").getPublicUrl(path).data.publicUrl);
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      setApplying(false);
    }
  };

  /* ── keyboard ──
   *   Undo/Redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z
   *   Delete: 선택된 텍스트 삭제
   *   Tools: V(select) / T(text) / P(pen) / E(eraser) / C(crop)
   *   Brush size: [ / ]  (Shift = x5)
   *   텍스트 입력 / 작업 대상 input·textarea·contentEditable 에선 무시
   */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isEditingField =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable === true ||
        !!textInput; // 텍스트 입력 중엔 모든 단축키 차단

      // Ctrl/Cmd+Z → Undo, Ctrl/Cmd+Shift+Z → Redo.
      // e.code === "KeyZ" 로 비교: Shift 조합에서 e.key 가 "Z"/"z" 레이아웃별로 달라지는 문제 회피.
      if ((e.metaKey || e.ctrlKey) && (e.code === "KeyZ" || e.key === "z" || e.key === "Z")) {
        if (isEditingField) return;
        e.preventDefault();
        if (e.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      // Ctrl/Cmd+Y → Redo (일반 윈도우 관행)
      if ((e.metaKey || e.ctrlKey) && (e.code === "KeyY" || e.key === "y" || e.key === "Y")) {
        if (isEditingField) return;
        e.preventDefault();
        redoRef.current();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !isEditingField) {
        e.preventDefault();
        setActions((prev) =>
          prev.filter((a) => !((a.type === "textobj" || a.type === "image") && a.id === selectedId)),
        );
        setSelectedId(null);
        return;
      }

      if (isEditingField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 툴 단축키 — 일부는 Text 탭 활성 중엔 충돌 가능하므로 editingField 가드로 보호됨
      switch (e.key.toLowerCase()) {
        case "v":
          e.preventDefault();
          setTool("select");
          return;
        case "t":
          e.preventDefault();
          setTool("text");
          setSelectedId(null);
          return;
        case "p":
          e.preventDefault();
          setTool("pen");
          setSelectedId(null);
          return;
        case "e":
          e.preventDefault();
          setTool("eraser");
          setSelectedId(null);
          return;
        case "c":
          e.preventDefault();
          setTool("crop");
          setSelectedId(null);
          return;
        case "i":
          e.preventDefault();
          setTool("image");
          setSelectedId(null);
          openImagePicker();
          return;
      }

      // 브러시 크기: [ / ]  (Shift = ±5)
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const delta = (e.key === "]" ? 1 : -1) * (e.shiftKey ? 5 : 1);
        setBrushSize((s) => Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, s + delta)));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedId, textInput, openImagePicker]);

  const transform = `${flipH ? "scaleX(-1)" : ""} ${flipV ? "scaleY(-1)" : ""}`.trim() || undefined;
  const hasChanges = actions.length > 0 || flipH || flipV || !!croppedImgSrc;
  const getCursor = () => {
    if (tool === "pen" || tool === "eraser") return "none";
    if (tool === "select") return dragState ? "grabbing" : "default";
    if (tool === "text") return "text";
    if (tool === "crop") return cropCursor;
    if (tool === "image") return "copy";
    return "crosshair";
  };

  /* ━━━ Color controls ━━━
   * 이전엔 단색 정사각형 픽커가 툴과 상관없이 항상 떠 있어서 시각 노이즈가
   * 컸음. 컬러는 pen/text(또는 select 로 텍스트 객체를 잡았을 때) 에서만
   * 의미 있으므로 해당 맥락에서만 노출하고, 단일 스와치 대신
   *   · 4개 프리셋 미니 스와치 (16px)
   *   · 커스텀 픽커 스와치 (20px) + Palette 인디케이터
   * 조합으로 폴리시. 활성 프리셋은 KR ring 으로 표시. */
  const renderColorControls = () => (
    <div className="flex items-center gap-1">
      {COLOR_PRESETS.map((preset) => {
        const isActive = color.toLowerCase() === preset.toLowerCase();
        return (
          <button
            key={preset}
            type="button"
            onClick={() => setColor(preset)}
            title={preset}
            className="w-4 h-4 transition-transform hover:scale-110"
            style={{
              background: preset,
              boxShadow: isActive
                ? `inset 0 0 0 1.5px ${KR}, 0 0 0 1px rgba(0,0,0,0.5)`
                : "inset 0 0 0 1px hsl(var(--foreground) / 0.2)",
            }}
          />
        );
      })}
      <button
        type="button"
        onClick={() => colorInputRef.current?.click()}
        className="relative w-5 h-5 ml-0.5 transition-transform hover:scale-105"
        title={t("annot.customColor", { color })}
        style={{
          background: color,
          boxShadow: "inset 0 0 0 1px hsl(var(--foreground) / 0.25), 0 0 0 1px rgba(0,0,0,0.5)",
        }}
      >
        <Palette
          className="absolute -bottom-1 -right-1 w-2.5 h-2.5 text-white/90"
          style={{ background: "hsl(var(--background))", padding: "1px" }}
        />
      </button>
    </div>
  );

  if (!imageUrl && !croppedImgSrc)
    return <div className="text-muted-foreground text-sm flex items-center justify-center h-full">{t("annot.noImage")}</div>;
  if (!imgLoaded)
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
      </div>
    );

  /* ━━━ Drag & Drop: 외부 파일(이미지/알파 PNG)을 캔버스에 드롭 → 레이어로 추가 ━━━
   * 중첩 엘리먼트로 인한 dragenter/dragleave 플리커는 ref 카운터로 상쇄. */
  const hasImageFiles = (dt: DataTransfer | null) => {
    if (!dt) return false;
    if (dt.types?.includes("Files")) return true;
    if (dt.items && dt.items.length > 0) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) return true;
      }
    }
    return false;
  };
  const handleEditorDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOverFiles(true);
  };
  const handleEditorDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleEditorDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragOverFiles(false);
  };
  const handleEditorDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOverFiles(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    // 여러 장이 한 번에 들어오면 겹치지 않도록 순차 추가 (각각 중앙 배치 후 offset 은 다음 개선)
    (async () => {
      for (const f of files) {
        await addImageLayerFromFile(f);
      }
    })();
  };

  return (
    <div
      className="relative w-full h-full flex flex-col items-center justify-center"
      onDragEnter={handleEditorDragEnter}
      onDragOver={handleEditorDragOver}
      onDragLeave={handleEditorDragLeave}
      onDrop={handleEditorDrop}
    >
      <div
        className="relative shrink-0"
        style={{ width: effectiveSize.w || undefined, height: effectiveSize.h || undefined, transform }}
      >
        <img
          src={effectiveImageUrl!}
          className="block w-full h-full"
          style={{ pointerEvents: "none", objectFit: "contain" }}
          alt="conti"
          crossOrigin="anonymous"
        />
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            cursor: getCursor(),
            touchAction: "none",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={(e) => {
            if (tool !== "select") return;
            const p = toCanvas(e.clientX, e.clientY);
            const objs = getTextObjects();
            for (let i = objs.length - 1; i >= 0; i--) {
              if (hitTestObj(objs[i], p.x, p.y)) {
                const obj = objs[i];
                setEditingTextId(obj.id);
                setSelectedId(obj.id);
                setTextValue(obj.text);
                setColor(obj.color);
                setTextFontSize(Math.round(obj.fontSize / (naturalSize.w / (effectiveSize.w || naturalSize.w))));
                const cv = canvasRef.current!;
                const rect = cv.getBoundingClientRect();
                let cssX = obj.x * (rect.width / cv.width);
                let cssY = (obj.y - obj.height) * (rect.height / cv.height);
                if (flipH) cssX = rect.width - cssX;
                if (flipV) cssY = rect.height - cssY;
                setTextInput({ x: cssX, y: cssY });
                setTimeout(() => textInputRef.current?.focus(), 50);
                return;
              }
            }
          }}
        />
        {safeFrame && tool !== "crop" && (
          <svg
            width={effectiveSize.w || undefined}
            height={effectiveSize.h || undefined}
            viewBox={`0 0 ${effectiveSize.w} ${effectiveSize.h}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            aria-hidden="true"
          >
            {/* 프레임 밖(= 썸네일에서 잘리는 영역)을 어둡게 덮는다. evenodd 로 안쪽 사각형을 비운다. */}
            <path
              d={`M0 0 H${effectiveSize.w} V${effectiveSize.h} H0 Z M ${safeFrame
                .map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
                .join(" L ")} Z`}
              fill="rgba(0,0,0,0.45)"
              fillRule="evenodd"
            />
            <polygon
              points={safeFrame.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.9}
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
          </svg>
        )}
        {(tool === "pen" || tool === "eraser") && (
          <canvas
            ref={cursorCanvasRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          />
        )}
        {textInput && (
          <input
            ref={textInputRef}
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setTextInput(null);
            }}
            onBlur={commitText}
            className="absolute z-10 bg-black/60 text-white border border-white/20 rounded-none px-1 py-0.5 outline-none"
            style={{
              left: textInput.x,
              top: textInput.y,
              minWidth: 80,
              fontSize: textFontSize,
              transform: flipH || flipV ? `${flipH ? "scaleX(-1)" : ""} ${flipV ? "scaleY(-1)" : ""}` : undefined,
            }}
          />
        )}
      </div>

      {/* Toolbar */}
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-2 rounded-none border z-20 flex-wrap justify-center"
        style={{ background: "hsl(var(--background))", borderColor: "hsl(var(--foreground) / 0.08)", maxWidth: "90%" }}
      >
        {tool === "crop" && cropRect ? (
          <>
            <div className="flex items-center gap-0.5 mr-2">
              {CROP_RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setCropRatio(opt.id)}
                  className="px-2 py-0.5 rounded-none text-2xs font-medium transition-colors"
                  style={{
                    background: cropRatio === opt.id ? "hsl(var(--primary) / 0.15)" : "transparent",
                    color: cropRatio === opt.id ? KR : "hsl(var(--foreground) / 0.4)",
                    border: cropRatio === opt.id ? `1px solid hsl(var(--primary) / 0.3)` : "1px solid transparent",
                  }}
                >
                  {opt.staticLabel ?? t(opt.labelKey)}
                </button>
              ))}
            </div>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button
              onClick={applyCrop}
              className="flex items-center gap-1 px-2.5 py-1 rounded-none text-caption font-medium"
              style={{ background: KR, color: "#fff" }}
            >
              <Check className="w-3.5 h-3.5" /> {t("annot.applyCrop")}
            </button>
            <button
              onClick={() => {
                setCropRect(null);
                setTool("select");
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-none text-caption font-medium text-white/60 hover:text-white"
            >
              <X className="w-3.5 h-3.5" /> {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <ToolBtn
              isActive={tool === "select"}
              icon={MousePointer2}
              label={t("annot.toolSelect")}
              onClick={() => setTool("select")}
            />
            <ToolBtn
              isActive={tool === "text"}
              icon={Type}
              label={t("annot.toolText")}
              onClick={() => {
                setTool("text");
                setSelectedId(null);
              }}
            />
            <ToolBtn
              isActive={tool === "pen"}
              icon={Pen}
              label={t("annot.toolPen")}
              onClick={() => {
                setTool("pen");
                setSelectedId(null);
              }}
            />
            <ToolBtn
              isActive={tool === "eraser"}
              icon={Eraser}
              label={t("annot.toolEraser")}
              onClick={() => {
                setTool("eraser");
                setSelectedId(null);
              }}
            />
            <ToolBtn
              isActive={tool === "crop"}
              icon={Crop}
              label={t("annot.toolCrop")}
              onClick={() => {
                setTool("crop");
                setSelectedId(null);
              }}
            />
            <ToolBtn
              isActive={tool === "image"}
              icon={ImagePlus}
              label={t("annot.toolImage")}
              onClick={() => {
                setTool("image");
                setSelectedId(null);
                openImagePicker();
              }}
            />
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addImageLayerFromFile(f);
                // 같은 파일 재선택도 허용
                e.target.value = "";
              }}
            />
            <div className="w-px h-5 bg-white/10 mx-1" />
            {tool === "crop" && (
              <>
                {CROP_RATIO_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setCropRatio(opt.id)}
                    className="px-2 py-0.5 rounded-none text-2xs font-medium transition-colors"
                    style={{
                      background: cropRatio === opt.id ? "hsl(var(--primary) / 0.15)" : "transparent",
                      color: cropRatio === opt.id ? KR : "hsl(var(--foreground) / 0.4)",
                      border: cropRatio === opt.id ? `1px solid hsl(var(--primary) / 0.3)` : "1px solid transparent",
                    }}
                  >
                    {opt.staticLabel ?? t(opt.labelKey)}
                  </button>
                ))}
                <div className="w-px h-5 bg-white/10 mx-1" />
              </>
            )}
            {(tool === "pen" || tool === "eraser") && (
              <>
                <input
                  type="range"
                  min={BRUSH_MIN}
                  max={BRUSH_MAX}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-20 h-1 cursor-pointer"
                  style={{ accentColor: KR }}
                  title={t("annot.brushSize")}
                />
                <span className="text-2xs text-white/50 min-w-[28px] text-center">{brushSize}px</span>
                {tool === "pen" && (
                  <>
                    <div className="w-px h-5 bg-white/10 mx-1" />
                    {renderColorControls()}
                  </>
                )}
                <div className="w-px h-5 bg-white/10 mx-1" />
              </>
            )}
            {tool === "text" && (
              <>
                {TEXT_FONT_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setTextFontSize(s)}
                    className="px-1.5 py-0.5 rounded-none text-2xs font-medium transition-colors"
                    style={{
                      background: textFontSize === s ? "hsl(var(--primary) / 0.15)" : "transparent",
                      color: textFontSize === s ? KR : "hsl(var(--foreground) / 0.4)",
                      border: textFontSize === s ? `1px solid hsl(var(--primary) / 0.3)` : "1px solid transparent",
                    }}
                  >
                    {s}
                  </button>
                ))}
                <div className="w-px h-5 bg-white/10 mx-1" />
                {renderColorControls()}
                <div className="w-px h-5 bg-white/10 mx-1" />
              </>
            )}
            {/* Select 모드에서 텍스트 객체가 선택된 경우에만 컬러 컨트롤 노출.
                선택된 텍스트의 색상을 즉시 변경하는 useEffect 가 이미 색
                상태와 연동돼 있음 — 컬러 컨트롤이 의미 있는 유일한 select
                케이스. 이미지 레이어/eraser 등에는 컬러가 무의미하므로 숨김. */}
            {tool === "select" && selectedObj?.type === "textobj" && (
              <>
                {renderColorControls()}
                <div className="w-px h-5 bg-white/10 mx-1" />
              </>
            )}
            {/* hidden color input 은 항상 마운트해두지 않으면 ref 가 null 인
                상태에서 클릭이 오면 무반응. 컬러 컨트롤이 어떤 툴에서든
                동일한 ref 를 공유하도록 툴바 루트에 항상 한 번만 둠. */}
            <input
              ref={colorInputRef}
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="absolute w-0 h-0 opacity-0 pointer-events-none"
              tabIndex={-1}
              aria-hidden="true"
            />
            <ActionBtn
              icon={Undo2}
              label={formatTitleShortcuts(t("annot.undo"))}
              onClick={undo}
              disabled={actions.length === 0 && cropHistory.length === 0}
            />
            <ActionBtn icon={Redo2} label={formatTitleShortcuts(t("annot.redo"))} onClick={redo} disabled={redoStack.length === 0} />
            <ActionBtn icon={FlipHorizontal2} label={t("annot.flipH")} onClick={() => setFlipH((v) => !v)} />
            <ActionBtn icon={FlipVertical2} label={t("annot.flipV")} onClick={() => setFlipV((v) => !v)} />
            <ToolBtn
              isActive={showSafeFrame}
              icon={SquareDashed}
              label={t("annot.safeFrame")}
              onClick={() => setShowSafeFrame((v) => !v)}
            />
            <button
              onClick={clearAll}
              disabled={!canRestore}
              title={canRestore ? t("annot.restoreOriginal") : t("annot.noChanges")}
              className="flex items-center gap-1 p-1.5 rounded-none transition-colors disabled:opacity-30"
              style={{ color: canRestore ? "#dc2626" : "hsl(var(--foreground) / 0.5)" }}
            >
              <RotateCcw className="w-4 h-4" />
              {canRestore && <span className="text-2xs font-medium">{t("common.restore")}</span>}
            </button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button
              onClick={handleApply}
              disabled={applying || !hasChanges}
              className="flex items-center gap-1 px-2.5 py-1 rounded-none text-caption font-medium transition-colors disabled:opacity-30"
              style={{ background: KR, color: "#fff" }}
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {t("common.apply")}
            </button>
          </>
        )}
      </div>
      {dragOverFiles && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{
            background: "hsl(var(--primary) / 0.08)",
            border: "2px dashed hsl(var(--primary) / 0.6)",
            zIndex: 50,
          }}
        >
          <div
            className="flex items-center gap-2 px-4 py-2 text-meta font-semibold text-white"
            style={{ background: "rgba(20,20,20,0.85)", border: "1px solid hsl(var(--primary) / 0.5)" }}
          >
            <ImagePlus className="w-4 h-4" />
            Drop image to add as layer
          </div>
        </div>
      )}
    </div>
  );
};
