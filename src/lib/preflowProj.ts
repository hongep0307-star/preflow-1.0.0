// `.preflowproj` 팩 — 프로젝트 export/import 의 공유 타입.
// 기존 라이브러리 팩 (`preflowPack.ts`) 과 동일한 구조 + 패턴을 따른다 — 한
// 개의 ZIP 안에 manifest.json + 테이블별 JSON + files/ 트리를 둔다.
//
// scope 정의:
//   "single"     — 한 프로젝트 한 개를 팩으로 묶는다. 카드 ⋯ 메뉴의 단축 경로
//                  로, manifest.project 가 채워지는 1-아이템 케이스.
//   "selection"  — 사용자가 대시보드에서 골라 담은 N(≥1)개 프로젝트를 한 팩으
//                  로 묶는다. UI 의 Selection bar 가 진입점. manifest.project
//                  은 null (workspace 와 동일 취급).
//   "workspace"  — 활성 워크스페이스의 모든 프로젝트를 한 팩으로 묶는다. 백업
//                  /이전 시나리오.

export type ProjPackKind = "preflowproj";
export type ProjPackScope = "single" | "selection" | "workspace";

/** Project pack 의 충돌 전략. references / scenes / assets 등은 ID 가
 *  새로 발급되므로 구조적 충돌은 없고, 대신 "같은 제목의 프로젝트가 이미
 *  있는가" 만 의미가 있다. V1 정책 — 항상 새로 만들고, 제목이 겹치면 ` (n)`
 *  suffix 자동 부여. 라이브러리 팩의 keepBoth 와 동일 의미. */
export type ProjPackImportStrategy = "keepBoth";

export interface ProjPackManifest {
  version: 1;
  kind: ProjPackKind;
  scope: ProjPackScope;
  created_at: string;
  app_version: string;
  workspace_id: string;
  project_count: number;
  reference_count: number;
  total_size_bytes: number;
  include_files: boolean;
  /** scope = "single" 인 경우에만 존재. workspace / selection 팩에서는 null
   *  (selection 은 정의상 다중 프로젝트이므로 단일 anchor 가 없음). */
  project?: { id: string; title: string } | null;
}

export interface ProjPackPreview {
  manifest: ProjPackManifest;
  tempPath: string;
  project_count: number;
  reference_count: number;
  total_size_bytes: number;
  /** 팩 안의 모든 프로젝트 제목 — import 다이얼로그의 미리보기 chip / 충돌
   *  안내에 사용. */
  project_titles: string[];
  /** import 후 활성 워크스페이스의 프로젝트와 제목이 겹치는 경우들. UI 가
   *  ` (1)` suffix 가 붙을 거라는 안내를 표시. */
  title_collisions: string[];
  /** ZIP 안의 reference snapshot 중 file/thumbnail entry 가 누락된 항목.
   *  사용자가 미리 알고 import 하도록. */
  missing_files: string[];
}

export interface ProjPackImportResult {
  imported_projects: number;
  imported_references: number;
  copied_files: number;
  /** 제목 충돌로 ` (n)` suffix 가 붙은 프로젝트의 새 제목들. */
  renamed_titles: string[];
  missing_files: string[];
}

export interface ProjPackExportResult {
  canceled?: boolean;
  saved_path?: string;
  project_count: number;
  reference_count: number;
  total_size_bytes: number;
}

export function validateProjManifest(value: unknown): asserts value is ProjPackManifest {
  const m = value as Partial<ProjPackManifest> | null;
  if (!m || typeof m !== "object") throw new Error("Invalid project pack manifest.");
  if (m.version !== 1) throw new Error("Unsupported project pack version.");
  if (m.kind !== "preflowproj") throw new Error("Invalid project pack kind.");
  if (m.scope !== "single" && m.scope !== "selection" && m.scope !== "workspace") {
    throw new Error("Invalid project pack scope.");
  }
}
