/* 뷰어 필터/정렬 상태 + 순수 함수.
 *
 * 메인 앱 LibraryPage 의 필터 파이프라인을 뷰어용으로 경량 포팅한 것.
 * 모든 함수는 부수효과 없는 순수 함수라 vitest 로 직접 검증한다 (DOM /
 * electron 글로벌 불필요). 색 매칭은 메인 앱과 동일한 순수 모듈
 * src/lib/colorMatch.ts 를 그대로 재사용 — 무거운 의존성이 없어 viewer
 * 번들에 그대로 들어가도 안전하다. */

import { COLOR_FILTER_THRESHOLD, scoreItemByColor } from "@/lib/colorMatch";
import type { ReferenceItem, ReferenceKind, ViewerFolderNode } from "../types";

export type ViewerSort = "imported_desc" | "imported_asc" | "title" | "duration_desc";

export interface ViewerFilterState {
  query: string;
  /** 비어 있으면 전체 종류 허용. */
  kinds: ReadonlySet<ReferenceKind>;
  /** OR 매칭 — 선택된 태그 중 하나라도 가진 아이템(종류 토글과 동일 시맨틱). */
  tags: ReadonlySet<string>;
  /** 선택 폴더 경로("folder:" 제거형). 하위 폴더 포함. null = 전체. */
  folderPath: string | null;
  /** 선택 색(hex). null = 색 필터 없음. */
  color: string | null;
  sort: ViewerSort;
}

export const EMPTY_FILTERS: ViewerFilterState = {
  query: "",
  kinds: new Set(),
  tags: new Set(),
  folderPath: null,
  color: null,
  sort: "imported_desc",
};

const FOLDER_PREFIX = "folder:";

/** folder: prefix 가상 태그를 제외한 사용자 태그만. */
export function nonFolderTags(item: ReferenceItem): string[] {
  return (item.tags ?? []).filter((tag) => !tag.startsWith(FOLDER_PREFIX));
}

function timeValue(value?: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function importedTime(item: ReferenceItem): number {
  return timeValue(item.imported_at ?? item.created_at);
}

/** 색 필터 — colorMatch.scoreItemByColor 의 distance 가 임계 이하면 매칭.
 *  메인 앱 Color 필터와 동일 시맨틱(palette 의 어느 swatch 든 target 과
 *  충분히 가까우면 통과). */
export function matchesColor(item: ReferenceItem, hex: string): boolean {
  const palette = item.color_palette ?? [];
  if (palette.length === 0) return false;
  const score = scoreItemByColor(palette, hex);
  return score !== null && score.distance <= COLOR_FILTER_THRESHOLD;
}

function matchesQuery(item: ReferenceItem, q: string): boolean {
  if (item.title && item.title.toLowerCase().includes(q)) return true;
  for (const tag of nonFolderTags(item)) {
    if (tag.toLowerCase().includes(q)) return true;
  }
  if (item.notes && item.notes.toLowerCase().includes(q)) return true;
  const ai = item.ai_suggestions;
  if (ai) {
    const arrays = [
      ai.suggested_tags,
      ai.suggested_tags_ko,
      ai.mood_labels,
      ai.mood_labels_ko,
    ];
    for (const arr of arrays) {
      if (!arr) continue;
      for (const value of arr) {
        if (typeof value === "string" && value.toLowerCase().includes(q)) return true;
      }
    }
  }
  return false;
}

function inFolder(item: ReferenceItem, folderPath: string): boolean {
  const target = `${FOLDER_PREFIX}${folderPath}`;
  return (item.tags ?? []).some(
    (tag) => tag === target || tag.startsWith(`${target}/`),
  );
}

function sortItems(items: ReferenceItem[], sort: ViewerSort): ReferenceItem[] {
  const arr = [...items];
  switch (sort) {
    case "imported_asc":
      arr.sort((a, b) => importedTime(a) - importedTime(b));
      break;
    case "title":
      arr.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
      break;
    case "duration_desc":
      arr.sort((a, b) => (b.duration_sec ?? 0) - (a.duration_sec ?? 0));
      break;
    case "imported_desc":
    default:
      arr.sort((a, b) => importedTime(b) - importedTime(a));
      break;
  }
  return arr;
}

/** 메인 필터 파이프라인. 필터 통과 → 정렬. */
export function applyFilters(
  items: readonly ReferenceItem[],
  f: ViewerFilterState,
): ReferenceItem[] {
  const q = f.query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (f.kinds.size > 0 && !f.kinds.has(item.kind)) return false;
    if (f.folderPath && !inFolder(item, f.folderPath)) return false;
    if (f.tags.size > 0) {
      const owned = new Set(nonFolderTags(item));
      let anyMatch = false;
      for (const tag of f.tags) {
        if (owned.has(tag)) {
          anyMatch = true;
          break;
        }
      }
      if (!anyMatch) return false;
    }
    if (f.color && !matchesColor(item, f.color)) return false;
    if (q && !matchesQuery(item, q)) return false;
    return true;
  });
  return sortItems(filtered, f.sort);
}

/** 태그 빈도 집계 (TagChips 용). folder: 가상 태그 제외, 빈도 내림차순. */
export function tagFrequencies(
  items: readonly ReferenceItem[],
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of nonFolderTags(item)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** data.folders 부재 시 tags 의 "folder:" prefix 에서 폴더 트리를 재구성.
 *  중간(조상) 경로도 노드로 만들어 트리가 끊기지 않게 한다 — 직접 소속
 *  아이템이 없는 조상 폴더는 count 0. */
export function foldersFromTags(items: readonly ReferenceItem[]): ViewerFolderNode[] {
  const direct = new Map<string, number>();
  const allPaths = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (typeof tag !== "string" || !tag.startsWith(FOLDER_PREFIX)) continue;
      const full = tag.slice(FOLDER_PREFIX.length).replace(/^\/+|\/+$/g, "");
      if (!full) continue;
      direct.set(full, (direct.get(full) ?? 0) + 1);
      let acc = "";
      for (const seg of full.split("/")) {
        if (!seg) continue;
        acc = acc ? `${acc}/${seg}` : seg;
        allPaths.add(acc);
      }
    }
  }
  return [...allPaths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      count: direct.get(path) ?? 0,
    }));
}

/** 데이터에 존재하는 종류만 추려 (kind 토글 UI 용) 안정 순서로 반환. */
const KIND_ORDER: ReferenceKind[] = ["image", "webp", "gif", "video", "youtube", "link", "doc"];
export function presentKinds(items: readonly ReferenceItem[]): ReferenceKind[] {
  const present = new Set<ReferenceKind>();
  for (const item of items) present.add(item.kind);
  return KIND_ORDER.filter((kind) => present.has(kind));
}
