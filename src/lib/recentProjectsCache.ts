/**
 * 최근/알려진 프로젝트 캐시 — workspace 와 *무관하게* localStorage 에 유지.
 *
 * 사용 시나리오:
 *   - 사용자가 라이브러리 워크스페이스에서 자료를 우클릭 → "Brief 에 추가" 등
 *     선택 시, 어느 프로젝트로 보낼지 picker UI 가 떠야 한다. 그런데 라이브러리
 *     워크스페이스의 DB 는 `projects` 테이블이 비어 있어 (프로젝트는 다른
 *     워크스페이스의 DB 에 있음) DB 쿼리로 목록을 얻을 수 없다.
 *   - 이 캐시는 *사용자가 어떤 프로젝트를 방문한 적이 있는지* 의 가벼운 요약을
 *     workspace-independent localStorage 에 저장 → 라이브러리에서 picker 가
 *     이 캐시를 읽어 표시.
 *
 * 갱신 시점:
 *   - DashboardPage 가 프로젝트 목록을 fetch 한 직후 `recordProjects()` 호출.
 *   - 새 프로젝트 생성 직후 (`recordProjectVisit()`).
 *   - 프로젝트 진입 시 (`recordProjectVisit()`).
 *
 * 한계 (Phase 2 에서 보강):
 *   - 사용자가 한 번도 dashboard 를 안 본 프로젝트 워크스페이스 의 프로젝트는
 *     캐시에 없음 → picker 가 "최근 방문한 프로젝트가 없습니다" 안내.
 *   - 다중 프로젝트 워크스페이스: 마지막 활성 워크스페이스 의 프로젝트만 캐시.
 *     다른 워크스페이스로 한 번 들어갔다 나오면 그 워크스페이스의 프로젝트도
 *     캐시에 추가됨 (append).
 */

const STORAGE_KEY = "ff_recent_projects_v1";
const MAX_ENTRIES = 200; // ample headroom — list / search 에서 충분히 컷오프

export interface RecentProject {
  /** 캐시 키 = workspaceId + ":" + projectId. 동일 projectId 가 다른 워크스페이스
   *  에서 새로 생기는 경우는 거의 없지만, FK 안전을 위해 분리. */
  projectId: string;
  /** 이 프로젝트가 속한 워크스페이스 id — 사용자가 picker 에서 선택했을 때
   *  attach 직전에 해당 워크스페이스 정보를 확인하는 데 사용 (현재는 단순
   *  표시용; 향후 cross-workspace attach validation 에 사용). */
  workspaceId: string;
  /** 사용자가 알아볼 수 있는 제목. */
  title: string;
  /** 정렬 키 — 최근 방문 / 갱신 시점 (ms epoch). */
  lastSeenAt: number;
  /** 옵션 — UI 에 활성 상태로 표시할 때 (현재는 미사용). */
  isFavorite?: boolean;
}

type Cache = Record<string, RecentProject>;

function keyFor(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}`;
}

function readCache(): Cache {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Cache;
    }
    return {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  if (typeof window === "undefined") return;
  try {
    // 엔트리 수가 MAX 를 넘으면 lastSeenAt 오름차순으로 자른다 (오래된 거 버림).
    const entries = Object.entries(cache);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
      const trimmed: Cache = {};
      for (const [k, v] of entries.slice(0, MAX_ENTRIES)) trimmed[k] = v;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    }
  } catch {
    /* quota 초과 등 — best-effort */
  }
}

/** Dashboard 등에서 프로젝트 목록을 fetch 한 직후 일괄 호출. workspaceId 는
 *  현재 활성 워크스페이스. 호출 후 캐시는 그 워크스페이스의 *모든* 프로젝트로
 *  덮어쓰이지 않고 *추가/갱신* 만 한다 (다른 워크스페이스 항목은 보존). */
export function recordProjects(
  workspaceId: string,
  projects: Array<{ id: string; title?: string | null; updated_at?: string | null; last_visited_at?: string | null }>,
): void {
  if (!workspaceId || projects.length === 0) return;
  const cache = readCache();
  for (const p of projects) {
    if (!p.id) continue;
    const k = keyFor(workspaceId, p.id);
    const lastSeenAt = parseTime(p.last_visited_at) ?? parseTime(p.updated_at) ?? Date.now();
    const existing = cache[k];
    cache[k] = {
      projectId: p.id,
      workspaceId,
      title: p.title?.trim() || existing?.title || "(제목 없음)",
      lastSeenAt: Math.max(lastSeenAt, existing?.lastSeenAt ?? 0),
    };
  }
  writeCache(cache);
}

/** 단일 프로젝트 방문 기록 — 진입 시점이나 새로 만들었을 때. lastSeenAt = now. */
export function recordProjectVisit(workspaceId: string, project: { id: string; title?: string | null }): void {
  if (!workspaceId || !project.id) return;
  const cache = readCache();
  const k = keyFor(workspaceId, project.id);
  cache[k] = {
    projectId: project.id,
    workspaceId,
    title: project.title?.trim() || cache[k]?.title || "(제목 없음)",
    lastSeenAt: Date.now(),
  };
  writeCache(cache);
}

/** 최근 본 프로젝트 N 개 — lastSeenAt 내림차순. */
export function getRecentProjects(limit = 20): RecentProject[] {
  const cache = readCache();
  return Object.values(cache)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit);
}

/** 캐시 전체 비우기 (settings / 디버그 용). */
export function clearRecentProjects(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/** 특정 프로젝트를 캐시에서 제거 — 영구 삭제 시 호출. 캐시 키가
 *  `workspaceId:projectId` 라 같은 projectId 가 어느 워크스페이스에 있든
 *  모두 정리한다. 이게 빠져 있어 "삭제한 프로젝트가 라이브러리 picker /
 *  최근 항목에 계속 남아 데이터가 쌓이는" 누수가 있었다. */
export function removeRecentProject(projectId: string): void {
  if (!projectId) return;
  const cache = readCache();
  let changed = false;
  for (const k of Object.keys(cache)) {
    if (cache[k]?.projectId === projectId) {
      delete cache[k];
      changed = true;
    }
  }
  if (changed) writeCache(cache);
}

/** 주어진 워크스페이스의 캐시 엔트리를 현재 DB 에 실제 존재하는 프로젝트로
 *  reconcile — DB 에 없는(이미 삭제됐는데 캐시에만 남은) 엔트리를 제거한다.
 *  대시보드 fetch 시 호출해, 이 fix 이전에 쌓인 과거 zombie 엔트리까지 한 번에
 *  청소한다. 다른 워크스페이스의 엔트리는 건드리지 않는다 (key prefix 로 구분). */
export function reconcileWorkspaceProjects(workspaceId: string, knownProjectIds: string[]): void {
  if (!workspaceId) return;
  const known = new Set(knownProjectIds);
  const prefix = `${workspaceId}:`;
  const cache = readCache();
  let changed = false;
  for (const k of Object.keys(cache)) {
    if (!k.startsWith(prefix)) continue;
    if (!known.has(cache[k]?.projectId)) {
      delete cache[k];
      changed = true;
    }
  }
  if (changed) writeCache(cache);
}

function parseTime(input: string | null | undefined): number | null {
  if (!input) return null;
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}
