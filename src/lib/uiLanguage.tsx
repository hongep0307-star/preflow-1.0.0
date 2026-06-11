import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getUiCopy } from "./uiCopy";

export type UiLanguage = "en" | "ko";

export const UI_LANG_KEY = "ff_ui_lang";

type Vars = Record<string, string | number>;

interface UiLanguageContextValue {
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
  t: (key: string, vars?: Vars) => string;
}

const UiLanguageContext = createContext<UiLanguageContextValue | null>(null);

const normalizeLanguage = (value: string | null | undefined): UiLanguage => (value === "ko" ? "ko" : "en");

const interpolate = (template: string, vars?: Vars) => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
};

export const UiLanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<UiLanguage>(() => {
    if (typeof window === "undefined") return "en";
    return normalizeLanguage(window.localStorage.getItem(UI_LANG_KEY));
  });

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(UI_LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_LANG_KEY) setLanguageState(normalizeLanguage(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<UiLanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, vars) => interpolate(getUiCopy(key, language), vars),
    }),
    [language, setLanguage],
  );

  return <UiLanguageContext.Provider value={value}>{children}</UiLanguageContext.Provider>;
};

export const useUiLanguage = () => {
  const ctx = useContext(UiLanguageContext);
  if (!ctx) throw new Error("useUiLanguage must be used within UiLanguageProvider");
  return ctx;
};

export const useT = () => useUiLanguage().t;
