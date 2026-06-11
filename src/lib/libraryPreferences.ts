// Library 화면의 사이드바 사용자 선호값. dashboardPreferences 의 사이드바
// 폭 섹션과 동일한 구조 — 사용자가 한 곳에서 폭을 바꿔도 같은 윈도우의 다른
// 컴포넌트(CustomEvent) 와 다른 BrowserWindow/탭(storage 이벤트) 양쪽에서
// 즉시 반영되도록 두 채널을 같이 발행한다.

/* ── 사이드바 폭 (드래그 리사이즈) ──────────────────────────────────
 * MIN: 검색 인풋 placeholder("Search…") + 카운트 칩이 잘리지 않는 최소 폭.
 *      Library 사이드바는 Quick Filters / Smart Folders 등 라벨이 Dashboard
 *      대비 길어 220 으로 설정.
 * MAX: 메인 그리드(LibraryGrid + 360px Inspector 고정) 가 카드 한 칸은
 *      유지할 수 있는 한계. 1024 폭에서 480 이 넘으면 그리드가 한 줄 한 장
 *      이하로 떨어져 라이브러리의 의의가 없어짐.
 * DEFAULT: 기존 하드코딩 260 을 그대로 승계 — 마이그레이션 부담 없음. */
export const LIBRARY_SIDEBAR_WIDTH_MIN = 220;
export const LIBRARY_SIDEBAR_WIDTH_MAX = 480;
export const DEFAULT_LIBRARY_SIDEBAR_WIDTH = 260;
export const LIBRARY_SIDEBAR_WIDTH_CHANGED_EVENT =
  "preflow:library-sidebar-width-changed";
const LIBRARY_SIDEBAR_WIDTH_STORAGE_KEY = "preflow.library.sidebarWidth";

/** 외부 입력(localStorage / drag delta / CustomEvent)을 모두 안전 범위로
 *  강제. NaN / Infinity / 음수 / 거대 값 모두 default 로 폴백. */
export const clampLibrarySidebarWidth = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIBRARY_SIDEBAR_WIDTH;
  return Math.min(
    LIBRARY_SIDEBAR_WIDTH_MAX,
    Math.max(LIBRARY_SIDEBAR_WIDTH_MIN, Math.round(n)),
  );
};

export const readLibrarySidebarWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_LIBRARY_SIDEBAR_WIDTH;
  try {
    const raw = window.localStorage.getItem(LIBRARY_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIBRARY_SIDEBAR_WIDTH;
    return clampLibrarySidebarWidth(raw);
  } catch {
    return DEFAULT_LIBRARY_SIDEBAR_WIDTH;
  }
};

export const saveLibrarySidebarWidth = (value: number): void => {
  if (typeof window === "undefined") return;
  const clamped = clampLibrarySidebarWidth(value);
  try {
    window.localStorage.setItem(
      LIBRARY_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clamped),
    );
    window.dispatchEvent(
      new CustomEvent(LIBRARY_SIDEBAR_WIDTH_CHANGED_EVENT, { detail: clamped }),
    );
  } catch {
    /* fall through — in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};

export const LIBRARY_SIDEBAR_WIDTH_STORAGE_KEY_EXPORTED =
  LIBRARY_SIDEBAR_WIDTH_STORAGE_KEY;

/* ── Inspector(우측 패널) 폭 — 사이드바 폭 섹션과 동일한 패턴 ──────────
 * MIN: 2열 properties 표(Dimensions / Size / Type … 라벨↔값)가 줄바꿈
 *      없이 한 줄에 들어가는 최소 폭. 280 미만이면 "Date imported" 같은
 *      라벨이 두 줄로 깨진다.
 * MAX: 메인 그리드(LibraryGrid) 가 카드 한 줄 한 장 이하로 내려가지
 *      않도록 보수적으로 720 까지 허용. 그 이상은 그리드가 의미를 잃음.
 * DEFAULT: 기존 하드코딩 360 을 그대로 승계. */
export const LIBRARY_INSPECTOR_WIDTH_MIN = 280;
export const LIBRARY_INSPECTOR_WIDTH_MAX = 720;
export const DEFAULT_LIBRARY_INSPECTOR_WIDTH = 360;
export const LIBRARY_INSPECTOR_WIDTH_CHANGED_EVENT =
  "preflow:library-inspector-width-changed";
const LIBRARY_INSPECTOR_WIDTH_STORAGE_KEY = "preflow.library.inspectorWidth";

export const clampLibraryInspectorWidth = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIBRARY_INSPECTOR_WIDTH;
  return Math.min(
    LIBRARY_INSPECTOR_WIDTH_MAX,
    Math.max(LIBRARY_INSPECTOR_WIDTH_MIN, Math.round(n)),
  );
};

export const readLibraryInspectorWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_LIBRARY_INSPECTOR_WIDTH;
  try {
    const raw = window.localStorage.getItem(LIBRARY_INSPECTOR_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIBRARY_INSPECTOR_WIDTH;
    return clampLibraryInspectorWidth(raw);
  } catch {
    return DEFAULT_LIBRARY_INSPECTOR_WIDTH;
  }
};

export const saveLibraryInspectorWidth = (value: number): void => {
  if (typeof window === "undefined") return;
  const clamped = clampLibraryInspectorWidth(value);
  try {
    window.localStorage.setItem(
      LIBRARY_INSPECTOR_WIDTH_STORAGE_KEY,
      String(clamped),
    );
    window.dispatchEvent(
      new CustomEvent(LIBRARY_INSPECTOR_WIDTH_CHANGED_EVENT, { detail: clamped }),
    );
  } catch {
    /* fall through */
  }
};

export const LIBRARY_INSPECTOR_WIDTH_STORAGE_KEY_EXPORTED =
  LIBRARY_INSPECTOR_WIDTH_STORAGE_KEY;
