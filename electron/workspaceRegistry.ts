// ── Workspace registry ─────────────────────────────────────────────
// `<userData>/workspaces.json` 의 주(primary) 진실원. 부팅 시 1 회 read/
// sanitize 후 메모리에 캐시하고, 모든 mutation 은 이 모듈을 거쳐 디스크에
// 즉시 flush 된다.
//
// 견고성을 위한 이중화:
//   1) save 시 main + `workspaces.bak.json` 두 파일을 atomic write — main 이
//      외부 도구/사용자 실수로 사라지거나 손상돼도 마지막 정상 스냅샷이 옆에
//      남는다. load 는 main → backup → empty 순서로 폴백.
//   2) bootstrap 직후 메타파일 기반 자동 복구 — `.preflow-workspace.json` 가
//      있는 형제 폴더(`appData/preflow-*` 등)를 스캔해 한 파일 손실로 모든
//      커스텀 워크스페이스가 영구히 사라지는 사고를 막는다.
//
// 의도적으로 작은 모듈 — Electron API 의존성을 최소화하고 (path/fs 만 사용)
// `userDataDir` 을 인자로 받기 때문에, 부팅 시점이나 단위 테스트에서 임의
// 디렉터리를 가리켜 동작 시키기 쉽다. `app.getPath("userData")` 의존을
// 호출자(`workspace.ts`/`main.ts`) 로 밀어 둠.

import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

import {
  REGISTRY_BACKUP_FILENAME,
  REGISTRY_FILENAME,
  WORKSPACE_META_FILENAME,
  type WorkspaceKind,
  type WorkspaceLastActive,
  type WorkspaceMeta,
  type WorkspaceRegistry,
} from "../shared/workspace";

const DEFAULT_PROJECT_NAME = "Default Projects";
const DEFAULT_LIBRARY_NAME = "Default Library";

let cache: { dir: string; data: WorkspaceRegistry } | null = null;

function registryPath(userDataDir: string): string {
  return path.join(userDataDir, REGISTRY_FILENAME);
}

function registryBackupPath(userDataDir: string): string {
  return path.join(userDataDir, REGISTRY_BACKUP_FILENAME);
}

function emptyRegistry(): WorkspaceRegistry {
  return { version: 1, active: null, lastActive: {}, workspaces: [] };
}

/** sanitize 시 lastActive 슬롯을 파싱. workspaces 에 실재하는 ID 만 살리고
 *  타입이 어긋나거나 가리키는 워크스페이스가 사라졌으면 슬롯을 빈 값으로
 *  떨어뜨린다 — quick-switch 가 stale ID 로 잘못 점프하지 않도록. */
function sanitizeLastActive(
  raw: unknown,
  workspaces: WorkspaceMeta[],
): WorkspaceLastActive {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: WorkspaceLastActive = {};
  for (const kind of ["project", "library"] as const) {
    const id = source[kind];
    if (typeof id === "string") {
      const found = workspaces.find((w) => w.id === id && w.kind === kind);
      if (found) out[kind] = id;
    }
  }
  return out;
}

/** Type-guard 보다 가벼운 sanitize. 손상된 JSON 이거나 schema 가 어긋나면
 *  빈 레지스트리로 fallback 해서 부트스트랩이 다시 default 두 개를 채운다.
 *  사용자에게 경고는 stderr 로만 — UI 까지 끌고 가지 않는다. */
function sanitize(parsed: unknown): WorkspaceRegistry {
  if (!parsed || typeof parsed !== "object") return emptyRegistry();
  const obj = parsed as Partial<WorkspaceRegistry>;
  if (obj.version !== 1) return emptyRegistry();
  if (!Array.isArray(obj.workspaces)) return emptyRegistry();
  const ws: WorkspaceMeta[] = [];
  for (const candidate of obj.workspaces) {
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as WorkspaceMeta).id === "string" &&
      typeof (candidate as WorkspaceMeta).path === "string" &&
      ((candidate as WorkspaceMeta).kind === "project" ||
        (candidate as WorkspaceMeta).kind === "library") &&
      typeof (candidate as WorkspaceMeta).name === "string"
    ) {
      ws.push({ ...(candidate as WorkspaceMeta) });
    }
  }
  const active =
    typeof obj.active === "string" && ws.some((w) => w.id === obj.active)
      ? obj.active
      : null;
  const lastActive = sanitizeLastActive(obj.lastActive, ws);
  return { version: 1, active, lastActive, workspaces: ws };
}

/** registry 파일 한 개를 안전하게 읽는다. 없거나/손상되었으면 null 반환 —
 *  호출자가 backup → bootstrap 순으로 폴백 결정. */
function tryReadRegistryFile(file: string): WorkspaceRegistry | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const parsed = sanitize(JSON.parse(raw));
    // 빈 registry 는 의미 있는 데이터로 간주하지 않음 — 백업으로 폴백 시도.
    if (parsed.workspaces.length === 0) return null;
    return parsed;
  } catch (err) {
    console.error(`[workspace-registry] failed to read ${file}:`, err);
    return null;
  }
}

function loadFromDisk(userDataDir: string): WorkspaceRegistry {
  // 주 파일 → 백업 파일 순으로 시도. 둘 다 비어/손상이면 빈 registry 반환 →
  // 부트스트랩이 default 두 개를 채우고, 그 직후 auto-recover 가 디스크에
  // 남아 있는 메타파일 기반 워크스페이스를 다시 등록한다.
  const main = tryReadRegistryFile(registryPath(userDataDir));
  if (main) return main;
  const backup = tryReadRegistryFile(registryBackupPath(userDataDir));
  if (backup) {
    console.warn(
      "[workspace-registry] main registry unreadable/empty — recovered from backup",
    );
    return backup;
  }
  return emptyRegistry();
}

function saveToDisk(userDataDir: string, data: WorkspaceRegistry): void {
  // atomic write: tmp + rename. OneDrive 동기화 중간에 0-byte 로 잡히는 상황을
  // 피한다. main 과 동시에 동일 내용의 .bak 도 atomic 으로 갱신해 두면, main
  // 파일이 외부 도구/사용자 실수로 사라지거나 손상돼도 마지막 정상 스냅샷이
  // 옆에 남는다. 두 번째 write 가 실패해도 main 은 이미 갱신되어 있어 사용자
  // 흐름은 정상.
  const payload = JSON.stringify(data, null, 2);
  const file = registryPath(userDataDir);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
  try {
    const bakFile = registryBackupPath(userDataDir);
    const bakTmp = bakFile + ".tmp";
    fs.writeFileSync(bakTmp, payload, "utf8");
    fs.renameSync(bakTmp, bakFile);
  } catch (err) {
    console.warn("[workspace-registry] backup write failed (non-fatal):", err);
  }
}

/** 갓 설치 / 손상 후 재설정 시 default 두 개를 등록한다. 둘 다 같은
 *  userData 경로를 가리키며, 기존 단일 DB 가 그대로 활용된다. */
function bootstrapDefaults(userDataDir: string, data: WorkspaceRegistry): WorkspaceRegistry {
  if (data.workspaces.length > 0) return data;
  const projectId = "default-projects";
  const libraryId = "default-library";
  const now = new Date().toISOString();
  data.workspaces = [
    {
      id: projectId,
      kind: "project",
      name: DEFAULT_PROJECT_NAME,
      path: userDataDir,
      isDefault: true,
      createdAt: now,
      schemaVersion: 1,
    },
    {
      id: libraryId,
      kind: "library",
      name: DEFAULT_LIBRARY_NAME,
      path: userDataDir,
      isDefault: true,
      createdAt: now,
      schemaVersion: 1,
    },
  ];
  data.active = projectId;
  // 첫 부팅에서도 quick-switch 가 자연스럽게 작동하도록 default 두 짝을
  // 시드. activateWorkspace 가 한 번도 안 불려도 사용자가 아이콘을 누르면
  // 반대 kind 의 default 로 즉시 점프할 수 있다.
  data.lastActive = { project: projectId, library: libraryId };
  return data;
}

/** 폴더 안의 `.preflow-workspace.json` 메타가 잘 정의되어 있으면 그 내용을
 *  반환. 메타파일이 없거나 schema 가 어긋나면 null — 호출자가 skip.
 *
 *  default 워크스페이스 폴더는 메타파일을 만들지 않기 때문에 자연스럽게
 *  자동 복구 후보에서 제외되고, 4월 archive 폴더처럼 그저 userData 백업
 *  스냅샷인 폴더도 메타가 없어 무시된다 — 의도된 동작. */
function readWorkspaceMeta(folder: string): {
  id?: string;
  kind: WorkspaceKind;
  name: string;
  createdAt?: string;
} | null {
  const file = path.join(folder, WORKSPACE_META_FILENAME);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const kind = parsed.kind;
    if (kind !== "project" && kind !== "library") return null;
    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
    if (!name) return null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      kind,
      name,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
    };
  } catch (err) {
    console.warn(`[workspace-registry] unreadable meta at ${file}:`, err);
    return null;
  }
}

/** registry 가 (재) bootstrap 된 직후 호출. 사용자가 만든 커스텀 워크스페이
 *  스 폴더는 자기 안에 `.preflow-workspace.json` 메타를 갖고 있으므로, 그
 *  메타파일이 발견되면 registry 에 다시 등록해 "registry 파일만 잃어버려서
 *  모든 워크스페이스가 사라지는" 사고를 막는다.
 *
 *  검색 범위는 두 곳:
 *    1) userData 디렉터리 자체의 직속 자식 폴더 — 사용자가 userData 안에
 *       워크스페이스를 둔 경우(이례적이지만).
 *    2) userData 디렉터리의 부모(`appData`)의 형제 폴더 — Electron 의
 *       이전 버전이나 사용자가 휴리스틱하게 옆에 둔 워크스페이스.
 *
 *  Desktop/Documents/OneDrive 등 임의 위치는 검색 범위에 포함시키지 않는다 —
 *  사용자가 명시적으로 "Add Workspace" 흐름을 거치지 않은 폴더를 자동
 *  등록하는 건 신뢰 경계 침범. 그런 워크스페이스는 백업 파일 폴백(2중 저장)
 *  으로 회복되거나, 사용자가 다시 Add 다이얼로그로 등록하면 된다. */
function discoverNearbyWorkspaces(userDataDir: string): Array<{
  meta: NonNullable<ReturnType<typeof readWorkspaceMeta>>;
  folderPath: string;
}> {
  const candidates: string[] = [];
  const pushDirChildren = (parent: string) => {
    if (!fs.existsSync(parent)) return;
    try {
      const entries = fs.readdirSync(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(parent, entry.name);
        // userData 폴더 자체는 default 워크스페이스 폴더라 메타가 없음 —
        // skip 해도 어차피 readWorkspaceMeta 가 null. 굳이 명시적 skip 안 함.
        candidates.push(full);
      }
    } catch (err) {
      console.warn(`[workspace-registry] cannot enumerate ${parent}:`, err);
    }
  };
  pushDirChildren(userDataDir);
  pushDirChildren(path.dirname(userDataDir));

  const seen = new Set<string>();
  const found: Array<{ meta: NonNullable<ReturnType<typeof readWorkspaceMeta>>; folderPath: string }> = [];
  for (const folder of candidates) {
    const resolved = path.resolve(folder);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const meta = readWorkspaceMeta(folder);
    if (!meta) continue;
    found.push({ meta, folderPath: resolved });
  }
  return found;
}

/** 발견된 후보들을 registry 에 머지. 이미 같은 path/kind 쌍이 등록되어 있으면
 *  skip. 새로 추가된 항목 개수를 반환. */
function mergeDiscoveredWorkspaces(
  data: WorkspaceRegistry,
  discovered: ReturnType<typeof discoverNearbyWorkspaces>,
): { added: number; restoredNames: string[] } {
  let added = 0;
  const restored: string[] = [];
  for (const { meta, folderPath } of discovered) {
    const normalized = path.resolve(folderPath);
    const collision = data.workspaces.find(
      (w) => path.resolve(w.path) === normalized && w.kind === meta.kind,
    );
    if (collision) continue;
    // 메타파일에 적힌 id 가 있으면 그걸 재사용(다른 PC 와 동일 ID 유지) — 그
    // id 가 이미 다른 entry 에 잡혀 있으면 새 UUID 발급.
    const conflictId = meta.id && data.workspaces.some((w) => w.id === meta.id);
    const id = meta.id && !conflictId ? meta.id : randomUUID();
    data.workspaces.push({
      id,
      kind: meta.kind,
      name: meta.name,
      path: normalized,
      isDefault: false,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      schemaVersion: 1,
    });
    added += 1;
    restored.push(`${meta.name} (${meta.kind})`);
  }
  return { added, restoredNames: restored };
}

/** PREFLOW_PROFILE 분리 도입 시점의 1 회 마이그레이션.
 *
 *  사연: PREFLOW_PROFILE=dev 가 적용되면 userData 가 `appData/preflow-dev/`
 *  로 갈라져, 이전까지 production userData(`appData/preflow/`) 에 등록되어
 *  있던 외부 워크스페이스가 dev profile 첫 부팅 시 popover 에서 안 보인다.
 *  폴더/DB 자체는 안전하지만 사용자 입장에선 "다 사라진" 인상.
 *
 *  여기서는 **현 profile 의 registry 파일이 main/bak 둘 다 없을 때만**
 *  production profile(`appData/preflow/`) 의 registry 를 base 로 한 번
 *  복사해 둔다. 두 번째 부팅부터는 자기 파일이 있으니 가드가 막아 no-op —
 *  두 profile 은 이후 완전히 독립적으로 진화한다.
 *
 *  복사 정책 (격리 원칙 보존):
 *    · isDefault=true 워크스페이스는 제외. 그들의 path 는 production userData
 *      를 가리켜 그대로 가져오면 dev 가 production DB 를 직접 열게 됨 →
 *      격리 위반. dev 의 default 두 개는 아래에서 현 userData 를 가리키도록
 *      새로 만들어 prepend.
 *    · active 가 production 에서 외부 워크스페이스였다면 그대로 승계.
 *      default 였거나 unresolvable 이면 dev 의 default-projects 로 폴백.
 *    · production → 다른 profile 단방향. production 자신은 다른 profile 의
 *      데이터를 끌어오지 않는다 (dirName === "preflow" 가드).
 *    · 직접적인 임의 profile 간 import 도 없다 — 항상 production 한 곳만 base.
 *      사용자가 staging/qa 를 production 과 *의도적으로* 분리한 경우라도
 *      "처음 한 번은 production 에서 시작" 이 자연스러운 출발점. */
function maybeImportSiblingProfile(userDataDir: string): void {
  // 자기 registry 가 이미 있으면 — main 이든 bak 이든 — 첫 부팅이 아님.
  if (fs.existsSync(registryPath(userDataDir))) return;
  if (fs.existsSync(registryBackupPath(userDataDir))) return;

  // production profile 자신은 import 발동 안 함. 단방향 정책.
  const dirName = path.basename(userDataDir);
  if (dirName === "preflow") return;
  // named profile 만 import 후보. 임의 경로(테스트 디렉터리 등) 는 자기
  // 부트스트랩 흐름을 그대로 타게 둔다.
  if (!dirName.startsWith("preflow-")) return;

  const siblingDir = path.join(path.dirname(userDataDir), "preflow");
  if (path.resolve(siblingDir) === path.resolve(userDataDir)) return;

  const source =
    tryReadRegistryFile(path.join(siblingDir, REGISTRY_FILENAME)) ??
    tryReadRegistryFile(path.join(siblingDir, REGISTRY_BACKUP_FILENAME));
  if (!source) return;

  const nonDefaults = source.workspaces.filter((w) => !w.isDefault);
  // 가져올 외부 워크스페이스가 하나도 없다면 굳이 마이그레이션 흔적을
  // 남기지 않고 평소 bootstrap 흐름에 맡긴다.
  if (nonDefaults.length === 0) return;

  const now = new Date().toISOString();
  const importedWorkspaces: WorkspaceMeta[] = [
    {
      id: "default-projects",
      kind: "project",
      name: DEFAULT_PROJECT_NAME,
      path: userDataDir,
      isDefault: true,
      createdAt: now,
      schemaVersion: 1,
    },
    {
      id: "default-library",
      kind: "library",
      name: DEFAULT_LIBRARY_NAME,
      path: userDataDir,
      isDefault: true,
      createdAt: now,
      schemaVersion: 1,
    },
    ...nonDefaults,
  ];
  // production 의 lastActive 슬롯이 dev 의 새 workspaces 안에 그대로
  // 매핑되는지 확인 — default 두 짝의 ID 가 동일("default-projects" /
  // "default-library") 이라 production 이 default 를 마지막으로 썼던 경우도
  // 자연스럽게 살아남는다. 비어 있는 슬롯은 dev default 로 디딤돌 시드.
  const importedLastActive = sanitizeLastActive(
    source.lastActive,
    importedWorkspaces,
  );
  const imported: WorkspaceRegistry = {
    version: 1,
    workspaces: importedWorkspaces,
    active:
      source.active && nonDefaults.some((w) => w.id === source.active)
        ? source.active
        : "default-projects",
    lastActive: {
      project: importedLastActive.project ?? "default-projects",
      library: importedLastActive.library ?? "default-library",
    },
  };

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    saveToDisk(userDataDir, imported);
    console.warn(
      `[workspace-registry] first-boot import: copied ${nonDefaults.length} workspace(s) ` +
        `from production profile (${siblingDir}). The two profiles are now independent.`,
    );
  } catch (err) {
    // 실패해도 평소 bootstrap 흐름이 이어 받아 default 두 개로 정상 부팅됨 —
    // 사용자에겐 "외부 워크스페이스 안 보이는" 정도의 영향만.
    console.warn("[workspace-registry] sibling-profile import failed (non-fatal):", err);
  }
}

/** Public — 부팅 시 1 회 호출. 디스크에서 읽고 (없으면) 부트스트랩하고
 *  메모리 캐시에 저장. 부트스트랩 직후 메타파일 자동 복구 단계를 거쳐
 *  사용자가 만든 커스텀 워크스페이스가 한 파일 손실로 영구히 사라지지 않게
 *  한다. */
export function ensureRegistry(userDataDir: string): WorkspaceRegistry {
  if (cache && cache.dir === userDataDir) return cache.data;
  // PREFLOW_PROFILE 분리 도입 후 첫 부팅이면 production 의 registry 를 1 회
  // 베이스로 복사. loadFromDisk 가 그 복사본을 자기 데이터로 읽어 통상 흐름
  // 그대로 진행된다.
  maybeImportSiblingProfile(userDataDir);
  const loaded = loadFromDisk(userDataDir);
  const bootstrapped = bootstrapDefaults(userDataDir, loaded);

  // bootstrap 직후 (또는 정상 load 후라도) 메타파일 기반 자동 복구. 후자의
  // 경우 보통 collision 으로 모두 skip 되어 no-op.
  const discovered = discoverNearbyWorkspaces(userDataDir);
  const { added, restoredNames } = mergeDiscoveredWorkspaces(bootstrapped, discovered);
  if (added > 0) {
    console.warn(
      `[workspace-registry] auto-recovered ${added} workspace(s) from disk meta files: ${restoredNames.join(
        ", ",
      )}`,
    );
  }

  saveToDisk(userDataDir, bootstrapped);
  cache = { dir: userDataDir, data: bootstrapped };
  return bootstrapped;
}

export function getRegistry(): WorkspaceRegistry {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  return cache.data;
}

/** Mutation 후 호출 — 캐시에 저장 + 디스크에 atomic flush. */
function persist(): void {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  saveToDisk(cache.dir, cache.data);
}

export function findWorkspace(id: string): WorkspaceMeta | null {
  if (!cache) return null;
  return cache.data.workspaces.find((w) => w.id === id) ?? null;
}

export function getActiveId(): string | null {
  return cache?.data.active ?? null;
}

export function setActiveId(id: string | null): void {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  if (id !== null && !cache.data.workspaces.some((w) => w.id === id)) {
    throw new Error(`unknown workspace id: ${id}`);
  }
  cache.data.active = id;
  // active 가 갱신될 때 그 kind 슬롯에도 같은 ID 를 기록 — quick-switch 가
  // 반대 kind 슬롯을 보고 "최근 사용" 으로 점프할 수 있도록. id 가 null 일
  // 때는 lastActive 는 그대로 보존(직전 두 슬롯의 기억을 비우지 않는다).
  if (id !== null) {
    const ws = cache.data.workspaces.find((w) => w.id === id);
    if (ws) {
      if (!cache.data.lastActive) cache.data.lastActive = {};
      cache.data.lastActive[ws.kind] = id;
    }
  }
  persist();
}

/** kind 별 마지막 활성 ID 를 반환. 슬롯이 없거나 그 ID 의 워크스페이스가
 *  이미 unregister/삭제 됐으면 null. WorkspaceSwitcher 의 quick-switch 가
 *  "반대 kind 의 최근 워크스페이스" 를 찾는 데 사용. */
export function getLastActiveId(kind: WorkspaceKind): string | null {
  if (!cache) return null;
  const id = cache.data.lastActive?.[kind];
  if (!id) return null;
  return cache.data.workspaces.some((w) => w.id === id && w.kind === kind)
    ? id
    : null;
}

export function getLastActive(): WorkspaceLastActive {
  if (!cache) return {};
  return { ...(cache.data.lastActive ?? {}) };
}

export function listWorkspaces(): WorkspaceMeta[] {
  if (!cache) return [];
  return [...cache.data.workspaces];
}

/** 새 워크스페이스를 레지스트리에 등록하기만 함. 폴더 초기화(빈 DB,
 *  storage/, 메타 파일) 는 호출자(`workspace.ts`) 가 책임. 같은 path/kind
 *  쌍이 이미 있으면 거부 — 동일 폴더가 두 번 등록되는 것을 막는다. */
export function registerWorkspace(args: {
  kind: WorkspaceKind;
  name: string;
  path: string;
  isDefault?: boolean;
}): WorkspaceMeta {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  const normalizedPath = path.resolve(args.path);
  const collision = cache.data.workspaces.find(
    (w) => path.resolve(w.path) === normalizedPath && w.kind === args.kind,
  );
  if (collision) {
    throw new Error(
      `workspace already registered for path/kind: ${normalizedPath} (${args.kind})`,
    );
  }
  const meta: WorkspaceMeta = {
    id: randomUUID(),
    kind: args.kind,
    name: args.name.trim() || (args.kind === "project" ? DEFAULT_PROJECT_NAME : DEFAULT_LIBRARY_NAME),
    path: normalizedPath,
    isDefault: args.isDefault === true,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  cache.data.workspaces.push(meta);
  persist();
  return meta;
}

export function renameWorkspace(id: string, name: string): WorkspaceMeta {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  const ws = cache.data.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`unknown workspace id: ${id}`);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("workspace name cannot be empty");
  ws.name = trimmed;
  persist();
  return ws;
}

/** 레지스트리에서만 제거 — 폴더는 그대로. default 워크스페이스는 거부. */
export function unregisterWorkspace(id: string): WorkspaceMeta {
  if (!cache) throw new Error("workspaceRegistry not initialized");
  const idx = cache.data.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) throw new Error(`unknown workspace id: ${id}`);
  const ws = cache.data.workspaces[idx];
  if (ws.isDefault) throw new Error("cannot unregister default workspace");
  cache.data.workspaces.splice(idx, 1);
  if (cache.data.active === id) {
    // 활성 워크스페이스를 제거할 때는 default-projects 로 fallback.
    const fallback = cache.data.workspaces.find((w) => w.isDefault && w.kind === "project");
    cache.data.active = fallback?.id ?? cache.data.workspaces[0]?.id ?? null;
  }
  // lastActive 의 두 슬롯도 청소 — 사라진 워크스페이스 ID 가 그대로 남아
  // 있으면 다음 quick-switch 가 stale 한 곳으로 점프해 null reload 가 난다.
  // sanitizeLastActive 가 부팅 시 이미 걸러 주지만, 그 검증을 다음 부팅까지
  // 미루면 같은 세션 안에서 잘못된 점프가 한 번 일어남.
  if (cache.data.lastActive) {
    for (const kind of ["project", "library"] as const) {
      if (cache.data.lastActive[kind] === id) cache.data.lastActive[kind] = null;
    }
  }
  persist();
  return ws;
}

/** 단위 테스트 / 부팅 재시작 용. 실제 런타임에서는 호출하지 말 것. */
export function __resetRegistryCacheForTests(): void {
  cache = null;
}
