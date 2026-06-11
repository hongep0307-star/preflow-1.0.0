/**
 * 그리드뷰 전용 "숨김" 영속화 — 라이브러리 그리드/리스트에서 특정 레퍼런스를
 * 시각적으로만 숨긴다(전역). 캔버스 숨김(`CanvasItemTransform.hidden`)과는
 * *의도적으로 분리*되어 서로 영향을 주지 않는다.
 *
 * 설계 의도:
 *   · 삭제(휴지통, `deleted_at`)가 아니다 — 태그/파일/캔버스/검색/생성 입력엔
 *     그대로 남고, 단지 그리드 목록에서만 빠진다.
 *   · 범위는 전역(폴더 무관) — "이 자료는 어느 그리드에서도 안 보고 싶다".
 *   · 저장은 다른 라이브러리 선호와 동일한 localStorage 패턴.
 */

const GRID_HIDDEN_KEY = "preflow.library.gridHidden";

/** 다른 LibraryPage 인스턴스/탭과 동기화하기 위한 변경 이벤트. */
export const GRID_HIDDEN_CHANGED_EVENT = "preflow:library-grid-hidden-changed";

export function loadGridHidden(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(GRID_HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

export function saveGridHidden(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GRID_HIDDEN_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new CustomEvent(GRID_HIDDEN_CHANGED_EVENT));
  } catch {
    /* quota / sandboxed — best-effort */
  }
}
