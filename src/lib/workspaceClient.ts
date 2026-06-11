// 렌더러 → main 의 /workspace/* HTTP 라우트로 가는 thin client.
//
// 부팅 시 1 회 list 를 호출해 메모리 캐시(`cache`) 를 채우고, 활성 변경
// 같은 mutation 이 일어나면 `webContents.reload()` 로 페이지가 통째로
// 다시 마운트된다. 따라서 이 캐시는 한 페이지 lifecycle 동안만 살면 충분.
//
// 동기 helper(`getCachedWorkspaces`, `getCachedActive`) 는 stub 시기 부터
// 호출되던 `workspaceLabel.ts::getActiveWorkspaceName` 의 시그니처를
// 깨지 않도록 캐시 lookup 만 수행 — 캐시가 비어 있으면 default 라벨로
// 폴백 (첫 페인트 안전).

import {
  LOCAL_SERVER_AUTH_HEADERS,
  LOCAL_SERVER_BASE_URL,
} from "@shared/constants";
import type {
  ListWorkspacesResponse,
  WorkspaceCounts,
  WorkspaceKind,
  WorkspaceLastActive,
  WorkspaceLockInfo,
  WorkspaceMeta,
} from "@shared/workspace";

interface CacheShape {
  workspaces: WorkspaceMeta[];
  counts: WorkspaceCounts[];
  active: string | null;
  /** kind 별 "마지막에 활성이었던 워크스페이스 ID". WorkspaceSwitcher 의
   *  quick-switch 가 반대 kind 로 즉시 점프할 때 사용. 서버 응답이 안 주거나
   *  슬롯이 비면 빈 객체. */
  lastActive: WorkspaceLastActive;
  /** 활성 워크스페이스 폴더의 OneDrive 충돌 사본 파일명. 비어 있으면 정상. */
  conflictCopies: string[];
}

let cache: CacheShape = { workspaces: [], counts: [], active: null, lastActive: {}, conflictCopies: [] };
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener 가 throw 해도 다른 listener 진행은 보장 */
    }
  }
}

export function subscribeWorkspaces(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${path} failed: ${res.status} ${txt}`);
  }
  return res.json() as Promise<T>;
}

export async function refreshWorkspaces(): Promise<ListWorkspacesResponse> {
  const data = await postJson<ListWorkspacesResponse>("/workspace/list");
  cache = {
    workspaces: data.workspaces,
    counts: data.counts,
    active: data.active,
    lastActive: data.lastActive ?? {},
    conflictCopies: data.conflictCopies ?? [],
  };
  notify();
  return data;
}

export function getCachedWorkspaces(): WorkspaceMeta[] {
  return cache.workspaces;
}

export function getCachedCounts(): WorkspaceCounts[] {
  return cache.counts;
}

export function getCachedActiveId(): string | null {
  return cache.active;
}

export function getCachedActive(): WorkspaceMeta | null {
  if (!cache.active) return null;
  return cache.workspaces.find((w) => w.id === cache.active) ?? null;
}

/** 활성 워크스페이스 폴더에서 발견된 OneDrive 충돌 사본 파일명. 비어 있으면
 *  정상. WorkspaceSwitcher 가 부팅 후 한 번 경고 토스트를 띄우는 데 사용. */
export function getCachedConflictCopies(): string[] {
  return cache.conflictCopies;
}

export function getCachedCountsFor(id: string): WorkspaceCounts | null {
  return cache.counts.find((c) => c.id === id) ?? null;
}

/** kind 별 마지막 활성 워크스페이스. 슬롯이 비어 있거나 그 ID 의 워크스페이
 *  스가 캐시에 없으면 null — 호출자(WorkspaceSwitcher) 가 isDefault 폴백을
 *  적용한다. */
export function getCachedLastActiveByKind(kind: WorkspaceKind): WorkspaceMeta | null {
  const id = cache.lastActive[kind];
  if (!id) return null;
  return cache.workspaces.find((w) => w.id === id && w.kind === kind) ?? null;
}

// 부팅 시 한 번 호출 — 첫 페인트 직후 비동기로 채운다. 첫 페인트가 default
// 라벨로 그려져도 무방하지만, 빠르게 진짜 이름으로 swap 되어야 하므로
// 모듈 로드 즉시 fetch 시작.
let bootPromise: Promise<void> | null = null;
export function ensureWorkspacesLoaded(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      await refreshWorkspaces();
    } catch (err) {
      console.warn("[workspaceClient] initial list failed:", err);
    }
  })();
  return bootPromise;
}

export interface ActivateResult {
  ok: boolean;
  locked?: boolean;
  lock?: WorkspaceLockInfo;
  workspace?: WorkspaceMeta;
  /** 전환한 워크스페이스 폴더의 OneDrive 충돌 사본 파일명(있으면). */
  conflictCopies?: string[];
}

export async function activateWorkspace(
  id: string,
  force = false,
  nextUrl?: string,
): Promise<ActivateResult> {
  // 전환 전에 대기 중인 캔버스 레이아웃 변경을 *현재* 워크스페이스 DB 로 먼저
  // flush. 서버가 활성 DB 를 바꾼 뒤(reload 시점)에 flush 가 일어나면 옛
  // 워크스페이스의 변경이 새 DB 로 잘못 들어가거나 유실된다. 정적 import 시
  // 순환(canvasLayout → workspaceClient) 을 피하려 동적 import 로 best-effort
  // 호출한다. 캔버스를 한 번도 안 연 경우엔 hydrate 전이라 즉시 no-op.
  try {
    const mod = await import("./canvasLayout");
    await mod.flushCanvasLayoutsNow();
  } catch {
    /* best-effort — flush 실패가 전환을 막지 않는다 */
  }
  const result = await postJson<ActivateResult>("/workspace/activate", { id, force });
  if (result.ok && typeof window !== "undefined") {
    // 활성 전환 성공 — SQLite 가 닫혔다 새로 열렸으므로 React state / 모듈
    // 캐시는 모두 stale. 페이지를 통째로 다시 마운트한다.
    //
    // 모든 nextUrl 을 *HashRouter 경로* 로 정규화 후 hash + reload.
    //
    //   "/#/library?..."  → hash: "/library?..."
    //   "#/library?..."   → hash: "/library?..."
    //   "/library?..."    → hash: "/library?..."     (path-style → hash 로 박음)
    //   "/dashboard"      → hash: "/dashboard"
    //   "library?..."     → hash: "/library?..."     (leading "/" 보정)
    //
    // 왜 path-style 도 hash 로:
    //   prod 빌드 (file://) 에서 `location.href = "/library?..."` 은 *file
    //   시스템 루트* (file:///library?...) 로 navigate → 그 파일이 없어서
    //   ERR_FILE_NOT_FOUND → 흰/검은 화면. vite base="./" 는 *빌드 시 asset
    //   path 상대화* 일 뿐, 런타임에 절대 path 를 index.html 로 redirect 하지
    //   않는다. pathname 을 절대 건드리지 않아야 SPA 가 살아 있다.
    //
    // reload() 가 필요한 이유:
    //   hash 만 변경하면 React 가 라우트만 갱신 — DB 는 main 에서 이미 swap
    //   됐으니 옛 페이지의 React state 가 stale DB pointer 로 살아 남음. 명시
    //   적 reload 로 모듈을 다 새로 mount 시켜야 안전.
    if (nextUrl) {
      let hashPart: string;
      if (nextUrl.startsWith("/#")) hashPart = nextUrl.slice(2);
      else if (nextUrl.startsWith("#")) hashPart = nextUrl.slice(1);
      else hashPart = nextUrl;
      if (!hashPart.startsWith("/")) hashPart = "/" + hashPart;
      window.location.hash = hashPart;
      window.location.reload();
    } else {
      window.location.reload();
    }
  }
  return result;
}

export interface CreateWorkspaceResponse {
  canceled: boolean;
  workspace: WorkspaceMeta | null;
}

export async function createWorkspace(args: {
  kind: WorkspaceKind;
  name: string;
  path?: string;
}): Promise<CreateWorkspaceResponse> {
  const result = await postJson<CreateWorkspaceResponse>("/workspace/create", args);
  if (!result.canceled) await refreshWorkspaces();
  return result;
}

export async function loadExistingWorkspace(args: {
  path?: string;
  hint?: { kind?: WorkspaceKind; name?: string };
}): Promise<CreateWorkspaceResponse> {
  const result = await postJson<CreateWorkspaceResponse>("/workspace/load", args);
  if (!result.canceled) await refreshWorkspaces();
  return result;
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceMeta> {
  const data = await postJson<{ workspace: WorkspaceMeta }>("/workspace/rename", { id, name });
  await refreshWorkspaces();
  return data.workspace;
}

export async function disconnectWorkspace(id: string): Promise<void> {
  await postJson("/workspace/disconnect", { id });
  await refreshWorkspaces();
}

export async function deleteWorkspace(id: string): Promise<{ folderRemoved: boolean; error?: string }> {
  const data = await postJson<{ ok: boolean; folderRemoved: boolean; error?: string }>(
    "/workspace/delete",
    { id },
  );
  await refreshWorkspaces();
  return { folderRemoved: data.folderRemoved, error: data.error };
}

/** OS 파일 탐색기에서 워크스페이스 폴더를 선택 상태로 연다.
 *  registry 변경이 없으므로 후속 refresh 불필요. */
export async function showWorkspaceInExplorer(id: string): Promise<void> {
  await postJson("/workspace/show-in-explorer", { id });
}
