// 영상 reference 의 [startSec, endSec] 구간을 GIF / WebP 애니메이션으로
// 변환하기 위한 공용 프레임 추출 + GIF 인코딩 파이프라인.
//
// 공통 흐름:
//   1) off-DOM <video> 로 videoUrl 을 로드하고 메타데이터를 기다린다.
//   2) OffscreenCanvas 에 1/fps 간격으로 seek + drawImage → getImageData 로
//      RGBA Uint8ClampedArray 를 모은다. 다운스케일 품질은
//      imageSmoothingQuality="high" 로 끌어올린다.
//   3) GIF: 모든 프레임을 Worker 에 transferable 로 넘긴다 — Worker 는
//      글로벌 팔레트 + Floyd-Steinberg 디더링으로 한 번에 인코딩.
//      WebP: extractLoopFramesFromVideo 결과를 videoToWebp.ts 가 받아
//      wasm-webp 의 encodeAnimation 으로 인코딩.
//
// 메인 스레드에서 <video> 가 필요한 이유: HTMLVideoElement 는 DOM API 라
// Worker 안에선 직접 디코드가 불가능하다. WebCodecs(VideoDecoder) + demuxer
// 로 옮기면 더 빨라지지만, 1차 구현은 호환성을 우선했다.

import {
  GIF_QUALITY_COLORS,
  computeGifDimensions,
  type GifExportOptions,
} from "./gifExportPreferences";

export interface ConvertLoopInput {
  /** ReferenceItem.file_url — Preflow 의 로컬 HTTP 서버 URL. */
  videoUrl: string;
  startSec: number;
  endSec: number;
  options: GifExportOptions;
  /** 0..1. 단계별로 호출 — 콜러가 phase 라벨로 UI 진행률을 표시. */
  onProgress?: (
    ratio01: number,
    phase: "extract" | "encode",
  ) => void;
  /** AbortSignal 호환 — Cancel 버튼이 abort() 하면 즉시 중단하고 reject. */
  signal?: AbortSignal;
}

/** convertVideoLoopToGif 와 동일한 입력 — 옛 이름은 호환을 위해 유지. */
export type ConvertLoopToGifInput = ConvertLoopInput;

export class GifConversionCancelledError extends Error {
  constructor() {
    super("Animation export cancelled");
    this.name = "GifConversionCancelledError";
  }
}

export interface ExtractedLoopFrames {
  /** 각 프레임 RGBA Uint8ClampedArray. 메인 스레드 소유 — Worker 에 transfer
   *  하려면 호출자가 buffer 를 transferable 로 넘길 책임. */
  frames: Uint8ClampedArray[];
  width: number;
  height: number;
  /** GIF / WebP delay 계산용 — 실제 출력 fps. */
  fps: number;
  /** 안내용 — 실제 추출된 프레임 수와 같다. */
  totalFrames: number;
}

/* off-DOM <video> 를 만들어 메타가 로드될 때까지 대기. crossOrigin 은
   같은 origin(127.0.0.1:port) 이라 굳이 설정 안 해도 되지만, 다른 origin
   이 들어와도 안전하게 anonymous 로 시도한다 (실패 시 같은 origin 이라
   상관없이 통과). */
async function loadVideo(videoUrl: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = videoUrl;
  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to load video for animation export"));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
  return video;
}

/* video.currentTime = t 후 다음 'seeked' 이벤트를 기다린다. 일부 코덱은
   요청한 시간보다 약간 이른/늦은 키프레임으로 스냅될 수 있는데, 12fps 의
   1/12s 그리드 안이면 시각적으로 무시 가능. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Seek failed at ${time}s`));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = time;
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new GifConversionCancelledError();
}

/** 영상 reference 의 loop 구간을 RGBA 프레임 배열로 추출. GIF/WebP 양쪽 모두
 *  이 결과를 받아 각자의 인코더에 넘긴다. progress 의 "extract" phase 가
 *  0~1 로 호출된다 — 콜러가 전체 0~0.5 로 매핑해 UI 에 반영. */
export async function extractLoopFramesFromVideo(
  input: ConvertLoopInput,
): Promise<ExtractedLoopFrames> {
  const { videoUrl, startSec, endSec, options, onProgress, signal } = input;
  const duration = endSec - startSec;
  if (!(duration > 0)) {
    throw new Error("Loop range is empty");
  }
  const fps = options.fps;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  throwIfAborted(signal);
  const video = await loadVideo(videoUrl);
  try {
    throwIfAborted(signal);
    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;
    if (srcW <= 0 || srcH <= 0) {
      throw new Error("Video has unknown dimensions");
    }
    const { width, height } = computeGifDimensions(srcW, srcH, options.maxDim);
    if (width <= 0 || height <= 0) {
      throw new Error("Animation target size is invalid");
    }

    /* OffscreenCanvas 는 Electron Chromium 에선 항상 지원되지만, 호환성을
       위해 둘 다 시도. drawImage 자체 동작은 동일하다. */
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : (() => {
            const el = document.createElement("canvas");
            el.width = width;
            el.height = height;
            return el;
          })();
    const ctx2d = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext(
      "2d",
    ) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx2d) throw new Error("Failed to get 2D canvas context");
    /* 720p → 480p 같은 다운스케일을 bilinear → bicubic 비슷한 품질로 끌어
       올림. 기본값(low) 으로 두면 가는 선이 뭉개지고 노이즈가 두드러진다. */
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.imageSmoothingQuality = "high";

    const frames: Uint8ClampedArray[] = [];
    /* 프레임 추출 — 정확히 N 개 프레임을 [startSec, endSec) 에 균등 분배.
       첫 프레임 = startSec, 마지막 프레임 = endSec - 1ms. */
    const step = duration / totalFrames;
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal);
      const t = Math.min(endSec - 1e-3, startSec + i * step);
      await seekTo(video, t);
      throwIfAborted(signal);
      (ctx2d as CanvasRenderingContext2D).drawImage(
        video,
        0,
        0,
        width,
        height,
      );
      const imageData = (ctx2d as CanvasRenderingContext2D).getImageData(
        0,
        0,
        width,
        height,
      );
      frames.push(imageData.data);
      onProgress?.((i + 1) / totalFrames, "extract");
    }

    return { frames, width, height, fps, totalFrames };
  } finally {
    /* off-DOM video 의 src 를 비워 메모리 해제 — Electron 의 일부 빌드에서
       blob URL 이 GC 전까지 남는 사례 보고됨. */
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* noop */
    }
  }
}

export async function convertVideoLoopToGif(
  input: ConvertLoopToGifInput,
): Promise<Blob> {
  const { options, onProgress, signal } = input;
  const colors = GIF_QUALITY_COLORS[options.quality];

  /* 1) 프레임 추출 — 진행률 0~50%. */
  const { frames, width, height, fps, totalFrames } =
    await extractLoopFramesFromVideo({
      ...input,
      onProgress: (ratio) => onProgress?.(ratio * 0.5, "extract"),
    });

  throwIfAborted(signal);

  /* 2) Worker 로 인코딩 — 글로벌 팔레트 + Floyd-Steinberg 디더링.
     모든 프레임을 init 직후 한꺼번에 보내고, finish 시그널 후 worker 가
     frame 별로 frameDone 을 보내며 50~100% 진행률을 채운다. */
  const worker = new Worker(
    new URL("../workers/videoToGif.worker.ts", import.meta.url),
    { type: "module" },
  );

  let resolveDone: ((blob: Blob) => void) | null = null;
  let rejectDone: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const onReady = (event: MessageEvent) => {
      const data = event.data as { type?: string; message?: string };
      if (data?.type === "ready") {
        worker.removeEventListener("message", onReady);
        resolve();
      } else if (data?.type === "error") {
        worker.removeEventListener("message", onReady);
        reject(new Error(data.message || "GIF worker init error"));
      }
    };
    worker.addEventListener("message", onReady);
  });
  const donePromise = new Promise<Blob>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  worker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as
      | { type: "extractAck"; totalCollected: number }
      | { type: "frameDone"; totalEncoded: number }
      | { type: "done"; bytes: Uint8Array }
      | { type: "error"; message: string }
      | { type: "ready" };
    if (data.type === "frameDone") {
      onProgress?.(
        0.5 + Math.min(1, data.totalEncoded / totalFrames) * 0.5,
        "encode",
      );
    } else if (data.type === "done") {
      /* TS 의 lib.dom 은 Blob 생성자 인자를 BlobPart 로 좁혀 두는데,
         postMessage 를 거친 Uint8Array 는 ArrayBufferLike(SharedArrayBuffer
         포함) 로 추론된다. 우리 worker 는 SAB 를 쓰지 않으니 명시 캐스트로
         해결한다. */
      resolveDone?.(new Blob([data.bytes as Uint8Array<ArrayBuffer>], { type: "image/gif" }));
    } else if (data.type === "error") {
      rejectDone?.(new Error(data.message || "GIF worker error"));
    }
  });
  worker.addEventListener("error", (event) => {
    rejectDone?.(new Error(event.message || "GIF worker crashed"));
  });

  const onAbort = () => {
    worker.postMessage({ type: "cancel" });
    worker.terminate();
    rejectDone?.(new GifConversionCancelledError());
  };
  signal?.addEventListener("abort", onAbort);

  try {
    worker.postMessage({
      type: "init",
      width,
      height,
      fps,
      colors,
    });
    await readyPromise;
    throwIfAborted(signal);

    /* 모든 프레임을 transferable 로 worker 에 보낸다. 한 번 보낸 프레임은
       메인 스레드에서 detach 되어 메모리에서 즉시 회수된다. */
    for (let i = 0; i < frames.length; i++) {
      throwIfAborted(signal);
      const buf = frames[i].buffer;
      worker.postMessage(
        { type: "frame", buffer: buf, index: i },
        [buf],
      );
    }
    /* main 측 frames 배열의 buffer 는 이제 detached. 참조를 끊어 GC 유도. */
    frames.length = 0;

    throwIfAborted(signal);
    worker.postMessage({ type: "finish" });
    const blob = await donePromise;
    return blob;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}

/** GIF / WebP 결과 파일 크기의 매우 거친 추정 — dialog 의 "예상 크기"
 *  라벨용. 실제 압축률은 콘텐츠와 포맷에 따라 크게 변한다.
 *
 *  - GIF: LZW + 256색. width × height × bytes/pixel(0.4) × frames × 0.6
 *  - WebP: VP8L/VP8 (libwebp). GIF 대비 1/3~1/5 으로 작게 잡는다. */
export function estimateAnimationBytes(
  width: number,
  height: number,
  frames: number,
  format: "gif" | "webp",
): number {
  if (width <= 0 || height <= 0 || frames <= 0) return 0;
  const gifBytes = Math.round(width * height * 0.4 * frames * 0.6);
  return format === "webp" ? Math.round(gifBytes * 0.28) : gifBytes;
}

/** 옛 이름 호환. */
export function estimateGifBytes(
  width: number,
  height: number,
  frames: number,
): number {
  return estimateAnimationBytes(width, height, frames, "gif");
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
