/**
 * 브리프 드래프트 + Conti Compare Library (localStorage) 스캐닝 으로
 * 라이브러리 자료의 cross-workspace 사용 카운트/위치를 집계.
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────
 * DB 테이블 `project_reference_links` 는 워크스페이스별 SQLite + FK
 * constraint 라서 라이브러리 워크스페이스(refs) ≠ 프로젝트 워크스페이스
 * (projects) 일 때 INSERT 가 silently 실패한다. 결과적으로 사용자가
 * "분명히 5번 Brief 로 보냈는데 라이브러리 카운트는 0" 으로 보이는
 * 미스매치가 발생.
 *
 * ── 우회 전략 ───────────────────────────────────────────────────────
 * 두 종류 LS 키를 스캔해 (refId, projectId, target) 트리플을 복원:
 *   - `ff_brief_draft_<projectId>` : 브리프 드래프트. refItems[].id 가
 *     `library_<refId>` 패턴이면 라이브러리 인용 (target=brief).
 *   - `ff_compare_lib_refs_<projectId>` : Conti Studio > Compare > 라이
 *     브러리 풀. entries[].id 자체가 raw refId (target=conti).
 *
 * DB 카운트와는 per-refId max 머지 — 같은 워크스페이스 안에서 attach 한
 * 경우 DB 와 LS 둘 다 보이지만 max 로 중복 카운트 방지. cross-workspace
 * 에서는 DB=0, LS=N → LS 가 폴백.
 *
 * ── 한계 (후속 phase 보강 예정) ────────────────────────────────────
 *   - conti-scene / conti-sketch / agent(promote) 는 별도 저장 경로라
 *     아직 미포함. 그쪽은 같은 워크스페이스 케이스가 많아 DB 카운트로
 *     어느 정도 잡힌다.
 *   - 다른 디바이스/계정에서는 안 보임 (localStorage 는 로컬). 추후
 *     중앙 link store 로 전환 시 자연 해결.
 *
 * ── 성능 ────────────────────────────────────────────────────────────
 * `localStorage.length` enumeration + `JSON.parse` per key. 일반적 사용
 * 자는 < 200 프로젝트, < 50KB / draft 라 50–200ms 수준. 호출 시점은
 * `runIdle` 안에서 (LibraryPage 의 usage counts fetch 와 같은 idle 콜백
 * 에 합류) — 첫 페인트 jank 없음.
 */

/** Brief 드래프트 localStorage 키 접두사 — `BriefTab.tsx` 의 LS_KEY 와
 *  반드시 동일해야 함. 동기화를 위해 상수를 export 하지 않고 *역방향
 *  파싱만 신뢰* 한다. 향후 BriefTab 의 LS 키 형식이 바뀌면 여기도 같이
 *  수정. */
const BRIEF_LS_KEY_PREFIX = "ff_brief_draft_";

/** Brief RefItem id 가 library 자료 인용임을 표시하는 접두사 — 마찬가지로
 *  `referenceToRefItem` 의 `library_${item.id}` 컨벤션과 반드시 일치. */
const REF_ID_PREFIX = "library_";

/** Conti Compare Library 풀 localStorage 키 접두사 — `compareLibraryStore`
 *  의 `compareLibraryLsKey` 와 반드시 동일. 본 모듈은 *역방향 파싱만
 *  신뢰* 정책 (briefRefUsageScan 동일) 이라 상수 import 대신 prefix 만
 *  재선언한다. Brief 와 달리 entry.id 가 raw refId 그 자체. */
const CONTI_LS_KEY_PREFIX = "ff_compare_lib_refs_";

/** 에셋 승격 추적 localStorage 키 접두사. promote 는 별도 워크스페이스 DB 에
 *  assets row 를 만들기 때문에(cross-workspace) 라이브러리에서 "어느 프로젝트의
 *  에셋이 됐는지" 를 DB 로는 못 본다. Brief/Conti 와 동일하게 LS 로 (refId,
 *  projectId, target=asset) 를 복원한다.
 *
 *  값 포맷: `Record<refId, assetId[]>` — refId 가 그 프로젝트에서 어떤 assetId 들
 *  로 승격됐는지까지 추적한다. 그래야 프로젝트 쪽에서 *특정 에셋만* 삭제됐을 때
 *  그 assetId 만 빼고, 같은 ref 로 만든 다른 에셋이 남아 있으면 연결을 유지할 수
 *  있다.
 *  레거시(이전 세션) 포맷: `string[]` (refId 배열, assetId 미상). 읽을 때
 *  `{ refId: [] }` 로 정규화한다 — 연결(라인)은 표시하되 카운트는 0(재승격 시 보정). */
const ASSET_LS_KEY_PREFIX = "ff_promoted_refs_";

export type RefUsageTarget = "brief" | "conti" | "asset";

/** 승격된 에셋 1개 — id + (선택) asset_type(character|item|background). */
type PromotedAssetEntry = { id: string; type?: string };
type PromotedRefMap = Record<string, PromotedAssetEntry[]>;

/** LS 값을 `Record<refId, {id,type?}[]>` 로 정규화. 세 포맷 호환:
 *   - 신규: `Record<refId, {id,type}[]>`
 *   - 중간: `Record<refId, string[]>` (assetId 문자열, type 미상)
 *   - 레거시: `string[]` (refId 배열, assetId 미상 → 빈 배열) */
function readPromotedRefMap(projectId: string): PromotedRefMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`${ASSET_LS_KEY_PREFIX}${projectId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const out: PromotedRefMap = {};
      for (const refId of parsed) if (typeof refId === "string" && refId) out[refId] = [];
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: PromotedRefMap = {};
      for (const [refId, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (!refId) continue;
        if (!Array.isArray(val)) {
          out[refId] = [];
          continue;
        }
        out[refId] = val
          .map((x): PromotedAssetEntry | null => {
            if (typeof x === "string") return { id: x };
            if (x && typeof x === "object" && typeof (x as any).id === "string") {
              const t = (x as any).type;
              return { id: (x as any).id, type: typeof t === "string" ? t : undefined };
            }
            return null;
          })
          .filter((e): e is PromotedAssetEntry => e !== null);
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writePromotedRefMap(projectId: string, map: PromotedRefMap): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${ASSET_LS_KEY_PREFIX}${projectId}`;
    if (Object.keys(map).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* best-effort (quota 등) */
  }
}

/** 라이브러리 자료를 프로젝트 에셋으로 승격할 때 호출 — (projectId, refId, assetId,
 *  assetType) 을 LS 에 기록해 인스펙터의 "사용 위치"/"생성됨"/타입 뱃지에 표시한다.
 *  cross-workspace 여도 LS 는 origin 단위라 양쪽에서 보인다. */
export function recordPromotedRefUsage(projectId: string, refId: string, assetId: string, assetType?: string): void {
  if (typeof window === "undefined" || !projectId || !refId || !assetId) return;
  const map = readPromotedRefMap(projectId);
  const entries = map[refId] ?? (map[refId] = []);
  const existing = entries.find((e) => e.id === assetId);
  if (existing) {
    if (assetType) existing.type = assetType;
  } else {
    entries.push({ id: assetId, type: assetType });
  }
  writePromotedRefMap(projectId, map);
}

/** 프로젝트에서 에셋이 삭제될 때 호출 — 해당 assetId 를 추적에서 제거한다.
 *  그 ref 로 만든 마지막 에셋이 사라지면 연결(라인/카운트/뱃지) 자체가 끊긴다. */
export function removePromotedAssetUsage(projectId: string, refId: string, assetId: string): void {
  if (typeof window === "undefined" || !projectId || !refId) return;
  const map = readPromotedRefMap(projectId);
  if (!(refId in map)) return;
  const next = (map[refId] ?? []).filter((e) => e.id !== assetId);
  if (next.length === 0) delete map[refId];
  else map[refId] = next;
  writePromotedRefMap(projectId, map);
}

/** 특정 refId 가 전체 프로젝트에 걸쳐 몇 개의 에셋으로 승격돼 있는지(LS 기준).
 *  레거시 항목(빈 배열)은 최소 1로 센다(연결은 분명히 존재). */
export function countPromotedAssetsForRef(refId: string): number {
  if (typeof window === "undefined" || !refId) return 0;
  let total = 0;
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key || !key.startsWith(ASSET_LS_KEY_PREFIX)) continue;
      const projectId = key.slice(ASSET_LS_KEY_PREFIX.length);
      if (!projectId) continue;
      const map = readPromotedRefMap(projectId);
      if (refId in map) total += Math.max(map[refId].length, 1);
    }
  } catch {
    /* best-effort */
  }
  return total;
}

export interface BriefRefUsageLocation {
  projectId: string;
  /** Brief: refItems 내 중복 인용 카운트 (dedupe 정상 동작 시 1).
   *  Conti: Compare 라이브러리 풀의 entries 중복은 store 가 dedup 하므로
   *  항상 1. 호환을 위해 동일 필드 유지. */
  count: number;
  /** 어떤 target 으로 attach 된 흔적인지 — Inspector 라벨 분기에 사용.
   *  기본 "brief" (기존 호출처 호환). */
  target: RefUsageTarget;
  /** target="asset" 일 때, 이 프로젝트에서 그 ref 로 승격된 distinct asset_type
   *  목록(character|item|background). 인스펙터 '에셋(캐릭터)' 등 표기에 사용. */
  assetTypes?: string[];
}

export interface BriefRefUsageScanResult {
  /** referenceId → 어느 프로젝트/target 조합에 들어 있는지. */
  byRefId: Record<string, BriefRefUsageLocation[]>;
  /** referenceId → distinct (projectId, target) 수.
   *  DB 카운트와 비교/머지 (max) 하기 좋게 분리 보관. */
  countsByRefId: Record<string, number>;
}

const EMPTY_RESULT: BriefRefUsageScanResult = { byRefId: {}, countsByRefId: {} };

/** localStorage 의 `ff_brief_draft_*` 키를 모두 읽어 `library_<refId>`
 *  패턴 인용을 집계.
 *
 *  실패 (JSON.parse / quota / SecurityError) 는 silently skip — 라이브러
 *  리 자체는 동작해야 하므로 best-effort. */
export function scanBriefRefUsageFromLocalStorage(): BriefRefUsageScanResult {
  if (typeof window === "undefined") return EMPTY_RESULT;

  const byRefId: Record<string, BriefRefUsageLocation[]> = {};
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key || !key.startsWith(BRIEF_LS_KEY_PREFIX)) continue;
      const projectId = key.slice(BRIEF_LS_KEY_PREFIX.length);
      if (!projectId) continue;

      const raw = ls.getItem(key);
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 손상된 draft — skip.
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const refItems = (parsed as { refItems?: unknown }).refItems;
      if (!Array.isArray(refItems)) continue;

      // 한 프로젝트 안에서 refId 별 count 집계 후 byRefId 에 push.
      const seen = new Map<string, number>();
      for (const r of refItems) {
        if (!r || typeof r !== "object") continue;
        const id = (r as { id?: unknown }).id;
        if (typeof id !== "string" || !id.startsWith(REF_ID_PREFIX)) continue;
        const refId = id.slice(REF_ID_PREFIX.length);
        if (!refId) continue;
        seen.set(refId, (seen.get(refId) ?? 0) + 1);
      }
      for (const [refId, count] of seen) {
        const arr = byRefId[refId] ?? (byRefId[refId] = []);
        arr.push({ projectId, count, target: "brief" });
      }
    }
  } catch (err) {
    console.warn("[briefRefUsageScan] LS enumeration failed", err);
    return EMPTY_RESULT;
  }

  const countsByRefId: Record<string, number> = {};
  for (const [refId, arr] of Object.entries(byRefId)) {
    countsByRefId[refId] = arr.length;
  }
  return { byRefId, countsByRefId };
}

/** localStorage 의 `ff_compare_lib_refs_*` 키를 모두 읽어 Conti Studio
 *  Compare > Library 풀에 들어 있는 라이브러리 자료 인용을 집계.
 *
 *  Brief 스캐너와 달리:
 *   - entry.id 자체가 raw refId (Brief 처럼 `library_` prefix 없음).
 *   - 중복 entries 는 `compareLibraryStore.appendCompareLibraryEntries`
 *     의 dedup 가 막아 항상 count=1. 외부 편집 가능성 대비 카운트는
 *     유지하지만 사실상 1.
 *
 *  실패 (JSON.parse / quota / SecurityError) 는 silently skip — Brief 와
 *  동일 best-effort 정책. */
export function scanContiCompareLibraryUsageFromLocalStorage(): BriefRefUsageScanResult {
  if (typeof window === "undefined") return EMPTY_RESULT;

  const byRefId: Record<string, BriefRefUsageLocation[]> = {};
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key || !key.startsWith(CONTI_LS_KEY_PREFIX)) continue;
      const projectId = key.slice(CONTI_LS_KEY_PREFIX.length);
      if (!projectId) continue;

      const raw = ls.getItem(key);
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      // compareLibraryStore 의 entries 는 CompareLibraryEntry[] 형태.
      // 레거시 string[] (id-only) 데이터는 store 에서 빈 배열로 폴백
      // 처리되므로 여기서도 무시 (entry shape 검증으로 자연 필터).
      if (!Array.isArray(parsed)) continue;

      const seen = new Map<string, number>();
      for (const e of parsed) {
        if (!e || typeof e !== "object") continue;
        const id = (e as { id?: unknown }).id;
        if (typeof id !== "string" || !id) continue;
        // Conti entry 의 id 는 raw refId (Brief 의 library_ prefix 와
        // 다름). compareLibraryStore.isEntry 와 동일한 최소 검증.
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      for (const [refId, count] of seen) {
        const arr = byRefId[refId] ?? (byRefId[refId] = []);
        arr.push({ projectId, count, target: "conti" });
      }
    }
  } catch (err) {
    console.warn("[briefRefUsageScan] Conti LS enumeration failed", err);
    return EMPTY_RESULT;
  }

  const countsByRefId: Record<string, number> = {};
  for (const [refId, arr] of Object.entries(byRefId)) {
    countsByRefId[refId] = arr.length;
  }
  return { byRefId, countsByRefId };
}

/** localStorage 의 `ff_promoted_refs_*` 키를 모두 읽어 어떤 라이브러리 자료가
 *  어느 프로젝트의 에셋으로 승격됐는지 집계 (target=asset). 값은 refId 배열. */
export function scanPromotedAssetUsageFromLocalStorage(): BriefRefUsageScanResult {
  if (typeof window === "undefined") return EMPTY_RESULT;

  const byRefId: Record<string, BriefRefUsageLocation[]> = {};
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key || !key.startsWith(ASSET_LS_KEY_PREFIX)) continue;
      const projectId = key.slice(ASSET_LS_KEY_PREFIX.length);
      if (!projectId) continue;

      const map = readPromotedRefMap(projectId);
      for (const refId of Object.keys(map)) {
        // key 존재 = 그 프로젝트에 이 ref 로 만든 에셋이 (최소 1개) 있다는 뜻.
        // 마지막 에셋이 삭제되면 removePromotedAssetUsage 가 key 를 지워 연결이 끊긴다.
        const entries = map[refId];
        const assetTypes = [...new Set(entries.map((e) => e.type).filter((t): t is string => !!t))];
        const arr = byRefId[refId] ?? (byRefId[refId] = []);
        arr.push({ projectId, count: Math.max(entries.length, 1), target: "asset", assetTypes });
      }
    }
  } catch (err) {
    console.warn("[briefRefUsageScan] Asset LS enumeration failed", err);
    return EMPTY_RESULT;
  }

  const countsByRefId: Record<string, number> = {};
  for (const [refId, arr] of Object.entries(byRefId)) {
    countsByRefId[refId] = arr.length;
  }
  return { byRefId, countsByRefId };
}

/** Brief + Conti 스캔을 한 번에 돌려 합친 결과를 반환한다.
 *
 *  - byRefId : refId 별 두 스캐너의 location 배열을 *concat*. 같은
 *    (projectId, target) 페어가 두 스캔에서 동시에 나올 수는 없으므로
 *    중복 위험 없음 (target prefix 가 LS 키 prefix 와 1:1 대응).
 *  - countsByRefId : refId 별 *합* — Brief 1 + Conti 1 = 2. Inspector
 *    의 "N개 프로젝트에서 사용 중" 라벨이 (project, target) 페어를
 *    세는 DB 카운트 정책과 일관.
 *
 *  호출처: LibraryPage 의 LS 스캔 3 군데 (캐시 hit/miss runIdle 및
 *  refresh 콜백) 가 모두 이 헬퍼 하나만 부르면 brief/conti 양쪽 다
 *  반영된다. */
export function scanAllUsageFromLocalStorage(): BriefRefUsageScanResult {
  const brief = scanBriefRefUsageFromLocalStorage();
  const conti = scanContiCompareLibraryUsageFromLocalStorage();
  const asset = scanPromotedAssetUsageFromLocalStorage();
  const byRefId: Record<string, BriefRefUsageLocation[]> = {};
  for (const [refId, arr] of Object.entries(brief.byRefId)) {
    byRefId[refId] = [...arr];
  }
  for (const src of [conti.byRefId, asset.byRefId]) {
    for (const [refId, arr] of Object.entries(src)) {
      const prev = byRefId[refId];
      byRefId[refId] = prev ? [...prev, ...arr] : [...arr];
    }
  }
  const countsByRefId: Record<string, number> = {};
  for (const [refId, arr] of Object.entries(byRefId)) {
    countsByRefId[refId] = arr.length;
  }
  return { byRefId, countsByRefId };
}

/** DB 카운트 (project_reference_links) 와 LS 스캔 카운트를 합쳐 반환.
 *
 *  정책: per-refId `max(db, ls)`.
 *  - 같은 워크스페이스 안에서 attach 한 경우: DB 와 LS 둘 다 같은 값.
 *    max 로 중복 카운트 방지.
 *  - cross-workspace: DB=0, LS=N → 결과 N.
 *  - LS 가 비어 있고 DB 만 있는 케이스 (예: conti/promote 사용): DB
 *    그대로 보존.
 *
 *  완벽한 합산 (워크스페이스별 분리 추적) 은 LS 스키마 확장이 필요한데,
 *  Phase 1 에선 사용자가 체감하는 "보였다 안 보였다 미스매치" 만 우선
 *  해결하는 게 목표. */
export function mergeUsageCounts(
  dbCounts: Record<string, number>,
  lsCounts: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...dbCounts };
  for (const [refId, n] of Object.entries(lsCounts)) {
    const prev = merged[refId] ?? 0;
    if (n > prev) merged[refId] = n;
  }
  return merged;
}
