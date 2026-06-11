/**
 * 활성 워크스페이스의 표시 이름을 반환하는 helper.
 *
 * 동기 시그니처를 유지하기 위해 `workspaceClient` 의 메모리 캐시만 조회한다.
 * 캐시는 부팅 시 `ensureWorkspacesLoaded()` 가 호출되며 백그라운드로
 * 채워지므로, 첫 페인트가 default 라벨로 잠깐 그려진 뒤 React 컴포넌트가
 * 자연스럽게 리렌더(아래 `useActiveWorkspaceName` 훅) 되며 실제 이름으로
 * swap 된다.
 *
 * 호출 위치 정책:
 *   - 정적 라벨이 필요한 곳(레거시 코드) → `getActiveWorkspaceName(kind)`
 *   - React 컴포넌트 → `useActiveWorkspaceName(kind)` 가 권장 — 자동 갱신
 */
import { useEffect, useState } from "react";
import {
  getCachedActive,
  getCachedWorkspaces,
  subscribeWorkspaces,
} from "./workspaceClient";

export type WorkspaceKind = "project" | "library";

const DEFAULT_NAMES: Record<WorkspaceKind, string> = {
  project: "Default Projects",
  library: "Default Library",
};

/** 동기 — 캐시가 비어 있으면 default 라벨을 반환. */
export const getActiveWorkspaceName = (kind: WorkspaceKind): string => {
  const active = getCachedActive();
  if (active) {
    // 활성 워크스페이스의 kind 가 호출자의 kind 와 같으면 그 이름을, 다르면
    // 같은 path 를 공유하는 형제(default 의 짝, 또는 custom 워크스페이스에
    // 짝꿍이 있을 경우)를 찾아 본다.
    if (active.kind === kind) return active.name;
    const sibling = getCachedWorkspaces().find(
      (w) => w.kind === kind && w.path === active.path,
    );
    if (sibling) return sibling.name;
  }
  return DEFAULT_NAMES[kind];
};

/** React hook — 캐시가 갱신될 때마다 자동 리렌더. */
export function useActiveWorkspaceName(kind: WorkspaceKind): string {
  const [label, setLabel] = useState(() => getActiveWorkspaceName(kind));
  useEffect(() => {
    const tick = () => setLabel(getActiveWorkspaceName(kind));
    tick();
    return subscribeWorkspaces(tick);
  }, [kind]);
  return label;
}
