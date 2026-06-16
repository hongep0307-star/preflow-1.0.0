import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";
import type {
  HtmlExportFormat,
  HtmlExportResult,
  PackExportResult,
  PackFolderStrategy,
  PackImportResult,
  PackImportStrategy,
  PackPreview,
  PackScope,
} from "./preflowPack";
import { refreshWorkspaces } from "./workspaceClient";

async function packPost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
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

export function exportPack(opts: {
  scope: PackScope;
  ids?: string[];
  folderTag?: string;
  projectId?: string | null;
  includeFiles: boolean;
  includeSubfolders?: boolean;
  suggestedName?: string;
  /** 캔버스 작업 (위치/노트/연결/뷰) — `getAllCanvasLayouts()` 결과를
   *  그대로 넘기면 electron 측이 `canvas_layouts.json` 으로 zip 에 동봉.
   *  import 측에서 mergeCanvasLayouts 로 복원한다. */
  canvasLayouts?: Record<string, unknown>;
}): Promise<PackExportResult> {
  return packPost<PackExportResult>("/pack/export", opts);
}

/**
 * HTML Viewer 로 export. 결과는 ZIP(여러 파일 묶음) 또는 단일 HTML 한 장.
 *
 * - 받는 사람은 앱 없이 더블클릭만으로 그리드/영상/타임라인 코멘트/리전
 *   코멘트를 모두 볼 수 있다.
 * - scope/ids/folderTag/includeSubfolders 는 exportPack 과 동일 의미.
 * - format="zip"        : 권장. 미디어를 별도 assets/ 폴더로 묶어 크기 작음.
 * - format="single-html": data: URI 인라인. 한 장으로 보내고 싶을 때.
 *   큰 영상이 들어가면 결과 파일이 폭증함 — 호출자 측에서 사용자에게
 *   사전 경고 책임.
 */
export function exportPackAsHtml(opts: {
  scope: Exclude<PackScope, "projectLinked">;
  ids?: string[];
  folderTag?: string;
  includeSubfolders?: boolean;
  suggestedName?: string;
  title?: string;
  format: HtmlExportFormat;
  /** export 한 앱의 UI 언어 — 뷰어 초기 언어 기본값. */
  language?: "ko" | "en";
  /** 뷰어 폴더 트리를 한정할 폴더 경로 목록(다중 폴더 선택 또는 선택 export 시). */
  folderScope?: string[];
}): Promise<HtmlExportResult> {
  return packPost<HtmlExportResult>("/pack/export-html", opts);
}

export function previewPack(): Promise<PackPreview & { canceled?: boolean }> {
  return packPost<PackPreview & { canceled?: boolean }>("/pack/preview");
}

/**
 * 사용자가 이미 고른(또는 드롭한) .preflowlib / .preflowpack 절대경로에
 * 대해 다이얼로그 없이 곧장 미리보기를 만든다. Add → Choose Files 와
 * 드래그-드랍에서 PackImportDialog 로 라우팅하기 위한 진입점.
 */
export function previewPackFromPath(path: string): Promise<PackPreview> {
  return packPost<PackPreview>("/pack/preview-from-path", { path });
}

export async function applyPack(opts: {
  tempPath: string;
  strategy: PackImportStrategy;
  mountProjectId?: string | null;
  /** Pack 의 `folder:*` 태그 처리 방식 — recreate(트리 재현) / flatten(평탄화). */
  folderStrategy?: PackFolderStrategy;
  /** Library UI 활성 폴더 경로(`folder:` prefix 없는 normalized path). */
  destinationFolderPath?: string | null;
  /** Favorites quick filter 에서 import 했을 때 is_favorite 강제 적용. */
  forceFavorite?: boolean;
}): Promise<PackImportResult> {
  const result = await packPost<PackImportResult>("/pack/import", opts);
  // 워크스페이스 카운트 캐시(refs/projects) 가 import 직후 stale 0 으로 남던
  // 버그 — popover 가 stale 한 값을 보여줘 사용자가 "0 개로 잡혀" 라고 느낀다.
  // fire-and-forget 으로 트리거해 import 응답 자체는 지연되지 않게.
  void refreshWorkspaces().catch(() => {
    /* 카운트 새로고침 실패는 사용자 흐름에 치명적이지 않음 — 다음 mutation
       시 다시 동기화된다. */
  });
  return result;
}
