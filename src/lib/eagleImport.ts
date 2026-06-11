import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

export interface EaglePreview {
  rootPath: string;
  libraryName: string;
  totalItems: number;
  totalBytes: number;
  kinds: Record<string, number>;
  folders: number;
  smartFolders: number;
  tags: number;
  duplicateCandidates: number;
  missingFiles: Array<{ id: string; name: string; reason: string }>;
}

export interface EagleImportResult extends EaglePreview {
  imported: number;
  skipped: number;
  metadataOnly: number;
  failed: Array<{ id: string; name: string; reason: string }>;
}

export interface EagleSelectResult {
  canceled: boolean;
  rootPath: string | null;
  preview: EaglePreview | null;
}

/**
 * Add 메뉴의 "Choose Files > Folder" 와 폴더 드래그-드랍이 공통으로
 * 사용하는 결과 모양. Eagle Library 면 `eaglePreview` 가 채워지고,
 * 일반 폴더면 재귀로 수집한 미디어 절대경로가 `mediaFiles` 에 담긴다.
 */
export interface FolderPickResult {
  canceled: boolean;
  rootPath: string | null;
  isEagleLibrary: boolean;
  eaglePreview: EaglePreview | null;
  mediaFiles: string[];
}

export interface FolderScanResult {
  rootPath: string;
  isEagleLibrary: boolean;
  eaglePreview: EaglePreview | null;
  mediaFiles: string[];
}

async function localPost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function selectEagleLibrary(): Promise<EagleSelectResult> {
  return localPost<EagleSelectResult>("/eagle/select-library");
}

export function previewEagleLibrary(rootPath: string): Promise<EaglePreview> {
  return localPost<EaglePreview>("/eagle/preview", { rootPath });
}

export function importEagleLibrary(rootPath: string): Promise<EagleImportResult> {
  return localPost<EagleImportResult>("/eagle/import", { rootPath });
}

export function pickLibraryFolder(): Promise<FolderPickResult> {
  return localPost<FolderPickResult>("/library/pick-folder");
}

export function scanLibraryFolder(rootPath: string): Promise<FolderScanResult> {
  return localPost<FolderScanResult>("/library/scan-folder", { rootPath });
}
