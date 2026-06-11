// Electron main-process 용 상수 & 런타임 값.
//
// `LOCAL_SERVER_PORT` 는 "선호 포트" (default 19876). 실제로 bind 된 포트는
// startLocalServer() 가 호출된 뒤 `getLocalServerPort()` / `getLocalServerBaseUrl()`
// 로 조회한다. 포트 충돌 시 OS 가 할당한 랜덤 포트로 fallback 될 수 있으므로,
// 반드시 getter 를 사용해야 올바른 URL 을 얻을 수 있다.

import { randomBytes } from "crypto";
import { LOCAL_SERVER_PORT, LOCAL_SERVER_BASE_URL } from "../shared/constants";

let actualPort: number = LOCAL_SERVER_PORT;
let actualBaseUrl: string = LOCAL_SERVER_BASE_URL;
const localServerAuthToken = randomBytes(32).toString("hex");

/** local-server 가 실제로 bind 한 포트를 기록한다.
 *  startLocalServer() 내부에서만 호출해야 한다. */
export function setLocalServerPort(port: number): void {
  actualPort = port;
  actualBaseUrl = `http://127.0.0.1:${port}`;
}

export function getLocalServerPort(): number {
  return actualPort;
}

export function getLocalServerBaseUrl(): string {
  return actualBaseUrl;
}

export function getLocalServerAuthToken(): string {
  return localServerAuthToken;
}

// Back-compat — 선호 포트 상수 자체는 그대로 노출.
export { LOCAL_SERVER_PORT, LOCAL_SERVER_BASE_URL };

/**
 * 일반 Chrome 으로 위장한 User-Agent.
 *
 * Electron 의 기본 UA 는 `... Chrome/<v> Electron/<v> Safari/...` 형태여서
 * YouTube 임베드 서버(`www.youtube.com/embed`, `i.ytimg.com`) 가 "Electron"
 * 토큰을 보고 503 을 돌려준다. 같은 이유로 oEmbed / og-image / 페이지 캡처
 * 같은 main 프로세스의 outbound 요청도 일부 사이트에서 거부된다.
 *
 * 이 상수를 메인 BrowserWindow `webContents.setUserAgent` 와
 * `link-preview-handler` 양쪽이 공유해 한 곳에서만 관리한다. Chrome 메이저
 * 버전을 올릴 일이 생기면 여기 한 줄만 갱신하면 된다.
 */
export const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
