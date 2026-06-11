/**
 * GIF / 애니메이션 WebP / APNG 프레임 단위 디코딩 훅.
 *
 * 큰 프리뷰의 GifFramePlayer 가 사용 — 진입 시점에 모든 프레임을 한 번에
 * 사전 디코드해 `VideoFrame[]` 으로 보유하고, 컴포넌트가 매 프레임을
 * `ctx.drawImage(frames[i], …)` 로 캔버스에 찍어 영상과 동일한 컨트롤 바
 * (재생/일시정지·프레임 단위 이동·배속·루프) 를 제공할 수 있게 한다.
 *
 * 전략:
 *   1) `globalThis.ImageDecoder` 가 없으면 즉시 `unsupported` 반환
 *      → 부모는 `<img>` 자동재생으로 자연 폴백.
 *   2) AbortController 로 fetch + 디코드를 묶고, src/언마운트 시 모든
 *      `VideoFrame.close()` 호출 + 진행 중 디코드 abort 로 메모리 누수 방지.
 *   3) `VideoFrame.duration` 은 마이크로초 단위 → /1000 으로 ms 변환.
 *      duration 이 0/null 인 프레임은 fallback 100ms (Safari 일부 GIF 케이스).
 *   4) `frameCount === 1` 인 정적 GIF/WebP 도 단일 프레임 배열로 반환 →
 *      컴포넌트가 컨트롤 바를 숨기고 정적 캔버스만 보여줄 수 있게 한다.
 *
 * 호환:
 *   - 동일 ImageDecoder API 가 src/lib/referenceLibrary.ts 의
 *     pickBestPosterFrame() 에서도 사용 중. 거기서 검증된 호환성을 그대로
 *     활용한다.
 */

import { useEffect, useState } from "react";

/** ImageDecoder global 타입. globalThis 에 직접 선언하지 않은 환경(예:
 *  Safari 16, Firefox 일부) 대비로 `unknown` 캐스팅 후 좁히는 방식. */
type ImageDecoderInstance = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
  decode: (opts: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
  close?: () => void;
};

type ImageDecoderCtorType = new (init: { data: ArrayBuffer; type: string }) => ImageDecoderInstance;

function getImageDecoderCtor(): ImageDecoderCtorType | null {
  const ctor = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtorType }).ImageDecoder;
  return typeof ctor === "function" ? ctor : null;
}

/** AI 분류용 안전 캡 — 매우 긴 GIF/animated WebP 가 들어올 경우 메모리 폭주를
 *  방지한다. 일반 스티커/시네마그래프는 보통 30~100 프레임, 250 이하가 99% 케이스.
 *  초과분은 truncated=true 로 호출자에 알리고, *처음부터 250 프레임까지만* 디코드
 *  → 그 안에서 균등 샘플링한다. */
const MAX_DECODE_FRAMES = 250;
const FRAME_DURATION_FALLBACK_MS = 100;

export interface DecodedAnimatedFrames {
  frames: VideoFrame[];
  /** 프레임별 표시 시간(ms). frames 와 길이가 같다. */
  durationsMs: number[];
  widthPx: number;
  heightPx: number;
  /** 전체 표시 시간 합(ms) — 디코드된 프레임 기준. */
  totalDurationMs: number;
  /** 원본 frameCount (truncated 이전 값). frames.length 와 다를 수 있다. */
  totalFrameCount: number;
  /** 안전 캡(MAX_DECODE_FRAMES) 에 걸려 일부만 디코드했는지 여부. */
  truncated: boolean;
}

/**
 * Promise 기반 GIF/애니메이션 WebP/APNG 전체 프레임 디코더.
 *
 * useGifFrames 훅이 같은 ImageDecoder 경로를 React state 로 노출한다면, 이
 * 함수는 비-React 코드(AI 분류 파이프라인) 에서 같은 디코더를 단발 Promise 로
 * 쓸 수 있게 해 준다. 두 경로가 같은 ArrayBuffer + ImageDecoder 흐름을 공유
 * 하므로 호환성 회귀 위험이 적다.
 *
 * 실패 케이스(미지원 환경, fetch/디코드 실패) 는 throw 한다. 호출자는 정적
 * 이미지 한 장으로 분석하는 폴백을 가질 책임을 갖는다 — 이 함수가 직접 폴백
 * 하지 않는 이유는 폴백 정책이 도메인(인스펙터 / 큐 / 미리보기) 마다 다르기
 * 때문.
 */
export async function decodeAnimatedAllFrames(
  src: string,
  mimeType: string | null | undefined,
  opts: {
    signal?: AbortSignal;
    /** 디코드된 프레임 개수가 늘어날 때마다 호출. UI 진행 표시용. */
    onFrameDecoded?: (done: number, totalEstimate: number) => void;
  } = {},
): Promise<DecodedAnimatedFrames> {
  const { signal, onFrameDecoded } = opts;
  const ImageDecoderCtor = getImageDecoderCtor();
  if (!ImageDecoderCtor) {
    throw new Error("ImageDecoder is not supported in this environment");
  }

  const res = await fetch(src, { signal });
  if (!res.ok) throw new Error(`Failed to fetch ${src} (${res.status})`);
  const buffer = await res.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const type = mimeType && mimeType.startsWith("image/") ? mimeType : "image/gif";
  const decoder = new ImageDecoderCtor({ data: buffer, type });
  await decoder.tracks.ready;

  const totalFrameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
  const decodeCount = Math.min(MAX_DECODE_FRAMES, totalFrameCount);
  const truncated = decodeCount < totalFrameCount;
  const decoded: VideoFrame[] = [];
  const durations: number[] = [];
  let firstSize: { w: number; h: number } | null = null;

  try {
    for (let i = 0; i < decodeCount; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { image } = await decoder.decode({ frameIndex: i });
      decoded.push(image);
      const dur = image.duration && image.duration > 0
        ? Math.max(1, Math.round(image.duration / 1000))
        : FRAME_DURATION_FALLBACK_MS;
      durations.push(dur);
      if (!firstSize) firstSize = { w: image.displayWidth, h: image.displayHeight };
      onFrameDecoded?.(i + 1, decodeCount);
    }
  } catch (err) {
    /* 부분 디코드 실패 — 이미 만든 VideoFrame 은 호출자가 받기 전이므로
       여기서 모두 close 한 뒤 다시 throw 한다. */
    for (const f of decoded) {
      try { f.close(); } catch { /* noop */ }
    }
    try { decoder.close?.(); } catch { /* noop */ }
    throw err;
  }

  try { decoder.close?.(); } catch { /* noop */ }

  const totalDurationMs = durations.reduce((s, d) => s + d, 0);
  return {
    frames: decoded,
    durationsMs: durations,
    widthPx: firstSize?.w ?? 0,
    heightPx: firstSize?.h ?? 0,
    totalDurationMs,
    totalFrameCount,
    truncated,
  };
}

export type GifFramesStatus = "loading" | "ready" | "error" | "unsupported";

export interface UseGifFramesResult {
  status: GifFramesStatus;
  /** 사전 디코드된 프레임. status="ready" 일 때만 채워짐. 컴포넌트는 이 배열
   *  의 *수명* 을 별도로 관리하지 않아도 된다 — 훅이 src 변경/언마운트 시점에
   *  모든 frame.close() 를 자동 호출. */
  frames: VideoFrame[];
  /** 프레임별 표시 시간(ms). frames 와 길이가 같다. */
  durationsMs: number[];
  /** 첫 프레임의 자연 해상도. 캔버스 크기/aspect-ratio 계산에 사용. */
  naturalSize: { w: number; h: number } | null;
  /** status="error" 일 때만 의미 있음. 사용자 노출 X (조용한 폴백 용). */
  error?: string;
}

const FALLBACK_FRAME_DURATION_MS = 100;

export function useGifFrames(src: string | null | undefined, mimeType: string | null | undefined): UseGifFramesResult {
  const [state, setState] = useState<UseGifFramesResult>({
    status: "loading",
    frames: [],
    durationsMs: [],
    naturalSize: null,
  });

  useEffect(() => {
    if (!src) {
      setState({ status: "loading", frames: [], durationsMs: [], naturalSize: null });
      return;
    }

    const ImageDecoderCtor = getImageDecoderCtor();
    if (!ImageDecoderCtor) {
      setState({ status: "unsupported", frames: [], durationsMs: [], naturalSize: null });
      return;
    }

    setState({ status: "loading", frames: [], durationsMs: [], naturalSize: null });

    const abort = new AbortController();
    /* 디코드된 프레임은 cleanup 까지의 race 동안에도 안전하게 닫혀야 하므로
       클로저 변수 + decoder ref 를 함께 보존해 cleanup 에서 일괄 close 한다.
       state 로만 보면 setState 가 batch 되는 동안 effect cleanup 이 먼저
       실행돼 frames 가 누수될 수 있다. */
    const decodedFrames: VideoFrame[] = [];
    let decoderRef: ImageDecoderInstance | null = null;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(src, { signal: abort.signal });
        if (!res.ok) throw new Error(`Failed to fetch ${src} (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        // 일부 서버가 image/* 가 아닌 application/octet-stream 으로 내려보내는
        // 케이스가 있어, mimeType 이 비어있으면 image/gif 를 fallback 으로 사용.
        // ImageDecoder 는 type 이 정확해야 디코드를 수락하므로 호출 측에서 늘
        // item.mime_type 을 넘겨주는 게 정석.
        const type = mimeType && mimeType.startsWith("image/") ? mimeType : "image/gif";

        let decoder: ImageDecoderInstance;
        try {
          decoder = new ImageDecoderCtor({ data: buffer, type });
          decoderRef = decoder;
          await decoder.tracks.ready;
        } catch (err) {
          if (cancelled) return;
          // 디코더 자체를 못 만든 경우(미지원 포맷 등)는 unsupported 로 폴백.
          setState({
            status: "unsupported",
            frames: [],
            durationsMs: [],
            naturalSize: null,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
        const durations: number[] = [];
        let firstSize: { w: number; h: number } | null = null;

        for (let i = 0; i < frameCount; i++) {
          if (cancelled) return;
          try {
            const { image } = await decoder.decode({ frameIndex: i });
            decodedFrames.push(image);
            // VideoFrame.duration 은 microsecond. 0/null 이면 fallback 100ms.
            const dur = image.duration && image.duration > 0
              ? Math.max(1, Math.round(image.duration / 1000))
              : FALLBACK_FRAME_DURATION_MS;
            durations.push(dur);
            if (!firstSize) firstSize = { w: image.displayWidth, h: image.displayHeight };
          } catch (err) {
            // 한 프레임 디코드 실패: error 상태로 폴백 — 부모가 <img> 로 자연
            // 폴백한다. 이미 디코드된 프레임은 cleanup 에서 닫힘.
            if (cancelled) return;
            setState({
              status: "error",
              frames: [],
              durationsMs: [],
              naturalSize: null,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }

        if (cancelled) return;
        setState({
          status: "ready",
          frames: decodedFrames,
          durationsMs: durations,
          naturalSize: firstSize,
        });
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setState({
          status: "error",
          frames: [],
          durationsMs: [],
          naturalSize: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      // 디코드된 프레임 일괄 close. ImageDecoder 자체도 close 해 내부
      // ArrayBuffer 메모리를 GC 가 회수할 수 있게 한다.
      for (const frame of decodedFrames) {
        try { frame.close(); } catch { /* noop */ }
      }
      try { decoderRef?.close?.(); } catch { /* noop */ }
    };
  }, [src, mimeType]);

  return state;
}
