// Renderer(브라우저) 와 Electron main 양쪽에서 공유하는 상수.
// 변경 시 한 곳만 고치면 양 빌드에 모두 반영됨.

/** 선호 포트 — main 이 이 포트로 bind 시도.
 *  실제 런타임 포트는 이 상수가 아니라 `LOCAL_SERVER_BASE_URL` 을 써야 한다
 *  (main 이 포트 충돌 시 다른 포트로 fallback 될 수 있음). */
export const LOCAL_SERVER_PORT = 19876;

/** 렌더러에서 local-server 와 통신할 때 쓰는 베이스 URL.
 *
 *  main 프로세스가 BrowserWindow 로드 시 URL query 에 `?preflowPort=XXX` 를
 *  주입하므로, 렌더러에서는 이 쿼리를 읽어 실제 포트를 알아낸다. 포트가
 *  지정돼 있지 않거나 (예: 브라우저 단독 테스트), main 에서 import 된 경우
 *  default 값(LOCAL_SERVER_PORT) 을 사용한다. */
function computeBaseUrl(): string {
  // tsconfig.node 에서도 컴파일되도록 globalThis 로 안전하게 접근.
  const g = globalThis as { location?: { search?: string } };
  if (g.location && typeof g.location.search === "string") {
    try {
      const params = new URLSearchParams(g.location.search);
      const p = params.get("preflowPort");
      if (p && /^\d+$/.test(p)) {
        return `http://127.0.0.1:${p}`;
      }
    } catch {
      /* fall through to default */
    }
  }
  return `http://127.0.0.1:${LOCAL_SERVER_PORT}`;
}

export const LOCAL_SERVER_BASE_URL = computeBaseUrl();

function computeAuthToken(): string {
  const g = globalThis as { location?: { search?: string } };
  if (g.location && typeof g.location.search === "string") {
    try {
      const params = new URLSearchParams(g.location.search);
      return params.get("preflowToken") ?? "";
    } catch {
      /* fall through */
    }
  }
  return "";
}

export const LOCAL_SERVER_AUTH_TOKEN = computeAuthToken();
export const LOCAL_SERVER_AUTH_HEADERS: Record<string, string> = LOCAL_SERVER_AUTH_TOKEN
  ? { "X-Preflow-Token": LOCAL_SERVER_AUTH_TOKEN }
  : {};

/** Reference Library 업로드의 절대 상한 (bytes).
 *  렌더러와 local-server 양쪽이 동일한 값을 써야 한쪽 우회로 200 MiB 를 넘는
 *  파일이 디스크에 들어가는 일을 막을 수 있다. UX 메시지("200MB 이하…") 도
 *  여기서 파생된다. */
export const REFERENCE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const REFERENCE_UPLOAD_MAX_LABEL = "200MB";
