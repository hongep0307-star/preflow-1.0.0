// ── Active workspace runtime ────────────────────────────────────────
// 부팅 시 registry 에서 active id 를 읽어 그에 해당하는 폴더 경로(`activePath`)
// 를 캐시한다. 이 모듈이 알려주는 `activePath` 가 곧 SQLite DB 와 storage/
// 트리의 베이스 — `paths.ts` / `db.ts` 가 이 값에 의존해 동적으로 경로를
// 해석한다.
//
// activate(id) 흐름:
//   1) 새 워크스페이스 폴더의 락 acquire (실패 시 충돌 모달 정보 반환)
//   2) 현재 DB close
//   3) 이전 워크스페이스 락 release
//   4) registry.active 갱신 + activePath 갱신
//   5) DB reopen (새 path 의 preflow.db)
//   6) 호출자(local-server route handler) 가 webContents.reload 트리거
//
// 락 파일은 워크스페이스 폴더 안의 `.preflow-lock` JSON. 같은 PC 의 같은 PID
// 가 살아 있으면 점유 중으로 판단하고, 그 외 (PID 죽음, 다른 호스트, 만료된
// timestamp) 는 stale 로 보고 takeover 가능. `force` 플래그로 사용자가
// 강제 takeover 도 가능 — OneDrive 다른 PC 시나리오 등.

import path from "path";
import fs from "fs";
import os from "os";

import {
  WORKSPACE_LOCK_FILENAME,
  WORKSPACE_META_FILENAME,
  type WorkspaceKind,
  type WorkspaceLockInfo,
  type WorkspaceMeta,
} from "../shared/workspace";
import {
  ensureRegistry,
  findWorkspace,
  getActiveId,
  getRegistry,
  registerWorkspace,
  setActiveId,
} from "./workspaceRegistry";
import { closeDb, openDatabaseAt } from "./db";

let userDataDir = "";
let activeId: string | null = null;
let activePath: string = "";
let heldLockPath: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// 락 보유 중 `renewedAt` 을 다시 찍는 주기. OneDrive 가 이 작은 파일을 자주
// 동기화하므로 너무 짧으면 sync 채널을 시끄럽게 만들고, 너무 길면 인계 판단이
// 둔해진다. 30 초가 균형점.
const HEARTBEAT_INTERVAL_MS = 30_000;

// 다른 호스트의 락을 "죽었다(stale)" 고 보기까지의 유예. 반드시
//   OneDrive 동기화 지연 + HEARTBEAT_INTERVAL_MS
// 보다 넉넉히 커야 한다 — 그렇지 않으면 상대 PC 가 *살아 있는데도* 동기화가
// 늦어 renewedAt 이 오래돼 보여 false-stale 인계 → 동시 쓰기 → DB 손상.
// 5 분이면 일반적인 OneDrive 지연을 충분히 흡수한다.
const LOCK_TTL_MS = 5 * 60_000;

function lockFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_LOCK_FILENAME);
}

function metaFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_META_FILENAME);
}

function readLock(workspaceDir: string): WorkspaceLockInfo | null {
  const file = lockFilePath(workspaceDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        username: parsed.username,
        acquiredAt: parsed.acquiredAt,
        // 구버전 락 파일에는 renewedAt 이 없다 — acquiredAt 으로 폴백해
        // "방금 막 잡은 락"처럼 취급(가장 보수적 = 인계 안 함).
        renewedAt:
          typeof parsed.renewedAt === "string"
            ? parsed.renewedAt
            : parsed.acquiredAt,
        prettyLabel:
          typeof parsed.prettyLabel === "string"
            ? parsed.prettyLabel
            : `${parsed.username} on ${parsed.hostname}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** PID 가 같은 호스트에서 살아 있는지 가벼운 검사 — `process.kill(pid, 0)` */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 락이 stale 한지.
 *  - 이 PC 호스트면 PID 살아 있음 여부로 즉시 판단(동기화 지연 없음).
 *  - 다른 호스트면 하트비트 기반 TTL 로 판단 — 마지막 활동(renewedAt)이
 *    LOCK_TTL_MS 보다 오래됐으면 점유 PC 가 죽었거나 안 끄고 떠난 것으로
 *    보고 자동 인계를 허용한다. (과거에는 무조건 false 라 다른 PC 가 한 번
 *    잡으면 영구히 강제 열기를 해야 했다.) */
function isLockStale(lock: WorkspaceLockInfo): boolean {
  if (lock.hostname === os.hostname()) {
    return !isProcessAlive(lock.pid);
  }
  const lastSeen = Date.parse(lock.renewedAt ?? lock.acquiredAt);
  if (Number.isNaN(lastSeen)) return false; // 타임스탬프 파싱 실패 = 보수적 유지
  return Date.now() - lastSeen > LOCK_TTL_MS;
}

function writeLockInfo(workspaceDir: string, info: WorkspaceLockInfo): void {
  const file = lockFilePath(workspaceDir);
  // atomic — OneDrive 동기화 중간 상태 회피.
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function writeLock(workspaceDir: string): void {
  const now = new Date().toISOString();
  writeLockInfo(workspaceDir, {
    pid: process.pid,
    hostname: os.hostname(),
    username: os.userInfo().username || "user",
    acquiredAt: now,
    renewedAt: now,
    prettyLabel: `${os.userInfo().username || "user"} on ${os.hostname()}`,
  });
}

/** 하트비트 — 보유 중인 락 파일의 `renewedAt` 만 현재 시각으로 새로 찍는다.
 *  `acquiredAt` 과 pid 는 보존해 "언제부터 점유 중인지" 정보를 유지한다.
 *  락 파일이 외부에서 사라졌거나 더 이상 내 것이 아니면 조용히 멈춘다 —
 *  강제 인계당한 뒤 좀비 하트비트가 남의 락을 덮어쓰지 않도록. */
function renewLock(workspaceDir: string): void {
  const existing = readLock(workspaceDir);
  if (
    !existing ||
    existing.pid !== process.pid ||
    existing.hostname !== os.hostname()
  ) {
    stopHeartbeat();
    return;
  }
  try {
    writeLockInfo(workspaceDir, {
      ...existing,
      renewedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — 다음 tick 에서 재시도 */
  }
}

function startHeartbeat(workspaceDir: string): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => renewLock(workspaceDir), HEARTBEAT_INTERVAL_MS);
  // Electron main 의 이벤트 루프가 이 타이머 때문에 살아있을 필요는 없다.
  heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function removeLockIfMine(workspaceDir: string): void {
  const file = lockFilePath(workspaceDir);
  const lock = readLock(workspaceDir);
  if (!lock) return;
  if (lock.pid !== process.pid || lock.hostname !== os.hostname()) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

// 정상적으로 존재하는 SQLite 파일들 — 충돌 사본 스캔에서 제외한다.
const CANONICAL_DB_FILES = new Set([
  "preflow.db",
  "preflow.db-wal",
  "preflow.db-shm",
  "preflow.db-journal",
]);

/** OneDrive/Dropbox 가 동시 수정 충돌 시 만들어 두는 사본 파일을 찾는다.
 *  예) "preflow-DESKTOP-AB12.db", "preflow (사용자의 충돌 본).db",
 *      "preflow.db (2)" 등. 이런 파일이 보이면 한쪽 PC 의 변경분이 본
 *      DB 에 머지되지 못하고 갈라져 나갔다는 신호 — 데이터 유실 위험을
 *      사용자에게 알린다. (자동 머지는 불가능하므로 경고만.)
 *  반환은 파일명 배열(경로 아님) — UI 표시는 파일명으로 충분하다. */
export function detectConflictCopies(workspaceDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(workspaceDir);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    if (CANONICAL_DB_FILES.has(name)) return false;
    const lower = name.toLowerCase();
    // preflow* 로 시작하는 .db 계열, 또는 registry 의 충돌 사본.
    const isDbCopy = lower.startsWith("preflow") && /\.db(\b|[^a-z])/.test(lower);
    const isRegistryCopy =
      lower.startsWith("workspaces") &&
      lower.endsWith(".json") &&
      name !== "workspaces.json" &&
      name !== "workspaces.bak.json";
    return isDbCopy || isRegistryCopy;
  });
}

export class WorkspaceLockedError extends Error {
  readonly code = "WORKSPACE_LOCKED";
  readonly lock: WorkspaceLockInfo;
  constructor(lock: WorkspaceLockInfo) {
    super(
      `Workspace is in use by ${lock.prettyLabel} (since ${lock.acquiredAt})`,
    );
    this.lock = lock;
  }
}

export interface AcquireLockOptions {
  /** 다른 PC 가 점유 중이라도 강제 takeover. 사용자가 충돌 모달에서 명시적
   *  으로 "Force open" 을 눌렀을 때만 true. */
  force?: boolean;
}

function acquireLock(workspaceDir: string, opts: AcquireLockOptions = {}): void {
  const existing = readLock(workspaceDir);
  if (existing) {
    if (
      existing.pid === process.pid &&
      existing.hostname === os.hostname()
    ) {
      // 자기 자신이 가진 락 — 그대로 둔다.
      return;
    }
    if (!opts.force && !isLockStale(existing)) {
      throw new WorkspaceLockedError(existing);
    }
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeLock(workspaceDir);
  heldLockPath = workspaceDir;
  startHeartbeat(workspaceDir);
}

function releaseLock(): void {
  stopHeartbeat();
  if (heldLockPath) {
    removeLockIfMine(heldLockPath);
    heldLockPath = null;
  }
}

/** 부팅 시 1 회 호출. 레지스트리를 ensure 하고, active 워크스페이스의 락을
 *  acquire 하며, DB 를 그 경로에서 연다. */
export async function initWorkspace(userDataPath: string): Promise<void> {
  userDataDir = userDataPath;
  ensureRegistry(userDataDir);
  const reg = getRegistry();
  const activeIdInRegistry = reg.active;
  if (!activeIdInRegistry) {
    throw new Error("workspace registry has no active id after bootstrap");
  }
  const ws = findWorkspace(activeIdInRegistry);
  if (!ws) {
    throw new Error(`active workspace ${activeIdInRegistry} not found`);
  }
  // default 워크스페이스(=userData 자체) 는 락을 안 잡음 — userData 는
  // 항상 한 사용자의 한 PC 안에서만 쓰이고, 단일 인스턴스 lock 으로 이미
  // 보호되기 때문. custom 워크스페이스만 폴더 단위 락으로 보호.
  if (!ws.isDefault) {
    acquireLock(ws.path);
  }
  activeId = ws.id;
  activePath = ws.path;
  ensureWorkspaceFolderLayout(ws);
  await openDatabaseAt(getDbFilePathFor(ws));
}

/** 활성 워크스페이스의 storage 베이스. paths.ts 가 이 값을 참조. */
export function getActiveStoragePath(): string {
  if (!activePath) {
    throw new Error("workspace not initialized — call initWorkspace first");
  }
  return path.join(activePath, "storage");
}

/** 활성 워크스페이스의 DB 파일 경로. */
export function getActiveDbPath(): string {
  if (!activePath) {
    throw new Error("workspace not initialized — call initWorkspace first");
  }
  return path.join(activePath, "preflow.db");
}

export function getActiveWorkspace(): WorkspaceMeta | null {
  if (!activeId) return null;
  return findWorkspace(activeId);
}

function getDbFilePathFor(ws: WorkspaceMeta): string {
  return path.join(ws.path, "preflow.db");
}

function ensureWorkspaceFolderLayout(ws: WorkspaceMeta): void {
  fs.mkdirSync(ws.path, { recursive: true });
  fs.mkdirSync(path.join(ws.path, "storage"), { recursive: true });
  if (!ws.isDefault) {
    // custom 워크스페이스는 자기 정체성을 폴더 안에 남김 — OneDrive 로 다른
    // PC 에서 봤을 때도 이게 무엇인지 즉시 알 수 있고, "Load existing"
    // 흐름의 검증에 쓰인다.
    const file = metaFilePath(ws.path);
    if (!fs.existsSync(file)) {
      const meta = {
        version: 1,
        id: ws.id,
        kind: ws.kind,
        name: ws.name,
        createdAt: ws.createdAt ?? new Date().toISOString(),
      };
      try {
        fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
      } catch (err) {
        console.warn("[workspace] failed to write workspace meta:", err);
      }
    }
  }
}

export interface ActivateOptions {
  force?: boolean;
}

/** 활성 워크스페이스 전환. 같은 path 로의 전환은 메타만 업데이트하고 DB 는
 *  닫지 않는다(default ↔ default 케이스에서 불필요한 reopen 회피). */
export async function activateWorkspace(
  id: string,
  opts: ActivateOptions = {},
): Promise<WorkspaceMeta> {
  const target = findWorkspace(id);
  if (!target) throw new Error(`unknown workspace id: ${id}`);
  if (id === activeId) return target;

  const samePath = path.resolve(target.path) === path.resolve(activePath);

  // 같은 path 면 락/DB 동작 모두 생략.
  if (!samePath) {
    // 새 워크스페이스 폴더 락 acquire 먼저 — 실패하면 현재 DB/락 그대로 둔다.
    if (!target.isDefault) {
      acquireLock(target.path, { force: opts.force }); // throws WorkspaceLockedError
    }
    closeDb();
    releaseLock();
    if (!target.isDefault) {
      // acquireLock 이 heldLockPath 를 갱신했으므로 release 후에도 정보 유지.
      acquireLock(target.path, { force: opts.force });
    }
    ensureWorkspaceFolderLayout(target);
    await openDatabaseAt(getDbFilePathFor(target));
  }

  setActiveId(id);
  activeId = id;
  activePath = target.path;
  return target;
}

/** 사용자가 새 폴더에 워크스페이스 생성 — 레지스트리 등록 + 폴더 초기화.
 *  이 시점에 DB 도 한 번 열고/닫아 schema 를 생성해 둔다 (다음에 activate
 *  될 때 즉시 사용 가능하도록). */
export async function createWorkspaceAt(args: {
  kind: WorkspaceKind;
  name: string;
  path: string;
}): Promise<WorkspaceMeta> {
  fs.mkdirSync(args.path, { recursive: true });
  // 빈 폴더가 아니면 거부하지 않는다 — 사용자가 이미 정리해 둔 디렉터리에
  // 워크스페이스를 새로 얹는 것도 허용. 단, 같은 폴더에 다른 워크스페이스가
  // 이미 등록돼 있으면 registerWorkspace 가 거부한다.
  const meta = registerWorkspace(args);
  ensureWorkspaceFolderLayout(meta);
  // schema 미리 생성 — 이때만 임시 DB 핸들을 열고 즉시 닫는다.
  // 단, 활성 DB 는 그대로 살아 있어야 하므로 openDatabaseAt 의 기본
  // 동작인 "기존 핸들 close 후 새로 open" 을 피하기 위해 createOnly
  // 모드로 호출.
  await openDatabaseAt(path.join(meta.path, "preflow.db"), { createOnly: true });
  return meta;
}

/** 기존 워크스페이스 폴더(다른 PC 에서 만든 것 포함) 를 이 PC 의 레지스트리
 *  에 추가. `.preflow-workspace.json` 메타가 있으면 그것을 신뢰. */
export function loadExistingWorkspace(folderPath: string, hint?: { kind?: WorkspaceKind; name?: string }): WorkspaceMeta {
  const file = metaFilePath(folderPath);
  let kind: WorkspaceKind | null = null;
  let name: string | null = null;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && (parsed.kind === "project" || parsed.kind === "library")) {
        kind = parsed.kind;
      }
      if (parsed && typeof parsed.name === "string" && parsed.name.trim()) {
        name = parsed.name.trim();
      }
    } catch (err) {
      console.warn("[workspace] meta file unreadable:", err);
    }
  }
  if (!kind) kind = hint?.kind ?? null;
  if (!name) name = hint?.name ?? null;
  if (!kind) {
    throw new Error("Cannot detect workspace kind — provide hint or include .preflow-workspace.json");
  }
  return registerWorkspace({
    kind,
    name: name ?? (kind === "project" ? "Imported Projects" : "Imported Library"),
    path: folderPath,
  });
}

/** 앱 종료 시 호출 — 락 정리. */
export function shutdownWorkspace(): void {
  releaseLock();
  activeId = null;
  activePath = "";
}

/** 단위 테스트 / 디버그 용 — 외부에서 호출하지 말 것. */
export function __resetWorkspaceForTests(): void {
  stopHeartbeat();
  activeId = null;
  activePath = "";
  heldLockPath = null;
  userDataDir = "";
}
