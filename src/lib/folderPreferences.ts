/**
 * Library 의 폴더별 사용자 환경설정 (UI 메타) 저장소.
 *
 * 폴더 자체는 reference_items.tags 의 `folder:` 접두 태그로 표현되어
 * 별도 DB row 가 없다 (`[src/lib/referenceLibrary.ts]` 의 folderTag /
 * listFolderPaths 참고). 색상·아이콘·펼침 상태처럼 "이 폴더를 이렇게
 * 보고 싶다" 같은 UI 전용 메타는 reference 데이터와 분리해 LocalStorage
 * 한 곳에 모아둔다 — 기존 `[src/lib/folderCache.ts]` 의 빈 폴더 추적
 * 패턴과 동일한 형태(JSON blob + CustomEvent + storage 이벤트).
 *
 * 단일 머신 한정. 멀티 디바이스 동기화가 필요해지면 SQLite 테이블로
 * 승격하면 되지만, 현 단계 사용 사례(개인용 Pre-Flow Beta)에선 과한
 * 인프라라 미룬다.
 */

import {
  migrateGlobalToScopedIfDefault,
  workspaceScopedKey,
} from "./workspaceScopedStorage";

const FOLDER_PREFS_KEY = "preflow.library.folderPrefs";
export const FOLDER_PREFS_CHANGED_EVENT =
  "preflow:library-folder-prefs-changed";

/** 한 폴더의 UI 메타. 모든 필드 optional 이며, 미지정 = 기본값.
 *  - color: `[src/components/library/folderIcons.ts]` 의 FOLDER_COLORS id 중 하나
 *  - icon:  같은 파일의 FOLDER_ICONS id 중 하나
 *  - expanded: 트리 상에서 자식 폴더를 펼친 상태인가. undefined 또는 true → 펼침
 *  - pinned: 사용자가 사이드바 상단의 "Pinned" 영역에 단축으로 박아둔 폴더.
 *            본 계층에는 그대로 남고, Pinned 영역에 평평한 단축으로 추가 표시됨. */
export interface FolderMeta {
  color?: string;
  icon?: string;
  expanded?: boolean;
  pinned?: boolean;
}

type FolderMetaMap = Record<string, FolderMeta>;

/** 경로 정규화. folderCache 와 정확히 같은 규칙 — 앞뒤 공백 제거,
 *  `folder:` 접두 제거, 빈 segment 제거. UI 단에서 들어오는 다양한
 *  형태(`"  Reference / 1. Motion  "` 등) 를 안정 키로 강제. */
function normalize(path: string): string {
  return path
    .replace(/^folder:/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function readMap(): FolderMetaMap {
  if (typeof window === "undefined") return {};
  migrateGlobalToScopedIfDefault(FOLDER_PREFS_KEY);
  const key = workspaceScopedKey(FOLDER_PREFS_KEY);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as FolderMetaMap;
  } catch {
    return {};
  }
}

function writeMap(map: FolderMetaMap): void {
  if (typeof window === "undefined") return;
  const key = workspaceScopedKey(FOLDER_PREFS_KEY);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(FOLDER_PREFS_CHANGED_EVENT));
  } catch {
    /* private browsing / quota — in-memory state 가 살아있으면 동작에 지장 없음 */
  }
}

/** 한 폴더의 메타 조회. 없으면 빈 객체. 호출처에서 항상 분해 할당으로
 *  쓸 수 있도록 항상 새 객체를 반환한다. */
export function getFolderMeta(path: string): FolderMeta {
  const key = normalize(path);
  if (!key) return {};
  return { ...(readMap()[key] ?? {}) };
}

/** 부분 patch 적용. 결과가 모든 필드 빈 객체가 되면 키 자체를 지워
 *  blob 이 무한정 커지지 않게 한다. */
export function setFolderMeta(path: string, patch: Partial<FolderMeta>): void {
  const key = normalize(path);
  if (!key) return;
  const map = readMap();
  const merged: FolderMeta = { ...map[key], ...patch };
  // undefined 명시값은 키 제거로 간주 (clear 의도).
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
  }
  if (Object.keys(merged).length === 0) {
    delete map[key];
  } else {
    map[key] = merged;
  }
  writeMap(map);
}

/** 한 폴더의 메타 전체 삭제. 더블클릭으로 기본값 복원하는 용도 */
export function clearFolderMeta(path: string): void {
  const key = normalize(path);
  if (!key) return;
  const map = readMap();
  if (!(key in map)) return;
  delete map[key];
  writeMap(map);
}

/** 모든 폴더 메타. 사이드바가 collapsed 부모 set 을 만들 때 사용. */
export function getAllFolderMeta(): FolderMetaMap {
  return readMap();
}

/** 폴더 path 변경(rename / move) 시 prefs 도 같이 따라가게 한다.
 *  자식 path 들도 prefix 일괄 치환 — referenceLibrary.renameFolder 가
 *  자식 태그를 일괄 갱신하는 동작과 정확히 대응. 호출처(LibraryPage)는
 *  rename 성공 직후 이 함수를 한 번만 부르면 된다.
 *
 *  옵션 A 정책: 이 함수는 referenceLibrary 에서 호출되지 않고 오직
 *  LibraryPage 의 콜사이트에서만 호출된다 — referenceLibrary 는
 *  Project 쪽도 import 하는 공용 모듈이라 그쪽 동작에 영향이 가지
 *  않도록 cascade 책임을 호출자에게 둔다. */
export function cascadeRenameFolderPrefs(oldPath: string, newPath: string): void {
  const oldKey = normalize(oldPath);
  const newKey = normalize(newPath);
  if (!oldKey || !newKey || oldKey === newKey) return;
  const map = readMap();
  let changed = false;
  const next: FolderMetaMap = {};
  for (const [path, meta] of Object.entries(map)) {
    if (path === oldKey) {
      next[newKey] = meta;
      changed = true;
    } else if (path.startsWith(`${oldKey}/`)) {
      next[`${newKey}/${path.slice(oldKey.length + 1)}`] = meta;
      changed = true;
    } else {
      next[path] = meta;
    }
  }
  if (changed) writeMap(next);
}

/** 폴더 삭제 시 prefs 도 같이 정리. recursive 여부와 무관하게 일치하는
 *  prefix 까지 모두 제거해 dangling 메타가 남지 않게 한다. */
export function cascadeDeleteFolderPrefs(path: string): void {
  const key = normalize(path);
  if (!key) return;
  const map = readMap();
  let changed = false;
  for (const existing of Object.keys(map)) {
    if (existing === key || existing.startsWith(`${key}/`)) {
      delete map[existing];
      changed = true;
    }
  }
  if (changed) writeMap(map);
}

// ── 폴더 정렬 모드 ────────────────────────────────────────────
//
// 사이드바 Folders 섹션의 "Sort by" 옵션. toolbar 의 item 정렬과는
// 분명히 다른 축(folder vs item) 이므로 키를 분리. 단일 머신 한정.
//
//   "name"   : 알파벳 (A→Z) — 기본값
//   "count"  : 항목 수 많은 순
//   "recent" : 가장 최근 사용된 항목을 가진 폴더 우선 (lastUsedAt desc)

export type FolderSortMode = "name" | "count" | "recent";

const FOLDER_SORT_MODE_KEY = "preflow.library.folderSortMode";
const VALID_SORT_MODES = new Set<FolderSortMode>(["name", "count", "recent"]);

export function getFolderSortMode(): FolderSortMode {
  if (typeof window === "undefined") return "name";
  migrateGlobalToScopedIfDefault(FOLDER_SORT_MODE_KEY);
  const key = workspaceScopedKey(FOLDER_SORT_MODE_KEY);
  if (!key) return "name";
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && VALID_SORT_MODES.has(raw as FolderSortMode)) {
      return raw as FolderSortMode;
    }
  } catch {
    /* fall through */
  }
  return "name";
}

export function setFolderSortMode(mode: FolderSortMode): void {
  if (typeof window === "undefined") return;
  const key = workspaceScopedKey(FOLDER_SORT_MODE_KEY);
  if (!key) return;
  try {
    if (mode === "name") {
      // 기본값은 키 자체를 비워 storage 깔끔히.
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, mode);
    }
    window.dispatchEvent(new CustomEvent(FOLDER_PREFS_CHANGED_EVENT));
  } catch {
    /* storage quota — 무시 */
  }
}

// ── Same-level expand 옵션 ───────────────────────────────────
//
// "이 폴더 펼치면 같은 부모의 다른 폴더는 자동 접힘" 옵션. Eagle 의
// 동일 옵션 대응. default off — 기존 동작과 호환 유지, 사용자 opt-in.

const SAME_LEVEL_EXPAND_KEY = "preflow.library.sameLevelExpand";

export function getSameLevelExpand(): boolean {
  if (typeof window === "undefined") return false;
  migrateGlobalToScopedIfDefault(SAME_LEVEL_EXPAND_KEY);
  const key = workspaceScopedKey(SAME_LEVEL_EXPAND_KEY);
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setSameLevelExpand(value: boolean): void {
  if (typeof window === "undefined") return;
  const key = workspaceScopedKey(SAME_LEVEL_EXPAND_KEY);
  if (!key) return;
  try {
    if (value) {
      window.localStorage.setItem(key, "1");
    } else {
      window.localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent(FOLDER_PREFS_CHANGED_EVENT));
  } catch {
    /* storage quota — 무시 */
  }
}

/** 모든 폴더 펼침/접힘 일괄 토글. 우클릭 메뉴의 "Expand all folders"
 *  / "Collapse all folders" 에서 사용. paths 인자는 현재 사이드바가
 *  알고 있는 모든 폴더 path 목록을 그대로 받는다 — 새 폴더가 추가
 *  되면 그 폴더는 기본값(펼침) 으로 시작한다. */
export function setAllFoldersExpanded(paths: string[], expanded: boolean): void {
  const map = readMap();
  let changed = false;
  for (const raw of paths) {
    const key = normalize(raw);
    if (!key) continue;
    const current = map[key] ?? {};
    // expanded === true 가 기본값이라, true 로 만들 때는 키를 빼주는
    // 게 깔끔하다. (저장소 비대화 방지)
    if (expanded) {
      if (current.expanded === false) {
        const { expanded: _, ...rest } = current;
        if (Object.keys(rest).length === 0) delete map[key];
        else map[key] = rest;
        changed = true;
      }
    } else {
      if (current.expanded !== false) {
        map[key] = { ...current, expanded: false };
        changed = true;
      }
    }
  }
  if (changed) writeMap(map);
}
