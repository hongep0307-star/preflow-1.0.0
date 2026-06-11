// 대시보드 사이드바·메인바 토글들의 사용자 선호값. 모두 localStorage 에
// 저장하고, 동일 키 변경 시 다른 컴포넌트가 자연스럽게 반응하도록 두 가지
// 채널을 같이 발행한다:
//   1. CustomEvent(DASHBOARD_*_CHANGED_EVENT) — 같은 탭 안의 다른 컴포넌트
//   2. 'storage' 이벤트 — 다른 BrowserWindow / 탭 (Electron 멀티 윈도우 대비)
//
// 이 두 채널을 동시에 청취하면 같은 윈도우 안에서도, 별도 윈도우에서도
// 토글이 동기화돼 사용자가 한 곳에서 바꿔도 다른 시야가 즉시 반영된다.

export type DashboardCardsPerRow = 4 | 5 | 6 | 7 | 8;

export const DASHBOARD_CARDS_PER_ROW_OPTIONS: DashboardCardsPerRow[] = [4, 5, 6, 7, 8];
export const DEFAULT_DASHBOARD_CARDS_PER_ROW: DashboardCardsPerRow = 6;
export const DASHBOARD_CARDS_PER_ROW_CHANGED_EVENT = "preflow:dashboard-cards-per-row-changed";

const DASHBOARD_CARDS_PER_ROW_STORAGE_KEY = "preflow.dashboard.cardsPerRow";

export const readDashboardCardsPerRow = (): DashboardCardsPerRow => {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_CARDS_PER_ROW;
  try {
    const raw = window.localStorage.getItem(DASHBOARD_CARDS_PER_ROW_STORAGE_KEY);
    const value = Number(raw);
    return DASHBOARD_CARDS_PER_ROW_OPTIONS.includes(value as DashboardCardsPerRow)
      ? (value as DashboardCardsPerRow)
      : DEFAULT_DASHBOARD_CARDS_PER_ROW;
  } catch {
    return DEFAULT_DASHBOARD_CARDS_PER_ROW;
  }
};

export const saveDashboardCardsPerRow = (value: DashboardCardsPerRow) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_CARDS_PER_ROW_STORAGE_KEY, String(value));
    window.dispatchEvent(new CustomEvent(DASHBOARD_CARDS_PER_ROW_CHANGED_EVENT, { detail: value }));
  } catch {
    // Keep the in-memory UI usable even if localStorage is unavailable.
  }
};

/* ── 그리드/리스트 뷰 모드 ───────────────────────────────────────── */

export type DashboardViewMode = "grid" | "list";
export const DEFAULT_DASHBOARD_VIEW_MODE: DashboardViewMode = "grid";
export const DASHBOARD_VIEW_MODE_CHANGED_EVENT = "preflow:dashboard-view-mode-changed";
const DASHBOARD_VIEW_MODE_STORAGE_KEY = "preflow.dashboard.viewMode";

export const readDashboardViewMode = (): DashboardViewMode => {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_VIEW_MODE;
  try {
    const raw = window.localStorage.getItem(DASHBOARD_VIEW_MODE_STORAGE_KEY);
    return raw === "grid" || raw === "list" ? raw : DEFAULT_DASHBOARD_VIEW_MODE;
  } catch {
    return DEFAULT_DASHBOARD_VIEW_MODE;
  }
};

export const saveDashboardViewMode = (value: DashboardViewMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_VIEW_MODE_STORAGE_KEY, value);
    window.dispatchEvent(new CustomEvent(DASHBOARD_VIEW_MODE_CHANGED_EVENT, { detail: value }));
  } catch {
    /* fall through */
  }
};

/* ── 정렬: 모드 + 방향 ───────────────────────────────────────────── */

export type DashboardSortMode = "deadline" | "size" | "name";
export type DashboardSortDir = "asc" | "desc";

/** Deadline 은 가까운 마감이 위로 오는 게 자연스러움(asc).
 *  Size 는 큰 프로젝트가 위로(desc).
 *  Name 은 ASCII 오름차순(asc).
 *  세 가지 모두 한 번에 저장해야 모드 전환 시 저장된 방향을 보존할 수 있다. */
export interface DashboardSortPreference {
  mode: DashboardSortMode;
  dir: DashboardSortDir;
}

export const DEFAULT_DASHBOARD_SORT: DashboardSortPreference = {
  mode: "deadline",
  dir: "asc",
};

export const DASHBOARD_SORT_CHANGED_EVENT = "preflow:dashboard-sort-changed";
const DASHBOARD_SORT_STORAGE_KEY = "preflow.dashboard.sort";

const isSortMode = (v: unknown): v is DashboardSortMode =>
  v === "deadline" || v === "size" || v === "name";
const isSortDir = (v: unknown): v is DashboardSortDir => v === "asc" || v === "desc";

export const readDashboardSort = (): DashboardSortPreference => {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_SORT;
  try {
    const raw = window.localStorage.getItem(DASHBOARD_SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_DASHBOARD_SORT;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      isSortMode((parsed as { mode?: unknown }).mode) &&
      isSortDir((parsed as { dir?: unknown }).dir)
    ) {
      return parsed as DashboardSortPreference;
    }
    return DEFAULT_DASHBOARD_SORT;
  } catch {
    return DEFAULT_DASHBOARD_SORT;
  }
};

export const saveDashboardSort = (value: DashboardSortPreference) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_SORT_STORAGE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(DASHBOARD_SORT_CHANGED_EVENT, { detail: value }));
  } catch {
    /* fall through */
  }
};

/* ── 사이드바 폭 (드래그 리사이즈) ──────────────────────────────────
 * MIN: 검색 인풋의 placeholder("Search…") 가 잘리지 않는 최소 폭.
 * MAX: 메인 그리드가 카드 한 칸을 유지할 수 있는 한계 (16:9 카드 1장 +
 *      좌우 패딩 + 안전 여유). 1024 폭 모니터 기준 480 이 넘으면 카드가
 *      찌그러져 D-day / 메타 칩이 깨지기 시작.
 * DEFAULT: 기존 하드코딩 230 을 그대로 승계 — 마이그레이션 부담 없음. */
export const DASHBOARD_SIDEBAR_WIDTH_MIN = 200;
export const DASHBOARD_SIDEBAR_WIDTH_MAX = 480;
export const DEFAULT_DASHBOARD_SIDEBAR_WIDTH = 230;
export const DASHBOARD_SIDEBAR_WIDTH_CHANGED_EVENT =
  "preflow:dashboard-sidebar-width-changed";
const DASHBOARD_SIDEBAR_WIDTH_STORAGE_KEY = "preflow.dashboard.sidebarWidth";

/** 외부 입력(localStorage / drag delta / CustomEvent)을 모두 안전 범위로
 *  강제. NaN / Infinity / 음수 / 거대 값 모두 default 로 폴백. */
export const clampDashboardSidebarWidth = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DASHBOARD_SIDEBAR_WIDTH;
  return Math.min(
    DASHBOARD_SIDEBAR_WIDTH_MAX,
    Math.max(DASHBOARD_SIDEBAR_WIDTH_MIN, Math.round(n)),
  );
};

export const readDashboardSidebarWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_SIDEBAR_WIDTH;
  try {
    const raw = window.localStorage.getItem(DASHBOARD_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_DASHBOARD_SIDEBAR_WIDTH;
    return clampDashboardSidebarWidth(raw);
  } catch {
    return DEFAULT_DASHBOARD_SIDEBAR_WIDTH;
  }
};

export const saveDashboardSidebarWidth = (value: number): void => {
  if (typeof window === "undefined") return;
  const clamped = clampDashboardSidebarWidth(value);
  try {
    window.localStorage.setItem(
      DASHBOARD_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clamped),
    );
    window.dispatchEvent(
      new CustomEvent(DASHBOARD_SIDEBAR_WIDTH_CHANGED_EVENT, { detail: clamped }),
    );
  } catch {
    /* fall through — in-memory state 가 살아있으면 사용엔 지장 없음 */
  }
};
