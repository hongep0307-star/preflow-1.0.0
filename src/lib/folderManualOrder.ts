/**
 * Library 사이드바의 폴더 형제(siblings) 수동 순서 저장소.
 *
 * 기존 `[src/lib/folderPreferences.ts]` 의 `FolderSortMode`(name/count/recent)
 * 대신 Eagle 스타일의 사용자 직접 정렬을 지원하기 위한 별도 storage.
 *
 * 데이터 구조:
 *   {
 *     [parentPath: string]: string[]  // 자식 폴더 *full path* 목록(순서)
 *   }
 *
 *   - parentPath = "" 는 최상위(root) 형제 그룹.
 *   - 자식은 segment 가 아니라 **전체 경로**로 저장. rename / delete 시 경로
 *     일치만 보면 되므로 cascade 가 단순해진다.
 *   - 한 자식이 여러 parentPath 에 동시에 들어가는 경우는 없다(폴더는 트리).
 *
 * 정책:
 *   - 한 번도 reorder 되지 않은 그룹은 빈 배열 → 사이드바는 알파벳순으로 보여줌.
 *   - reorder 된 그룹은 등록된 자식들이 그 순서대로, 새로 생긴(미등록) 자식은
 *     끝에 알파벳순으로 모인다. 이 정책은 manualOrder.ts(레퍼런스 정렬) 와
 *     의도적으로 같음 — 사용자 신뢰 / 학습 비용을 줄이는 일관성.
 *   - localStorage 단일 머신 한정. 멀티 디바이스 동기화는 현재 단계 가치 대비
 *     오버 엔지니어링이라 생략.
 */

import {
  migrateGlobalToScopedIfDefault,
  workspaceScopedKey,
} from "./workspaceScopedStorage";

const KEY = "preflow.library.folderManualOrder";
export const FOLDER_MANUAL_ORDER_CHANGED_EVENT =
  "preflow:library-folder-manual-order-changed";

type FolderManualOrderMap = Record<string, string[]>;

function read(): FolderManualOrderMap {
  if (typeof window === "undefined") return {};
  migrateGlobalToScopedIfDefault(KEY);
  const scoped = workspaceScopedKey(KEY);
  if (!scoped) return {};
  try {
    const raw = window.localStorage.getItem(scoped);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FolderManualOrderMap;
    }
    return {};
  } catch {
    return {};
  }
}

function write(map: FolderManualOrderMap): void {
  if (typeof window === "undefined") return;
  const scoped = workspaceScopedKey(KEY);
  if (!scoped) return;
  try {
    window.localStorage.setItem(scoped, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(FOLDER_MANUAL_ORDER_CHANGED_EVENT));
  } catch {
    /* quota / private mode — best-effort */
  }
}

/** 한 부모 path 의 자식 순서 조회. 등록 안 된 부모면 빈 배열. */
export function getFolderSiblingOrder(parentPath: string): string[] {
  return read()[parentPath] ?? [];
}

/** 한 부모 path 의 자식 순서 저장. 빈 배열이면 키 자체를 지워 storage 비대화
 *  방지(다음 조회는 빈 배열로 자연 fallback). */
export function setFolderSiblingOrder(parentPath: string, order: string[]): void {
  const map = read();
  if (order.length === 0) {
    if (!(parentPath in map)) return;
    delete map[parentPath];
  } else {
    map[parentPath] = [...order];
  }
  write(map);
}

/** 사이드바 sort 비교용 — 한 번에 모든 부모의 순서를 읽어 두고 lookup. */
export function getAllFolderManualOrder(): FolderManualOrderMap {
  return read();
}

/** 폴더 rename / move 시 prefix 일괄 치환.
 *  - parentPath 키 자체가 X 거나 X/ 로 시작하면 새 prefix 로 키 이름 변경.
 *  - 모든 자식 배열에서 X 또는 X/ 로 시작하는 항목의 prefix 도 함께 치환.
 *  호출자(LibraryPage)는 referenceLibrary.renameFolder 성공 직후 한 번만
 *  호출하면 된다 — folderPreferences 의 cascadeRenameFolderPrefs 와 같은 패턴. */
export function cascadeRenameFolderManualOrder(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const map = read();
  const next: FolderManualOrderMap = {};
  let changed = false;
  for (const [parent, children] of Object.entries(map)) {
    let newParent = parent;
    if (parent === oldPath) {
      newParent = newPath;
      changed = true;
    } else if (parent.startsWith(`${oldPath}/`)) {
      newParent = `${newPath}/${parent.slice(oldPath.length + 1)}`;
      changed = true;
    }
    const newChildren = children.map((child) => {
      if (child === oldPath) {
        changed = true;
        return newPath;
      }
      if (child.startsWith(`${oldPath}/`)) {
        changed = true;
        return `${newPath}/${child.slice(oldPath.length + 1)}`;
      }
      return child;
    });
    next[newParent] = newChildren;
  }
  if (changed) write(next);
}

/** 폴더 삭제 시 정리 — parentPath 가 X / X 의 자손이면 키 자체를 제거하고,
 *  남은 부모의 자식 배열에서도 X / X 의 자손을 모두 제거. */
export function cascadeDeleteFolderManualOrder(path: string): void {
  if (!path) return;
  const map = read();
  let changed = false;
  const next: FolderManualOrderMap = {};
  for (const [parent, children] of Object.entries(map)) {
    if (parent === path || parent.startsWith(`${path}/`)) {
      changed = true;
      continue;
    }
    const filtered = children.filter((child) => child !== path && !child.startsWith(`${path}/`));
    if (filtered.length !== children.length) changed = true;
    if (filtered.length > 0) next[parent] = filtered;
  }
  if (changed) write(next);
}

/** reorder 헬퍼 — visible 형제 순서(알파벳 정렬 후 manual override 가 적용된
 *  실제 표시 순서)를 시드로 받아 moveId 를 targetId *직전* 위치로 옮긴 새
 *  배열을 만든다. targetId === null 이면 끝쪽 append. moveId 가 targetId 와
 *  같으면 noop. */
export function reorderFoldersBefore(
  visibleChildren: string[],
  moveId: string,
  targetId: string | null,
): string[] {
  if (targetId !== null && moveId === targetId) return visibleChildren;
  const remaining = visibleChildren.filter((id) => id !== moveId);
  if (targetId === null) return [...remaining, moveId];
  const targetIdx = remaining.indexOf(targetId);
  if (targetIdx < 0) return [...remaining, moveId];
  return [...remaining.slice(0, targetIdx), moveId, ...remaining.slice(targetIdx)];
}

/** parent 의 부모 path 산출 helper. "" 는 root.
 *  e.g., "a/b/c" → "a/b", "a" → "", "" → "" */
export function parentPathOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}
