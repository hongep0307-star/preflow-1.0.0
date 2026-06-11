/**
 * Color matching for library 의 Color 필터.
 *
 * 두 가지 색을 "사람이 비슷하다고 인지하는가" 로 비교해야 한다. RGB 공간에서
 * 그냥 Euclidean 거리를 재면 똑같은 numerical 거리라도 시각적으로 매우 다르게
 * 느껴지는 케이스가 흔하다(특히 어두운 영역 vs 밝은 영역). 그래서 sRGB → CIELAB
 * 으로 옮긴 뒤 ΔE76(LAB Euclidean) 을 거리로 사용한다.
 *
 * ΔE 감각 척도:
 *   ~ 1   : 거의 구분 불가
 *   ~ 5   : 가까이서 보면 차이 인지
 *   ~ 10  : 한눈에 다른 색
 *   ~ 25  : 같은 color family 내 분명한 변형 (예: 진한 파랑 vs 옅은 파랑)
 *   ~ 50  : 다른 family
 *
 * COLOR_FILTER_THRESHOLD 는 25 — 모니터/색약 차를 고려해 살짝 관대한 경계.
 *
 * 성능 메모: hex → Lab 변환 결과는 모듈 내부 Map 으로 캐시한다. 한 라이브러리
 * 1000~3000 항목 × palette 8 swatch 면 최대 24k lookup 인데, 같은 hex 가
 * 자료들 사이에 흔히 반복되므로 캐시 hit 율이 매우 높다. selected hex 는
 * useMemo 분석 1회당 1회만 변환된다.
 */

export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

export interface LabColor {
  L: number;
  a: number;
  b: number;
}

/** "#rrggbb" 또는 "rrggbb" 모두 허용. 잘못된 입력은 null. 3자리 단축형
 *  ("#abc") 은 라이브러리에 들어올 일이 없어 무시 — 단순함 우선. */
export function hexToRgb(hex: string): RgbColor | null {
  if (typeof hex !== "string") return null;
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length !== 6) return null;
  const num = Number.parseInt(clean, 16);
  if (!Number.isFinite(num)) return null;
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const hex = (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** sRGB(0..255) → linear sRGB(0..1) 역감마. 표준 곡선. */
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** D65 광원 기준 XYZ → Lab 의 f() 함수. */
function labF(t: number): number {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  return t > epsilon ? Math.cbrt(t) : (kappa * t + 16) / 116;
}

export function rgbToLab(rgb: RgbColor): LabColor {
  const rl = srgbToLinear(rgb.r);
  const gl = srgbToLinear(rgb.g);
  const bl = srgbToLinear(rgb.b);
  // sRGB → XYZ (D65). 표준 변환 행렬.
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
  // D65 white point 로 정규화.
  const xr = x / 0.95047;
  const yr = y / 1.0;
  const zr = z / 1.08883;
  const fx = labF(xr);
  const fy = labF(yr);
  const fz = labF(zr);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

const labCache = new Map<string, LabColor>();

/** hex → Lab. 잘못된 입력은 null. 결과는 캐시. */
export function hexToLab(hex: string): LabColor | null {
  const key = hex.toLowerCase();
  const cached = labCache.get(key);
  if (cached) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lab = rgbToLab(rgb);
  labCache.set(key, lab);
  return lab;
}

/** ΔE76 — 두 Lab 의 Euclidean 거리. 더 정교한 ΔE2000 도 있지만, 라이브러리
 *  필터링 용도에선 ΔE76 의 정확도로 충분하고 계산 비용이 훨씬 싸다. */
export function labDistance(a: LabColor, b: LabColor): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** 두 hex 의 ΔE. 어느 쪽이라도 invalid 면 Infinity (= 절대 매칭 안 됨). */
export function colorDistance(hexA: string, hexB: string): number {
  const labA = hexToLab(hexA);
  const labB = hexToLab(hexB);
  if (!labA || !labB) return Number.POSITIVE_INFINITY;
  return labDistance(labA, labB);
}

/** "비슷한 톤" 의 경계선. ΔE 32 — 같은 family 내 분명한 변형(짙은 vs 옅은
 *  파랑, 짙은 vs 옅은 teal) 까지 확실히 허용. 이전 25 는 같은 hue 라도 명도/
 *  채도가 좀만 달라도 떨어뜨려서 사용자가 "이거 걸렸어야 하는데" 느낌 잦았음. */
export const COLOR_FILTER_THRESHOLD = 32;

/** chroma-aware secondary 매칭의 hue 허용치 (도). target 의 chroma 가 충분히
 *  높을 때 (≥ 12) 만 작동 — 그레이/뉴트럴 target 은 hue 의미가 약해 적용 X.
 *  hue 차이 ≤ 28° 면 같은 color family 로 인정. cinematic 영상에서 흔한 톤
 *  변형 (짙은 vs 옅은 / 어두운 vs 밝은) 까지 확실히 포함되도록 살짝 넉넉. */
const HUE_TOLERANCE_DEG = 28;
const TARGET_CHROMA_MIN = 12;
/** hue family 가 같을 때 L(명도) 차이를 얼마나 깎을지. 어두운 cinematic
 *  green 도 brightish teal target 에 잡히도록. 1.0 = ΔE76 원본, 0.3 = L 차이를
 *  30% 만 반영. cinematic 톤 변형 (어두운 색조 + 밝은 톤) 이 같은 hue family
 *  로 묶이려면 L 영향력을 충분히 줄여야 함. */
const L_WEIGHT_HUE_MATCH = 0.3;

/** Lab → 채도(chroma) + 색상(hue, 0..360). a/b 평면의 polar 좌표. */
function labToChromaHue(lab: LabColor): { chroma: number; hue: number } {
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { chroma, hue };
}

/** 두 hue 의 *각도 거리* (0..180). 320° vs 10° = 50°. */
function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/** palette 내에서 target 과 가장 가까운 swatch 의 거리 점수를 반환.
 *
 *  점수 정책:
 *   - 1차: ΔE76 — Lab 공간 Euclidean. 직관적 색 차이.
 *   - 2차 (chromatic target 한정): swatch 의 hue 가 target hue 와 ±28° 이내면
 *     ΔE 값이 다소 커도 점수에 보너스(=거리에서 차감). 같은 color family 의
 *     다양한 명도/채도 변형을 확실히 잡아 사용자가 그린 직관과 일치.
 *
 *  반환 값:
 *   - `distance`: ΔE / hue-weighted ΔE 의 *최소값*. **필터 통과 판정에만
 *     사용**. ratio 가중치는 적용하지 *않는다* — "이 자료에 고른 색이
 *     있나" 에 가까운 본래 직관 보존(파란 하늘이 작게 들어간 풍경 사진을
 *     "파랑" 필터로 골랐을 때 잡혀야 자연스럽다).
 *   - `rankScore`: 위 점수에서 swatch 의 ratio(=면적 비중) 기반 *보너스*
 *     만큼 차감한 값들의 최소. **정렬 점수**(낮을수록 위로). ratio 가
 *     큰 swatch 가 매칭됐으면 더 작은 rankScore 가 나와 상단에 노출 —
 *     "이미지의 *지배색* 이 target 과 가까울수록 더 강한 매칭으로 본다"
 *     는 직관에 부합. ratio 가 작거나 누락된 swatch 에는 보너스를 *주지
 *     않는다* — 즉 페널티 없이 기존 distance 와 동일하게 동작.
 *
 *  보너스가 distance 시맨틱을 망가뜨리지 않도록 두 값을 같은 루프에서
 *  *독립적으로* 추적: 각각의 최소값을 만들어내는 swatch 가 서로 다를
 *  수 있다 (작은 면적의 정확 매칭이 distance 1등, 큰 면적의 적당 매칭이
 *  rankScore 1등). 호출 측은 distance 로 threshold 자르고, rankScore
 *  로 정렬한다.
 *
 *  palette 가 비었거나 모든 swatch 가 invalid hex 면 null. */
/** ratio → 거리 차감 보너스. 면적이 클수록 큰 보너스, 0/누락이면 0.
 *  sqrt 곡선을 쓰는 이유: 실제 ratio 분포가 0.05~0.5 에 몰려 있는 경우가
 *  많아 선형이면 dominant 와 minor 의 보너스 차이가 잘 안 느껴짐. sqrt 면
 *  ratio=0.5 → ≈ 7.1, ratio=0.1 → ≈ 3.2 정도로 충분히 차별화되면서, 면적
 *  0 인 (=ratio 누락) swatch 는 정확히 0 만큼 차감 → 기존 동작과 동일. */
const AREA_BONUS_MAX = 10;
function areaBonus(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return 0;
  const clamped = ratio > 1 ? 1 : ratio;
  return AREA_BONUS_MAX * Math.sqrt(clamped);
}

export function scoreItemByColor(
  palette: ReadonlyArray<{ color: string; ratio?: number }>,
  targetHex: string,
): { distance: number; rankScore: number } | null {
  if (!palette || palette.length === 0) return null;
  const target = hexToLab(targetHex);
  if (!target) return null;
  const { chroma: targetChroma, hue: targetHue } = labToChromaHue(target);
  const useHueBonus = targetChroma >= TARGET_CHROMA_MIN;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const swatch of palette) {
    const lab = hexToLab(swatch.color);
    if (!lab) continue;
    const dL = target.L - lab.L;
    const da = target.a - lab.a;
    const db = target.b - lab.b;
    const deltaE = Math.sqrt(dL * dL + da * da + db * db);
    let score = deltaE;
    if (useHueBonus) {
      const { chroma: swatchChroma, hue: swatchHue } = labToChromaHue(lab);
      // swatch 도 어느 정도 채도가 있어야 hue 의미 — 회색 swatch 가 hue 우연
      // 일치로 통과하는 거짓-매칭 방지.
      if (swatchChroma >= TARGET_CHROMA_MIN / 2) {
        const dh = hueDistance(targetHue, swatchHue);
        if (dh <= HUE_TOLERANCE_DEG) {
          // 같은 hue family — L(명도) 차이를 깎은 *weighted* 거리.
          // cinematic 어두운 green 이 밝은 teal target 에도 잡히도록.
          // hue 가 정확할수록 weight 더 줄임 (hue==0° 면 L_WEIGHT_HUE_MATCH 적용,
          // tolerance 경계면 원래 ΔE).
          const t = 1 - dh / HUE_TOLERANCE_DEG;
          const lWeight = 1 - t * (1 - L_WEIGHT_HUE_MATCH);
          const weighted = Math.sqrt(lWeight * lWeight * dL * dL + da * da + db * db);
          if (weighted < score) score = weighted;
        }
      }
    }
    if (score < bestDistance) bestDistance = score;
    // rankScore 는 면적 큰 swatch 일수록 더 낮게(=정렬 시 위로) 만들기 위해
    // 보너스를 *차감*. 보너스 함수는 ratio<=0 / 누락에서 0 을 반환하므로
    // 작은 면적 swatch 에 페널티가 가지 *않는다*.
    const rank = score - areaBonus(swatch.ratio);
    if (rank < bestRank) bestRank = rank;
  }
  if (!Number.isFinite(bestDistance)) return null;
  return { distance: bestDistance, rankScore: bestRank };
}
