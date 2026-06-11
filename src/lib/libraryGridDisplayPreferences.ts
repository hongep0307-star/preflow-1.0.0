// Library 그리드 카드의 "썸네일 영역 보기 옵션". Eagle 처럼 우클릭 컨텍스트
// 메뉴에서 토글로 끄고 켤 수 있게 노출되는 세 가지 시각 옵션을 한 곳에서
// 관리한다.
//
//   - showName       : 그리드 카드 하단의 파일명 라벨
//   - showTypeLabel  : 썸네일 좌상단의 "WEBP / MP4 / GIF …" 종류 배지
//   - showAnnotation : 썸네일 우상단의 노트(MessageSquare) 배지
//
// 영속 / 동기화 패턴은 animationPreferences.ts 와 동일한 dual-channel:
//   1. CustomEvent  — 같은 BrowserWindow 안의 다른 LibraryCard 즉시 갱신
//   2. 'storage'    — 다른 BrowserWindow/탭 (Electron 멀티 윈도우 대비)
//
// 기본값은 모두 true — 기존 사용자는 업데이트 후에도 시각적으로 동일한 카드
// 를 보게 되고, "끄는 것" 을 *명시적인 사용자 선택* 으로 둔다.

import { useEffect, useState } from "react";

type ToggleKey = "showName" | "showTypeLabel" | "showAnnotation" | "showBadges";

interface ToggleDef {
  storageKey: string;
  changedEvent: string;
  defaultValue: boolean;
}

const TOGGLE_DEFS: Record<ToggleKey, ToggleDef> = {
  showName: {
    storageKey: "preflow.library.grid.showName",
    changedEvent: "preflow:library-grid-show-name-changed",
    defaultValue: true,
  },
  showTypeLabel: {
    storageKey: "preflow.library.grid.showTypeLabel",
    changedEvent: "preflow:library-grid-show-type-label-changed",
    defaultValue: true,
  },
  showAnnotation: {
    storageKey: "preflow.library.grid.showAnnotation",
    changedEvent: "preflow:library-grid-show-annotation-changed",
    defaultValue: true,
  },
  // 마스터 토글 — 썸네일 위에 떠 있는 모든 오버레이 배지(즐겨찾기/핀/중복/
  // 사용 카운트/휴지통/길이/종류 라벨/노트)를 한 번에 끄고 켠다. 끄면
  // 카드가 *완전한 빈 썸네일* 만 남아 시각 노이즈 없이 이미지 자체에
  // 집중할 수 있다. 다시 켜면 개별 토글(showTypeLabel / showAnnotation)
  // 이 그대로 적용되어 이전 상태로 복원.
  showBadges: {
    storageKey: "preflow.library.grid.showBadges",
    changedEvent: "preflow:library-grid-show-badges-changed",
    defaultValue: true,
  },
};

const readToggle = (key: ToggleKey): boolean => {
  const def = TOGGLE_DEFS[key];
  if (typeof window === "undefined") return def.defaultValue;
  try {
    const raw = window.localStorage.getItem(def.storageKey);
    if (raw === null) return def.defaultValue;
    // 명시적으로 "false" 만 끔으로 해석. 잘못 저장된 값은 default 로 폴백해서
    // 사용자가 보이지 않게 깨진 상태에 갇히지 않도록 한다.
    if (raw === "true") return true;
    if (raw === "false") return false;
    return def.defaultValue;
  } catch {
    return def.defaultValue;
  }
};

const writeToggle = (key: ToggleKey, value: boolean): void => {
  const def = TOGGLE_DEFS[key];
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(def.storageKey, value ? "true" : "false");
    window.dispatchEvent(new CustomEvent(def.changedEvent, { detail: value }));
  } catch {
    /* in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};

const useToggle = (key: ToggleKey): boolean => {
  const [value, setValue] = useState<boolean>(() => readToggle(key));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const def = TOGGLE_DEFS[key];
    const sync = () => setValue(readToggle(key));
    const onStorage = (event: StorageEvent) => {
      if (event.key === def.storageKey) sync();
    };
    window.addEventListener(def.changedEvent, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(def.changedEvent, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  return value;
};

/* ── 개별 read / write / hook — 카드 컴포넌트에서 호출하기 쉽도록 키 이름
 *    그대로 export. 동일 윈도우 / 다른 윈도우 변경 모두 자동 반영. ──── */

export const readLibraryShowName = (): boolean => readToggle("showName");
export const saveLibraryShowName = (value: boolean): void =>
  writeToggle("showName", value);
export const useLibraryShowName = (): boolean => useToggle("showName");

export const readLibraryShowTypeLabel = (): boolean => readToggle("showTypeLabel");
export const saveLibraryShowTypeLabel = (value: boolean): void =>
  writeToggle("showTypeLabel", value);
export const useLibraryShowTypeLabel = (): boolean => useToggle("showTypeLabel");

export const readLibraryShowAnnotation = (): boolean => readToggle("showAnnotation");
export const saveLibraryShowAnnotation = (value: boolean): void =>
  writeToggle("showAnnotation", value);
export const useLibraryShowAnnotation = (): boolean => useToggle("showAnnotation");

export const readLibraryShowBadges = (): boolean => readToggle("showBadges");
export const saveLibraryShowBadges = (value: boolean): void =>
  writeToggle("showBadges", value);
export const useLibraryShowBadges = (): boolean => useToggle("showBadges");
