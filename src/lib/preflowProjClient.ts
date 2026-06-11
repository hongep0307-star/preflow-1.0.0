import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";
import type {
  ProjPackExportResult,
  ProjPackImportResult,
  ProjPackPreview,
  ProjPackScope,
} from "./preflowProj";
import { refreshWorkspaces } from "./workspaceClient";

async function projPost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
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

export function exportProjectPack(opts: {
  scope: ProjPackScope;
  /** scope = "single" 일 때 필수. */
  projectId?: string | null;
  /** scope = "selection" 일 때 필수 (≥1). */
  projectIds?: string[] | null;
  includeFiles?: boolean;
  includeReferences?: boolean;
  suggestedName?: string;
}): Promise<ProjPackExportResult> {
  return projPost<ProjPackExportResult>("/pack/export-project", opts);
}

/** Open 다이얼로그를 띄워 사용자가 .preflowproj 파일을 직접 고르게 하고
 *  미리보기를 만든다. */
export function previewProjectPack(): Promise<ProjPackPreview & { canceled?: boolean }> {
  return projPost<ProjPackPreview & { canceled?: boolean }>("/pack/preview-project");
}

/** 이미 절대경로를 가진 .preflowproj (드래그-드랍 / 외부 진입) 의 미리보기. */
export function previewProjectPackFromPath(path: string): Promise<ProjPackPreview> {
  return projPost<ProjPackPreview>("/pack/preview-project-from-path", { path });
}

export async function applyProjectPack(opts: { tempPath: string }): Promise<ProjPackImportResult> {
  const result = await projPost<ProjPackImportResult>("/pack/import-project", opts);
  // 프로젝트 카운트 캐시가 import 직후 stale 한 값으로 남아 popover 가 옛
  // 값을 보여주던 문제 — applyPack(레퍼런스 import) 와 동일한 패턴으로
  // fire-and-forget 갱신.
  void refreshWorkspaces().catch(() => {
    /* 카운트 새로고침 실패는 import 자체에 영향을 주지 않음. */
  });
  return result;
}
