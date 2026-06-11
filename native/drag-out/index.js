"use strict";

// v2 (2026-06-05) — Phase 0: 메인 UI thread 동기 DoDragDrop. v1 의 libuv
//     worker-thread 데드락을 회피. 설계는 DRAG-AND-DROP-RESEARCH.md §B-v2 참조.
//
// 이 모듈은 Windows + macOS 지원. Windows 는 OLE DoDragDrop(addon.cc), macOS 는
// NSDraggingSession(addon_mac.mm). 그 외 OS(Linux 등) 에서는 null 을 돌려
// 호출부가 안전하게 `webContents.startDrag` 폴백으로 빠질 수 있게 한다.
//
// 빌드 산출물은 `build/Release/preflow_drag_out.node`. node-gyp 가 만든다.
// Electron ABI 에 맞춰 다시 빌드해야 하므로 `scripts/build-native.mjs` 가
// `npm_config_target` 등 환경변수를 채워서 node-gyp 를 돌린다.
//
// API (Windows):
//   const drag = require("preflow-drag-out");
//   const res = drag.startDrag(filePaths: string[], allowedEffects?: number);
//   // res = { ok: boolean, effect: number, hr: number, elapsedMs: number, threadId: number }
//
//   - filePaths: 절대 경로 배열. 호출자(메인 프로세스) 가 미리 sandbox 검증을
//     마친 storage 안의 파일이거나 임시 `.url` 바로가기.
//   - allowedEffects: 옵셔널 DROPEFFECT 비트마스크 (기본 COPY | LINK).
//   - 반환(동기): drag 가 *끝난 뒤* (drop/cancel) 결과 객체. 이 호출은 drag
//     동안 메인 스레드를 블록하므로, 호출자는 호출 전에 sendSync 응답
//     (event.returnValue) 을 먼저 보내 렌더러 dragstart 를 unblock 해야 한다.
//
// 핵심 설계:
//   - 자체 IDataObject 가 CF_HDROP 만 published. CF_BITMAP / image/* 안 박음
//     → Chromium 의 image-mode trigger 가 *원리적으로* 켜질 수 없음.
//   - IDropSource::GiveFeedback 이 DRAGDROP_S_USEDEFAULTCURSORS 반환 →
//     OS 기본 copy/link cursor. webview 의 깨진 not-allowed 가 안 보임.

if (process.platform !== "win32" && process.platform !== "darwin") {
  module.exports = null;
} else {
  let addon = null;
  try {
    // 빌드된 .node 파일을 직접 로드. `nodejs ./build/Release/*.node` 가 표준.
    // 부재 시(빌드 안 됨) require 가 throw → 호출부가 try/catch 로 받아 폴백.
    addon = require("./build/Release/preflow_drag_out.node");
  } catch (err) {
    // 어떤 환경에서든 메인 프로세스가 죽지는 않도록 silent null.
    // 메인은 `if (!nativeDrag)` 분기로 폴백.
    addon = null;
    if (process.env.PREFLOW_NATIVE_DRAG_DEBUG) {
      console.warn("[preflow-drag-out] failed to load native binding:", err);
    }
  }
  module.exports = addon;
}
