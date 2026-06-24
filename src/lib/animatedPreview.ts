// 그리드 자동재생용 경량 애니메이션 프리뷰 인코더.
//
// 배경: 라이브러리 그리드가 GIF / animated-WebP 원본(수 MB, 수천 프레임 가능)
// 을 그대로 <img> 자동재생하면 카드 수십 개가 동시에 디코드를 돌려 메인스레드
// 가 길게 멈춘다. 여기서는 원본을 작은 다운스케일 animated WebP(`≤360px`,
// `~12fps`) 로 한 번 구워 두고, 그리드는 그 경량 프리뷰만 재생한다.
//
// 파이프라인:
//   1) decodeAnimatedAllFrames(ImageDecoder, 250-frame 캡) 로 모든 프레임 디코드.
//   2) fps subsample — 원본 프레임 delay 를 누적하며 ~12fps 로 솎되, 솎인 프레임
//      들의 실제 표시 시간은 보존한다(느린 GIF 는 그대로 느리게).
//   3) 360px 다운스케일 + canvas getImageData → RGBA.
//   4) wasm-webp encodeAnimation 으로 한 번에 인코딩.
//
// 안전:
//   - 디코드된 VideoFrame 은 *반드시* finally 에서 close() — GPU 메모리 누수 방지.
//   - webpSafeMaxDim(프레임 수 기반)으로 maxDim 을 한 번 더 clamp 해 WASM 힙
//     초과(native abort)를 예방한다.
//   - 어떤 단계든 실패하면 null 반환 — 호출자는 원본 자동재생으로 자연 폴백.

import {
  WEBP_QUALITY_LEVELS,
  computeGifDimensions,
  type GifMaxDim,
} from "./gifExportPreferences";
import { decodeAnimatedAllFrames } from "./gifFrames";
import { webpSafeMaxDim } from "./videoToWebp";

/** 프리뷰 목표 — 가장 긴 변 360px. GifMaxDim 의 한 옵션이라 타입도 정확히 맞는다. */
const PREVIEW_MAX_DIM: GifMaxDim = 360;
/** 목표 프레임레이트(상한). 원본이 더 느리면 native 속도를 유지한다. */
const PREVIEW_TARGET_FPS = 12;
/** WebP 품질 — balanced(80). 그리드 카드 크기에서 시각적으로 충분하고 파일이 작다. */
const PREVIEW_QUALITY = WEBP_QUALITY_LEVELS.balanced;
/** animated WebP 의 프레임 delay 최소값(ms). libwebp 가 너무 작은 delay 를
 *  떨어뜨리는 케이스 방지 — videoToWebp 의 frameDelayMs 하한과 동일. */
const MIN_FRAME_DELAY_MS = 20;

export interface GenerateAnimatedPreviewOptions {
  signal?: AbortSignal;
}

/** wasm-webp 의 encodeAnimation per-frame 입력 형태(videoToWebp 와 동일 규약). */
interface WebpAnimFrame {
  data: Uint8Array;
  duration: number;
  config: { lossless: 0 | 1; quality: number };
}

/**
 * GIF / animated WebP / APNG 원본 URL 에서 경량 animated WebP 프리뷰 Blob 을 만든다.
 *
 * @returns `image/webp` Blob, 또는 실패/부적합(정적 단일 프레임 등) 시 `null`.
 *          null 이면 호출자는 원본을 그대로 쓰는 폴백을 유지해야 한다.
 */
export async function generateAnimatedPreviewBlob(
  src: string,
  mime: string | null | undefined,
  opts: GenerateAnimatedPreviewOptions = {},
): Promise<Blob | null> {
  const { signal } = opts;
  if (typeof document === "undefined") return null;

  let decoded: Awaited<ReturnType<typeof decodeAnimatedAllFrames>>;
  try {
    decoded = await decodeAnimatedAllFrames(src, mime, { signal });
  } catch (err) {
    // Abort 는 호출자에게 전파(스케줄러가 취소를 구분). 그 외 디코드 실패는
    // 조용히 null — 원본 폴백.
    if ((err as { name?: string })?.name === "AbortError") throw err;
    return null;
  }

  const frames = decoded.frames;
  try {
    // 정적(단일 프레임) 자료는 애니메이션 프리뷰 의미가 없다 → null 폴백.
    if (frames.length <= 1) return null;

    const srcW = decoded.widthPx || frames[0].displayWidth;
    const srcH = decoded.heightPx || frames[0].displayHeight;
    if (!srcW || !srcH) return null;

    // (2) fps subsample — 원본 delay 를 누적하다 frameInterval 을 넘으면 그
    // 구간의 마지막 프레임을 채택하고, delay 는 누적분(=실제 경과시간)을 부여.
    const frameIntervalMs = 1000 / PREVIEW_TARGET_FPS;
    const keptIdx: number[] = [];
    const keptDelays: number[] = [];
    let pending = 0;
    for (let i = 0; i < frames.length; i++) {
      pending += decoded.durationsMs[i] ?? Math.round(frameIntervalMs);
      const isLast = i === frames.length - 1;
      if (pending >= frameIntervalMs || isLast) {
        keptIdx.push(i);
        keptDelays.push(Math.max(MIN_FRAME_DELAY_MS, Math.round(pending)));
        pending = 0;
      }
    }
    if (keptIdx.length <= 1) return null;

    // (3) 목표 해상도 — 360px 요청을 webpSafeMaxDim(프레임 수)으로 한 번 더
    // 하향. 보통 360 이 그대로 채택되고, 프레임이 매우 많을 때만 더 작아진다.
    const safeDim = webpSafeMaxDim(keptIdx.length);
    const effectiveMaxDim = Math.min(PREVIEW_MAX_DIM, safeDim) as GifMaxDim;
    const { width, height } = computeGifDimensions(srcW, srcH, effectiveMaxDim);
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const animFrames: WebpAnimFrame[] = [];
    for (let k = 0; k < keptIdx.length; k++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const vf = frames[keptIdx[k]];
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(vf as unknown as CanvasImageSource, 0, 0, width, height);
      // getImageData 는 매 호출 새 ImageData 를 반환하므로 buffer 가 겹치지
      // 않는다 → 배열에 모아 둬도 안전(서로 덮어쓰지 않음).
      const imageData = ctx.getImageData(0, 0, width, height);
      animFrames.push({
        data: new Uint8Array(
          imageData.data.buffer,
          imageData.data.byteOffset,
          imageData.data.byteLength,
        ),
        duration: keptDelays[k],
        // lossy(0) + balanced quality. 영상 프레임이라 알파는 항상 255 →
        // hasAlpha=true 여도 파일 크기 영향 미미(아래 encodeAnimation 인자).
        config: { lossless: 0, quality: PREVIEW_QUALITY },
      });
    }

    // (4) wasm-webp 동적 로드 + 인코드. 사용자가 GIF 프리뷰를 한 번도 굽지
    // 않으면 wasm 은 로드되지 않는다(Vite 가 별도 chunk 로 분리).
    let bytes: Uint8Array | null = null;
    try {
      const { encodeAnimation } = await import("wasm-webp");
      // hasAlpha=true — getImageData 는 RGBA(픽셀당 4바이트)다. false 로 주면
      // stride 가 어긋나 그리드 노이즈가 생긴다(videoToWebp 와 동일 이유).
      const result = await encodeAnimation(width, height, true, animFrames);
      bytes = result ?? null;
    } catch (err) {
      // WASM OOM(abort) 등 — 프리뷰는 어디까지나 부가물이므로 조용히 폴백.
      console.warn("[animatedPreview] encode failed (keeping original):", err);
      return null;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!bytes) return null;
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/webp" });
  } finally {
    // 디코드된 VideoFrame 은 전부 close — 누락 시 GPU 메모리 누수.
    for (const f of frames) {
      try { f.close(); } catch { /* noop */ }
    }
  }
}
