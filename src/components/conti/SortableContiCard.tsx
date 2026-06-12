import { useState, useRef, memo, useEffect, useCallback, useSyncExternalStore } from "react";
import type { GeneratingStage } from "@/lib/conti";
import {
  Sparkles,
  Download,
  RefreshCw,
  GripVertical,
  Upload,
  History,
  RotateCcw,
  Move,
  X,
  Check,
  ChevronDown,
  SwitchCamera,
  Loader2,
  ClipboardPaste,
  Copy,
} from "lucide-react";
import { PhotoStar } from "@/components/icons/PhotoStar";
import { DotGrid3x3 } from "@/components/icons/DotGrid3x3";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { KR, DEFAULT_CONTI_INFO_VISIBILITY, normalizeGridHistory, type Scene, type Asset, type ContiInfoVisibility } from "./contiTypes";
import { InlineField, MetaRows, DescriptionField, SidePanel, resolveAsset } from "./contiInternals";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  TRANSITION_CATEGORIES,
  TRANSITION_MAP,
  normalizeTransitionKey,
  type TransitionKey,
  type TransitionCategory,
  type TransitionSpec,
} from "@/lib/transitionGrammar";
import { useUiLanguage, useT } from "@/lib/uiLanguage";
import { getAllSketchGensForScene, subscribeSketchGen } from "./sketchState";
import { isCamVarGenerating as isCamVarGeneratingStore, subscribeCamVarGen } from "./camVarGridState";

/* ClipboardItem 의 sanitized write 가 신뢰할 수 있는 MIME 은 사실상 png/jpeg
   뿐이라, gif/webp 등은 canvas 로 png 변환해 복사한다. fetch 한 blob 을
   object URL 로 디코드하므로 cross-origin canvas taint 가 발생하지 않는다. */
async function blobToPngBlob(blob: Blob): Promise<Blob> {
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode image."));
      el.src = objUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas context.");
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode image."))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

// Walks free-form scene text (description / location / etc) and returns the
// set of canonical asset tag names referenced via `@mention`. Uses
// resolveAsset so that case-insensitive matches and Korean-particle
// suffixes (e.g. `@YD가`) collapse onto the registered tag, while
// look-alike prefixes like `@BG` vs `@BG_medium` stay distinct (the
// resolver rejects ASCII tails). Returns names without the leading `@`.
const collectTagsFromText = (text: string | null | undefined, assets: Asset[]): string[] => {
  if (!text) return [];
  const matches = text.match(/@[\w가-힣-]+/g) ?? [];
  const names: string[] = [];
  for (const m of matches) {
    const r = resolveAsset(m, assets);
    if (r && !names.includes(r.name)) names.push(r.name);
  }
  return names;
};

// Builds the full tagged_assets set for a scene from BOTH its description
// AND location field. This is the single source of truth handed to the
// Conti generator's fetchTaggedAssets — it routes background variations
// like `BG_medium` to the right photo_variation, so the location tag
// MUST land here.
//
// We deliberately DROP carry-over for `background` assets that are no
// longer mentioned in either text field. Background framing is set by
// the *currently mentioned* tag (Location: `@BG_medium` should mean
// medium, not the legacy wide `@BG` that's still hanging around in
// tagged_assets from when the user first wrote `@BG` in description).
// Without this, both backgrounds get fetched and `buildAssetImageUrls`
// just picks bgAssets[0] (often the wide one), which is exactly the
// "BG_medium 호출했는데 BG가 불러와짐" symptom.
//
// Text is the single source of truth. Previously character/item tags
// were carried over from `existingTags` even when the user deleted
// their `@mention` from description/location — justified by "chip-only
// additions via UI", but the TagChip UI is display-only (no add/remove
// handler exists in the codebase). That carry-over meant a tag once
// in `tagged_assets` could never be removed except by direct DB edit,
// and duplicated scenes kept their ancestor's cast forever. Now we
// derive tags strictly from what's actually `@mentioned` in the
// current text. `existingTags` is kept in the signature purely for
// call-site compatibility.
const computeTaggedAssets = (
  description: string | null | undefined,
  location: string | null | undefined,
  assets: Asset[],
  _existingTags: string[] = [],
): string[] => {
  const fromDesc = collectTagsFromText(description, assets);
  const fromLoc = collectTagsFromText(location, assets);
  // Location tags first so fetchTaggedAssets preserves the scene's
  // primary background as bgAssets[0] downstream.
  const out: string[] = [];
  for (const n of [...fromLoc, ...fromDesc]) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
};

const TRANSITION_CATEGORY_KO: Record<TransitionCategory, string> = {
  "Camera Movement": "카메라 무브먼트",
  "Light & Optics": "빛/광학",
  "Digital / Glitch": "디지털/글리치",
  "Geometric / Morph": "기하/변형",
  Environmental: "환경 효과",
  Temporal: "시간 효과",
};

const TRANSITION_UI_KO: Record<TransitionKey, { label: string; tagline: string; guide: string }> = {
  WHIP_PAN: { label: "휩 팬", tagline: "빠른 팬의 모션 블러 정점", guide: "A컷을 기준으로 빠른 팬이 정점에 도달한 순간을 포착합니다. B컷은 직접 보이지 않고 색감 정도만 가장자리에서 살짝 묻어납니다." },
  ZOOM_PUNCH: { label: "줌 펀치", tagline: "급격한 줌의 피크 프레임", guide: "A컷 피사체를 향한 급격한 줌이 가장 강하게 걸린 순간입니다. 중심부는 비교적 읽히고 주변부는 방사형으로 흐려집니다." },
  DOLLY_ZOOM: { label: "돌리 줌", tagline: "공간이 뒤틀리는 압축감", guide: "A컷을 기준으로 배경 깊이가 비정상적으로 당겨지거나 밀리는 순간을 만듭니다. 인물/주체는 유지하고 공간감만 불안정하게 변형합니다." },
  CAMERA_ROLL: { label: "카메라 롤", tagline: "화면 축이 회전하는 순간", guide: "A컷이 회전축을 따라 기울어지는 정점입니다. B컷은 명확히 등장하지 않고 회전감과 색 흐름만 암시합니다." },
  ARC_SWEEP: { label: "아크 스윕", tagline: "궤도 이동으로 연결", guide: "카메라가 A컷에서 B컷으로 호를 그리며 이동하는 연결 프레임입니다. 두 공간이 동시에 읽히되 하나의 카메라 동선처럼 보여야 합니다." },
  LIGHT_LEAK: { label: "라이트 리크", tagline: "빛 번짐으로 화면 전환", guide: "A컷을 강한 빛 번짐이 덮는 순간입니다. B컷은 빛 속 색감이나 형태의 암시 정도만 허용합니다." },
  LENS_FLARE: { label: "렌즈 플레어", tagline: "플레어가 화면을 가르는 순간", guide: "A컷 위로 렌즈 플레어가 강하게 지나가는 순간입니다. 플레어가 주된 전환 장치이며 B컷은 직접 렌더링하지 않습니다." },
  DEFOCUS_PULL: { label: "디포커스 풀", tagline: "초점이 빠지는 순간", guide: "A컷의 초점이 풀리며 형태가 흐려지는 순간입니다. 피사체 윤곽은 남기되 B컷은 흐릿한 색면 정도로만 암시합니다." },
  GLITCH: { label: "글리치", tagline: "디지털 깨짐의 정점", guide: "주체와 배경이 디지털 노이즈, 블록, 찢김으로 분해되는 순간입니다. A/B 피사체보다 효과 자체가 화면을 지배합니다." },
  DATAMOSH: { label: "데이터모시", tagline: "프레임이 압축 오류처럼 섞임", guide: "이전 프레임의 픽셀 잔상이 다음 흐름과 뒤섞이는 순간입니다. 명확한 인물 합성보다 압축 오류 같은 흐름이 중요합니다." },
  CHROMATIC_SPLIT: { label: "색수차 분리", tagline: "RGB 채널이 갈라지는 순간", guide: "A컷 피사체의 채널이 어긋나며 색이 분리되는 순간입니다. B컷은 색 힌트 정도로만 제한합니다." },
  VHS_WARP: { label: "VHS 워프", tagline: "아날로그 화면 뒤틀림", guide: "A컷이 테이프 노이즈와 수평 왜곡으로 흔들리는 순간입니다. 화면 결함이 전환의 주된 느낌을 만듭니다." },
  MORPH: { label: "모프", tagline: "형태가 다른 형태로 변환", guide: "A컷의 실루엣이 B컷의 실루엣으로 넘어가는 중간 프레임입니다. 두 형태가 동시에 읽히는 드문 bridge 방식입니다." },
  LIQUID_WARP: { label: "리퀴드 워프", tagline: "액체처럼 휘어지는 변형", guide: "A컷이 액체 표면처럼 휘어지고 늘어나는 순간입니다. B컷은 왜곡 속 색감이나 윤곽 정도만 나타납니다." },
  SHATTER: { label: "샤터", tagline: "화면이 조각나는 순간", guide: "A컷이 유리나 파편처럼 깨져 나가는 순간입니다. 조각 속에 B컷 색이 일부 비칠 수 있지만 주체는 A컷입니다." },
  PRISM: { label: "프리즘", tagline: "굴절 조각으로 분할", guide: "A컷이 프리즘/유리 굴절처럼 여러 조각으로 나뉘는 순간입니다. 색 분산과 굴절이 핵심입니다." },
  SMOKE_VEIL: { label: "스모크 베일", tagline: "연무가 화면을 덮는 순간", guide: "A컷을 연기나 먼지가 덮으며 전환을 숨기는 순간입니다. B컷은 연무 너머 희미한 색감만 허용합니다." },
  WATER_RIPPLE: { label: "물결 리플", tagline: "수면처럼 번지는 왜곡", guide: "A컷이 물결에 비친 것처럼 퍼지고 흔들리는 순간입니다. 형태는 유지하되 표면 왜곡을 강하게 보여줍니다." },
  TIME_FREEZE: { label: "타임 프리즈", tagline: "시간이 멈춘 잔상", guide: "A컷의 동작이 멈추고 잔상/입자가 남는 순간입니다. B컷보다 멈춘 시간감과 잔상 표현이 중심입니다." },
};

const getTransitionUi = (spec: TransitionSpec, lang: "en" | "ko") =>
  lang === "ko" ? TRANSITION_UI_KO[spec.key] : { label: spec.label, tagline: spec.tagline, guide: spec.guide };

const FORMAT_RATIO: Record<string, number> = {
  horizontal: 16 / 9,
  vertical: 9 / 16,
  square: 1,
};
const FORMAT_LABEL: Record<string, string> = {
  horizontal: "16:9",
  vertical: "9:16",
  square: "1:1",
};
const ASPECT_RATIO_STR: Record<string, string> = {
  horizontal: "16 / 9",
  vertical: "9 / 16",
  square: "1 / 1",
};

interface CropState {
  _v?: number;
  x: number;
  y: number;
  scale: number;
  rotate?: number;
  fmt?: string;
  ia?: number;
}

type CropMap = Partial<Record<"horizontal" | "vertical" | "square", CropState>>;

function isCropMap(val: unknown): val is CropMap {
  if (!val || typeof val !== "object") return false;
  return "horizontal" in val || "vertical" in val || "square" in val;
}

function getCropForFmt(stored: unknown, fmt: string): CropState | null {
  if (!stored) return null;
  if (isCropMap(stored)) return (stored as CropMap)[fmt as keyof CropMap] ?? null;
  const s = stored as CropState;
  if (s._v === 2 && (!s.fmt || s.fmt === fmt)) return s;
  return null;
}

function setCropForFmt(stored: unknown, fmt: string, crop: CropState): CropMap {
  const map: CropMap = {};
  if (isCropMap(stored)) Object.assign(map, stored);
  else if (stored) {
    const s = stored as CropState;
    if (s.fmt && s._v === 2) map[s.fmt as keyof CropMap] = s;
  }
  map[fmt as keyof CropMap] = crop;
  return map;
}

function computeImageLayout(
  imgAspect: number,
  containerAspect: number,
  scale: number,
  x: number,
  y: number,
): { wPct: number; hPct: number; leftPct: number; topPct: number } {
  let covWR: number, covHR: number;
  if (imgAspect >= containerAspect) {
    covHR = 1;
    covWR = imgAspect / containerAspect;
  } else {
    covWR = 1;
    covHR = containerAspect / imgAspect;
  }
  const s = scale + 0.2;
  const wPct = s * covWR * 100;
  const hPct = s * covHR * 100;
  return {
    wPct,
    hPct,
    leftPct: 50 - wPct / 2 + x,
    topPct: 50 - hPct / 2 + y,
  };
}

// ─────────────────────────────────────────────────────
// AdjustImageModal
// ─────────────────────────────────────────────────────
function AdjustImageModal({
  imageUrl,
  videoFormat,
  initialCrop,
  onSave,
  onClose,
  onCapture,
}: {
  imageUrl: string;
  videoFormat: string;
  initialCrop: CropState;
  onSave: (crop: CropState) => void;
  onClose: () => void;
  onCapture?: (file: File) => void;
}) {
  const t = useT();
  const ratio = FORMAT_RATIO[videoFormat] ?? 16 / 9;
  const fmtLabel = FORMAT_LABEL[videoFormat] ?? "16:9";
  const arStr = ASPECT_RATIO_STR[videoFormat] ?? "16 / 9";
  const isPortrait = ratio < 1;

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const [crop, setCrop] = useState<CropState>({ rotate: 0, ...initialCrop });
  const [zoomInput, setZoomInput] = useState(String(Math.round(((initialCrop.scale ?? 0.8) + 0.2) * 100)));
  const [rotateInput, setRotateInput] = useState(String(initialCrop.rotate ?? 0));
  const [capturing, setCapturing] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [minScale, setMinScale] = useState(0.1);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    if (naturalSize.w <= 0) return;
    const cRatio = FORMAT_RATIO[videoFormat] ?? 16 / 9;
    const imgAspect = naturalSize.w / naturalSize.h;
    const sRenderContain = imgAspect >= cRatio ? cRatio / imgAspect : imgAspect / cRatio;
    const computed = Math.max(0.05, sRenderContain - 0.2);
    setMinScale(computed);
  }, [naturalSize, videoFormat]);

  const getOverflow = useCallback((): { ox: number; oy: number } => {
    const c = containerRef.current;
    if (!c) return { ox: 0, oy: 0 };
    const s = Math.max(0.1, crop.scale) + 0.2;
    const cW = c.clientWidth;
    const cH = c.clientHeight;
    const rad = ((crop.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    let covW: number, covH: number;
    if (naturalSize.w > 0 && naturalSize.h > 0) {
      const imgAspect = naturalSize.w / naturalSize.h;
      const cAspect = cW / cH;
      if (imgAspect >= cAspect) {
        covH = cH;
        covW = cH * imgAspect;
      } else {
        covW = cW;
        covH = cW / imgAspect;
      }
    } else {
      covW = cW;
      covH = cH;
    }
    const bbW = s * covW * cos + s * covH * sin;
    const bbH = s * covW * sin + s * covH * cos;
    return { ox: Math.abs(bbW - cW) / 2, oy: Math.abs(bbH - cH) / 2 };
  }, [crop.scale, crop.rotate, naturalSize]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    const { ox, oy } = getOverflow();
    const c = containerRef.current;
    if (!c) return;
    const cW = c.clientWidth;
    const cH = c.clientHeight;
    const dxPct = cW > 0 ? (dx / cW) * 100 : 0;
    const dyPct = cH > 0 ? (dy / cH) * 100 : 0;
    const mxPct = cW > 0 ? (ox / cW) * 100 : 0;
    const myPct = cH > 0 ? (oy / cH) * 100 : 0;
    setCrop((prev) => ({
      ...prev,
      x: Math.max(-mxPct, Math.min(mxPct, prev.x + dxPct)),
      y: Math.max(-myPct, Math.min(myPct, prev.y + dyPct)),
    }));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  const handleReset = () => {
    setCrop({ x: 0, y: 0, scale: 0.8, rotate: 0 });
    setZoomInput("100");
    setRotateInput("0");
  };

  const captureAsImage = useCallback(async () => {
    const c = containerRef.current;
    if (!c || !onCapture) return;
    setCapturing(true);
    try {
      const { width: cW, height: cH } = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(cW * dpr);
      canvas.height = Math.round(cH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cW, cH);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => res(el);
        el.onerror = rej;
        el.src = imageUrl;
      });
      const s = Math.max(0.1, crop.scale) + 0.2;
      const rad = ((crop.rotate ?? 0) * Math.PI) / 180;
      const imgAspect = img.naturalWidth / img.naturalHeight;
      const cAspect = cW / cH;
      let covW: number, covH: number;
      if (imgAspect >= cAspect) {
        covH = cH;
        covW = cH * imgAspect;
      } else {
        covW = cW;
        covH = cW / imgAspect;
      }
      ctx.save();
      ctx.translate(cW / 2 + (crop.x / 100) * cW, cH / 2 + (crop.y / 100) * cH);
      ctx.scale(s, s);
      ctx.rotate(rad);
      ctx.drawImage(img, -covW / 2, -covH / 2, covW, covH);
      ctx.restore();
      canvas.toBlob((blob) => {
        if (!blob) return;
        onCapture(new File([blob], "conti-capture.png", { type: "image/png" }));
        onClose();
      }, "image/png");
    } catch (err) {
      console.error("Capture failed:", err);
      alert(t("conti.captureFailedCors"));
    } finally {
      setCapturing(false);
    }
  }, [crop, imageUrl, onCapture, onClose, t]);

  const displayScale = Math.max(-0.15, crop.scale);
  const rot = crop.rotate ?? 0;
  const wProp = isPortrait ? undefined : videoFormat === "square" ? "min(60vw, 480px)" : "min(88vw, 720px)";

  const imgAspectModal = naturalSize.w > 0 ? naturalSize.w / naturalSize.h : (FORMAT_RATIO[videoFormat] ?? 16 / 9);
  const containerAspectModal = FORMAT_RATIO[videoFormat] ?? 16 / 9;
  const { wPct, hPct, leftPct, topPct } = computeImageLayout(
    imgAspectModal,
    containerAspectModal,
    displayScale,
    crop.x,
    crop.y,
  );

  const inputStyle: React.CSSProperties = {
    width: 48,
    height: 30,
    fontSize: 11,
    lineHeight: "30px",
    color: "#fff",
    textAlign: "center",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 0,
    padding: "0 4px",
    outline: "none",
    cursor: "text",
    boxSizing: "border-box",
  };

  const btnGhost: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 34,
    padding: "0 16px",
    fontSize: 13,
    fontWeight: 500,
    color: "#c4c4c4",
    background: "#2a2d33",
    border: "1px solid #3a3e45",
    borderRadius: 0,
    cursor: "pointer",
    whiteSpace: "nowrap",
    wordBreak: "keep-all",
    minWidth: 68,
    lineHeight: 1,
    boxSizing: "border-box",
  };

  const btnWhite: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    padding: "0 16px",
    fontSize: 13,
    fontWeight: 500,
    color: "#fff",
    background: "#41454d",
    border: "1px solid #54585f",
    borderRadius: 0,
    cursor: capturing ? "default" : "pointer",
    opacity: capturing ? 0.6 : 1,
    whiteSpace: "nowrap",
    wordBreak: "keep-all",
    minWidth: 96,
    lineHeight: 1,
    boxSizing: "border-box",
  };

  const btnPrimary: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    padding: "0 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: KR,
    border: "none",
    borderRadius: 0,
    cursor: "pointer",
    whiteSpace: "nowrap",
    wordBreak: "keep-all",
    minWidth: 68,
    lineHeight: 1,
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.78)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !dragging.current) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          background: "#16181c",
          border: "1px solid #2a2d33",
          borderRadius: 0,
          padding: 20,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: wProp,
          color: "#fff",
          minWidth: 260,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Move size={14} color={KR} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t("conti.adjustImage")}</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: KR,
              background: "rgba(249,66,58,0.12)",
              border: `1px solid rgba(249,66,58,0.28)`,
              borderRadius: 0,
              padding: "2px 8px",
            }}
          >
            {t("conti.outputFrame", { format: fmtLabel })}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#999", padding: 4 }}
        >
          <X size={17} />
        </button>
      </div>

      {/* 이미지 조정 영역 */}
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: "relative",
          aspectRatio: arStr,
          overflow: "hidden",
          cursor: "grab",
          userSelect: "none",
          touchAction: "none",
          border: `2px solid ${KR}`,
          borderRadius: 0,
          backgroundColor: "hsl(var(--background))",
          width: wProp,
          ...(isPortrait ? { height: "min(68vh, 480px)" } : {}),
        }}
      >
        <div
          style={{
            position: "absolute",
            width: `${wPct}%`,
            height: `${hPct}%`,
            left: `${leftPct}%`,
            top: `${topPct}%`,
            backgroundImage: `url(${imageUrl})`,
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            backgroundColor: "hsl(var(--background))",
            transform: rot !== 0 ? `rotate(${rot}deg)` : undefined,
            transformOrigin: "center center",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "rgba(255,255,255,0.45)",
            background: "rgba(0,0,0,0.55)",
            padding: "3px 12px",
            borderRadius: 20,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {t("conti.dragToReposition")}
        </div>
      </div>

      {/* Zoom 슬라이더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: wProp, minWidth: 260 }}>
        <span style={{ fontSize: 11, color: "#666", width: 36 }}>{t("conti.zoom")}</span>
        <input
          type="range"
          min={-0.15}
          max={4}
          step={0.05}
          value={displayScale}
          onChange={(e) => {
            const s = parseFloat(e.target.value);
            setCrop((prev) => ({ ...prev, scale: s }));
            setZoomInput(String(Math.round((s + 0.2) * 100)));
          }}
          style={{ flex: 1, accentColor: KR, cursor: "pointer" }}
        />
        <input
          type="text"
          inputMode="numeric"
          value={zoomInput}
          onChange={(e) => setZoomInput(e.target.value.replace(/[^0-9]/g, ""))}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            const v = parseInt(zoomInput, 10);
            if (!isNaN(v)) {
              const renderPct = v / 100;
              const s = Math.max(-0.15, Math.min(4, renderPct - 0.2));
              setCrop((prev) => ({ ...prev, scale: s }));
              setZoomInput(String(Math.round((s + 0.2) * 100)));
            } else {
              setZoomInput(String(Math.round((displayScale + 0.2) * 100)));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const delta = e.key === "ArrowUp" ? 0.01 : -0.01;
              const s = Math.max(-0.15, Math.min(4, displayScale + delta));
              setCrop((prev) => ({ ...prev, scale: s }));
              setZoomInput(String(Math.round((s + 0.2) * 100)));
            }
          }}
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: "#666" }}>%</span>
      </div>

      {/* Rotate 슬라이더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: wProp, minWidth: 260 }}>
        <span style={{ fontSize: 11, color: "#666", width: 36 }}>{t("conti.rotate")}</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={rot}
          onChange={(e) => {
            const r = parseInt(e.target.value);
            setCrop((prev) => ({ ...prev, rotate: r }));
            setRotateInput(String(r));
          }}
          style={{ flex: 1, accentColor: KR, cursor: "pointer" }}
        />
        <input
          type="text"
          inputMode="numeric"
          value={rotateInput}
          onChange={(e) => setRotateInput(e.target.value.replace(/[^0-9\-]/g, ""))}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            const v = parseInt(rotateInput, 10);
            if (!isNaN(v)) {
              const r = Math.max(-180, Math.min(180, v));
              setCrop((prev) => ({ ...prev, rotate: r }));
              setRotateInput(String(r));
            } else {
              setRotateInput(String(rot));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const delta = e.key === "ArrowUp" ? 1 : -1;
              const r = Math.max(-180, Math.min(180, rot + delta));
              setCrop((prev) => ({ ...prev, rotate: r }));
              setRotateInput(String(r));
            }
          }}
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: "#666" }}>°</span>
      </div>

      {/* 하단 버튼 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: wProp, minWidth: 260 }}>
        <button onClick={handleReset} style={{ ...btnGhost, flex: 1 }}>
          {t("conti.reset")}
        </button>
        <button onClick={onClose} style={{ ...btnGhost, flex: 1 }}>
          {t("common.cancel")}
        </button>
        {onCapture && (
          <button
            onClick={captureAsImage}
            disabled={capturing}
            style={{ ...btnWhite, flex: 1 }}
          >
            {capturing ? t("conti.capturing") : t("conti.setAsImage")}
          </button>
        )}
        <button
          onClick={() => {
            const ia = naturalSize.w > 0 ? naturalSize.w / naturalSize.h : undefined;
            onSave({ ...crop, scale: displayScale, _v: 2, fmt: videoFormat, ia });
            onClose();
          }}
          style={{ ...btnPrimary, flex: 1 }}
        >
          {t("conti.apply")}
        </button>
      </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// TransitionTechniquePicker
// ─────────────────────────────────────────────────────
//
// Grouped dropdown that drives the TR card's `transition_type` value.
// Each option shows label + korean tagline inline; hovering an option
// pops a tooltip with the full English director-guide (the exact text
// also sent to Claude downstream). This is the single UI surface that
// keeps the 19-technique grammar discoverable.
//
// Why DropdownMenu instead of Select:
//   Radix Select intercepts hover on its items for keyboard roving,
//   which fights with Tooltip's hover listeners (tooltip flickers or
//   never fires). DropdownMenu is built for richer items and lets a
//   per-item Tooltip sit naturally on the row without conflict.
//
// Legacy rows (`transition_type === "TRANSITION"` from before the
// grammar existed) normalize to null so we can surface a "Select a
// technique" placeholder rather than silently defaulting to Whip Pan.
const TransitionTechniquePicker = memo(function TransitionTechniquePicker({
  rawValue,
  onChange,
}: {
  rawValue: string | null | undefined;
  onChange: (newKey: TransitionKey) => void;
}) {
  const normalized = normalizeTransitionKey(rawValue);
  const current = normalized ? TRANSITION_MAP[normalized] : null;
  const [open, setOpen] = useState(false);
  const { language } = useUiLanguage();
  const t = useT();
  const currentUi = current ? getTransitionUi(current, language) : null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-[border-color,background-color] duration-200 hover:border-foreground/20"
          style={{
            borderRadius: 0,
            border: "1px solid hsl(var(--foreground) / 0.12)",
            background: "hsl(var(--foreground) / 0.025)",
          }}
        >
          <div className="flex flex-col min-w-0">
            <span className="text-2xs font-mono tracking-[0.08em] text-muted-foreground/70">
              {t("conti.transitionTechnique")}
            </span>
            {current ? (
              <span className="text-body font-semibold truncate text-foreground">
                {currentUi?.label}
                <span className="ml-1.5 text-caption font-normal opacity-70">
                  {currentUi?.tagline}
                </span>
              </span>
            ) : (
              <span className="text-body font-semibold text-amber-500">
                {t("conti.selectTechnique")}
              </span>
            )}
          </div>
          <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-[280px] max-h-[420px] overflow-y-auto bg-popover border border-border-subtle text-popover-foreground rounded-none"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {TRANSITION_CATEGORIES.map((group, gi) => (
          <div key={group.category}>
            {gi > 0 && <DropdownMenuSeparator className="bg-foreground/5" />}
            <DropdownMenuLabel
              className="text-2xs font-mono tracking-[0.08em] text-muted-foreground"
            >
              {language === "ko" ? TRANSITION_CATEGORY_KO[group.category] : group.category}
            </DropdownMenuLabel>
            {group.items.map((spec) => {
              const isSelected = normalized === spec.key;
              const specUi = getTransitionUi(spec, language);
              return (
                <Tooltip key={spec.key} delayDuration={250}>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      onSelect={() => {
                        onChange(spec.key);
                        setOpen(false);
                      }}
                      className="flex flex-col items-start gap-0.5 py-2 cursor-pointer data-[highlighted]:bg-foreground/5 focus:bg-foreground/5"
                      style={{
                        borderRadius: 0,
                        background: isSelected ? "hsl(var(--primary) / 0.08)" : undefined,
                      }}
                    >
                      <span
                        className="text-body font-semibold leading-tight"
                        style={{ color: isSelected ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}
                      >
                        {specUi.label}
                      </span>
                      <span
                        className="text-caption leading-tight opacity-70"
                        style={{ color: "hsl(var(--muted-foreground))" }}
                      >
                        {specUi.tagline}
                      </span>
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    sideOffset={12}
                    align="start"
                    className="max-w-[340px] bg-popover border border-border-subtle text-popover-foreground rounded-none shadow-lg"
                  >
                    <div className="flex flex-col gap-1.5 p-1">
                      <div className="text-meta font-semibold text-foreground">
                        {specUi.label}
                      </div>
                      <div className="text-caption font-mono text-muted-foreground">
                        {specUi.tagline}
                      </div>
                      <div className="text-2xs font-mono text-muted-foreground/70">
                        {t("conti.transitionGuide")}
                      </div>
                      <div
                        className="text-caption leading-relaxed mt-0.5"
                        style={{ color: "rgba(255,255,255,0.8)" }}
                      >
                        {specUi.guide}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

// ─────────────────────────────────────────────────────
// SortableContiCard
// ─────────────────────────────────────────────────────
export const SortableContiCard = memo(
  ({
    scene,
    isGenerating,
    isGeneratingAll,
    isUploading,
    isStyleTransferring,
    isStyleTransferFlow,
    isQueued,
    aspectClass,
    assetMap,
    assets,
    onClickImage,
    onGenerate,
    onInpaint,
    onCompare,
    onUpload,
    onHistory,
    onSceneUpdate,
    onDelete,
    onDuplicate,
    hasMultipleVersions,
    cacheBuster,
    historyCount,
    selected,
    onSelect,
    onSetThumbnail,
    onAdjustImage,
    onUseAsStyle,
    onRelight,
    onCameraVariations,
    onChangeAngle,
    onSketches,
    onTransitionTypeChange,
    displayNumber,
    info,
    layout = "card",
    showGroup,
    groupColor,
    groupLabel,
    isGroupStart,
    generatingStage,
    isEditGenerating,
    allScenes,
    videoFormat,
  }: {
    scene: Scene;
    isGenerating: boolean;
    isGeneratingAll: boolean;
    isUploading: boolean;
    isStyleTransferring: boolean;
    /** 스타일 트랜스퍼 작업이 전역적으로 진행 중인지 여부 (Queued 라벨 표기 분기용) */
    isStyleTransferFlow?: boolean;
    isQueued: boolean;
    aspectClass: string;
    assetMap: Record<string, Asset>;
    assets: Asset[];
    onClickImage: () => void;
    onGenerate: () => void;
    onInpaint: () => void;
    onCompare: () => void;
    onUpload: (file: File) => void;
    onHistory: () => void;
    onSceneUpdate: (sceneNumber: number, fields: Partial<Scene>) => Promise<void>;
    onDelete: () => void;
    onDuplicate: () => void;
    hasMultipleVersions: boolean;
    cacheBuster: number;
    historyCount: number;
    selected: boolean;
    onSelect: (v: boolean) => void;
    onSetThumbnail?: () => void;
    onAdjustImage?: () => void;
    /** 이 씬 이미지를 스타일 프리셋으로 등록한다. hasImage 일 때만 제공. */
    onUseAsStyle?: () => void;
    /** 조명 변경(Relight) 모달을 연다. hasImage 일 때만 제공. */
    onRelight?: () => void;
    /** 카메라 베리에이션 모달을 연다. hasImage 일 때만 제공.
     *  씬 description + tagged_assets 를 reference 로 8 가지 카메라 앵글로 병렬 생성. */
    onCameraVariations?: () => void;
    /** Change Angle 모달을 연다. hasImage 일 때만 제공.
     *  원본 이미지를 그대로 유지한 채 yaw/pitch/zoom 만 자연어로 매핑해 카메라 이동. */
    onChangeAngle?: () => void;
    /** Open ContiStudio directly on the Sketches tab for this scene.
     *  Available regardless of hasImage — sketches are composition drafts,
     *  they're often how you GET to an image in the first place. */
    onSketches?: () => void;
    onTransitionTypeChange?: (scene: Scene, newType: string) => void;
    displayNumber?: number;
    /** Per-field visibility for the text body. When every field is false the
     *  body is not rendered at all (image-only card). */
    info?: ContiInfoVisibility;
    /** "card" = vertical (header→image→body). "row" = landscape (image left,
     *  header+body right) for the single/landscape view mode. */
    layout?: "card" | "row";
    /** Scene-group (sequence) visualization. */
    showGroup?: boolean;
    groupColor?: string;
    groupLabel?: string;
    isGroupStart?: boolean;
    generatingStage?: GeneratingStage;
    isEditGenerating?: boolean;
    allScenes?: Scene[];
    videoFormat?: string;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: scene.id });
    // 드래그 중 source 카드를 *완전 투명* 으로 — DragOverlay clone 이 유일한
    // 시각 representation 이라 source 가 0.4 로 보이면 drop 직후 1~2 프레임
    // 동안 "원래 DOM 위치에 다시 등장 → sortable transition 으로 새 자리로
    // 슬라이드" 가 잔상으로 인지됨. visibility 가 아니라 opacity 0 으로 둬야
    // 레이아웃 공간은 유지되고, drop 후 새 자리에서 즉시 1 로 등장.
    const dndStyle: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0 : 1,
    };

    const fileInputRef = useRef<HTMLInputElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);

    // Info-field visibility (default = all visible). `anyInfo` gates the whole
    // text body so an all-off selection yields an image-only card.
    const vis: ContiInfoVisibility = info ?? DEFAULT_CONTI_INFO_VISIBILITY;
    const anyInfo = Object.values(vis).some(Boolean);
    const isRow = layout === "row";

    const [imgHov, setImgHov] = useState(false);
    const [moreHov, setMoreHov] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuOpenLeft, setMenuOpenLeft] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const [adjustOpen, setAdjustOpen] = useState(false);
    const t = useT();
    const { toast } = useToast();

    /* 우클릭 → 클립보드 이미지 붙여넣기. native(Electron) 경로를 먼저 시도하고
       web clipboard.read() 로 폴백. 읽은 blob 을 File 로 만들어 기존 업로드
       경로(onUpload → handleUploadConti)로 흘려보내 이미지가 없든 있든 동일하게
       교체/등록된다. */
    const handlePasteImageFromClipboard = useCallback(async () => {
      try {
        let blob: Blob | null = null;
        let pastedName: string | null = null;
        const readNative = window.preflowWindow?.readClipboardImage;
        if (readNative) {
          const bytes = await readNative().catch(() => null);
          if (bytes && bytes.byteLength > 0) blob = new Blob([bytes], { type: "image/png" });
        }
        if (!blob && navigator.clipboard?.read) {
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageType = item.types.find((ty) => ty.startsWith("image/"));
              if (imageType) {
                blob = await item.getType(imageType);
                break;
              }
            }
          } catch {
            /* 권한/포커스 거부 — native 경로도 비었으면 아래에서 안내 */
          }
        }
        // fallback: 탐색기/Finder 에서 이미지 *파일* 을 복사한 경우(클립보드에
        // 비트맵이 아닌 파일 경로가 들어감). OS 도구로 파일을 읽어온다.
        if (!blob) {
          const readFile = window.preflowWindow?.readClipboardImageFile;
          if (readFile) {
            const result = await readFile().catch(() => null);
            if (result && result.bytes.byteLength > 0) {
              blob = new Blob([result.bytes], { type: result.mime || "image/png" });
              pastedName = result.name;
            }
          }
        }
        if (!blob) throw new Error(t("conti.toast.noImageInClipboard"));
        const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const fileName = pastedName || `pasted-${Date.now()}.${ext}`;
        const file = new File([blob], fileName, { type: blob.type || "image/png" });
        onUpload(file);
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("conti.toast.pasteFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }, [onUpload, t, toast]);

    /* 우클릭 → 현재 컷 이미지를 클립보드로 복사. png/jpeg 는 원본 그대로,
       그 외(gif/webp 등)는 png 로 변환해 ClipboardItem 으로 쓴다. */
    const handleCopyImageToClipboard = useCallback(async () => {
      const url = scene.conti_image_url;
      if (!url) return;
      try {
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
          throw new Error("Clipboard API unavailable");
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.blob();
        let mime = (raw.type || "").toLowerCase();
        let outBlob = raw;
        if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
          outBlob = await blobToPngBlob(raw);
          mime = "image/png";
        }
        const writeMime = mime === "image/jpg" ? "image/jpeg" : mime;
        await navigator.clipboard.write([new ClipboardItem({ [writeMime]: outBlob })]);
        toast({ title: t("conti.toast.imageCopied") });
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("conti.toast.copyFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }, [scene.conti_image_url, t, toast]);

    const [localTitle, setLocalTitle] = useState(scene.title ?? "");
    const [localCam, setLocalCam] = useState(scene.camera_angle ?? "");
    const [localMood, setLocalMood] = useState(scene.mood ?? "");
    const [localLocation, setLocalLocation] = useState(scene.location ?? "");
    const [localDuration, setLocalDuration] = useState(scene.duration_sec != null ? String(scene.duration_sec) : "");

    useEffect(() => {
      setLocalTitle(scene.title ?? "");
      setLocalCam(scene.camera_angle ?? "");
      setLocalMood(scene.mood ?? "");
      setLocalLocation(scene.location ?? "");
      setLocalDuration(scene.duration_sec != null ? String(scene.duration_sec) : "");
    }, [scene]);

    useEffect(() => {
      if (!menuOpen) return;
      const fn = (e: MouseEvent) => {
        if (cardRef.current && !cardRef.current.contains(e.target as Node)) setMenuOpen(false);
      };
      document.addEventListener("mousedown", fn);
      return () => document.removeEventListener("mousedown", fn);
    }, [menuOpen]);

    const fmt = videoFormat ?? "horizontal";
    const imgSrc = scene.conti_image_url
      ? cacheBuster
        ? `${scene.conti_image_url}?t=${cacheBuster}`
        : scene.conti_image_url
      : null;
    const isBusy = isGenerating || isUploading || isStyleTransferring || isQueued;
    const hasImage = !!imgSrc && !isBusy;
    const showImgOverlay = imgHov || selected;
    const showMoreBtn = imgHov || menuOpen;
    const sketchGenSnapshot = useSyncExternalStore(
      useCallback(
        (onStoreChange) => subscribeSketchGen(scene.project_id, scene.id, onStoreChange),
        [scene.project_id, scene.id],
      ),
      useCallback(
        () =>
          getAllSketchGensForScene(scene.project_id, scene.id)
            .map((g) => `${g.model}:${g.arrivedUrls.length}/${g.count}:${g.promise ? "1" : "0"}`)
            .join("|"),
        [scene.project_id, scene.id],
      ),
      () => "",
    );
    const sketchGenStates = sketchGenSnapshot
      ? getAllSketchGensForScene(scene.project_id, scene.id)
      : [];
    const sketchGeneratingTotal = sketchGenStates.reduce((sum, g) => sum + g.count, 0);
    const sketchGeneratingDone = sketchGenStates.reduce((sum, g) => sum + g.arrivedUrls.length, 0);
    const isSketchGenerating = sketchGenStates.some((g) => !!g.promise);
    const sketchProgressRatio =
      sketchGeneratingTotal > 0 ? Math.min(1, sketchGeneratingDone / sketchGeneratingTotal) : 0;
    // Camera-variation grid generation runs in the background (survives the
    // modal closing) — surface a spinner on the Camera Variations quick icon so
    // it's clear which scene is still generating.
    const isCamVarGenerating = useSyncExternalStore(
      useCallback(
        (onStoreChange) => subscribeCamVarGen(scene.project_id, scene.id, onStoreChange),
        [scene.project_id, scene.id],
      ),
      useCallback(() => isCamVarGeneratingStore(scene.project_id, scene.id), [scene.project_id, scene.id]),
      () => false,
    );
    // 생성된 카메라 베리에이션 그리드 개수 — 스케치 카운트 뱃지와 동일하게 노출한다.
    const camVarGridCount = normalizeGridHistory(scene.camera_variation_grid).length;

    const STAGE_LABELS: Record<GeneratingStage, string> = {
      queued: t("conti.queued"),
      translating: t("conti.translating"),
      building: t("conti.building"),
      generating: t("conti.generating"),
      uploading: t("conti.uploading"),
    };
    // 일반 generate-all 플로우의 스테이지 번호 (Queued 는 사전 단계로 번호 미부여, 유지)
    const STAGE_STEPS: Partial<Record<GeneratingStage, string>> = {
      translating: "1/4",
      building: "2/4",
      generating: "3/4",
      uploading: "4/4",
    };
    // 스타일 트랜스퍼 플로우의 스테이지 번호
    // 4단계: Queued(1) → Style transfer...(2) → Generating...(3) → Uploading...(4)
    const STYLE_TRANSFER_STAGE_STEPS: Partial<Record<GeneratingStage, string>> = {
      generating: "3/4",
      uploading: "4/4",
    };

    // 스타일 트랜스퍼 컨텍스트: 실제 트랜스퍼 중이거나, 전역 트랜스퍼 작업의 큐 대기 중인 경우
    const isInStyleTransferContext = isStyleTransferring || (isQueued && !!isStyleTransferFlow);

    const busyLabel = generatingStage
      ? STAGE_LABELS[generatingStage]
      : isQueued
        ? t("conti.queued")
        : isStyleTransferring
          ? t("conti.styleTransferring")
          : isUploading
            ? t("conti.uploading")
            : t("conti.generating");

    // isEditGenerating=true면 inpaint 단일 호출 → "1/1" 고정 표시
    const busyStep = isEditGenerating
      ? generatingStage
        ? "1/1"
        : null
      : isInStyleTransferContext
        ? generatingStage
          ? (STYLE_TRANSFER_STAGE_STEPS[generatingStage] ?? null)
          : isQueued
            ? "1/4"
            : isStyleTransferring
              ? "2/4"
              : null
        : generatingStage
          ? (STAGE_STEPS[generatingStage] ?? null)
          : null;

    const saveField = async (fields: Partial<Scene>) => {
      await onSceneUpdate(scene.scene_number, fields);
    };

    const handleAdjustSave = async (crop: CropState) => {
      const newMap = setCropForFmt(scene.conti_image_crop, fmt, crop);
      await onSceneUpdate(scene.scene_number, { conti_image_crop: newMap } as any);
    };

    const openAdjust = () => {
      setMenuOpen(false);
      if (videoFormat) setAdjustOpen(true);
      else onAdjustImage?.();
    };

    const handleCapture = useCallback(
      (file: File) => {
        onUpload(file);
        const stored = scene.conti_image_crop;
        if (isCropMap(stored)) {
          const newMap = { ...(stored as CropMap) };
          delete newMap[fmt as keyof CropMap];
          onSceneUpdate(scene.scene_number, { conti_image_crop: Object.keys(newMap).length ? newMap : null } as any);
        } else {
          onSceneUpdate(scene.scene_number, { conti_image_crop: null } as any);
        }
      },
      [onUpload, onSceneUpdate, scene.scene_number, scene.conti_image_crop, fmt],
    );

    const normalizedInitialCrop: CropState = (() => {
      const crop = getCropForFmt(scene.conti_image_crop, fmt);
      if (crop?._v === 2) return crop;
      return { _v: 2, x: 0, y: 0, scale: 0.8, rotate: 0 };
    })();

    const activeCrop = getCropForFmt(scene.conti_image_crop, fmt);
    const isCropValid = activeCrop?._v === 2;

    const cardImageLayout = (() => {
      if (!isCropValid || !activeCrop) return null;
      const containerAspect = FORMAT_RATIO[fmt] ?? 16 / 9;
      const ia = activeCrop.ia ?? containerAspect;
      return computeImageLayout(ia, containerAspect, activeCrop.scale, activeCrop.x, activeCrop.y);
    })();

    return (
      <>
        <div
          ref={(el) => {
            setNodeRef(el);
            (cardRef as any).current = el;
          }}
          {...attributes}
          {...listeners}
          id={`conti-scene-${scene.scene_number}`}
          data-scene-id={scene.id}
          className={`overflow-visible cursor-grab active:cursor-grabbing h-full ${isRow ? "" : "flex flex-col"}`}
          style={{
            ...dndStyle,
            position: "relative",
            borderRadius: 0,
            border: selected ? `1.5px solid ${KR}` : "1px solid hsl(var(--foreground) / 0.10)",
            // subtle inset shadow — paper-thin border 의 brittle 한 느낌을 살짝 깊이감
            // 으로 살림. sharp-corner 미감은 그대로 유지.
            boxShadow: selected ? undefined : "inset 0 0 0 1px hsl(var(--foreground) / 0.03)",
            background: "hsl(var(--card))",
            transition: "border-color 0.2s ease, box-shadow 0.2s ease",
            // Row (landscape) layout: image left spanning both rows, header (top)
            // and body (bottom) stacked in the right column.
            ...(isRow
              ? {
                  display: "grid",
                  gridTemplateColumns: "clamp(240px, 34%, 420px) 1fr",
                  gridTemplateRows: "auto 1fr",
                }
              : {}),
          }}
        >
          {/* Scene-group rail — left color band when grouping viz is on. */}
          {showGroup && groupColor && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: 3,
                background: groupColor,
                zIndex: 6,
                pointerEvents: "none",
              }}
            />
          )}
          {/* ── HEADER ── */}
          <div
            className="flex items-center gap-2 px-2.5 py-1.5 border-b shrink-0"
            style={{
              background: "hsl(var(--foreground) / 0.025)",
              borderColor: "hsl(var(--foreground) / 0.08)",
              borderRadius: 0,
              ...(isRow ? { gridColumn: 2, gridRow: 1 } : {}),
            }}
          >
            <GripVertical className="w-3 h-3 shrink-0" style={{ color: "hsl(var(--foreground) / 0.22)" }} />
            {scene.is_transition ? (
              // 전환(TR) 뱃지 — 시각적으로 1군(번호 뱃지) 과 같은 patrimony 를
              // 갖도록 brand 톤 사용(채도 낮춤). 회색 #6b7280 은 카드 grid 안에서
              // *없는 정보* 처럼 보였음.
              <span
                className="font-mono text-2xs font-bold px-1.5 py-0.5 shrink-0"
                style={{
                  background: "hsl(var(--primary) / 0.2)",
                  border: "1px solid hsl(var(--primary) / 0.4)",
                  color: "hsl(var(--primary) / 0.95)",
                  borderRadius: 0,
                }}
              >
                TR
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onSceneUpdate(scene.scene_number, { is_final: !scene.is_final });
                  }}
                  title={scene.is_final ? t("conti.unmarkFinal") : t("conti.markFinal")}
                  aria-pressed={!!scene.is_final}
                  className="font-mono text-2xs font-bold px-1.5 py-0.5 text-white shrink-0 inline-flex items-center gap-0.5 cursor-pointer hover:brightness-110 transition-[filter,background-color]"
                  style={{ background: scene.is_final ? KR : "hsl(var(--muted-foreground))", borderRadius: 0 }}
                >
                  {scene.is_final && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                  <span>#{String(displayNumber ?? scene.scene_number).padStart(2, "0")}</span>
                </button>
                {showGroup && groupLabel && groupColor && (
                  <span
                    title={t("conti.groupBadgeTip")}
                    className="font-mono text-micro font-bold px-1.5 py-0.5 shrink-0 inline-flex items-center"
                    style={{
                      borderRadius: 0,
                      border: `1px solid ${groupColor}`,
                      background: `${groupColor}22`,
                      color: groupColor,
                    }}
                  >
                    {groupLabel}
                  </span>
                )}
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !scene.is_highlight;
                    void onSceneUpdate(scene.scene_number, {
                      is_highlight: next,
                      highlight_kind: next ? (scene.highlight_kind ?? "hero") : null,
                      highlight_reason: next
                        ? (scene.highlight_reason ?? t("agent.keyVisualCandidate"))
                        : null,
                    });
                  }}
                  title={scene.is_highlight ? t("conti.unmarkHighlight") : t("conti.markHighlight")}
                  aria-pressed={!!scene.is_highlight}
                  className="font-mono text-micro font-bold px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1 cursor-pointer transition-colors"
                  style={{
                    borderRadius: 0,
                    border: scene.is_highlight ? `1px solid ${KR}` : "1px solid rgba(255,255,255,0.12)",
                    background: scene.is_highlight ? "rgba(249,66,58,0.14)" : "rgba(255,255,255,0.03)",
                    color: scene.is_highlight ? "#fff" : "rgba(255,255,255,0.38)",
                  }}
                >
                  <span>H</span>
                </button>
              </>
            )}
            <div className="flex-1" />
            {historyCount > 0 && (
              <button
                title={t("conti.history")}
                onClick={(e) => {
                  e.stopPropagation();
                  onHistory();
                }}
                className="flex items-center gap-1 text-2xs font-mono hover:text-foreground transition-colors px-1.5 py-0.5"
                style={{
                  background: "hsl(var(--foreground) / 0.05)",
                  border: "none",
                  cursor: "pointer",
                  color: "hsl(var(--foreground) / 0.5)",
                  borderRadius: 0,
                }}
              >
                <History className="w-2.5 h-2.5" />
                <span>{historyCount}</span>
              </button>
            )}
            {scene.conti_image_url && (
              <a
                href={scene.conti_image_url}
                download
                target="_blank"
                rel="noopener noreferrer"
                title={t("conti.downloadImage")}
                className="w-4 h-4 flex items-center justify-center hover:text-foreground transition-colors"
                style={{ color: "rgba(255,255,255,0.25)" }}
              >
                <Download className="w-2.5 h-2.5" />
              </a>
            )}
          </div>

          {/* ── IMAGE ── */}
          <ContextMenu>
          <ContextMenuTrigger asChild>
          <div
            onMouseEnter={() => setImgHov(true)}
            onMouseLeave={() => setImgHov(false)}
            className={`relative ${aspectClass} overflow-hidden shrink-0`}
            style={{
              // 이미지 없을 때 너무 묻혀서 "여기 클릭하면 뭐가 들어간다" 시그널이
              // 약했음. 살짝 더 보이는 톤 + dashed inset 으로 placeholder affordance.
              background: imgSrc ? "hsl(var(--background))" : "hsl(var(--foreground) / 0.04)",
              boxShadow: imgSrc ? undefined : "inset 0 0 0 1px hsl(var(--foreground) / 0.08)",
              cursor: "pointer",
              // Row layout: left column spanning both rows; align to top so the
              // aspect-ratio height is preserved instead of stretching.
              ...(isRow ? { gridColumn: 1, gridRow: "1 / span 2", alignSelf: "start" } : {}),
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClickImage}
            /* 드래그&드롭은 이미지 유무와 상관없이 컷 전체에서 동작 — 이미지가
               있어도 드롭으로 새 이미지로 교체된다 (handleUploadConti 가 기존
               URL 을 히스토리로 밀어넣음). */
            onDragOver={(e) => {
              if (isBusy) return;
              e.preventDefault();
              e.stopPropagation();
              setIsDragOver(true);
            }}
            onDragEnter={(e) => {
              if (isBusy) return;
              e.preventDefault();
              e.stopPropagation();
              setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              e.stopPropagation();
              setIsDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragOver(false);
              if (isBusy) return;
              const file = e.dataTransfer.files?.[0];
              if (file?.type.startsWith("image/")) onUpload(file);
            }}
          >
            {isBusy ? (
              <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-10 gap-3">
                {/* 원형 스피너 + 중앙 스텝 번호 */}
                <div style={{ position: "relative", width: 44, height: 44 }}>
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 44 44"
                    style={{
                      position: "absolute",
                      inset: 0,
                      animation: "spin 1.2s linear infinite",
                    }}
                  >
                    <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                    <circle cx="22" cy="22" r="18" fill="none" stroke="hsl(var(--foreground) / 0.12)" strokeWidth="2.5" />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke="hsl(var(--foreground) / 0.75)"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray="28 85"
                      strokeDashoffset="0"
                    />
                  </svg>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: busyStep ? 11 : 10,
                        fontWeight: 600,
                        color: busyStep ? "hsl(var(--foreground) / 0.92)" : "hsl(var(--foreground) / 0.35)",
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: "-0.02em",
                        lineHeight: 1,
                      }}
                    >
                      {busyStep ?? "—"}
                    </span>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: "hsl(var(--foreground) / 0.65)",
                    letterSpacing: 0.2,
                  }}
                >
                  {busyLabel}
                </span>
              </div>
            ) : imgSrc ? (
              cardImageLayout ? (
                <div
                  style={{
                    position: "absolute",
                    width: `${cardImageLayout.wPct}%`,
                    height: `${cardImageLayout.hPct}%`,
                    left: `${cardImageLayout.leftPct}%`,
                    top: `${cardImageLayout.topPct}%`,
                    backgroundImage: `url(${imgSrc})`,
                    backgroundSize: "cover",
                    backgroundRepeat: "no-repeat",
                    backgroundColor: "hsl(var(--background))",
                    transform: activeCrop?.rotate ? `rotate(${activeCrop.rotate}deg)` : undefined,
                    transformOrigin: "center center",
                  }}
                />
              ) : (
                <div
                  className="w-full h-full"
                  style={{
                    backgroundImage: `url(${imgSrc})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                    backgroundColor: "hsl(var(--background))",
                  }}
                />
              )
            ) : scene.is_transition ? (
              (() => {
                const idx = allScenes?.findIndex((s) => s.id === scene.id) ?? -1;
                let prevLabel = "",
                  nextLabel = "";
                if (allScenes && idx > 0) {
                  for (let i = idx - 1; i >= 0; i--) {
                    if (!allScenes[i].is_transition) {
                      let dn = 0;
                      for (let j = 0; j <= i; j++) {
                        if (!allScenes[j].is_transition) dn++;
                      }
                      prevLabel = `#${String(dn).padStart(2, "0")}`;
                      break;
                    }
                  }
                }
                if (allScenes && idx >= 0 && idx < allScenes.length - 1) {
                  for (let i = idx + 1; i < allScenes.length; i++) {
                    if (!allScenes[i].is_transition) {
                      let dn = 0;
                      for (let j = 0; j <= i; j++) {
                        if (!allScenes[j].is_transition) dn++;
                      }
                      nextLabel = `#${String(dn).padStart(2, "0")}`;
                      break;
                    }
                  }
                }
                return (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <svg
                      viewBox="0 0 300 50"
                      width="90%"
                      height="56"
                      xmlns="http://www.w3.org/2000/svg"
                      style={{ display: "block" }}
                    >
                      <text
                        x="4"
                        y="25"
                        dominantBaseline="middle"
                        fill="#9ca3af"
                        fontSize="14"
                        fontWeight="500"
                        fontFamily="sans-serif"
                      >
                        {prevLabel}
                      </text>
                      <line x1="36" y1="25" x2="100" y2="25" stroke="#4b5563" strokeWidth="1" />
                      <circle cx="104" cy="25" r="3.5" fill="#4b5563" />
                      <text
                        x="150"
                        y="25"
                        dominantBaseline="middle"
                        textAnchor="middle"
                        fill="#9ca3af"
                        fontSize="14"
                        fontWeight="600"
                        fontFamily="sans-serif"
                      >
                        Transition
                      </text>
                      <circle cx="196" cy="25" r="3.5" fill="#4b5563" />
                      <line x1="200" y1="25" x2="260" y2="25" stroke="#4b5563" strokeWidth="1" />
                      <polygon points="260,20 270,25 260,30" fill="#4b5563" />
                      <text
                        x="276"
                        y="25"
                        dominantBaseline="middle"
                        fill="#9ca3af"
                        fontSize="14"
                        fontWeight="500"
                        fontFamily="sans-serif"
                      >
                        {nextLabel}
                      </text>
                    </svg>
                    {!isBusy && !imgSrc && (
                      <div className="absolute bottom-2 right-2 flex gap-1" style={{ zIndex: 5 }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onGenerate();
                          }}
                          title={t("conti.generate")}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 28,
                            height: 28,
                            borderRadius: 0,
                            background: KR,
                            color: "#fff",
                            border: "none",
                            cursor: "pointer",
                          }}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            fileInputRef.current?.click();
                          }}
                          title={t("conti.uploadImage")}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 28,
                            height: 28,
                            borderRadius: 0,
                            background: "hsl(var(--background))",
                            color: "hsl(var(--foreground))",
                            border: "0.5px solid hsl(var(--border))",
                            cursor: "pointer",
                          }}
                        >
                          <Upload className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                style={{ background: "transparent" }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {isGeneratingAll ? (
                  <>
                    <div className="w-8 h-8 rounded-none border-2 border-border animate-pulse" />
                    <span className="text-caption text-muted-foreground/50">{t("conti.queued")}</span>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onGenerate();
                      }}
                      title={t("conti.generate")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 36,
                        height: 36,
                        borderRadius: 0,
                        background: KR,
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      <Sparkles className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      title={t("conti.uploadImage")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 36,
                        height: 36,
                        borderRadius: 0,
                        background: "hsl(var(--background))",
                        color: "hsl(var(--foreground))",
                        border: "0.5px solid hsl(var(--border))",
                        cursor: "pointer",
                      }}
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 딤 오버레이 */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: showImgOverlay ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0)",
                transition: "background 0.15s",
                pointerEvents: "none",
              }}
            />

            {/* 체크박스 */}
            <div
              style={{
                position: "absolute",
                top: 8,
                left: 8,
                zIndex: 10,
                opacity: showImgOverlay ? 1 : 0,
                transition: "opacity 0.15s",
                pointerEvents: showImgOverlay ? "auto" : "none",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(!selected);
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 0,
                  cursor: "pointer",
                  border: selected ? "none" : `2px solid ${showImgOverlay ? "#fff" : "rgba(255,255,255,0.55)"}`,
                  background: selected ? KR : "rgba(0,0,0,0.38)",
                  backdropFilter: "blur(4px)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {selected && (
                  <svg
                    width={13}
                    height={13}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#fff"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </div>
            </div>

            {/* ··· 버튼 */}
            <div
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 10,
                opacity: showMoreBtn ? 1 : 0,
                transition: "opacity 0.15s",
                pointerEvents: showMoreBtn ? "auto" : "none",
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                onMouseEnter={() => setMoreHov(true)}
                onMouseLeave={() => setMoreHov(false)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!menuOpen) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuOpenLeft(window.innerWidth - rect.right < 220);
                  }
                  setMenuOpen((v) => !v);
                }}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 0,
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: menuOpen
                    ? "rgba(0,0,0,0.82)"
                    : moreHov
                      ? "rgba(255,255,255,0.22)"
                      : "rgba(0,0,0,0.42)",
                  // 열림 상태는 흰색 대신 어두운 톤 + 옅은 흰 링으로 "눌림"을
                  // 표현해 다크 UI 전반과 톤을 통일한다.
                  boxShadow: menuOpen ? "inset 0 0 0 1px rgba(255,255,255,0.28)" : "none",
                  backdropFilter: "blur(6px)",
                  transition: "background 0.12s",
                }}
              >
                <svg
                  width={14}
                  height={14}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v.01M12 12v.01M12 19v.01" />
                </svg>
              </button>
            </div>

            {/* Variants quick-access icons (Sketches / Use as Style).
                Relight 는 호버시 바로 노출되지 않도록 제외 — 실수 클릭을
                유발하기 쉬워 "..." 메뉴의 Variants 서브메뉴에서만 열도록
                일원화한다 (ChangeAngle 과 동일한 취급).
                Camera Variations / Change Angle 은 NB2 단일 파이프라인으로
                원본 유지 + 앵글 변경이 안정적으로 안 되므로(novel-view
                synthesis 모델 부재) 호버 퀵 아이콘에서 제외. 사이드패널
                Variants 에는 노출.
                Sketches 는 hasImage 여부와 무관하게 노출 — 오히려 콘티 이미지가
                없을 때가 주 사용 케이스(구도 탐색). */}
            {(onSketches || (hasImage && (onCameraVariations || onUseAsStyle))) && (
              <div
                style={{
                  position: "absolute",
                  bottom: 8,
                  left: 8,
                  zIndex: 5,
                  display: "flex",
                  gap: 4,
                  // Sketches 생성중일 땐 호버와 무관하게 노출 — 사용자가 콘티탭에
                  // 와 있는 동안 "지금 sketches 가 돌고 있구나" 를 즉시 인지할 수
                  // 있도록 (아이콘 안의 progress ring + count 가 그대로 동작).
                  opacity: imgHov || isSketchGenerating || isCamVarGenerating ? 1 : 0,
                  transition: "opacity 0.15s",
                  pointerEvents: imgHov || isSketchGenerating || isCamVarGenerating ? "auto" : "none",
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {onSketches && (() => {
                  // Defensive: legacy version JSON may have `sketches` as a
                  // string `"[]"`. Reading `.length` on the string yields 2
                  // and showed a phantom "2" badge → users clicked, opened
                  // StudioSketchesTab, which crashed on `sketches.filter(...)`.
                  // We hardened the read path in ContiTab.loadVersions, but
                  // also guard here so any future shape regression doesn't
                  // produce a misleading badge.
                  const sketchCount = Array.isArray(scene.sketches) ? scene.sketches.length : 0;
                  return (
                    <button
                      title={
                        sketchCount > 0
                          ? t("conti.openSketchesCount", { count: sketchCount })
                          : t("conti.openSketches")
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onSketches();
                      }}
                      className="flex items-center justify-center gap-1 min-w-[28px] h-7 px-1.5 rounded-none text-white hover:opacity-90"
                      style={{
                        background: isSketchGenerating || sketchCount > 0 ? KR : "rgba(0,0,0,0.55)",
                        border: isSketchGenerating ? "1px solid rgba(255,255,255,0.55)" : "1px solid rgba(255,255,255,0.12)",
                        cursor: "pointer",
                      }}
                    >
                      {isSketchGenerating ? (
                        <span style={{ position: "relative", width: 15, height: 15, display: "inline-flex" }}>
                          <svg width="15" height="15" viewBox="0 0 15 15" style={{ transform: "rotate(-90deg)" }}>
                            <circle
                              cx="7.5"
                              cy="7.5"
                              r="5.7"
                              fill="none"
                              stroke="rgba(255,255,255,0.28)"
                              strokeWidth="2"
                            />
                            <circle
                              cx="7.5"
                              cy="7.5"
                              r="5.7"
                              fill="none"
                              stroke="#fff"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeDasharray={`${2 * Math.PI * 5.7}`}
                              strokeDashoffset={`${2 * Math.PI * 5.7 * (1 - sketchProgressRatio)}`}
                              style={{ transition: "stroke-dashoffset 0.2s ease" }}
                            />
                          </svg>
                          <span
                            className="animate-spin"
                            style={{
                              position: "absolute",
                              inset: 1,
                              border: "1.5px solid transparent",
                              borderTopColor: "rgba(255,255,255,0.85)",
                              borderRadius: "50%",
                            }}
                          />
                        </span>
                      ) : (
                        <SwitchCamera className="w-3.5 h-3.5" />
                      )}
                      {(isSketchGenerating || sketchCount > 0) && (
                        <span className="text-2xs font-bold tracking-wide">
                          {isSketchGenerating ? `${sketchGeneratingDone}/${sketchGeneratingTotal}` : sketchCount}
                        </span>
                      )}
                    </button>
                  );
                })()}
                {hasImage && onCameraVariations && (
                  <button
                    title={
                      camVarGridCount > 0
                        ? t("conti.cameraVariationsCount", { count: camVarGridCount })
                        : t("conti.cameraVariations")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onCameraVariations();
                    }}
                    className="flex items-center justify-center gap-1 min-w-[28px] h-7 px-1.5 rounded-none text-white hover:opacity-90"
                    style={{
                      background: isCamVarGenerating || camVarGridCount > 0 ? KR : "rgba(0,0,0,0.55)",
                      border: isCamVarGenerating
                        ? "1px solid rgba(255,255,255,0.55)"
                        : "1px solid rgba(255,255,255,0.12)",
                      cursor: "pointer",
                    }}
                  >
                    {isCamVarGenerating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <DotGrid3x3 className="w-3.5 h-3.5" />
                    )}
                    {(isCamVarGenerating || camVarGridCount > 0) && (
                      <span className="text-2xs font-bold tracking-wide">{camVarGridCount}</span>
                    )}
                  </button>
                )}
                {hasImage && onUseAsStyle && (
                  <button
                    title={t("conti.useAsStyle")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUseAsStyle();
                    }}
                    className="flex items-center justify-center w-7 h-7 rounded-none text-white/90 hover:bg-white/20"
                    style={{
                      background: "rgba(0,0,0,0.55)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      cursor: "pointer",
                    }}
                  >
                    <PhotoStar className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Regenerate */}
            {hasImage && (
              <div
                style={{
                  position: "absolute",
                  bottom: 8,
                  right: 8,
                  zIndex: 5,
                  opacity: imgHov ? 1 : 0,
                  transition: "opacity 0.15s",
                  pointerEvents: imgHov ? "auto" : "none",
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onGenerate();
                  }}
                  disabled={isGeneratingAll}
                  className="flex items-center gap-1 text-caption font-semibold px-3 h-7 rounded-none text-white hover:opacity-85 disabled:opacity-40"
                  style={{ background: KR, border: "none", cursor: "pointer" }}
                >
                  <RefreshCw className="w-3 h-3" /> {t("conti.regenerate")}
                </button>
              </div>
            )}

            {/* 드래그 오버 표시 — 이미지가 있든 없든 컷 위로 드래그하면 노출. */}
            {isDragOver && !isBusy && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  zIndex: 20,
                  background: "rgba(249,66,58,0.12)",
                  border: `2px dashed ${KR}`,
                  borderRadius: 0,
                  pointerEvents: "none",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#fff",
                    background: KR,
                    padding: "3px 8px",
                    letterSpacing: 0.2,
                  }}
                >
                  {t("conti.dropToReplace")}
                </span>
              </div>
            )}
          </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-52">
            <ContextMenuItem onSelect={() => void handlePasteImageFromClipboard()}>
              <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
              {t("conti.ctx.pasteImage")}
            </ContextMenuItem>
            <ContextMenuItem disabled={!hasImage} onSelect={() => void handleCopyImageToClipboard()}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              {t("conti.ctx.copyImage")}
            </ContextMenuItem>
          </ContextMenuContent>
          </ContextMenu>

          {/* SidePanel */}
          {menuOpen && (
            <div onPointerDown={(e) => e.stopPropagation()}>
              <SidePanel
                hasImage={!!scene.conti_image_url}
                openLeft={menuOpenLeft}
                hasMultipleVersions={hasMultipleVersions}
                onDuplicate={() => {
                  setMenuOpen(false);
                  onDuplicate();
                }}
                onDelete={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                onUpload={() => {
                  setMenuOpen(false);
                  fileInputRef.current?.click();
                }}
                onDeleteImage={() => {
                  setMenuOpen(false);
                  onSceneUpdate(scene.scene_number, { conti_image_url: null });
                }}
                onCompare={() => {
                  setMenuOpen(false);
                  onCompare();
                }}
                onInpaint={() => {
                  setMenuOpen(false);
                  onInpaint();
                }}
                onSetThumbnail={
                  scene.conti_image_url
                    ? () => {
                        setMenuOpen(false);
                        onSetThumbnail?.();
                      }
                    : undefined
                }
                onAdjustImage={scene.conti_image_url ? openAdjust : undefined}
                onUseAsStyle={
                  scene.conti_image_url && onUseAsStyle
                    ? () => {
                        setMenuOpen(false);
                        onUseAsStyle();
                      }
                    : undefined
                }
                onRelight={
                  scene.conti_image_url && onRelight
                    ? () => {
                        setMenuOpen(false);
                        onRelight();
                      }
                    : undefined
                }
                onCameraVariations={
                  scene.conti_image_url && onCameraVariations
                    ? () => {
                        setMenuOpen(false);
                        onCameraVariations();
                      }
                    : undefined
                }
                onChangeAngle={
                  scene.conti_image_url && onChangeAngle
                    ? () => {
                        setMenuOpen(false);
                        onChangeAngle();
                      }
                    : undefined
                }
              />
            </div>
          )}

          {/* ── BODY ── (hidden entirely when every info field is off → image-only) */}
          {(scene.is_transition || anyInfo) && (
          <div
            className="px-2.5 py-2 flex-1 flex flex-col gap-2"
            style={isRow ? { gridColumn: 2, gridRow: 2, minWidth: 0 } : undefined}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {scene.is_transition ? (
              <>
                {/* Technique picker — controls `transition_type` which drives
                 *  both the Claude prompt (via KNOWLEDGE_TRANSITION_GRAMMAR)
                 *  and the fallback template. The `onTransitionTypeChange`
                 *  prop is threaded down from ContiTab and persists via
                 *  `handleTransitionTypeChange`. Before this picker existed
                 *  the prop was declared but never bound to any control, so
                 *  every TR shipped with the legacy catch-all "TRANSITION"
                 *  value and the whole technique dispatch in the prompt was
                 *  dead code. */}
                {onTransitionTypeChange && (
                  <TransitionTechniquePicker
                    rawValue={scene.transition_type}
                    onChange={(newKey) => onTransitionTypeChange(scene, newKey)}
                  />
                )}
                <DescriptionField
                  value={scene.description ?? ""}
                  assets={assets}
                  existingTags={scene.tagged_assets ?? []}
                  onChange={(desc, tags) => {
                    const nextTags = computeTaggedAssets(desc, scene.location, assets, tags);
                    saveField({ description: desc, tagged_assets: nextTags });
                  }}
                />
              </>
            ) : (
              <>
                {vis.title && (
                  <InlineField
                    value={localTitle}
                    onChange={(v) => {
                      setLocalTitle(v);
                      saveField({ title: v });
                    }}
                    placeholder={t("agent.shotTitlePlaceholder")}
                    style={{ fontSize: 12, fontWeight: 600, color: "#f0f0f0", lineHeight: 1.4 } as any}
                  />
                )}
                {(vis.camera || vis.mood || vis.location || vis.duration) && (
                  <MetaRows
                    visible={{
                      camera_angle: vis.camera,
                      mood: vis.mood,
                      location: vis.location,
                      duration_sec: vis.duration,
                    }}
                    fields={{
                      camera_angle: localCam,
                      mood: localMood,
                      location: localLocation,
                      duration_sec: localDuration,
                    }}
                    assets={assets}
                    onUpdate={(k, v) => {
                      if (k === "camera_angle") {
                        setLocalCam(v);
                        saveField({ camera_angle: v });
                      }
                      if (k === "mood") {
                        setLocalMood(v);
                        saveField({ mood: v });
                      }
                      if (k === "location") {
                        setLocalLocation(v);
                        // Recompute tagged_assets from BOTH location and the
                        // (unchanged) description so a `@BG_medium` typed in
                        // Location actually reaches generateConti via
                        // fetchTaggedAssets — without this it never landed
                        // in the persisted tagged_assets and the generator
                        // fell back to whatever description-only tag was
                        // there (typically the bare `@BG`).
                        const nextTags = computeTaggedAssets(
                          scene.description,
                          v,
                          assets,
                          scene.tagged_assets ?? [],
                        );
                        saveField({ location: v, tagged_assets: nextTags });
                      }
                      if (k === "duration_sec") {
                        setLocalDuration(v);
                        saveField({ duration_sec: v ? parseInt(v) : null });
                      }
                    }}
                  />
                )}
                {vis.description && (
                <DescriptionField
                  value={scene.description ?? ""}
                  assets={assets}
                  existingTags={scene.tagged_assets ?? []}
                  onChange={(desc, tags) => {
                    // DescriptionField only scans the description text, so
                    // merge in tags found in the (unchanged) location field
                    // here too. Mirrors the location handler above.
                    const nextTags = computeTaggedAssets(desc, scene.location, assets, tags);
                    saveField({ description: desc, tagged_assets: nextTags });
                  }}
                />
                )}
                {vis.description && !scene.description?.trim() && !isBusy && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "4px 8px",
                      borderRadius: 0,
                      background: "rgba(245,158,11,0.08)",
                      border: "0.5px solid rgba(245,158,11,0.25)",
                    }}
                  >
                    <svg
                      width={11}
                      height={11}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#d97706"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01" />
                    </svg>
                    <span style={{ fontSize: 10, color: "#d97706", fontWeight: 500 }}>
                      {t("conti.noDescriptionGenerateAll")}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {!isRow && <div className="flex-1" />}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
        </div>

        {/* ── Adjust Image Modal ── */}
        {adjustOpen && scene.conti_image_url && (
          <AdjustImageModal
            imageUrl={scene.conti_image_url}
            videoFormat={fmt}
            initialCrop={normalizedInitialCrop}
            onSave={handleAdjustSave}
            onCapture={handleCapture}
            onClose={() => setAdjustOpen(false)}
          />
        )}
      </>
    );
  },
);

SortableContiCard.displayName = "SortableContiCard";
