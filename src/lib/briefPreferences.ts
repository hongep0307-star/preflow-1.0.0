// 브리프(크리에이티브 입력) 패널 폭의 사용자 선호값. Dashboard / Library
// 사이드바와 동일한 패턴으로 localStorage 에 저장하고, 같은 윈도우(CustomEvent)
// 와 다른 윈도우('storage' 이벤트) 양쪽에서 동기화되게 두 채널을 발행한다.

// MIN: "이미지 전용 모드 · 링크/영상은 모델 변경 필요" 같은 긴 설명/모델 라벨이
//      잘리지 않고 보이는 최소 폭.
// MAX: 분석 결과(전략) 영역이 카드 한 칸을 유지할 수 있는 한계.
// DEFAULT: 기존 300 보다 넓혀, 설명이 처음부터 한 줄에 더 잘 들어오게 한다.
export const BRIEF_PANEL_WIDTH_MIN = 300;
export const BRIEF_PANEL_WIDTH_MAX = 620;
export const DEFAULT_BRIEF_PANEL_WIDTH = 380;
export const BRIEF_PANEL_WIDTH_CHANGED_EVENT = "preflow:brief-panel-width-changed";
const BRIEF_PANEL_WIDTH_STORAGE_KEY = "preflow.brief.panelWidth";

/** 외부 입력(localStorage / drag delta / CustomEvent)을 안전 범위로 강제.
 *  NaN / Infinity / 음수 / 거대 값 모두 default 로 폴백. */
export const clampBriefPanelWidth = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BRIEF_PANEL_WIDTH;
  return Math.min(
    BRIEF_PANEL_WIDTH_MAX,
    Math.max(BRIEF_PANEL_WIDTH_MIN, Math.round(n)),
  );
};

export const readBriefPanelWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_BRIEF_PANEL_WIDTH;
  try {
    const raw = window.localStorage.getItem(BRIEF_PANEL_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_BRIEF_PANEL_WIDTH;
    return clampBriefPanelWidth(raw);
  } catch {
    return DEFAULT_BRIEF_PANEL_WIDTH;
  }
};

export const saveBriefPanelWidth = (value: number): void => {
  if (typeof window === "undefined") return;
  const clamped = clampBriefPanelWidth(value);
  try {
    window.localStorage.setItem(BRIEF_PANEL_WIDTH_STORAGE_KEY, String(clamped));
    window.dispatchEvent(
      new CustomEvent(BRIEF_PANEL_WIDTH_CHANGED_EVENT, { detail: clamped }),
    );
  } catch {
    /* fall through — in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};
