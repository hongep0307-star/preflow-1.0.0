// SaveLoopAsGifDialog 가 매번 같은 옵션을 다시 입력하지 않도록 마지막 값을
// localStorage 에 기억한다. dashboardPreferences.ts / animationPreferences.ts
// 와 동일한 패턴: read / save 단순 함수 + clamp 로 외부 입력(이전 버전·수동
// 편집) 을 안전 범위로 강제.

/** 저장 포맷. "gif" 는 gifenc + 글로벌 팔레트 + Floyd-Steinberg 디더링
 *  파이프라인을, "webp" 는 wasm-webp 의 encodeAnimation 파이프라인을
 *  사용한다. 같은 영상 구간에 대해 webp 는 보통 GIF 대비 3~5배 작은
 *  파일에 더 깨끗한 색을 낸다 (libwebp 자체 압축 + 24bit 색). */
export type AnimationFormat = "gif" | "webp";
export type GifFps = 8 | 10 | 12 | 15 | 24;
/** maxDim = 0 → "원본 해상도 유지" 라는 sentinel. UI 에서 "Original" 옵션. */
export type GifMaxDim = 0 | 240 | 360 | 480 | 720;
export type GifQuality = "fast" | "balanced" | "high";

export const ANIMATION_FORMAT_OPTIONS: AnimationFormat[] = ["gif", "webp"];
export const GIF_FPS_OPTIONS: GifFps[] = [8, 10, 12, 15, 24];
export const GIF_MAX_DIM_OPTIONS: GifMaxDim[] = [240, 360, 480, 720, 0];
export const GIF_QUALITY_OPTIONS: GifQuality[] = ["fast", "balanced", "high"];

export const DEFAULT_ANIMATION_FORMAT: AnimationFormat = "gif";
export const DEFAULT_GIF_FPS: GifFps = 12;
export const DEFAULT_GIF_MAX_DIM: GifMaxDim = 480;
export const DEFAULT_GIF_QUALITY: GifQuality = "balanced";

/** GIF 품질 preset → 색상 수(quantize maxColors). gifenc 의 PnnQuant 는
 *  16~256 사이가 의미 있고, 그 이상은 GIF 사양상 의미 없다. */
export const GIF_QUALITY_COLORS: Record<GifQuality, number> = {
  fast: 64,
  balanced: 128,
  high: 256,
};

/** WebP 품질 preset → libwebp 의 quality 파라미터 (0~100). lossless 모드는
 *  보통 영상 출처엔 파일이 너무 커져서 lossy(100 = visually lossless 에
 *  가까움) 만 노출한다. */
export const WEBP_QUALITY_LEVELS: Record<GifQuality, number> = {
  fast: 60,
  balanced: 80,
  high: 95,
};

export interface GifExportOptions {
  format: AnimationFormat;
  fps: GifFps;
  maxDim: GifMaxDim;
  quality: GifQuality;
}

const STORAGE_KEY = "preflow.library.lastGifExportOptions";

const isFormat = (v: unknown): v is AnimationFormat =>
  ANIMATION_FORMAT_OPTIONS.includes(v as AnimationFormat);
const isFps = (v: unknown): v is GifFps =>
  GIF_FPS_OPTIONS.includes(v as GifFps);
const isMaxDim = (v: unknown): v is GifMaxDim =>
  GIF_MAX_DIM_OPTIONS.includes(v as GifMaxDim);
const isQuality = (v: unknown): v is GifQuality =>
  GIF_QUALITY_OPTIONS.includes(v as GifQuality);

export const DEFAULT_GIF_EXPORT_OPTIONS: GifExportOptions = {
  format: DEFAULT_ANIMATION_FORMAT,
  fps: DEFAULT_GIF_FPS,
  maxDim: DEFAULT_GIF_MAX_DIM,
  quality: DEFAULT_GIF_QUALITY,
};

export const readGifExportOptions = (): GifExportOptions => {
  if (typeof window === "undefined") return DEFAULT_GIF_EXPORT_OPTIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GIF_EXPORT_OPTIONS;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        format: isFormat(obj.format) ? obj.format : DEFAULT_ANIMATION_FORMAT,
        fps: isFps(obj.fps) ? obj.fps : DEFAULT_GIF_FPS,
        maxDim: isMaxDim(obj.maxDim) ? obj.maxDim : DEFAULT_GIF_MAX_DIM,
        quality: isQuality(obj.quality) ? obj.quality : DEFAULT_GIF_QUALITY,
      };
    }
    return DEFAULT_GIF_EXPORT_OPTIONS;
  } catch {
    return DEFAULT_GIF_EXPORT_OPTIONS;
  }
};

export const saveGifExportOptions = (value: GifExportOptions): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 사용자가 거부했거나 quota 초과 — UI 동작은 그대로. */
  }
};

/** 원본(srcW × srcH) 를 maxDim 으로 비례 축소한 정수 픽셀 크기. maxDim=0 이면
 *  원본을 그대로 반환. GIF 인코더는 짝수 픽셀이 아니어도 동작하지만, 일부
 *  뷰어가 홀수 폭에서 사이드 1px 가 잘리는 케이스가 보고된 적 있어 짝수로
 *  맞춘다. */
export const computeGifDimensions = (
  srcW: number,
  srcH: number,
  maxDim: GifMaxDim,
): { width: number; height: number } => {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { width: 0, height: 0 };
  }
  const ensureEven = (n: number) =>
    Math.max(2, Math.floor(Math.round(n) / 2) * 2);
  if (maxDim === 0) {
    return { width: ensureEven(srcW), height: ensureEven(srcH) };
  }
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxDim ? maxDim / longest : 1;
  return {
    width: ensureEven(srcW * scale),
    height: ensureEven(srcH * scale),
  };
};
