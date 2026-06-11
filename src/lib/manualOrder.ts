/**
 * 사용자가 라이브러리 그리드에서 카드를 드래그해 직접 정한 "수동 순서" 를
 * 컨텍스트(=현재 활성 폴더 / quick filter 등) 별로 분리해 localStorage 에
 * 보존한다.
 *
 * 왜 DB 가 아니라 localStorage 인가:
 *   - 순서는 *보는 사람의 작업 흐름* 에 가까운 정보(같은 폴더라도 사용자
 *     마다 정렬 욕구가 다를 수 있고, 협업으로 동기화돼야 하는 핵심 메타도
 *     아님). DB 스키마 변경/마이그레이션 비용 대비 가치가 낮다.
 *   - 멀티 윈도우 / 멀티 탭 동기화는 storage 이벤트로 충분.
 *   - 다른 PC 로 옮길 때 따라가지 않아도 사용자 모델이 자연스럽다(라이트
 *     레퍼런스 라이브러리는 보통 한 머신에서만 본다).
 *
 * 컨텍스트 키 정책:
 *   - activeTag (폴더 또는 일반 태그) 가 있으면 `tag:<value>` 가 1차 키.
 *   - 그 외엔 quickFilter (`q:all`, `q:favorites` …) 를 키로.
 *   - kind/rating/note/source/searchQuery 같은 보조 필터는 키에 *섞지
 *     않는다*. 그렇게 하면 한 번 정렬해 둔 결과가 우연한 필터 토글마다
 *     리셋된 듯이 보여 사용자 신뢰를 깬다 — 메인 컨텍스트(폴더) 만 키로.
 */

import {
  migrateGlobalToScopedIfDefault,
  workspaceScopedKey,
} from "./workspaceScopedStorage";

const KEY = "preflow.library.manualOrder";
export const MANUAL_ORDER_CHANGED_EVENT = "preflow-library-manual-order-changed";

type ManualOrderMap = Record<string, string[]>;

function read(): ManualOrderMap {
  if (typeof window === "undefined") return {};
  migrateGlobalToScopedIfDefault(KEY);
  const scoped = workspaceScopedKey(KEY);
  if (!scoped) return {};
  try {
    const raw = window.localStorage.getItem(scoped);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ManualOrderMap;
    }
    return {};
  } catch {
    return {};
  }
}

function write(map: ManualOrderMap): void {
  if (typeof window === "undefined") return;
  const scoped = workspaceScopedKey(KEY);
  if (!scoped) return;
  try {
    window.localStorage.setItem(scoped, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(MANUAL_ORDER_CHANGED_EVENT));
  } catch {
    // best-effort — quota 초과 등은 silently 무시. 다음 페인트엔 캐시본이 살아있다.
  }
}

export function getManualOrder(contextKey: string): string[] {
  return read()[contextKey] ?? [];
}

export function setManualOrder(contextKey: string, order: string[]): void {
  const map = read();
  map[contextKey] = order;
  write(map);
}

export function clearManualOrder(contextKey: string): void {
  const map = read();
  if (!(contextKey in map)) return;
  delete map[contextKey];
  write(map);
}

/** sort 비교용 인덱스 맵. `getManualOrder` 결과로부터 한 번만 만들어 두고
 *  filteredItems sort 콜백에서 lookup 한다. 순서에 없는 신규 항목은
 *  Number.MAX_SAFE_INTEGER 로 fallback 해 항상 끝쪽에 모이게.
 */
export function manualOrderIndex(order: string[]): Map<string, number> {
  return new Map(order.map((id, i) => [id, i] as const));
}

/** 다중 선택 reorder — 드래그된 ids 한 묶음을 list 에서 빼낸 뒤,
 *  target 항목 *직전* 위치(=before)에 그대로 삽입. target 도 선택에
 *  포함된 상태로 자기 자리에 떨어졌다면 noop.
 *
 *  - allIds      : 현재 정렬 키로 보이는 모든 id (visible-and-ordered).
 *  - moveIds     : 드래그 중인 id 들 (단일 카드면 [id]).
 *  - targetId    : 드롭한 카드의 id. null 이면 끝쪽으로 append.
 */
export function reorderManyBefore(
  allIds: string[],
  moveIds: string[],
  targetId: string | null,
): string[] {
  const moveSet = new Set(moveIds);
  if (targetId !== null && moveSet.has(targetId)) {
    // 자기 자신 위에 떨어뜨림 — 의미 없는 동작.
    return allIds;
  }
  const remaining = allIds.filter((id) => !moveSet.has(id));
  // moveIds 의 순서는 allIds 안에서의 순서를 따라가게 — 사용자가 화면에서
  // 보는 순서와 reorder 결과가 일관되게 한다.
  const orderedMoves = allIds.filter((id) => moveSet.has(id));
  if (targetId === null) {
    return [...remaining, ...orderedMoves];
  }
  const targetIdx = remaining.indexOf(targetId);
  if (targetIdx < 0) {
    // 안전 폴백 — target 이 사라진 경우 끝에 붙임.
    return [...remaining, ...orderedMoves];
  }
  return [
    ...remaining.slice(0, targetIdx),
    ...orderedMoves,
    ...remaining.slice(targetIdx),
  ];
}

/** activeTag / quickFilter 로부터 안정적인 컨텍스트 키 산출. */
export function deriveLibraryContextKey(
  activeTag: string | null,
  quickFilter: string,
): string {
  if (activeTag) return `tag:${activeTag}`;
  return `q:${quickFilter}`;
}
