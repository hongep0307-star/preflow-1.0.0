/**
 * 설정 모달의 전역 오픈 상태.
 *
 * 과거 설정은 `/settings` 라우트라 어디서 열든 화면 전체가 그 페이지로
 * 이동했고, 닫으면 대시보드/라이브러리로 빠져 작업하던 위치(예: 프로젝트
 * 콘티 탭)를 잃었다. 이제는 라우트 이동 없이 현재 화면 위에 팝업으로 띄운다.
 *
 * Zustand/Redux 없이 Context + 로컬 state 로 구성(프로젝트의 UiLanguageProvider
 * 관례와 동일). Provider 는 HashRouter 안에 두고, 모달 본체는 App 에서 한 번만
 * 마운트한다. openSettings 는 라우트를 건드리지 않으므로 현재 경로가 유지된다.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SettingsSurface } from "@/lib/imageGenPreference";

/** 설정 좌측 레일 카테고리. (구 SettingsPage 의 로컬 타입을 여기로 승격) */
export type SettingsCategoryId = "keys" | "models" | "language" | "displayUi";

export interface OpenSettingsOpts {
  /** 열린 공간 — 이미지 생성 행의 정렬/그룹 분리에 쓰인다. 기본 dashboard. */
  surface?: SettingsSurface;
  /** 초기 카테고리. 기본 "keys". */
  category?: SettingsCategoryId;
}

interface SettingsModalContextValue {
  open: boolean;
  surface: SettingsSurface;
  category: SettingsCategoryId;
  openSettings: (opts?: OpenSettingsOpts) => void;
  closeSettings: () => void;
  setCategory: (category: SettingsCategoryId) => void;
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null);

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<SettingsSurface>("dashboard");
  const [category, setCategory] = useState<SettingsCategoryId>("keys");

  const openSettings = useCallback((opts?: OpenSettingsOpts) => {
    setSurface(opts?.surface ?? "dashboard");
    setCategory(opts?.category ?? "keys");
    setOpen(true);
  }, []);

  const closeSettings = useCallback(() => setOpen(false), []);

  const value = useMemo<SettingsModalContextValue>(
    () => ({ open, surface, category, openSettings, closeSettings, setCategory }),
    [open, surface, category, openSettings, closeSettings],
  );

  return (
    <SettingsModalContext.Provider value={value}>{children}</SettingsModalContext.Provider>
  );
}

export function useSettingsModal(): SettingsModalContextValue {
  const ctx = useContext(SettingsModalContext);
  if (!ctx) {
    throw new Error("useSettingsModal must be used within a SettingsModalProvider");
  }
  return ctx;
}
