import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

export interface StorageUsage {
  total_bytes: number;
  by_bucket: Record<string, number>;
  file_count: number;
}

/** 대시보드의 프로젝트 카드 사이즈 칩이 소비하는 형태. 백엔드는 모든 버킷을
 *  walk 하면서 첫 path segment 가 v4 UUID 면 by_project[id], 아니면
 *  unscoped_bytes 로 누적한다. */
export interface StorageUsageByProject {
  by_project: Record<string, { bytes: number; files: number }>;
  unscoped_bytes: number;
  total_bytes: number;
}

export interface OrphanCleanupPreview {
  total_files: number;
  orphan_files: number;
  bytes_reclaimable: number;
  skipped_recent: number;
  sample: Array<{ key: string; size: number; mtimeMs: number }>;
}

export interface OrphanCleanupResult {
  filesDeleted: number;
  bytesFreed: number;
  skippedRecent: number;
  durationMs: number;
}

async function maintenancePost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
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

export function getStorageUsage(): Promise<StorageUsage> {
  return maintenancePost<StorageUsage>("/storage/usage");
}

export function getStorageUsageByProject(): Promise<StorageUsageByProject> {
  return maintenancePost<StorageUsageByProject>("/storage/usage/by-project");
}

export function previewOrphanCleanup(): Promise<OrphanCleanupPreview> {
  return maintenancePost<OrphanCleanupPreview>("/storage/orphans/preview", { includeReferences: true });
}

export function runOrphanCleanup(): Promise<OrphanCleanupResult> {
  return maintenancePost<OrphanCleanupResult>("/storage/orphans/cleanup", { includeReferences: true });
}

/** 바이트를 KB/MB/GB 단위로 사람이 읽기 쉽게 포맷. OrphanCleanupDialog 와
 *  대시보드 ProjectCard 가 동일 표기를 공유하도록 한 곳에서만 정의한다.
 *
 *  - 0 / null / undefined / NaN → "0 B"
 *  - 단위는 1024 진법 (binary). UI 에서 통일성이 더 중요해 SI 와 섞지 않음.
 *  - 한 자리수는 소수점 1 자리, 그 이상은 정수 — "1.4 GB" / "12 MB" 식. */
export function formatBytes(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
