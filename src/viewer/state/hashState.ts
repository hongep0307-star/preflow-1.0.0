/* URL hash <-> 뷰어 상태 동기화.
 *
 * file:// 더블클릭 환경에서도 동작해야 하므로 history API 를 쓰지 않고
 * location.hash 만 읽고 쓴다(일부 file:// 컨텍스트에서 history.replaceState
 * 가 SecurityError 를 던지는 사고 회피).
 *
 * 포맷: #item=<id>&folder=<path>&q=<검색어>
 *   - 값은 URLSearchParams 로 인코딩/디코딩 (한글 폴더명/검색어 안전). */

export interface HashState {
  itemId: string;
  folder: string;
  query: string;
}

export function readHashState(): Partial<HashState> {
  if (typeof window === "undefined" || typeof location === "undefined") return {};
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const out: Partial<HashState> = {};
  const item = params.get("item");
  const folder = params.get("folder");
  const query = params.get("q");
  if (item) out.itemId = item;
  if (folder) out.folder = folder;
  if (query) out.query = query;
  return out;
}

export function writeHashState(s: {
  itemId?: string | null;
  folder?: string | null;
  query?: string;
}): void {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  const params = new URLSearchParams();
  if (s.itemId) params.set("item", s.itemId);
  if (s.folder) params.set("folder", s.folder);
  if (s.query && s.query.trim()) params.set("q", s.query.trim());
  const next = params.toString();
  /* 동일 값이면 no-op — location.hash 재할당이 history 항목을 쌓아 뒤로가기
   *  스팸이 되는 것을 막는다. */
  const current = location.hash.replace(/^#/, "");
  if (current === next) return;
  try {
    location.hash = next;
  } catch {
    /* 극히 일부 환경의 보안 정책 — 무시(딥링크는 best-effort). */
  }
}
