/**
 * 클라이언트 사이드 영상 프레임 샘플링.
 *
 * 의존성 0 (브라우저 <video> + <canvas> 만 사용). 분석 대상 영상을 GPT-5.x 의
 * 멀티모달 입력 (image_url 데이터 URI) 로 변환하기 위함이다.
 *
 * 동작:
 *   1. 추가 즉시: 첫 프레임 1장만 추출 (poster) — UI 칩에 즉시 썸네일 표시
 *   2. 분석 직전: N (8 또는 16) 프레임을 균등 시점으로 추출
 *
 * 다운스케일: 가로 768px (GPT vision detail=auto 권장 영역). 세로는 비율 유지.
 *
 * 한도: 300MB / 5분 — 그 이상은 호출자가 사전 검증하고 throw.
 */

import { MAX_VIDEO_BYTES, REFERENCE_UPLOAD_MAX_LABEL } from "@shared/constants";

export interface ExtractedFrame {
  /** 영상 내 시점 (초) */
  t: number;
  /** "image/png" — 항상 PNG 로 통일 */
  mediaType: string;
  /** Base64 (no data: prefix) */
  base64: string;
}

export interface VideoMeta {
  durationSec: number;
  widthPx: number;
  heightPx: number;
}

export { MAX_VIDEO_BYTES };
export const MAX_DURATION_SEC = 5 * 60;
const TARGET_WIDTH = 768;

/* ---- Scene-aware sampling 상수 ----
   - OVERSAMPLE_RATIO: 최종 N 의 몇 배만큼 후보를 뽑을지. 1.75 는 비용-품질
     트레이드오프 스위트스팟 — 2.0 보다 시간 ~12% 단축되며 선택 품질 차이는
     주관적 비교에서 무시할 수준이었다.
   - SCENE_SHARE: 선택 슬롯 중 점수 기반(장면 전환/모션 집중) 비율. 나머지는
     균등 anchor 로 채워 시간축 커버리지를 보장.
   - HIST_BINS: RGB 히스토그램의 각 채널 분할 수. 6^3=216 bin 이면 색조 변화
     를 잘 잡으면서 비용은 무시할 수준.
   - SHORT_CLIP_THRESHOLD_SEC: 이 길이 이하면 oversample 없이 균등 추출 fast path. */
const OVERSAMPLE_RATIO = 1.75;
const SCENE_SHARE = 0.6;
const HIST_BINS = 6;
const SHORT_CLIP_THRESHOLD_SEC = 10;
const HIST_DOWNSCALE_WIDTH = 96;

/**
 * 영상 길이별 권장 프레임 수.
 *
 * 곡선 설계 의도:
 *   ≤ 10s : 6   (스토리는 거의 단일 비트)
 *   ≤ 30s : 10  (1~2 컷 전환을 캡처)
 *   ≤ 60s : 14
 *   ≤ 120s: 18
 *   ≤ 180s: 22
 *   ≤ 240s: 26
 *   ≤ 300s: 28  (5분 = 최대)
 *
 * Vision API 비용 ≈ 프레임 수에 비례 (각 768px PNG 가 ~1.5k input tokens).
 * 28 프레임이면 ~42k input tokens — 분류 1회당 GPT-5.5 기준 약 $0.04~0.06
 * 수준이라 도구의 핵심 가치를 감안하면 합리적.
 */
export function suggestedFrameCount(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 8;
  if (durationSec <= 10) return 6;
  if (durationSec <= 30) return 10;
  if (durationSec <= 60) return 14;
  if (durationSec <= 120) return 18;
  if (durationSec <= 180) return 22;
  if (durationSec <= 240) return 26;
  return 28;
}

export function validateVideoFile(file: File): { ok: true } | { ok: false; reason: string } {
  if (!file.type.startsWith("video/")) return { ok: false, reason: "비디오 파일이 아닙니다." };
  if (file.size > MAX_VIDEO_BYTES) return { ok: false, reason: `${REFERENCE_UPLOAD_MAX_LABEL} 이하 영상만 지원합니다.` };
  return { ok: true };
}

export function validateVideoMeta(meta: VideoMeta): { ok: true } | { ok: false; reason: string } {
  if (meta.durationSec > MAX_DURATION_SEC) {
    // 길이 초과는 toast 설명으로 그대로 노출된다. 용량 초과와 혼동되지 않도록
    // "분" 단위로 안내하고, 컨버팅으로도 해결되지 않음을 명시한다.
    return {
      ok: false,
      reason: `5분 이하 영상만 지원합니다 (현재 약 ${Math.ceil(meta.durationSec / 60)}분). 영상 길이는 변환으로 줄일 수 없습니다.`,
    };
  }
  return { ok: true };
}

/**
 * 비디오 메타 + 첫 프레임 1장 추출. 칩 즉시 렌더링용.
 * 동일 video element 를 후속 N 프레임 추출에서 재사용하지 않고,
 * (오류 격리/메모리 정리 단순화 목적) 매번 새 element 를 만든다.
 */
export async function extractFirstFrame(file: File): Promise<{ meta: VideoMeta; poster: ExtractedFrame }> {
  const url = URL.createObjectURL(file);
  try {
    const { meta, frames } = await sampleFromObjectUrl(url, [0.1]);
    return { meta, poster: frames[0] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * N 프레임 균등 샘플링. `count` 가 1 이면 중간 프레임 1장.
 *
 * `range` 가 주어지면 해당 구간 `[startSec..endSec]` 안에서 균등 추출한다.
 * 구간이 영상 길이를 벗어나거나 폭이 0.2s 미만이면 전체 구간으로 폴백.
 *
 * 입력은 `File` 또는 `string` (storage URL). Library 에서 import 된 영상은
 * 원본 File 핸들이 없으므로 URL 경로로 들어오는 것이 정상이며, 둘 다 동일한
 * `<video>` element 디코딩 경로를 사용한다.
 */
export async function sampleFrames(
  source: File | string,
  count: number,
  range?: { startSec: number; endSec: number },
): Promise<{ meta: VideoMeta; frames: ExtractedFrame[] }> {
  const isFile = source instanceof File;
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    const meta = await probeVideoMeta(url);
    const validation = validateVideoMeta(meta);
    if (validation.ok !== true) throw new Error(validation.reason);
    const times = computeUniformTimes(meta.durationSec, Math.max(1, count), range);
    return await sampleFromObjectUrl(url, times);
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

function computeUniformTimes(
  durationSec: number,
  count: number,
  range?: { startSec: number; endSec: number },
): number[] {
  // 유효 구간 계산. range 가 비정상이면 전체 사용.
  let lo = 0.1;
  let hi = Math.max(0.1, durationSec - 0.05);
  if (range) {
    const s = Math.max(0, Math.min(range.startSec, durationSec));
    const e = Math.max(0, Math.min(range.endSec, durationSec));
    if (e - s >= 0.2) {
      lo = Math.max(0.05, s);
      hi = Math.min(durationSec - 0.01, e);
    }
  }
  if (count === 1) return [(lo + hi) / 2];
  const span = Math.max(0.1, hi - lo);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = lo + (span * i) / (count - 1);
    out.push(Math.min(hi, Math.max(lo, t)));
  }
  return out;
}

function probeVideoMeta(objectUrl: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };
    video.onloadedmetadata = () => {
      const meta: VideoMeta = {
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        widthPx: video.videoWidth,
        heightPx: video.videoHeight,
      };
      cleanup();
      resolve(meta);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error("영상 메타데이터 로드 실패"));
    };
    video.src = objectUrl;
  });
}

interface SampleFromObjectUrlOpts {
  /** 프레임 1장 추출 직후 호출. (frame, index, total). 진행률 보고용. */
  onFrame?: (frame: ExtractedFrame, index: number, total: number) => void;
  /** drawImage 직후, toDataURL 직전에 canvas 를 열람할 수 있는 훅.
     scene-aware 샘플러가 히스토그램을 채취하는 용도. 동기 함수로 구현 권장. */
  onCanvas?: (canvas: HTMLCanvasElement, index: number, total: number) => void;
  /** AbortSignal — 자료 전환 / 재요청 시 in-flight seeking 을 끊는다.
     이미 추출된 프레임은 그대로 버리고 AbortError 를 reject. */
  signal?: AbortSignal;
}

async function sampleFromObjectUrl(
  objectUrl: string,
  times: number[],
  opts: SampleFromObjectUrlOpts = {},
): Promise<{ meta: VideoMeta; frames: ExtractedFrame[] }> {
  return new Promise((resolve, reject) => {
    const { onFrame, onCanvas, signal } = opts;
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    const frames: ExtractedFrame[] = [];
    let metaResult: VideoMeta | null = null;
    let queue: number[] = [];
    const total = times.length;

    const cleanup = () => {
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* noop */
      }
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    };

    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };

    const abortListener = signal
      ? () => fail(makeAbortError())
      : null;
    if (signal && abortListener) signal.addEventListener("abort", abortListener);

    const drainNext = () => {
      if (signal?.aborted) return fail(makeAbortError());
      if (queue.length === 0) {
        cleanup();
        if (!metaResult) return reject(new Error("메타데이터 누락"));
        return resolve({ meta: metaResult, frames });
      }
      const t = queue.shift()!;
      const safeT = Math.min(t, Math.max(0, (metaResult?.durationSec ?? 0) - 0.05));
      try {
        video.currentTime = safeT;
      } catch (e) {
        return fail(new Error(`seek 실패 t=${safeT}: ${(e as Error).message}`));
      }
    };

    video.onloadedmetadata = () => {
      metaResult = {
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        widthPx: video.videoWidth,
        heightPx: video.videoHeight,
      };
      queue = [...times];
      drainNext();
    };

    video.onseeked = () => {
      if (signal?.aborted) return fail(makeAbortError());
      try {
        const meta = metaResult!;
        const ratio = meta.widthPx > 0 ? TARGET_WIDTH / meta.widthPx : 1;
        const w = Math.min(TARGET_WIDTH, meta.widthPx);
        const h = Math.round(meta.heightPx * Math.min(ratio, 1));
        const canvas = document.createElement("canvas");
        canvas.width = w || TARGET_WIDTH;
        canvas.height = h || Math.round((TARGET_WIDTH * 9) / 16);
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail(new Error("canvas 2d context 획득 실패"));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frameIndex = frames.length;
        /* onCanvas 는 toDataURL 전에 호출해야 한다 — 이후 canvas 픽셀이 같은 메모리
           이긴 하지만 scene-aware 측에서 같은 ImageData 를 두 번 읽는 비용을 줄임. */
        if (onCanvas) {
          try {
            onCanvas(canvas, frameIndex, total);
          } catch {
            /* canvas hook 실패는 fatal 아님 — sampling 자체는 계속. */
          }
        }
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        const frame: ExtractedFrame = { t: video.currentTime, mediaType: "image/png", base64 };
        frames.push(frame);
        if (onFrame) {
          try {
            onFrame(frame, frameIndex, total);
          } catch {
            /* progress callback 실패는 fatal 아님. */
          }
        }
        drainNext();
      } catch (e) {
        fail(new Error(`프레임 추출 실패: ${(e as Error).message}`));
      }
    };

    video.onerror = () => fail(new Error("영상 디코딩 실패"));
    video.src = objectUrl;
  });
}

function makeAbortError(): Error {
  const err = new Error("Frame sampling aborted");
  err.name = "AbortError";
  return err;
}

/* ---- Scene-aware sampling ---- */

interface SceneAwareSampleOpts {
  /** 메타 도착 직후 호출. UI 가 동적으로 결정된 N 을 즉시 알 수 있다. */
  onMeta?: (meta: VideoMeta) => void;
  /** 후보 프레임이 추출될 때마다 호출. (done, total). */
  onCandidateProgress?: (done: number, total: number) => void;
  /** scoring/선택 단계 진입 직전 호출. 짧지만(보통 <100ms) UI 가 spinner
     상태를 유지하도록 알린다. */
  onScoring?: () => void;
  /** 최종 N 프레임이 선택된 직후 호출 — 썸네일 미리보기 즉시 표시.
     sceneAware=false 면 fast path (uniform-only) 였다는 신호. */
  onSelected?: (frames: ExtractedFrame[], sceneAware: boolean) => void;
  /** 자료 전환 / 재분석 시 in-flight sampling 즉시 중단. */
  signal?: AbortSignal;
  /** 강제 프레임 수 (테스트/디버그 용). 미지정이면 suggestedFrameCount(duration). */
  forceTargetN?: number;
}

/**
 * Scene-aware 프레임 샘플링.
 *
 * 알고리즘:
 *   1. probe meta → N = suggestedFrameCount(duration)
 *   2. duration ≤ SHORT_CLIP_THRESHOLD_SEC 이면 균등 N 프레임 fast path
 *   3. 그 외: K = ceil(N * OVERSAMPLE_RATIO) 의 균등 시점에서 oversample
 *      - 각 프레임의 다운스케일 RGB 히스토그램 (6^3 bin) 채취
 *   4. 인접 히스토그램 L1 거리로 scene score 계산
 *   5. Hybrid 선택: 상위 (N * SCENE_SHARE) 개 점수 + 나머지 균등 anchor
 *      ── anchor 는 [0..K-1] 균등 분할 인덱스에서 가장 가까운 미선택 후보로 매칭
 *   6. 선택 인덱스를 시간 순 정렬해 반환
 *
 * 비용 모델 (5분 / target 28):
 *   - 후보 K = 49 → ~49번 seek + draw + 히스토그램. 1080p 기준 디코드는 보통
 *     프레임당 ~150~250ms, 히스토그램은 96px 다운스케일 후 ~3ms 라 무시 수준.
 *   - 총 sampling 시간 ~ 8~13초. 사용자에 progress bar 가 보이는 한 수용 가능.
 *
 * Race / cancel: AbortSignal 이 abort 되면 즉시 AbortError 로 reject.
 */
export async function sampleFramesWithSceneAwareness(
  source: File | string,
  opts: SceneAwareSampleOpts = {},
): Promise<{ meta: VideoMeta; frames: ExtractedFrame[] }> {
  const { onMeta, onCandidateProgress, onScoring, onSelected, signal, forceTargetN } = opts;
  if (signal?.aborted) throw makeAbortError();

  const isFile = source instanceof File;
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    const meta = await probeVideoMeta(url);
    const validation = validateVideoMeta(meta);
    if (validation.ok !== true) throw new Error(validation.reason);
    if (signal?.aborted) throw makeAbortError();

    const targetN = Math.max(1, forceTargetN ?? suggestedFrameCount(meta.durationSec));
    if (onMeta) onMeta(meta);

    /* Fast path — 짧은 클립은 oversample 의미가 작다 (장면 전환이 거의 없음). */
    if (meta.durationSec <= SHORT_CLIP_THRESHOLD_SEC || targetN <= 4) {
      const times = computeUniformTimes(meta.durationSec, targetN);
      const result = await sampleFromObjectUrl(url, times, {
        signal,
        onFrame: (_, idx, total) => onCandidateProgress?.(idx + 1, total),
      });
      if (onSelected) onSelected(result.frames, false);
      return result;
    }

    /* Scene-aware path */
    const candidateCount = Math.min(
      Math.ceil(targetN * OVERSAMPLE_RATIO),
      /* 안전 상한 — 5분 영상에서도 후보가 60장 이하로 제한 */
      Math.max(targetN, 60),
    );
    const candidateTimes = computeUniformTimes(meta.durationSec, candidateCount);
    const histograms: Float32Array[] = [];

    const candidateResult = await sampleFromObjectUrl(url, candidateTimes, {
      signal,
      onCanvas: (canvas, idx) => {
        histograms[idx] = computeRgbHistogram(canvas);
      },
      onFrame: (_, idx, total) => onCandidateProgress?.(idx + 1, total),
    });

    if (signal?.aborted) throw makeAbortError();
    if (onScoring) onScoring();

    const selectedIndices = selectSceneAwareIndices(histograms, targetN);
    const selectedFrames = selectedIndices.map((i) => candidateResult.frames[i]).filter(Boolean);
    if (onSelected) onSelected(selectedFrames, true);
    return { meta: candidateResult.meta, frames: selectedFrames };
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

/**
 * canvas 에 그려진 프레임을 다운스케일 후 6^3=216 bin RGB 히스토그램으로 변환.
 * 정규화 (sum=1) — 다른 해상도/비율의 프레임끼리도 L1 비교 가능.
 */
function computeRgbHistogram(source: HTMLCanvasElement): Float32Array {
  const bins = HIST_BINS;
  const out = new Float32Array(bins * bins * bins);
  const w = HIST_DOWNSCALE_WIDTH;
  const h = Math.max(1, Math.round((source.height / Math.max(1, source.width)) * w));
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  ctx.drawImage(source, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    /* tainted canvas 등 — 0 히스토그램 반환. 점수 0 이 되므로 anchor 만 사용. */
    return out;
  }
  const step = 256 / bins;
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.min(bins - 1, Math.floor(data[i] / step));
    const g = Math.min(bins - 1, Math.floor(data[i + 1] / step));
    const b = Math.min(bins - 1, Math.floor(data[i + 2] / step));
    out[r * bins * bins + g * bins + b] += 1;
  }
  const total = w * h;
  if (total > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= total;
  }
  return out;
}

function histogramL1Distance(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/**
 * Hybrid scene-aware 선택:
 *   - 상위 sceneCount 개는 인접 히스토그램 L1 거리 합이 큰 인덱스 (장면 전환).
 *   - 나머지 anchorCount 개는 [0..K-1] 균등 분할 위치에서 가장 가까운 미선택 후보.
 *   - 점수 0 (히스토그램 실패) 후보는 자연스럽게 anchor 로만 채택될 가능성이 높음.
 *   - 결과는 candidate index 의 오름차순 정렬.
 */
function selectSceneAwareIndices(histograms: Float32Array[], targetN: number): number[] {
  const K = histograms.length;
  if (K <= targetN) return histograms.map((_, i) => i);

  const sceneCount = Math.max(1, Math.min(targetN - 1, Math.floor(targetN * SCENE_SHARE)));

  const scores: number[] = new Array(K).fill(0);
  for (let i = 0; i < K; i++) {
    /* 양 끝은 anchor 자리로 더 자주 잡히도록 점수 가중 약하게 (한쪽 인접만 사용). */
    if (i > 0) scores[i] += histogramL1Distance(histograms[i], histograms[i - 1]);
    if (i < K - 1) scores[i] += histogramL1Distance(histograms[i], histograms[i + 1]);
  }

  const ranked = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);
  const scenePicks = new Set<number>();
  for (const { index } of ranked) {
    if (scenePicks.size >= sceneCount) break;
    scenePicks.add(index);
  }

  const anchorCount = targetN - scenePicks.size;
  const anchors: number[] = [];
  if (anchorCount > 0) {
    const used = new Set<number>(scenePicks);
    for (let j = 0; j < anchorCount; j++) {
      const ideal = anchorCount === 1
        ? Math.floor((K - 1) / 2)
        : Math.round((j * (K - 1)) / (anchorCount - 1));
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < K; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(i - ideal);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        anchors.push(bestIdx);
        used.add(bestIdx);
      }
    }
  }

  return [...scenePicks, ...anchors].sort((a, b) => a - b);
}
