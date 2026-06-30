/**
 * 팩 파일(.preflowlib / .preflowproj) 더블클릭 → 활성 워크스페이스 임포트 흐름의
 * 렌더러측 단일 출처.
 *
 * 동작(A-2):
 *   1. main 이 OS 로부터 받은 팩 경로를 렌더러로 전달(App 의 PackOpenRouter 가
 *      pull/push 로 수신) → 여기 `setPendingPackPath` 로 보관.
 *   2. 팩 종류(확장자)와 활성 워크스페이스 종류가 다르면 PackOpenRouter 가 그
 *      종류의 최근 워크스페이스로 전환(reload). pending 은 localStorage 에 있어
 *      reload 너머로 유지된다.
 *   3. 종류가 맞는 페이지(Library/Dashboard)가 mount 되면 pending 을 소비해
 *      기존 임포트 다이얼로그(미리보기→확인→import)를 연다.
 *
 * reload 를 건너서 살아남아야 하므로 localStorage 에 저장하고, 같은 세션 내
 * 변경은 pub/sub 로 즉시 통지한다.
 */

import type { WorkspaceKind } from "@shared/workspace";

const PENDING_KEY = "preflow.pendingPackImport";

/** 확장자로 팩 종류 판별. 팩이 아니면 null. */
export function packKindFromPath(path: string | null | undefined): WorkspaceKind | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".preflowlib")) return "library";
  if (lower.endsWith(".preflowproj")) return "project";
  return null;
}

export function readPendingPackPath(): string | null {
  try {
    return window.localStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

export function clearPendingPackPath(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* 구독자 예외가 다른 구독자에 영향 주지 않게 */
    }
  }
}

/** pending 팩 경로 설정 + 구독자 통지. 팩이 아닌 경로는 무시. */
export function setPendingPackPath(path: string | null): void {
  if (!packKindFromPath(path)) return;
  try {
    window.localStorage.setItem(PENDING_KEY, path as string);
  } catch {
    /* ignore */
  }
  notify();
}

/** pending 변경(설정/해제) 구독. 반환값은 unsubscribe. */
export function subscribePendingPack(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
