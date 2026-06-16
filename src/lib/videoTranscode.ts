// 300MB 초과 영상을 네이티브 ffmpeg(메인 프로세스) 로 목표 용량 이하 mp4 로
// 재인코딩하는 렌더러 측 클라이언트.
//
// 데이터 흐름:
//   1) getPathForFile 로 원본 디스크 경로 확보(드래그&드랍/파일 선택만 가능 —
//      폴더 임포트로 재구성된 File 은 경로가 없어 변환 불가).
//   2) IPC transcodeVideo → ffmpeg 가 references/.scratch/<id>.mp4 로 출력.
//   3) scratch 를 /storage/file/ 로 fetch → File(.mp4) 로 만들어 반환.
//   4) scratch 는 정리(storage.remove).
// 진행률은 onTranscodeProgress 스트림으로, 취소는 AbortSignal → cancelTranscode.

import { LOCAL_SERVER_BASE_URL } from "@shared/constants";
import { supabase } from "./supabase";

export interface ProbedVideoMeta {
  durationSec: number;
  sizeBytes: number;
  width: number;
  height: number;
}

/** <video> 메타데이터만 로드(전체 디코드 없음) 해 길이/해상도를 읽는다. */
export async function probeVideoMeta(file: File): Promise<ProbedVideoMeta> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<ProbedVideoMeta>((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      const done = (fn: () => void) => {
        video.removeAttribute("src");
        try {
          video.load();
        } catch {
          /* noop */
        }
        fn();
      };
      video.onloadedmetadata = () =>
        done(() =>
          resolve({
            durationSec: Number.isFinite(video.duration) ? video.duration : 0,
            sizeBytes: file.size,
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
          }),
        );
      video.onerror = () => done(() => reject(new Error("영상 메타데이터를 읽을 수 없습니다.")));
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class TranscodeCancelledError extends Error {
  constructor() {
    super("Video transcode cancelled");
    this.name = "TranscodeCancelledError";
  }
}

let transcodeSeq = 0;

export interface TranscodeVideoOptions {
  file: File;
  /** 목표 용량(bytes). 보통 VIDEO_CONVERT_TARGET_BYTES(290MB). */
  targetBytes: number;
  /** 이미 메타를 probe 했다면 재측정을 피하기 위해 전달. */
  durationSec?: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * 원본 영상 File 을 목표 용량 이하로 변환한 새 File(.mp4) 로 반환한다.
 * 경로를 얻을 수 없거나(폴더 임포트 등) 변환이 실패/취소되면 throw.
 */
export async function transcodeVideoFile(opts: TranscodeVideoOptions): Promise<File> {
  const { file, targetBytes, onProgress, signal } = opts;
  const bridge = window.preflowWindow;
  if (!bridge?.transcodeVideo || !bridge.getPathForFile) {
    throw new Error("이 환경에서는 영상 변환을 사용할 수 없습니다.");
  }
  const inputPath = bridge.getPathForFile(file);
  if (!inputPath) {
    throw new Error(
      "원본 파일 경로를 얻을 수 없어 변환할 수 없습니다. 파일을 직접 드래그하거나 파일 선택으로 추가해 주세요.",
    );
  }
  // 길이는 0/Infinity 여도 그대로 넘긴다 — 일부 mp4 는 <video>.duration 이
  // 신뢰 불가라, 메인 프로세스(ffmpeg)가 실제 길이를 다시 측정해 결정한다.
  const durationSec = opts.durationSec ?? (await probeVideoMeta(file)).durationSec ?? 0;

  const id = `tx_${Date.now()}_${transcodeSeq++}`;
  const unsub = bridge.onTranscodeProgress?.((p) => {
    if (p.id === id) onProgress?.(p.ratio);
  });
  const onAbort = () => bridge.cancelTranscode?.(id);

  if (signal?.aborted) {
    unsub?.();
    throw new TranscodeCancelledError();
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await bridge.transcodeVideo({ id, inputPath, durationSec, targetBytes });
    if (signal?.aborted) throw new TranscodeCancelledError();
    if (result.ok !== true) {
      throw new Error(result.reason);
    }
    const scratchRelPath = result.scratchRelPath;

    const scratchUrl = `${LOCAL_SERVER_BASE_URL}/storage/file/references/${scratchRelPath}`;
    const res = await fetch(scratchUrl);
    if (!res.ok) throw new Error(`변환 결과를 읽지 못했습니다 (HTTP ${res.status}).`);
    const blob = await res.blob();
    const baseName = file.name.replace(/\.[^.]+$/, "") || "video";
    const converted = new File([blob], `${baseName}.mp4`, { type: "video/mp4" });

    // scratch 정리 — best-effort.
    void supabase.storage
      .from("references")
      .remove([scratchRelPath])
      .catch(() => undefined);

    return converted;
  } finally {
    unsub?.();
    signal?.removeEventListener("abort", onAbort);
  }
}
