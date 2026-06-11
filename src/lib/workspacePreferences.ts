import { useEffect, useState } from "react";

// "Hide default workspaces" — 외부 폴더로만 작업하는 사용자가 Default
// Projects / Default Library 를 시야에서 빼고 싶을 때 쓰는 토글.
//
// 정책:
//   · 값은 사용자 보기 선호이므로 워크스페이스와 무관 → 글로벌 localStorage.
//   · default 워크스페이스가 *active* 상태일 때는 토글이 켜져 있어도
//     popover 에서 숨기지 않는다. 그렇지 않으면 사용자가 default 에 갇혀
//     "다른 워크스페이스로 빠져나갈 길" 자체가 보이지 않게 되기 때문.
//   · 변경 통지는 dashboardPreferences 와 동일한 dual-channel (CustomEvent
//     + storage 이벤트) — 같은/다른 BrowserWindow 모두 즉시 반영.

const STORAGE_KEY = "preflow.workspaces.hideDefault";
export const HIDE_DEFAULT_WORKSPACES_CHANGED_EVENT =
  "preflow:workspaces-hide-default-changed";

export const readHideDefaultWorkspaces = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

export const saveHideDefaultWorkspaces = (value: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
    window.dispatchEvent(
      new CustomEvent(HIDE_DEFAULT_WORKSPACES_CHANGED_EVENT, { detail: value }),
    );
  } catch {
    /* in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};

/** 컴포넌트에서 같은/다른 BrowserWindow 변경을 모두 따라오게 하는 hook.
 *  Settings 에서 토글 → WorkspaceSwitcher popover 가 즉시 반영. */
export const useHideDefaultWorkspaces = (): boolean => {
  const [value, setValue] = useState<boolean>(readHideDefaultWorkspaces);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setValue(readHideDefaultWorkspaces());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) sync();
    };
    window.addEventListener(HIDE_DEFAULT_WORKSPACES_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(HIDE_DEFAULT_WORKSPACES_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return value;
};
