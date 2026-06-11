/// <reference lib="webworker" />

// 비디오 loop 구간을 GIF 로 인코딩하는 Web Worker. 메인 스레드가 <video> +
// canvas 로 프레임을 RGBA 로 뽑아 transferable buffer 로 보낸다. worker 는
// **모든 프레임을 모아** 한 번에 글로벌 팔레트를 만들고, Floyd-Steinberg
// 디더링으로 각 프레임을 인덱스화한 뒤 gifenc 의 writeFrame 으로 누적한다.
//
// 글로벌 팔레트의 효과:
//   - 프레임 간 색 일관성 → 플리커 제거
//   - 256 색을 전체 영상에 최적 분배 → 같은 색상수로도 더 자연스러움
//   - GCT 한 번 + LCT 없음 → 파일 크기 추가 절감
//
// Floyd-Steinberg 디더링은 본래 hot path 가 픽셀당 256 비교라 매우 느린데,
// rgb444 키(12bit, 4096 슬롯) 의 양자화 cache 로 hit ratio 를 끌어올려
// 480p × 36 프레임이 ~1.5s 이내에 끝나도록 했다.
//
// 메시지 프로토콜:
//   main -> worker
//     { type: "init", width, height, fps, colors }
//     { type: "frame", buffer: ArrayBuffer, index }    // RGBA
//     { type: "finish" }                                // 글로벌 palette + dither + write all
//     { type: "cancel" }
//   worker -> main
//     { type: "ready" }                                 // init OK
//     { type: "extractAck", index, totalCollected }     // frame 수집 ACK (메인 progress 산출용)
//     { type: "frameDone", index, totalEncoded }        // 인코딩 1프레임 완료
//     { type: "done", bytes: Uint8Array }
//     { type: "error", message }

import { GIFEncoder, quantize, nearestColorIndex } from "gifenc";

type InitMessage = {
  type: "init";
  width: number;
  height: number;
  fps: number;
  colors: number;
};
type FrameMessage = {
  type: "frame";
  buffer: ArrayBuffer;
  index: number;
};
type FinishMessage = { type: "finish" };
type CancelMessage = { type: "cancel" };
type InboundMessage =
  | InitMessage
  | FrameMessage
  | FinishMessage
  | CancelMessage;

interface EncoderState {
  width: number;
  height: number;
  delayMs: number;
  colors: number;
  /* 메모리 부담 — 480x270 RGBA × 36 프레임 = ~18MB, 720x405 × 100 프레임 =
     ~113MB. SaveLoopAsGifDialog 가 무거운 조합엔 경고를 띄우므로 여기서는
     단순 누적. 사용자가 정말 크게 잡았으면 OOM 으로 worker 가 죽고 main 의
     error 핸들러가 잡는다. */
  frames: Uint8ClampedArray[];
  cancelled: boolean;
}

let state: EncoderState | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: unknown, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    ctx.postMessage(message, transfer);
  } else {
    ctx.postMessage(message);
  }
}

function handleInit(msg: InitMessage) {
  if (state) {
    state.cancelled = true;
    state = null;
  }
  state = {
    width: Math.max(2, Math.floor(msg.width)),
    height: Math.max(2, Math.floor(msg.height)),
    delayMs: Math.max(20, Math.round(1000 / Math.max(1, msg.fps))),
    colors: Math.max(2, Math.min(256, Math.floor(msg.colors))),
    frames: [],
    cancelled: false,
  };
  post({ type: "ready" });
}

function handleFrame(msg: FrameMessage) {
  if (!state || state.cancelled) return;
  /* RGBA buffer 를 그대로 보관 (transferable 로 받았으니 메모리 복사 없음).
     디더링은 finish 단계에서 한 번에 진행 — 글로벌 팔레트가 필요하기 때문. */
  state.frames.push(new Uint8ClampedArray(msg.buffer));
  post({
    type: "extractAck",
    index: msg.index,
    totalCollected: state.frames.length,
  });
}

/* Floyd-Steinberg 디더링 — 입력 RGBA(write-through 가능) 를 받아 인덱스
 *  배열(Uint8Array) 을 반환. cache 는 픽셀 RGB 를 rgb444 키(4096) 로 양자화
 *  한 lookup. 디더 오차로 미세 분산된 픽셀도 같은 bucket 에 떨어져 cache hit
 *  비율이 매우 높다 (보통 99%+ on photographic frames).
 *
 *  버퍼는 in-place 로 수정 (이미 transfer 받은 메모리라 안전). 입력은 다음
 *  프레임에 재사용하지 않으므로 부작용 없음. */
function ditherFrame(
  rgba: Uint8ClampedArray,
  palette: number[][],
  width: number,
  height: number,
  cache: Int16Array,
): Uint8Array {
  const indexed = new Uint8Array(width * height);
  /* 디더 오차 누적을 위해 픽셀을 Int16 로 본다. 한 프레임 안에서만
     사용하니 새 Int16Array 를 만든다. */
  const buf = new Int16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) buf[i] = rgba[i];

  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const stride = width * 4;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * 4;
      const r = clamp(buf[i]);
      const g = clamp(buf[i + 1]);
      const b = clamp(buf[i + 2]);

      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let idx = cache[key];
      if (idx < 0) {
        idx = nearestColorIndex(palette, [r, g, b]);
        cache[key] = idx;
      }
      indexed[y * width + x] = idx;

      const pal = palette[idx];
      const errR = r - pal[0];
      const errG = g - pal[1];
      const errB = b - pal[2];

      /* Floyd-Steinberg: 7/16 → right, 3/16 → bottom-left,
                          5/16 → bottom, 1/16 → bottom-right */
      if (x + 1 < width) {
        const j = i + 4;
        buf[j] += (errR * 7) >> 4;
        buf[j + 1] += (errG * 7) >> 4;
        buf[j + 2] += (errB * 7) >> 4;
      }
      if (y + 1 < height) {
        if (x > 0) {
          const j = i + stride - 4;
          buf[j] += (errR * 3) >> 4;
          buf[j + 1] += (errG * 3) >> 4;
          buf[j + 2] += (errB * 3) >> 4;
        }
        {
          const j = i + stride;
          buf[j] += (errR * 5) >> 4;
          buf[j + 1] += (errG * 5) >> 4;
          buf[j + 2] += (errB * 5) >> 4;
        }
        if (x + 1 < width) {
          const j = i + stride + 4;
          buf[j] += (errR * 1) >> 4;
          buf[j + 1] += (errG * 1) >> 4;
          buf[j + 2] += (errB * 1) >> 4;
        }
      }
    }
  }

  return indexed;
}

function handleFinish() {
  if (!state) {
    post({ type: "error", message: "Encoder not initialized" });
    return;
  }
  if (state.cancelled) return;
  if (state.frames.length === 0) {
    post({ type: "error", message: "No frames received" });
    state = null;
    return;
  }
  try {
    /* 글로벌 팔레트를 위해 모든 프레임 RGBA 를 한 줄로 concat. 메모리는 잠시
       두 배가 되지만 quantize 가 끝나면 combined 는 GC 대상. */
    let totalLen = 0;
    for (const f of state.frames) totalLen += f.length;
    const combined = new Uint8ClampedArray(totalLen);
    {
      let off = 0;
      for (const f of state.frames) {
        combined.set(f, off);
        off += f.length;
      }
    }

    /* gifenc 의 quantize 는 PnnQuant 기반. 색 분포가 영상 전체 기준으로
       잡혀 프레임 간 일관성 ↑, 작은 채도 디테일도 보존 가능성 ↑. */
    const palette = quantize(combined, state.colors, {
      format: "rgb565",
      oneBitAlpha: false,
      clearAlpha: false,
    });

    const encoder = GIFEncoder();
    const ditherCache = new Int16Array(4096);

    for (let i = 0; i < state.frames.length; i++) {
      if (state.cancelled) return;
      /* 매 프레임마다 cache 를 리셋해야 새 프레임의 디더 오차 분산이
         이전 프레임 키 매핑을 답습하지 않는다. 사실 cache key 는 디더 후
         RGB 라서 프레임 간 공유해도 손해는 없지만, 안전하게 -1 초기화. */
      ditherCache.fill(-1);
      const indexed = ditherFrame(
        state.frames[i],
        palette,
        state.width,
        state.height,
        ditherCache,
      );
      encoder.writeFrame(indexed, state.width, state.height, {
        /* 첫 프레임에만 palette 전달 → GCT(Global Color Table) 가 작성되고,
           이후 프레임은 palette 미전달 → LCT 없이 GCT 재사용. */
        palette: i === 0 ? palette : undefined,
        delay: state.delayMs,
        repeat: 0,
      });
      post({
        type: "frameDone",
        index: i,
        totalEncoded: i + 1,
      });
    }

    encoder.finish();
    const bytes = encoder.bytes();
    post({ type: "done", bytes }, [bytes.buffer]);
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state = null;
  }
}

function handleCancel() {
  if (state) {
    state.cancelled = true;
    state = null;
  }
}

ctx.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const data = event.data;
  switch (data.type) {
    case "init":
      handleInit(data);
      break;
    case "frame":
      handleFrame(data);
      break;
    case "finish":
      handleFinish();
      break;
    case "cancel":
      handleCancel();
      break;
  }
});
