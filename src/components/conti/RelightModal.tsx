/**
 * RelightModal — Interactive relighting controls.
 *
 * 기술적 제약:
 *   NB2(Vertex gemini-3.1-flash-image) 는 숫자 파라미터를 직접 받지 않고 텍스트 프롬프트만 받는다.
 *   그래서 UI 컨트롤 값들을 자연어 서술자로 매핑해 프롬프트에 주입하는 방식으로 "각도/광량/컬러" 를
 *   제어한다. 실제 모델은 이런 서술자(low angle / soft / warm tungsten / neon cyan / backlit 등)를
 *   잘 따르기 때문에 프리셋 고정 대비 훨씬 넓은 조합이 가능하다.
 *
 * 컨트롤:
 *   - 방향: 2D polar pad (azimuth 0°~360°, elevation 0°~90°)
 *       중심 = 피사체 바로 위(top-down), 가장자리 = 수평(측/후광).
 *       12시 방향 = 카메라 정면, 3시 = 오른쪽, 6시 = 뒤(backlit), 9시 = 왼쪽.
 *   - 광량(intensity): 0~100
 *   - 소프트니스(softness): 0~100 (hard ↔ soft)
 *   - 환경광(ambient fill): 0~100 (deep shadows ↔ even fill)
 *   - 컬러: Kelvin/creative 스왓치 + 자유 색상 선택. 선택값은 자연어로 치환되어 프롬프트에 반영.
 *   - Quick preset: 6종 — 클릭시 위 컨트롤 값 전체를 한 번에 세팅 (덮어쓰기).
 *   - Additional notes: 프리셋/컨트롤로 표현이 어려운 디테일을 프롬프트에 이어 붙일 자유 텍스트.
 *
 * 파이프라인:
 *   supabase.functions.invoke("openai-image", {
 *     mode: "inpaint",
 *     useNanoBanana: true,
 *     sourceImageUrl, referenceImageUrls: [],
 *     prompt, projectId, sceneNumber, imageSize,
 *   })
 */

import { useMemo, useRef, useState, useEffect } from "react";
import { ChevronDown, ChevronUp, HelpCircle, Sun, X, SlidersHorizontal } from "lucide-react";
import type { Scene } from "./contiTypes";
import { IMAGE_SIZE_MAP } from "@/lib/conti";
import { useT, useUiLanguage, type UiLanguage } from "@/lib/uiLanguage";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

type VideoFormat = keyof typeof IMAGE_SIZE_MAP;

/** 섹션 헤더 옆 (?) 호버 툴팁 — verbose 설명을 본문에서 분리해 기본 UI 는
 *  심플하게 유지. 두 줄 이내의 보조 설명에 적합. */
const HelpHint = ({ text }: { text: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground/80 transition-colors"
        onClick={(e) => e.preventDefault()}
        aria-label="help"
      >
        <HelpCircle className="w-3 h-3" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
      {text}
    </TooltipContent>
  </Tooltip>
);

/* ━━━ Types ━━━ */
interface RelightConfig {
  /** 0~360 — 0: 카메라 정면, 90: 오른쪽, 180: 후광, 270: 왼쪽 */
  azimuth: number;
  /** 0~90 — 0: 눈높이(수평), 90: 바로 위(top-down) */
  elevation: number;
  /** 0~100 */
  intensity: number;
  /** 0~100 — 0: hard shadows, 100: ultra soft */
  softness: number;
  /** 0~100 — 0: deep shadows, 100: even fill */
  ambient: number;
  colorHex: string;
  /** preset 에서 선택됐다면 자연어 라벨(예: "warm tungsten 3200K"). 자유 입력이면 null. */
  colorLabel: string | null;
  /** 프롬프트에 이어붙일 추가 설명 (optional) */
  customText: string;
  /** 씬 내 실광원(네온/창문/램프) 처리 방식 (5-B). replace=교체, augment=추가. */
  lightMode: "replace" | "augment";
}

interface ColorSwatch {
  id: string;
  hex: string;
  label: string;
  /** 모델에 주입할 자연어 서술자 (label 보다 풍부한 문장형) */
  descriptor: string;
}

interface QuickPreset {
  id: string;
  label: string;
  apply: () => Partial<RelightConfig>;
}

/* ━━━ Constants ━━━ */
/** lightMode="replace": 기존 광원을 새 설정으로 완전 대체. */
const RELIGHT_PREFIX_REPLACE =
  "Re-light the input image while strictly preserving identity, geometry, composition, " +
  "camera angle, framing, pose, clothing silhouette and background layout. " +
  "REPLACE the existing lighting entirely: disregard the original light sources' " +
  "direction and color, and re-render shadows, highlights, and color temperature " +
  "according to the new setup below. Do NOT redraw content, do NOT change the subject, " +
  "do NOT change props. New lighting setup: ";

/** lightMode="augment": 씬의 실광원은 유지하고 키 라이트만 추가. */
const RELIGHT_PREFIX_AUGMENT =
  "Re-light the input image while strictly preserving identity, geometry, composition, " +
  "camera angle, framing, pose, clothing silhouette and background layout. " +
  "KEEP every practical light source visible in the scene (windows, lamps, neon signs, " +
  "screens) exactly as it is — same position, same color, same glow. ADD the following " +
  "key light ON TOP of the existing lighting, blending its shadows and highlights " +
  "naturally with what is already there. Do NOT redraw content, do NOT change the " +
  "subject, do NOT change props. Added key light: ";

const COLOR_SWATCHES: ColorSwatch[] = [
  {
    id: "candle",
    hex: "#ffb070",
    label: "Candle 1900K",
    descriptor: "very warm orange candle-like light around 1900K",
  },
  {
    id: "tungsten",
    hex: "#ffc488",
    label: "Tungsten 2800K",
    descriptor: "warm tungsten indoor light around 2800K",
  },
  {
    id: "halogen",
    hex: "#ffd6a0",
    label: "Halogen 3200K",
    descriptor: "warm halogen light around 3200K",
  },
  {
    id: "golden",
    hex: "#ffb43f",
    label: "Golden Hour",
    descriptor: "golden-hour amber sunlight with honey and orange tones",
  },
  {
    id: "daylight",
    hex: "#ffffff",
    label: "Daylight 5600K",
    descriptor: "neutral daylight around 5600K",
  },
  {
    id: "overcast",
    hex: "#e6eeff",
    label: "Overcast 6500K",
    descriptor: "flat overcast daylight around 6500K, softly bluish",
  },
  {
    id: "shade",
    hex: "#a9c4ff",
    label: "Blue Hour 8000K",
    descriptor: "cool twilight blue-hour ambient around 8000K",
  },
  {
    id: "moonlight",
    hex: "#b9ccff",
    label: "Moonlight",
    descriptor: "cool silvery-blue moonlit night light",
  },
  {
    id: "neon_pink",
    hex: "#ff4fb5",
    label: "Neon Pink",
    descriptor: "saturated neon magenta-pink colored light",
  },
  {
    id: "neon_cyan",
    hex: "#4fe4ff",
    label: "Neon Cyan",
    descriptor: "saturated neon cyan colored light",
  },
  {
    id: "neon_violet",
    hex: "#7a5cff",
    label: "Neon Violet",
    descriptor: "saturated neon violet-purple colored light",
  },
  {
    id: "lime",
    hex: "#9dff6a",
    label: "Acid Green",
    descriptor: "vivid acid green colored light",
  },
];

const DEFAULT_CONFIG: RelightConfig = {
  azimuth: 330,
  elevation: 35,
  intensity: 65,
  softness: 55,
  ambient: 35,
  colorHex: COLOR_SWATCHES[3].hex, // Golden Hour
  colorLabel: COLOR_SWATCHES[3].descriptor,
  customText: "",
  lightMode: "replace",
};

/* ━━━ Helpers ━━━ */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const m = hex.replace("#", "").trim();
  const h =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m.padEnd(6, "0").slice(0, 6);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

const rgbToHsl = (r: number, g: number, b: number) => {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
};

/** hex → 자연어 설명 (preset 라벨이 없을 때 폴백). */
const describeColorFromHex = (hex: string): string => {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  if (s < 0.1) {
    if (l > 0.85) return "neutral bright white light";
    if (l < 0.25) return "very dim neutral light";
    // 중성 — R/B 의 미묘한 편차로 warmth 구분
    if (r - b > 6) return "slightly warm neutral white";
    if (b - r > 6) return "slightly cool neutral white";
    return "neutral white light";
  }
  if (s >= 0.5) {
    if (h < 20 || h >= 340) return "saturated neon red-orange colored light";
    if (h < 45) return "saturated neon amber-orange colored light";
    if (h < 70) return "saturated golden-yellow colored light";
    if (h < 95) return "saturated yellow-green colored light";
    if (h < 155) return "saturated neon green colored light";
    if (h < 200) return "saturated neon cyan colored light";
    if (h < 250) return "saturated neon blue colored light";
    if (h < 290) return "saturated neon violet colored light";
    if (h < 335) return "saturated neon magenta-pink colored light";
    return "saturated colored light";
  }
  if (h < 40 || h >= 340) return "warm reddish-amber light";
  if (h < 70) return "warm amber/gold light";
  if (h < 170) return "slightly greenish light";
  if (h < 260) return "cool bluish light";
  return "magenta-tinted light";
};

const describeElevation = (e: number): string => {
  if (e >= 80) return "from directly overhead, top-down";
  if (e >= 55) return "from a high angle above the subject";
  if (e >= 30) return "from a slightly elevated angle";
  if (e >= 10) return "near eye-level";
  return "from a low angle below the subject (uplight)";
};

/**
 * azimuth → 광원 방향 서술 + 기준 고정 (5-A).
 * 기준: 모두 "카메라(시청자) 기준 프레임 좌/우" — UI 폴라 패드의 3시=오른쪽과 일치.
 * bearing: 카메라 정면 = 0°, 시계방향. 숫자 anchor 를 함께 박아 좌우 flip 저항성을
 * 높인다 (cameraLibrary 의 yaw bearing 기법과 동일 근거).
 */
const describeAzimuth = (az: number): string => {
  const a = ((az % 360) + 360) % 360;
  const anchor =
    `(light bearing ${Math.round(a)}° — 0° is the camera position, ` +
    `measured clockwise as seen from above; "right" means the VIEWER'S right / ` +
    `frame-right, not the subject's anatomical right)`;
  if (a < 15 || a >= 345) return `from the front, the camera side ${anchor}`;
  if (a < 60) return `from front-right of frame ${anchor}`;
  if (a < 105) return `from frame-right ${anchor}`;
  if (a < 150) return `from back-right, creating a rim on the frame-right side of the subject ${anchor}`;
  if (a < 195) return `from directly behind the subject (backlit, silhouetting rim light) ${anchor}`;
  if (a < 240) return `from back-left, creating a rim on the frame-left side of the subject ${anchor}`;
  if (a < 285) return `from frame-left ${anchor}`;
  return `from front-left of frame ${anchor}`;
};

const describeIntensity = (i: number): string => {
  if (i < 20) return "very subtle";
  if (i < 40) return "soft";
  if (i < 60) return "moderate";
  if (i < 80) return "bright";
  return "harsh high-intensity";
};

const describeSoftness = (s: number): string => {
  if (s < 20) return "hard-edged crisp shadows with clearly defined edges";
  if (s < 40) return "medium-hard shadows";
  if (s < 60) return "softened shadow edges";
  if (s < 80) return "very soft diffused shadows";
  return "ultra-soft wrap-around shadows as if from a large softbox";
};

const describeAmbient = (a: number): string => {
  if (a < 20) return "deep black shadows with almost no fill light";
  if (a < 40) return "low ambient fill, moody high-contrast";
  if (a < 60) return "moderate ambient fill";
  if (a < 80) return "bright ambient fill, lower contrast";
  return "very even ambient illumination with minimal shadow contrast";
};

const buildRelightPrompt = (cfg: RelightConfig): string => {
  const colorDesc = cfg.colorLabel ?? describeColorFromHex(cfg.colorHex);
  const parts: string[] = [];
  parts.push(
    `A ${describeIntensity(cfg.intensity)} ${colorDesc} key light ${describeAzimuth(cfg.azimuth)}, ${describeElevation(cfg.elevation)}.`,
  );
  parts.push(`${describeSoftness(cfg.softness)}.`);
  parts.push(`${describeAmbient(cfg.ambient)}.`);
  if (cfg.customText.trim()) parts.push(cfg.customText.trim());
  const prefix = cfg.lightMode === "augment" ? RELIGHT_PREFIX_AUGMENT : RELIGHT_PREFIX_REPLACE;
  return prefix + parts.join(" ");
};

/* ━━━ Quick presets — 컨트롤 값 전체를 한 번에 세팅 ━━━ */
const QUICK_PRESETS: QuickPreset[] = [
  {
    id: "golden_hour",
    label: "Golden Hour",
    apply: () => ({
      azimuth: 320,
      elevation: 20,
      intensity: 70,
      softness: 60,
      ambient: 40,
      colorHex: COLOR_SWATCHES[3].hex,
      colorLabel: COLOR_SWATCHES[3].descriptor,
    }),
  },
  {
    id: "blue_hour",
    label: "Blue Hour",
    apply: () => ({
      azimuth: 0,
      elevation: 60,
      intensity: 45,
      softness: 85,
      ambient: 70,
      colorHex: COLOR_SWATCHES[6].hex,
      colorLabel: COLOR_SWATCHES[6].descriptor,
    }),
  },
  {
    id: "neon_night",
    label: "Neon Night",
    apply: () => ({
      azimuth: 220,
      elevation: 25,
      intensity: 75,
      softness: 30,
      ambient: 20,
      colorHex: COLOR_SWATCHES[8].hex,
      colorLabel: COLOR_SWATCHES[8].descriptor,
    }),
  },
  {
    id: "backlit_rim",
    label: "Backlit Rim",
    apply: () => ({
      azimuth: 180,
      elevation: 45,
      intensity: 85,
      softness: 25,
      ambient: 35,
      colorHex: COLOR_SWATCHES[4].hex,
      colorLabel: COLOR_SWATCHES[4].descriptor,
    }),
  },
  {
    id: "softbox",
    label: "Studio Softbox",
    apply: () => ({
      azimuth: 330,
      elevation: 55,
      intensity: 65,
      softness: 90,
      ambient: 55,
      colorHex: COLOR_SWATCHES[4].hex,
      colorLabel: COLOR_SWATCHES[4].descriptor,
    }),
  },
  {
    id: "moonlight",
    label: "Moonlight",
    apply: () => ({
      azimuth: 30,
      elevation: 70,
      intensity: 45,
      softness: 75,
      ambient: 15,
      colorHex: COLOR_SWATCHES[7].hex,
      colorLabel: COLOR_SWATCHES[7].descriptor,
    }),
  },
];

const RELIGHT_PRESET_LABEL_KO: Record<string, string> = {
  golden_hour: "골든아워",
  blue_hour: "블루아워",
  neon_night: "네온 나이트",
  backlit_rim: "역광 림라이트",
  softbox: "스튜디오 소프트박스",
  moonlight: "달빛",
};

const COLOR_SWATCH_LABEL_KO: Record<string, string> = {
  candle: "촛불 1900K",
  tungsten: "텅스텐 2800K",
  halogen: "할로겐 3200K",
  golden: "골든아워",
  daylight: "주광 5600K",
  overcast: "흐린 날 6500K",
  shade: "블루아워 8000K",
  moonlight: "달빛",
  neon_pink: "네온 핑크",
  neon_cyan: "네온 시안",
  neon_violet: "네온 바이올렛",
  lime: "애시드 그린",
};

const getRelightPresetLabel = (preset: QuickPreset, language: UiLanguage) =>
  language === "ko" ? (RELIGHT_PRESET_LABEL_KO[preset.id] ?? preset.label) : preset.label;

const getColorSwatchLabel = (swatch: ColorSwatch, language: UiLanguage) =>
  language === "ko" ? (COLOR_SWATCH_LABEL_KO[swatch.id] ?? swatch.label) : swatch.label;

/* ━━━ Polar Pad ━━━
 * PAD_SIZE 는 SVG 외곽 크기(방위 라벨까지 포함한 여유 공간).
 * PAD_RADIUS 는 실제 드래그 가능한 원의 반지름. 라벨이 잘리지 않도록 충분한 여백을 둔다. */
const PAD_SIZE = 168;
const PAD_RADIUS = 66;

interface PolarPadProps {
  azimuth: number;
  elevation: number;
  onChange: (next: { azimuth: number; elevation: number }) => void;
  disabled?: boolean;
  labels: {
    back: string;
    front: string;
  };
}

const PolarPad = ({ azimuth, elevation, onChange, disabled, labels }: PolarPadProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);

  /* Pad 의 공간 매핑: 카메라 = 패드 하단, 피사체 = 중앙 (업계 plan-view lighting diagram 관례).
   * 따라서 12시 = Back(피사체 뒤), 6시 = Front(카메라 쪽) 이 되도록 y 부호를 반전.
   * azimuth 의 의미론(0° = from front/camera-side)과 describeAzimuth/프리셋 값은 그대로 유지. */
  const posFromConfig = () => {
    const r = (1 - elevation / 90) * PAD_RADIUS;
    const rad = (azimuth * Math.PI) / 180;
    return { x: r * Math.sin(rad), y: r * Math.cos(rad) };
  };
  const { x: dotX, y: dotY } = posFromConfig();

  const handleAt = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const r = Math.hypot(dx, dy);
    const capped = Math.min(r, PAD_RADIUS);
    if (r > PAD_RADIUS && r > 0) {
      dx = (dx / r) * PAD_RADIUS;
      dy = (dy / r) * PAD_RADIUS;
    }
    const elev = clamp((1 - capped / PAD_RADIUS) * 90, 0, 90);
    let az = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (az < 0) az += 360;
    onChange({ azimuth: az, elevation: elev });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    (e.currentTarget as unknown as Element).setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    handleAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    handleAt(e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    try {
      (e.currentTarget as unknown as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    draggingRef.current = false;
  };

  const cx = PAD_SIZE / 2;
  const cy = PAD_SIZE / 2;

  const labelStyle: React.CSSProperties = {
    userSelect: "none",
    WebkitUserSelect: "none",
    pointerEvents: "none",
  };

  return (
    <svg
      ref={svgRef}
      width={PAD_SIZE}
      height={PAD_SIZE}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        touchAction: "none",
        cursor: disabled ? "default" : "grab",
        opacity: disabled ? 0.5 : 1,
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* dial 배경: 라벨 영역을 침범하지 않도록 원형으로 한정 */}
      <circle
        cx={cx}
        cy={cy}
        r={PAD_RADIUS + 2}
        fill="hsl(var(--foreground) / 0.04)"
        stroke="hsl(var(--foreground) / 0.1)"
        strokeWidth={1}
      />
      {/* horizon ring */}
      <circle cx={cx} cy={cy} r={PAD_RADIUS} fill="none" stroke="hsl(var(--foreground) / 0.12)" strokeWidth={1} />
      {/* mid ring (45°) */}
      <circle cx={cx} cy={cy} r={PAD_RADIUS / 2} fill="none" stroke="hsl(var(--foreground) / 0.08)" strokeWidth={1} />
      {/* crosshair */}
      <line
        x1={cx - PAD_RADIUS}
        y1={cy}
        x2={cx + PAD_RADIUS}
        y2={cy}
        stroke="hsl(var(--foreground) / 0.08)"
        strokeWidth={1}
      />
      <line
        x1={cx}
        y1={cy - PAD_RADIUS}
        x2={cx}
        y2={cy + PAD_RADIUS}
        stroke="hsl(var(--foreground) / 0.08)"
        strokeWidth={1}
      />
      {/* cardinal labels — plan-view 관례: 카메라가 아래쪽.
       * 12시 = Back(피사체 뒤 / backlit), 6시 = Front(카메라 쪽). */}
      <text
        x={cx}
        y={cy - PAD_RADIUS - 6}
        textAnchor="middle"
        fill="hsl(var(--foreground) / 0.55)"
        fontSize={9}
        style={labelStyle}
      >
        {labels.back}
      </text>
      <text
        x={cx + PAD_RADIUS + 6}
        y={cy + 3}
        textAnchor="start"
        fill="hsl(var(--foreground) / 0.55)"
        fontSize={9}
        style={labelStyle}
      >
        R
      </text>
      <text
        x={cx}
        y={cy + PAD_RADIUS + 12}
        textAnchor="middle"
        fill="hsl(var(--foreground) / 0.55)"
        fontSize={9}
        style={labelStyle}
      >
        {labels.front}
      </text>
      <text
        x={cx - PAD_RADIUS - 6}
        y={cy + 3}
        textAnchor="end"
        fill="hsl(var(--foreground) / 0.55)"
        fontSize={9}
        style={labelStyle}
      >
        L
      </text>
      {/* draggable dot */}
      <circle cx={cx + dotX} cy={cy + dotY} r={6} fill="hsl(var(--primary))" stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
};

/* ━━━ Small labeled slider ━━━ */
interface LabeledSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  rightLabel?: string;
}
const LabeledSlider = ({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  rightLabel,
}: LabeledSliderProps) => (
  <div>
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        fontSize: 11,
        color: "hsl(var(--foreground) / 0.62)",
        marginBottom: 6,
        userSelect: "none",
      }}
    >
      <span>{label}</span>
      <span style={{ color: "hsl(var(--foreground) / 0.42)", fontVariantNumeric: "tabular-nums" }}>
        {rightLabel ?? `${Math.round(value)}`}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      disabled={disabled}
      style={{ width: "100%", accentColor: "hsl(var(--primary))", cursor: disabled ? "default" : "pointer" }}
    />
  </div>
);

/* ━━━ Section wrapper: 섹션 소제목 + 선택적 right-aligned meta + 상단 구분선
 * 모든 컨트롤 섹션을 동일한 수직 리듬으로 정렬하기 위한 헬퍼. */
interface SectionProps {
  label: string;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  first?: boolean;
  /** 라벨 옆에 표시할 (?) 호버 툴팁 본문. 길어진 인라인 설명은 여기로. */
  help?: string;
  children: React.ReactNode;
}
const Section = ({ label, meta, icon, first, help, children }: SectionProps) => (
  <div
    style={{
      paddingTop: first ? 0 : 14,
      paddingBottom: 14,
      borderTop: first ? "none" : "1px solid hsl(var(--foreground) / 0.06)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 10,
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: "hsl(var(--foreground) / 0.82)",
          letterSpacing: 0.1,
        }}
      >
        {icon}
        {label}
        {help && <HelpHint text={help} />}
      </div>
      {meta !== undefined && meta !== null && (
        <div
          style={{
            fontSize: 10,
            color: "hsl(var(--foreground) / 0.42)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </div>
      )}
    </div>
    {children}
  </div>
);

/* ━━━ Main modal ━━━ */

/** Self-contained spec the parent needs to fire the actual generation in
 *  the background. The modal builds this from its UI state and hands it
 *  off via `onSubmit` — it does NOT call the network itself anymore.
 *
 *  Promoting the request to the parent lets ContiTab drive the same
 *  `editGeneratingIds` + `sceneStages` channels that inpaint / ChangeAngle
 *  already use, so the user sees the standard `1/1 Generating…` spinner
 *  on the scene card with the modal out of the way. */
export interface RelightSubmit {
  sceneId: string;
  sceneNumber: number;
  /** Source image at submit time — the parent uses this to push history
   *  before overwriting `conti_image_url`. */
  sourceImageUrl: string;
  /** Ready-to-invoke body for `supabase.functions.invoke("openai-image", ...)`. */
  body: Record<string, unknown>;
}

export interface RelightModalProps {
  scene: Scene;
  projectId: string;
  videoFormat: VideoFormat;
  onClose: () => void;
  /** Hand off the built request to the parent. The modal closes itself
   *  right after; the parent runs the generation and drives the
   *  scene-card spinner. */
  onSubmit: (req: RelightSubmit) => void;
}

const BACKDROP_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "hsl(0 0% 0% / 0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};
const PANEL_STYLE: React.CSSProperties = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border-subtle))",
  boxShadow: "0 10px 15px -3px hsl(0 0% 0% / 0.5), 0 4px 6px -4px hsl(0 0% 0% / 0.4)",
  width: "min(960px, 100%)",
  maxHeight: "min(92vh, 780px)",
  display: "grid",
  gridTemplateColumns: "minmax(280px, 380px) 1fr",
  overflow: "hidden",
};

export function RelightModal({ scene, projectId, videoFormat, onClose, onSubmit }: RelightModalProps) {
  const t = useT();
  const { language } = useUiLanguage();
  const sourceUrl = scene.conti_image_url;
  const [cfg, setCfg] = useState<RelightConfig>(DEFAULT_CONFIG);
  /** With generation hoisted to the parent, the modal no longer carries
   *  an in-flight `applying` state — it builds the body and hands off.
   *  `error` is kept for prompt-construction-time validation only
   *  (e.g. missing source url); real network errors now surface as
   *  toasts on the scene card. */
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // Modal hands off synchronously, so there's never a true in-flight state
  // here — kept as a constant so the existing `disabled` props on controls
  // stay readable.
  const applying = false;

  const prompt = useMemo(() => buildRelightPrompt(cfg), [cfg]);
  const selectedSwatch = COLOR_SWATCHES.find((sw) => cfg.colorLabel === sw.descriptor);
  const lightColorMeta = selectedSwatch
    ? getColorSwatchLabel(selectedSwatch, language)
    : t("variant.customHex", { hex: cfg.colorHex.toUpperCase() });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const applyQuickPreset = (preset: QuickPreset) => {
    setCfg((prev) => ({ ...prev, ...preset.apply() }));
    setError(null);
  };

  const pickSwatch = (sw: ColorSwatch) => {
    setCfg((prev) => ({ ...prev, colorHex: sw.hex, colorLabel: sw.descriptor }));
  };

  const pickCustomColor = (hex: string) => {
    setCfg((prev) => ({ ...prev, colorHex: hex, colorLabel: null }));
  };

  const handleApply = () => {
    if (!sourceUrl) {
      setError(t("variant.noSourceImage"));
      return;
    }
    const body: Record<string, unknown> = {
      mode: "inpaint",
      useNanoBanana: true,
      sourceImageUrl: sourceUrl,
      referenceImageUrls: [],
      prompt,
      projectId,
      sceneNumber: scene.scene_number,
      imageSize: IMAGE_SIZE_MAP[videoFormat],
    };
    onSubmit({
      sceneId: scene.id,
      sceneNumber: scene.scene_number,
      sourceImageUrl: sourceUrl,
      body,
    });
    onClose();
  };

  if (!sourceUrl) {
    return (
      <div style={BACKDROP_STYLE} onClick={onClose}>
        <div style={{ ...PANEL_STYLE, gridTemplateColumns: "1fr", padding: 24 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ color: "hsl(var(--foreground) / 0.7)", fontSize: 13 }}>{t("variant.noSourceImage")}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={BACKDROP_STYLE} onClick={onClose}>
      <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
        {/* Preview */}
        <div
          style={{
            background: "hsl(var(--background))",
            borderRight: "1px solid hsl(var(--foreground) / 0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            minHeight: 320,
          }}
        >
          <img
            src={sourceUrl}
            alt={`Shot #${String(scene.scene_number).padStart(2, "0")}`}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
          />
        </div>

        {/* Controls */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 20px",
              borderBottom: "1px solid hsl(var(--foreground) / 0.06)",
              userSelect: "none",
            }}
          >
            <Sun className="w-4 h-4" style={{ color: "hsl(var(--foreground) / 0.78)" }} />
            <div
              style={{
                color: "hsl(var(--foreground) / 0.95)",
                fontSize: 14,
                fontWeight: 600,
                flex: 1,
                letterSpacing: 0.1,
              }}
            >
              {t("conti.relight")}
            </div>
            <button
              onClick={onClose}
              disabled={applying}
              className="text-white/60 hover:text-white/90 disabled:opacity-40"
              style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex" }}
              title={t("variant.closeEsc")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: "4px 20px 6px", overflow: "auto", flex: 1 }}>
            {/* Light-source handling mode (5-B) */}
            <Section label={t("relight.lightSource")} first help={t("relight.lightSourceHelp")}>
              <div style={{ display: "flex", gap: 6 }}>
                {(["replace", "augment"] as const).map((mode) => {
                  const active = cfg.lightMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => setCfg((p) => ({ ...p, lightMode: mode }))}
                      disabled={applying}
                      title={mode === "replace" ? t("relight.modeReplaceHint") : t("relight.modeAugmentHint")}
                      style={{
                        flex: 1,
                        padding: "8px 10px",
                        borderRadius: 0,
                        cursor: applying ? "default" : "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        textAlign: "center",
                        border: active
                          ? "1px solid hsl(var(--primary) / 0.8)"
                          : "1px solid hsl(var(--foreground) / 0.12)",
                        background: active ? "hsl(var(--primary) / 0.14)" : "transparent",
                        color: active ? "hsl(var(--foreground) / 0.95)" : "hsl(var(--foreground) / 0.6)",
                      }}
                    >
                      {mode === "replace" ? t("relight.modeReplace") : t("relight.modeAugment")}
                    </button>
                  );
                })}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: "hsl(var(--foreground) / 0.5)", lineHeight: 1.45 }}>
                {cfg.lightMode === "replace" ? t("relight.modeReplaceHint") : t("relight.modeAugmentHint")}
              </div>
            </Section>

            {/* Direction + sliders */}
            <Section
              label={t("variant.direction")}
              help={t("variant.directionHelp")}
              meta={
                <span>
                  {t("variant.azimuth")} {Math.round(cfg.azimuth)}° <span style={{ opacity: 0.35, margin: "0 4px" }}>·</span> {t("variant.elevation")}{" "}
                  {Math.round(cfg.elevation)}°
                </span>
              }
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `${PAD_SIZE}px 1fr`,
                  gap: 18,
                  alignItems: "center",
                }}
              >
                <PolarPad
                  azimuth={cfg.azimuth}
                  elevation={cfg.elevation}
                  onChange={({ azimuth, elevation }) => setCfg((p) => ({ ...p, azimuth, elevation }))}
                  disabled={applying}
                  labels={{ back: t("variant.back"), front: t("variant.front") }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                  <LabeledSlider
                    label={t("variant.intensity")}
                    value={cfg.intensity}
                    onChange={(v) => setCfg((p) => ({ ...p, intensity: v }))}
                    disabled={applying}
                  />
                  <LabeledSlider
                    label={t("variant.softness")}
                    value={cfg.softness}
                    onChange={(v) => setCfg((p) => ({ ...p, softness: v }))}
                    disabled={applying}
                    rightLabel={cfg.softness < 40 ? t("variant.hard") : cfg.softness < 70 ? t("variant.medium") : t("variant.soft")}
                  />
                  <LabeledSlider
                    label={t("variant.ambientFill")}
                    value={cfg.ambient}
                    onChange={(v) => setCfg((p) => ({ ...p, ambient: v }))}
                    disabled={applying}
                    rightLabel={cfg.ambient < 35 ? t("variant.deepShadows") : cfg.ambient < 70 ? t("variant.balanced") : t("variant.flat")}
                  />
                </div>
              </div>
            </Section>

            {/* Color */}
            <Section
              label={t("variant.lightColor")}
              icon={<SlidersHorizontal className="w-3 h-3" />}
              help={t("variant.lightColorHelp")}
              meta={lightColorMeta}
            >
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {COLOR_SWATCHES.map((sw) => {
                  const active = cfg.colorLabel === sw.descriptor;
                  return (
                    <button
                      key={sw.id}
                      onClick={() => pickSwatch(sw)}
                      disabled={applying}
                      title={getColorSwatchLabel(sw, language)}
                      style={{
                        width: 24,
                        height: 24,
                        background: sw.hex,
                        border: active ? "2px solid hsl(var(--primary))" : "1px solid hsl(var(--foreground) / 0.18)",
                        cursor: applying ? "default" : "pointer",
                        padding: 0,
                        boxShadow: active ? "0 0 0 2px hsl(var(--primary) / 0.25)" : "none",
                        transition: "box-shadow 120ms ease",
                      }}
                    />
                  );
                })}
                {/* 자유 색상 선택 */}
                <label
                  title={t("variant.customColor")}
                  style={{
                    width: 24,
                    height: 24,
                    background: cfg.colorLabel ? "hsl(var(--foreground) / 0.04)" : cfg.colorHex,
                    border: cfg.colorLabel
                      ? "1px dashed hsl(var(--foreground) / 0.35)"
                      : "2px solid hsl(var(--primary))",
                    cursor: applying ? "default" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                    boxShadow: !cfg.colorLabel ? "0 0 0 2px hsl(var(--primary) / 0.25)" : "none",
                    transition: "box-shadow 120ms ease",
                  }}
                >
                  {cfg.colorLabel && (
                    <span style={{ fontSize: 12, color: "hsl(var(--foreground) / 0.5)", lineHeight: 1 }}>+</span>
                  )}
                  <input
                    type="color"
                    value={cfg.colorHex}
                    onChange={(e) => pickCustomColor(e.target.value)}
                    disabled={applying}
                    style={{
                      opacity: 0,
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      inset: 0,
                      cursor: "inherit",
                    }}
                  />
                </label>
              </div>
            </Section>

            {/* Quick presets */}
            <Section
              label={t("variant.quickPreset")}
              help={t("variant.quickPresetHelp")}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {QUICK_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => applyQuickPreset(p)}
                    disabled={applying}
                    className="hover:bg-white/[0.08] disabled:opacity-50"
                    style={{
                      padding: "5px 10px",
                      fontSize: 11,
                      background: "hsl(var(--foreground) / 0.04)",
                      border: "1px solid hsl(var(--foreground) / 0.1)",
                      color: "hsl(var(--foreground) / 0.82)",
                      cursor: applying ? "default" : "pointer",
                      transition: "background 120ms ease",
                    }}
                  >
                    {getRelightPresetLabel(p, language)}
                  </button>
                ))}
              </div>
            </Section>

            {/* Additional notes */}
            <Section label={t("variant.additionalNotes")} meta={t("variant.optional")}>
              <textarea
                value={cfg.customText}
                onChange={(e) => setCfg((p) => ({ ...p, customText: e.target.value }))}
                disabled={applying}
                rows={2}
                placeholder={t("variant.relightNotesPlaceholder")}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  background: "hsl(var(--input))",
                  border: "1px solid hsl(var(--foreground) / 0.08)",
                  color: "hsl(var(--foreground) / 0.88)",
                  fontSize: 11,
                  fontFamily: "inherit",
                  lineHeight: 1.55,
                  resize: "vertical",
                  outline: "none",
                }}
              />
              <button
                onClick={() => setShowPrompt((s) => !s)}
                disabled={applying}
                className="hover:text-white/70"
                style={{
                  marginTop: 8,
                  background: "transparent",
                  border: "none",
                  color: "hsl(var(--foreground) / 0.42)",
                  fontSize: 10,
                  cursor: "pointer",
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                {showPrompt ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showPrompt ? t("variant.hideGeneratedPrompt") : t("variant.showGeneratedPrompt")}
              </button>
              {showPrompt && (
                <pre
                  style={{
                    marginTop: 6,
                    padding: "8px 10px",
                    background: "hsl(var(--background))",
                    border: "1px solid hsl(var(--foreground) / 0.06)",
                    color: "hsl(var(--foreground) / 0.55)",
                    fontSize: 10,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                    maxHeight: 160,
                    overflow: "auto",
                  }}
                >
                  {prompt}
                </pre>
              )}
            </Section>

            {error && (
              <div className="mt-1 mb-2.5 rounded-none border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-caption text-destructive-foreground">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-background px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={applying}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              disabled={applying}
              className="min-w-[92px]"
            >
              {t("conti.apply")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
