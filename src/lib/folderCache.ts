import {
  migrateGlobalToScopedIfDefault,
  workspaceScopedKey,
} from "./workspaceScopedStorage";

/** Library 사이드바가 보여주는 "빈 폴더 path" 목록의 storage 키 이름.
 *  실제 사용 키는 활성 워크스페이스 ID 가 suffix 로 붙어 격리된다. 워크
 *  스페이스 간 폴더 누수(다른 워크스페이스에서 만든 폴더가 새 라이브러
 *  리에도 보이는 버그) 차단의 핵심. */
const USER_FOLDERS_KEY = "preflow.library.userFolders";

function normalizeFolderPath(path: string): string {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function readPaths(): string[] {
  // 활성 워크스페이스가 default 였다면 옛 글로벌 키의 데이터를 1 회만
  // scoped 키로 옮긴다 — 기존 사용자의 폴더 메타 보존.
  migrateGlobalToScopedIfDefault(USER_FOLDERS_KEY);
  const key = workspaceScopedKey(USER_FOLDERS_KEY);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((value) => normalizeFolderPath(String(value))).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function writePaths(paths: string[]): void {
  const key = workspaceScopedKey(USER_FOLDERS_KEY);
  // 활성 미로딩 시 write 보류 — scope 미정 상태로 글로벌 또는 잘못된 키에
  // 쓰면 다른 워크스페이스로 데이터가 새는 사고가 다시 난다.
  if (!key) return;
  const next = [...new Set(paths.map(normalizeFolderPath).filter(Boolean))].sort();
  localStorage.setItem(key, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("preflow-library-folders-changed"));
}

export function getUserFolderPaths(): string[] {
  return readPaths();
}

export function addUserFolderPath(path: string): void {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return;
  writePaths([...readPaths(), normalized]);
}

export function removeUserFolderPath(path: string): void {
  const normalized = normalizeFolderPath(path);
  writePaths(readPaths().filter((existing) => existing !== normalized && !existing.startsWith(`${normalized}/`)));
}

export function renameUserFolderPath(oldPath: string, newPath: string): void {
  const oldNormalized = normalizeFolderPath(oldPath);
  const newNormalized = normalizeFolderPath(newPath);
  if (!oldNormalized || !newNormalized) return;
  writePaths(readPaths().map((existing) => {
    if (existing === oldNormalized) return newNormalized;
    if (existing.startsWith(`${oldNormalized}/`)) {
      return `${newNormalized}/${existing.slice(oldNormalized.length + 1)}`;
    }
    return existing;
  }));
}

export function normalizeLibraryFolderPath(path: string): string {
  return normalizeFolderPath(path);
}
