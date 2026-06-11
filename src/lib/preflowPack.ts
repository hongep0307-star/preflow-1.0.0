import type { ReferenceKind } from "./referenceLibrary";

/**
 * Pack 의 파일 식별자. 과거에는 `"preflowlib"` (라이브러리 단독) 과
 * `"preflowpack"` (프로젝트 연결) 두 종류로 분리되어 있었지만, 데이터 측면의
 * 차이가 `project_links.json` 한 메타파일뿐이라 사용자가 두 포맷을 혼동했다.
 * 지금은 단일 `"preflowlib"` 로 통합 — `project_links.json` 은 옵션 메타가
 * 되어, 있으면 import 시 프로젝트 연결을 복원하고 없으면 그냥 라이브러리에
 * 들어간다. 옛 `"preflowpack"` 파일도 import 측에서 동등하게 받아 들이도록
 * 타입에 legacy 로 남겨 둔다 — 새 export 는 절대 이 값을 쓰지 않는다.
 */
export type PackKind = "preflowlib" | "preflowpack";
export type PackScope = "folder" | "selected" | "filtered" | "all" | "projectLinked";
export type PackImportStrategy = "skip" | "keepBoth" | "mergeMetadata";

/**
 * Pack 의 `folder:*` 태그를 import 시 어떻게 다룰지. duplicate strategy 와
 * 독립. "recreate" 는 pack 트리를 destination 아래에 재현(충돌 시 (1)
 * suffix), "flatten" 은 모두 제거 후 destination 단일 폴더로 평탄화.
 */
export type PackFolderStrategy = "recreate" | "flatten";

export interface PackManifest {
  version: 1;
  kind: PackKind;
  created_at: string;
  app_version: string;
  library_id: string;
  item_count: number;
  total_size_bytes: number;
  include_files: boolean;
  scope: PackScope;
  scope_label?: string | null;
  project?: { id: string; name?: string | null } | null;
}

export interface PackPreview {
  manifest: PackManifest;
  tempPath: string;
  item_count: number;
  kind_distribution: Partial<Record<ReferenceKind, number>>;
  total_size_bytes: number;
  duplicates: Array<{
    source_id: string;
    existing_reference_id: string;
    title: string;
    content_hash?: string | null;
  }>;
  missing_files: string[];
  /** Pack 안에 `folder:*` 태그가 한 개라도 있으면 true. 다이얼로그가
   *  폴더 배치 라디오 그룹을 보일지 결정하는 데 사용. */
  has_folder_structure: boolean;
  /** Pack 의 unique top-level 폴더 segment 목록 (정렬됨). recreate 모드의
   *  미리보기 chip + 클라이언트 충돌 (1) 계산에 사용. */
  top_level_folders: string[];
  /** Pack 에 동봉된 캔버스 작업 (위치/노트/연결/뷰). 있으면 import 직후
   *  `mergeCanvasLayouts` 로 현재 워크스페이스에 병합. */
  canvas_layouts?: Record<string, unknown> | null;
}

export interface PackImportResult {
  inserted: number;
  skipped: number;
  merged: number;
  copied_files: number;
  missing_files: string[];
  /** import 결과로 라이브러리에 새로 등장한 folder 경로들 (top-level + 모든
   *  내부 ancestor 포함, `folder:` prefix 제외). LibraryPage 가
   *  `addUserFolderPath` 로 영구 등록해 — 수동 생성 폴더와 동일하게
   *  아이템이 비더라도 사이드바에 남게 한다. recreate 전략에서만 채워진다. */
  created_folder_paths: string[];
}

export interface PackExportResult {
  canceled?: boolean;
  saved_path?: string;
  item_count: number;
  total_size_bytes: number;
  skipped: string[];
}

/**
 * HTML Viewer Export 결과. .preflowlib 와 달리 외부 공유용 read-only
 * viewer 패키지(.zip 또는 .html)를 만든 응답이라 별도 타입으로 분리.
 * 필드 구성은 PackExportResult 와 동일하지만 의미가 달라 별칭을 유지하기
 * 위해 별도 인터페이스로 둔다.
 */
export interface HtmlExportResult {
  canceled?: boolean;
  saved_path?: string;
  item_count: number;
  total_size_bytes: number;
  skipped: string[];
}

/** HTML Viewer 출력 포맷. ZIP 은 큰 미디어 모음 / 단일 HTML 은 한 장으로
 *  공유하고 싶을 때. base64 인라인 특성상 단일 HTML 은 큰 영상에 부적합. */
export type HtmlExportFormat = "zip" | "single-html";

export function validateManifest(value: unknown): asserts value is PackManifest {
  const manifest = value as Partial<PackManifest> | null;
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid pack manifest.");
  if (manifest.version !== 1) throw new Error("Unsupported pack version.");
  if (manifest.kind !== "preflowlib" && manifest.kind !== "preflowpack") {
    throw new Error("Invalid pack kind.");
  }
  if (!["folder", "selected", "filtered", "all", "projectLinked"].includes(String(manifest.scope))) {
    throw new Error("Invalid pack scope.");
  }
}
