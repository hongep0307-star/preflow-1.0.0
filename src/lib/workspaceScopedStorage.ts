/**
 * Workspace 별로 localStorage 키를 격리하는 helper.
 *
 * Library 사이드바의 폴더 메타(빈 폴더 추적, 색/아이콘, 펼침 상태, 정렬,
 * 수동 순서) 는 모두 localStorage 에 저장되는데, 초기 구현은 단일 글로벌
 * 키였다 — 워크스페이스가 1 개뿐이라는 전제. 다중 워크스페이스로 확장한
 * 뒤에는 글로벌 키가 누수 통로가 된다: Default Library 에서 만든 폴더
 * 트리가 새로 만든 비어 있는 라이브러리 워크스페이스에도 그대로 묻어
 * 나옴.
 *
 * 이 모듈은 두 일을 한다:
 *   1) globalKey → "<globalKey>.ws_<activeWorkspaceId>" 로 변환. 활성 ID
 *      미로딩 시엔 null 반환 — 호출처가 "아직 모름" 으로 처리해 빈 값을
 *      쓰도록.
 *   2) 활성 워크스페이스가 default 일 때, scoped 키가 비어 있고 글로벌
 *      키에 데이터가 있으면 1 회 마이그레이션. 기존 Default 사용자의
 *      폴더 메타가 손실되지 않게 한다. 비-default 워크스페이스에서는
 *      절대 글로벌 키를 보지 않으므로 누수가 발생할 수 없다.
 */

import { getCachedActive, getCachedActiveId } from "./workspaceClient";

/** 활성 워크스페이스 ID 가 suffix 로 붙은 localStorage 키. ID 가 아직
 *  로딩되지 않았으면 null — 호출처는 read 시 빈 값을, write 시 보류를
 *  선택해야 한다. */
export function workspaceScopedKey(globalKey: string): string | null {
  const id = getCachedActiveId();
  if (!id) return null;
  return `${globalKey}.ws_${id}`;
}

/** Default 워크스페이스 활성 + scoped 키 없음 + 글로벌 키 있음 일 때 1 회
 *  마이그레이션. 글로벌 키는 그대로 두어 옛 클라이언트와 호환을 유지하되,
 *  이후 read 는 scoped 키만 본다. 다른 워크스페이스에서는 호출되어도
 *  no-op 이라 누수 위험 없음. */
export function migrateGlobalToScopedIfDefault(globalKey: string): void {
  if (typeof window === "undefined") return;
  const active = getCachedActive();
  if (!active?.isDefault) return;

  const scoped = workspaceScopedKey(globalKey);
  if (!scoped) return;

  try {
    if (window.localStorage.getItem(scoped) !== null) return;
    const legacy = window.localStorage.getItem(globalKey);
    if (legacy === null) return;
    window.localStorage.setItem(scoped, legacy);
  } catch {
    /* quota / private mode — best-effort */
  }
}
