// 영상 reference 의 [startSec, endSec] 구간을 animated WebP 로 인코딩한다.
// libwebp WASM (wasm-webp) 의 encodeAnimation 을 사용한다.
//
// GIF 와의 비교:
//   - GIF 는 256 색 + LZW 압축이라 그라데이션·피부톤이 띠(banding) 와 디더
//     노이즈로 나타난다. 디더링/글로벌 팔레트로 많이 개선되지만 한계가 있다.
//   - WebP 는 24bit 색 + VP8/VP8L 압축이라 보통 같은 클립 기준 GIF 대비
//     ~3~5배 작은 파일에 시각적으로 거의 무손실에 가까운 결과가 나온다.
//
// 인코더는 wasm-webp 의 동적 import 로 가져온다. 사용자가 GIF 만 쓰는
// 시나리오에선 wasm(~470KB) + glue js(~140KB) 가 로드되지 않는다.

import {
  WEBP_QUALITY_LEVELS,
  type GifExportOptions,
  type GifMaxDim,
} from "./gifExportPreferences";
import {
  GifConversionCancelledError,
  convertVideoLoopToGif,
  extractLoopFramesFromVideo,
  type ConvertLoopInput,
} from "./videoToGif";

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new GifConversionCancelledError();
}

/* wasm-webp 의 encodeAnimation 은 모든 프레임 RGBA 데이터를 WASM 힙에 한꺼번에
   올린다. WASM 힙 한계(보통 256MB) 초과 시 native abort() 가 발생하므로,
   총 RGBA 바이트 = width × height × 4 × 프레임 수 를 이 값 이하로 유지한다. */
const WASM_SAFE_RGBA_BYTES = 192 * 1024 * 1024; // 192 MB

/** 프레임 수 기반으로 WASM OOM 없이 처리 가능한 최대 픽셀(가장 긴 변) 를 반환.
 *  최악의 경우(정사각형 영상)를 가정해 보수적으로 계산한다. */
function webpSafeMaxDim(totalFrames: number): number {
  return Math.floor(Math.sqrt(WASM_SAFE_RGBA_BYTES / (totalFrames * 4)));
}

export async function convertVideoLoopToWebp(
  input: ConvertLoopInput,
): Promise<Blob> {
  const { options, onProgress, signal } = input;
  const quality = WEBP_QUALITY_LEVELS[options.quality];

  /* WASM 메모리 안전 상한 — 프레임 수에 따라 maxDim 을 자동으로 제한.
     maxDim=0("Original") 이거나 요청 값이 안전 한계를 넘으면 자동 하향. */
  const duration = Math.max(0, input.endSec - input.startSec);
  const totalFrames = Math.max(1, Math.ceil(duration * options.fps));
  const safeDim = webpSafeMaxDim(totalFrames);
  const effectiveMaxDim: GifMaxDim =
    options.maxDim === 0 || options.maxDim > safeDim
      ? (safeDim as GifMaxDim)
      : options.maxDim;
  const safeOptions: GifExportOptions = { ...options, maxDim: effectiveMaxDim };

  /* 1) 프레임 추출 — 진행률 0~50%. */
  const { frames, width, height, fps } = await extractLoopFramesFromVideo({
    ...input,
    options: safeOptions,
    onProgress: (ratio) => onProgress?.(ratio * 0.5, "extract"),
  });

  throwIfAborted(signal);

  /* 2) wasm-webp 동적 로드. 첫 호출에서 wasm 컴파일 + 모듈 부팅이 일어나
        ~수백 ms 가 추가된다. 사용자에게는 "encode" 단계의 첫 시그널로 보임.
        Vite 는 이 dynamic import 를 보고 별도 chunk + .wasm asset 을 emit
        하므로 사용자가 GIF 만 쓰는 경우 wasm 은 다운로드되지 않는다. */
  onProgress?.(0.5, "encode");
  const { encodeAnimation } = await import("wasm-webp");

  throwIfAborted(signal);

  /* 3) 프레임 변환 — wasm-webp 는 Uint8Array 만 받는다. Uint8ClampedArray 의
        buffer 를 zero-copy 로 감싸 변환 비용을 없앤다. duration 은 ms 단위. */
  const frameDelayMs = Math.max(20, Math.round(1000 / Math.max(1, fps)));
  const animFrames = frames.map((rgba) => ({
    data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    duration: frameDelayMs,
    /* per-frame config — 모든 프레임 동일 quality. lossless=0(lossy)이
       파일 크기 대비 화질 최적. quality=95 면 사실상 무손실에 가깝다. */
    config: { lossless: 0, quality },
  }));

  /* 메모리 회수 — Uint8Array 로 감싼 동일 buffer 를 wasm 이 들고 가니
     frames 배열 자체는 비워도 된다. */
  frames.length = 0;

  /* encodeAnimation 은 한 번에 모든 프레임을 받아 wasm 안에서 인코딩한다.
     중간 progress 콜백이 없으므로 50→95% 까지 "추정" 진행률을 천천히
     올린다. UI 가 멈춰 보이지 않도록 setInterval 로 매끄럽게 흐른다. */
  let estimated = 0.5;
  const encodeTimer = setInterval(() => {
    /* 95% 까지 점근 — 실제 완료 직전까지 끌어올린다. */
    estimated = Math.min(0.95, estimated + 0.01);
    onProgress?.(estimated, "encode");
  }, 250);

  /* 사용자가 인코딩 도중 cancel 을 눌러도 wasm 호출 자체는 중단 불가.
     호출 완료 후 결과를 throw 하는 식으로 cancel 을 적용한다. */
  let bytes: Uint8Array | null = null;
  try {
    /* hasAlpha=true — 입력 버퍼는 getImageData 의 RGBA(픽셀당 4바이트) 다.
       wasm-webp 의 C++ 측은 has_alpha 값에 따라 stride = (has_alpha ? 4 : 3)
       * width 로 데이터를 읽기 때문에, false 로 보내면 모든 행이 1바이트씩
       어긋나면서 그리드 노이즈가 발생한다. 영상 프레임의 알파는 항상 255 라
       libwebp 의 알파 압축이 사실상 0 바이트로 끝나므로 파일 크기 영향은
       무시할 수 있다. */
    const result = await encodeAnimation(width, height, true, animFrames);
    bytes = result ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) {
      throw new Error(
        `WebP 인코딩 실패: WASM 메모리 부족 (${width}×${height} × ${animFrames.length}프레임). 해상도 또는 FPS를 낮춰 다시 시도해 주세요.`,
      );
    }
    throw err;
  } finally {
    clearInterval(encodeTimer);
  }

  throwIfAborted(signal);
  if (!bytes) {
    throw new Error("wasm-webp returned no data");
  }

  onProgress?.(1, "encode");
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/webp" });
}

/** SaveLoopAsGifDialog 가 format 에 따라 분기할 수 있도록, 두 인코더를 같은
 *  시그니처로 노출하는 유니파이드 헬퍼. GIF 경로는 동기적으로 import 되지만
 *  WebP 경로의 wasm-webp 모듈은 convertVideoLoopToWebp 안에서 dynamic import
 *  된다 — 사용자가 WebP 를 선택하지 않으면 wasm 은 로드되지 않는다. */
export async function convertVideoLoopToAnimation(
  input: ConvertLoopInput,
): Promise<Blob> {
  if (input.options.format === "webp") {
    return convertVideoLoopToWebp(input);
  }
  return convertVideoLoopToGif(input);
}
