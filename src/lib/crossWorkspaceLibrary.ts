/**
 * 비활성(보통 라이브러리) 워크스페이스의 레퍼런스를 *페이지 전환 없이* 읽어오는
 * 클라이언트. 워크스페이스마다 SQLite + storage 가 분리돼 있어 활성 워크스페이스
 * 외의 자료는 supabase 샤임(`/db/select`, 활성 DB 전용)으로 못 본다. 그래서
 * main 의 cross-workspace 엔드포인트(`/cross-workspace/references`, readonly DB
 * 오픈 + URL rewrite)를 호출하고, 썸네일/원본은 `/cross-workspace/file/<ws>/<rel>`
 * 로 서빙된 rewrite URL 을 그대로 쓴다. (LibraryImportDialog 가 사용)
 */
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";
import { getCachedLastActiveByKind, getCachedWorkspaces } from "./workspaceClient";
import type { ReferenceItem, ReferenceKind } from "./referenceLibrary";

export type CrossWorkspaceFilter = "all" | "favorite" | "recent";

/** 모달 표시에 필요한 최소 필드. file_url/thumbnail_url 은 이미 cross-workspace
 *  서빙 URL 로 rewrite 되어 있어 `<img src>`/fetch 에 바로 쓸 수 있다. */
export interface CrossWorkspaceReference {
  id: string;
  kind: string;
  title: string;
  file_url: string | null;
  thumbnail_url: string | null;
  mime_type: string | null;
  tags: string[];
  is_favorite: boolean;
  last_used_at: string | null;
  ai_suggestions: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
}

export interface CrossWorkspaceReferencesResult {
  references: CrossWorkspaceReference[];
  /** `folder:` 태그에서 도출한 폴더 경로 목록(정렬됨). */
  folders: string[];
}

export interface ListLibraryReferencesOptions {
  filter?: CrossWorkspaceFilter;
  /** folder path(예: "캐릭터/주연"). 지정 시 그 폴더에 속한 자료만. */
  folder?: string;
  query?: string;
  limit?: number;
}

/** 가져오기 모달이 읽을 "현재 활성 라이브러리" 워크스페이스. 마지막 활성 라이브러리
 *  슬롯 → 없으면 등록된 library kind 첫 항목. 0개면 null. */
export function getActiveLibraryWorkspace(): { id: string; name: string } | null {
  const last = getCachedLastActiveByKind("library");
  if (last) return { id: last.id, name: last.name };
  const libs = getCachedWorkspaces().filter((w) => w.kind === "library");
  return libs.length > 0 ? { id: libs[0].id, name: libs[0].name } : null;
}

/** 등록된 모든 library kind 워크스페이스(향후 셀렉터용). */
export function getLibraryWorkspaces(): Array<{ id: string; name: string }> {
  return getCachedWorkspaces()
    .filter((w) => w.kind === "library")
    .map((w) => ({ id: w.id, name: w.name }));
}

export async function listLibraryReferences(
  workspaceId: string,
  options: ListLibraryReferencesOptions = {},
): Promise<CrossWorkspaceReferencesResult> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}/cross-workspace/references`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify({
      workspaceId,
      filter: options.filter ?? "all",
      query: options.query ?? "",
      limit: options.limit ?? 500,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as CrossWorkspaceReferencesResult;
  let references = Array.isArray(data.references) ? data.references : [];
  // 폴더 필터는 클라이언트에서 적용(서버는 전체 + folders 목록 반환).
  if (options.folder) {
    const want = `folder:${options.folder}`;
    references = references.filter((r) => r.tags.includes(want));
  }
  return { references, folders: Array.isArray(data.folders) ? data.folders : [] };
}

/** 대상(보통 프로젝트) 워크스페이스의 대시보드 폴더 목록을 *페이지 전환 없이*
 *  조회한다. "스마트 브리프 매치 → 프로젝트 내보내기" 다이얼로그가 대상 폴더를
 *  고르는 데 쓴다. main 의 `/cross-workspace/folders`(readonly DB 오픈) 미러. */
export async function listCrossWorkspaceProjectFolders(
  workspaceId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}/cross-workspace/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { folders?: Array<{ id: string; name: string }> };
  return Array.isArray(data.folders) ? data.folders : [];
}

/** CrossWorkspaceReference → ReferenceItem(필수 필드 채움). brief/conti 의 기존
 *  attach 헬퍼(referenceToRefItem / makeCompareLibraryEntry)가 ReferenceItem 을
 *  받으므로, rewrite URL 을 그대로 담은 ReferenceItem 으로 변환해 재사용한다.
 *  (이미지 바이트는 그 헬퍼들이 rewrite URL 을 fetch → base64 로 인라인) */
export function crossRefToReferenceItem(r: CrossWorkspaceReference): ReferenceItem {
  return {
    id: r.id,
    kind: r.kind as ReferenceKind,
    title: r.title,
    file_url: r.file_url,
    thumbnail_url: r.thumbnail_url,
    mime_type: r.mime_type,
    duration_sec: r.duration_sec,
    width: r.width,
    height: r.height,
    tags: r.tags,
    is_favorite: r.is_favorite,
    last_used_at: r.last_used_at,
    ai_suggestions: r.ai_suggestions,
    timestamp_notes: [],
    color_palette: [],
  };
}
