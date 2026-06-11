// .preflowproj 팩 export — 단일 프로젝트(scope:"single"), 사용자가 대시보드
// 에서 골라 담은 N개 프로젝트(scope:"selection"), 또는 활성 워크스페이스
// 전체(scope:"workspace") 를 ZIP 으로 묶어 사용자가 고른 경로에 저장한다.
//
// ZIP 레이아웃 (라이브러리 packExport.ts 와 일관):
//   manifest.json
//   projects.json              # projects 행 1개 또는 N개
//   briefs.json
//   brief_attachments.json     # 브리프 composer / 레퍼런스 패널 첨부물 (이미지·PDF·비디오·YouTube)
//   scenes.json
//   scene_versions.json
//   assets.json
//   chat_logs.json
//   project_reference_links.json
//   references.json            # 위 링크가 가리키는 reference_items 임베드
//   folders.json               # 프로젝트가 속한 dashboard 폴더 (옵션)
//   style_presets.json         # 프로젝트가 의존하는 conti_style_id 의 프리셋만
//   storyboard_sheets.json     # 콘티 시트 테스트 갤러리 (mood 버킷 이미지)
//   files/<originalRelpath>    # storage 디스크 파일 (e.g. files/contis/<oldPid>/<sceneId>.png)
//
// 행 안의 URL 은 export 시점의 절대 URL/local-file URL 그대로 둔다 — import
// 측에서 base URL 재작성 + project_id substring 치환을 책임진다. (Phase 3 V1
// 단순화. 추후 필요해지면 sentinel 토큰화로 갈 수 있음.)

import { dialog } from "electron";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import JSZip from "jszip";

import { getStorageBasePath } from "./paths";
import { getLocalServerBaseUrl } from "./constants";
import { dbSelect, deserializeRow, runQuery } from "./db-utils";
import type { ProjPackManifest, ProjPackScope } from "../src/lib/preflowProj";

interface ExportProjPackRequest {
  scope: ProjPackScope;
  /** scope = "single" 일 때 필수. selection/workspace 에서는 무시된다. */
  projectId?: string | null;
  /** scope = "selection" 일 때 필수 (1개 이상). 중복은 무시되고, 존재하지
   *  않는 ID 는 조용히 걸러진다. single/workspace 에서는 무시. */
  projectIds?: string[] | null;
  /** false 면 metadata 만 — files/ 디렉터리 자체를 ZIP 에 안 넣는다. UI 의
   *  "Include files" 토글이 false 일 때. 기본 true. */
  includeFiles?: boolean;
  /** false 면 references.json + project_reference_links.json 모두 빈 배열.
   *  V1 은 항상 true 권장 — references 없는 프로젝트 팩은 conti 결과물의
   *  context 가 비어 보임. */
  includeReferences?: boolean;
  /** "Save as" 다이얼로그의 default name. 빈 값이면 자동 생성. */
  suggestedName?: string;
}

interface ProjectRow {
  id: string;
  title?: string | null;
  conti_style_id?: string | null;
  folder_id?: string | null;
  thumbnail_url?: string | null;
  [key: string]: unknown;
}

function sanitizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "preflow-project";
}

function resolveStorageUrlToPath(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const storageBase = path.resolve(getStorageBasePath());
  let target: string;
  if (rawUrl.startsWith("local-file://")) {
    let rawPath = decodeURIComponent(rawUrl.slice("local-file://".length).split(/[?#]/)[0]).replace(/\//g, path.sep);
    if (/^\\[A-Za-z]:/.test(rawPath)) rawPath = rawPath.slice(1);
    target = path.resolve(rawPath);
  } else {
    const match = rawUrl.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\/(.+)$/i);
    if (!match?.[1]) return null;
    target = path.resolve(storageBase, decodeURIComponent(match[1].split(/[?#]/)[0]));
  }
  const rel = path.relative(storageBase, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

function relPathFromStorage(diskPath: string): string {
  const storageBase = path.resolve(getStorageBasePath());
  return path.relative(storageBase, diskPath).replace(/\\/g, "/");
}

async function fileExists(filePath: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 한 행 안에 들어 있을 수 있는 모든 storage URL 문자열을 추출. JSON 컬럼은
 *  이미 deserializeRow 가 객체/배열로 풀어 놨으므로, 객체 트리를 walk 해서
 *  string 노드 중 storage URL 패턴인 것만 꺼낸다. */
function collectUrlsFromValue(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (
      value.startsWith("local-file://") ||
      /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\//i.test(value)
    ) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrlsFromValue(v, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectUrlsFromValue(v, out);
  }
}

function collectUrlsFromRows(rows: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const urls = new Set<string>();
  for (const row of rows) {
    for (const v of Object.values(row)) collectUrlsFromValue(v, urls);
  }
  return urls;
}

function resolveProjectIds(req: ExportProjPackRequest): string[] {
  if (req.scope === "single") {
    if (!req.projectId) throw new Error("scope=single requires projectId.");
    const row = runQuery("SELECT id FROM projects WHERE id = ?", [req.projectId])[0] as
      | { id: string }
      | undefined;
    return row ? [row.id] : [];
  }
  if (req.scope === "selection") {
    // 호출자가 보낸 ID 목록을 DB 와 교차해 존재하는 것만 통과. 정렬은
    // created_at ASC — workspace export 와 동일한 정렬 기준을 유지하면 import
    // 측에서 같은 순서로 보이고, 같은 selection 을 두 번 export 해도 결과
    // 결정성이 보장된다.
    const ids = Array.from(
      new Set((req.projectIds ?? []).filter((s) => typeof s === "string" && s.length > 0)),
    );
    if (ids.length === 0) throw new Error("scope=selection requires at least one projectId.");
    const placeholders = ids.map(() => "?").join(",");
    return (
      runQuery(
        `SELECT id FROM projects WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
        ids,
      ) as Array<{ id: string }>
    ).map((r) => r.id);
  }
  // workspace: 활성 워크스페이스의 모든 프로젝트. 활성 DB 가 곧 활성
  // 워크스페이스이므로 단순 SELECT.
  return (
    runQuery("SELECT id FROM projects ORDER BY created_at ASC") as Array<{ id: string }>
  ).map((r) => r.id);
}

function selectChildRows(table: string, projectIds: string[]): Array<Record<string, unknown>> {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM "${table}" WHERE project_id IN (${placeholders}) ORDER BY created_at ASC`,
    projectIds,
  ).map((r) => deserializeRow(r) as Record<string, unknown>);
}

function selectProjectRows(projectIds: string[]): ProjectRow[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM projects WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
    projectIds,
  ).map((r) => deserializeRow(r) as ProjectRow);
}

function selectReferenceItems(referenceIds: string[]): Array<Record<string, unknown>> {
  if (referenceIds.length === 0) return [];
  const placeholders = referenceIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM reference_items WHERE id IN (${placeholders})`,
    referenceIds,
  ).map((r) => deserializeRow(r) as Record<string, unknown>);
}

function selectFolders(folderIds: string[]): Array<Record<string, unknown>> {
  if (folderIds.length === 0) return [];
  const placeholders = folderIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM folders WHERE id IN (${placeholders})`,
    folderIds,
  ).map((r) => deserializeRow(r) as Record<string, unknown>);
}

function selectStylePresets(styleIds: string[]): Array<Record<string, unknown>> {
  if (styleIds.length === 0) return [];
  const placeholders = styleIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM style_presets WHERE id IN (${placeholders})`,
    styleIds,
  ).map((r) => deserializeRow(r) as Record<string, unknown>);
}

export async function exportProjPack(req: ExportProjPackRequest) {
  const includeFiles = req.includeFiles !== false;
  const includeReferences = req.includeReferences !== false;
  const projectIds = resolveProjectIds(req);
  if (projectIds.length === 0) {
    return {
      canceled: true as const,
      project_count: 0,
      reference_count: 0,
      total_size_bytes: 0,
    };
  }

  const projects = selectProjectRows(projectIds);

  // ── 자식 행 수집 ──
  const briefs = selectChildRows("briefs", projectIds);
  // brief_attachments — 브리프 영역의 1등 시민 첨부물. 옛날 export 는 이걸
  // 빼먹어 사용자가 export 한 파일을 import 해도 브리프 이미지/PDF/레퍼런스가
  // 사라져 있었다. selectChildRows 는 마이그레이션 전 DB (테이블 없음) 도 빈
  // 배열로 안전하게 반환되도록 try/catch 한다.
  let briefAttachments: Array<Record<string, unknown>> = [];
  try {
    briefAttachments = selectChildRows("brief_attachments", projectIds);
  } catch (err) {
    console.warn("[projPackExport] brief_attachments select failed (likely pre-migration DB):", err);
  }
  const scenes = selectChildRows("scenes", projectIds);
  const sceneVersions = selectChildRows("scene_versions", projectIds);
  const assets = selectChildRows("assets", projectIds);
  const chatLogs = selectChildRows("chat_logs", projectIds);
  // storyboard_sheets — 콘티 시트 테스트 갤러리. brief_attachments 처럼 옛날
  // export 가 빼먹던 프로젝트 자식 테이블. 시트 이미지(url)는 mood 버킷에
  // 있고 아래 allRows 에 넣어야 files/ 에 함께 동봉된다. 마이그레이션 전
  // DB (테이블 없음) 도 빈 배열로 안전하게 반환되도록 try/catch.
  let storyboardSheets: Array<Record<string, unknown>> = [];
  try {
    storyboardSheets = selectChildRows("storyboard_sheets", projectIds);
  } catch (err) {
    console.warn("[projPackExport] storyboard_sheets select failed (likely pre-migration DB):", err);
  }
  const projectReferenceLinks = includeReferences
    ? selectChildRows("project_reference_links", projectIds)
    : [];

  // ── reference snapshots ──
  const referenceIds = Array.from(
    new Set(projectReferenceLinks.map((r) => String(r.reference_id)).filter(Boolean)),
  );
  const references = includeReferences ? selectReferenceItems(referenceIds) : [];

  // ── style_presets (프로젝트의 conti_style_id 만) ──
  const styleIds = Array.from(
    new Set(projects.map((p) => p.conti_style_id).filter((id): id is string => !!id)),
  );
  const stylePresets = selectStylePresets(styleIds);

  // ── folders (대시보드 그룹화 — projects.folder_id 만) ──
  const folderIds = Array.from(
    new Set(projects.map((p) => p.folder_id).filter((id): id is string => !!id)),
  );
  const folders = selectFolders(folderIds);

  // ── 파일 수집 (모든 행의 storage URL 을 walk) ──
  const allRows: Array<Record<string, unknown>> = [
    ...projects,
    ...briefs,
    ...briefAttachments,
    ...scenes,
    ...sceneVersions,
    ...assets,
    ...references,
    ...stylePresets,
    ...storyboardSheets,
  ];
  const urls = includeFiles ? collectUrlsFromRows(allRows) : new Set<string>();

  const zip = new JSZip();
  let totalSize = 0;
  const missingFiles: string[] = [];
  const seenRelPaths = new Set<string>();

  if (includeFiles) {
    for (const url of urls) {
      const diskPath = resolveStorageUrlToPath(url);
      if (!(await fileExists(diskPath))) {
        missingFiles.push(url);
        continue;
      }
      const rel = relPathFromStorage(diskPath!);
      if (seenRelPaths.has(rel)) continue; // 중복 파일은 한 번만
      seenRelPaths.add(rel);
      zip.file(`files/${rel}`, fs.createReadStream(diskPath!));
      try {
        const stat = await fs.promises.stat(diskPath!);
        totalSize += stat.size;
      } catch {
        /* size 누락은 통계만 영향 */
      }
    }
  }

  // ── manifest ──
  // workspace_id 는 활성 워크스페이스가 default 이거나 미완 부트스트랩일 수
  // 있어 best-effort 로 채운다 — workspace.ts 에서 export 하지만 packExport
  // 패턴과 통일하려고 여기서는 직접 import 하지 않고 manifest 에는 placeholder
  // 만 둔다. import 측은 어차피 manifest.workspace_id 를 검증하지 않음.
  const manifest: ProjPackManifest = {
    version: 1,
    kind: "preflowproj",
    scope: req.scope,
    created_at: new Date().toISOString(),
    app_version: "1.0.0",
    workspace_id: "active",
    project_count: projects.length,
    reference_count: references.length,
    total_size_bytes: totalSize,
    include_files: includeFiles,
    project:
      req.scope === "single" && projects.length > 0
        ? { id: String(projects[0].id), title: String(projects[0].title ?? "") }
        : null,
  };

  // ── ZIP 본문 작성 ──
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("projects.json", JSON.stringify(projects, null, 2));
  zip.file("briefs.json", JSON.stringify(briefs, null, 2));
  zip.file("brief_attachments.json", JSON.stringify(briefAttachments, null, 2));
  zip.file("scenes.json", JSON.stringify(scenes, null, 2));
  zip.file("scene_versions.json", JSON.stringify(sceneVersions, null, 2));
  zip.file("assets.json", JSON.stringify(assets, null, 2));
  zip.file("chat_logs.json", JSON.stringify(chatLogs, null, 2));
  zip.file("project_reference_links.json", JSON.stringify(projectReferenceLinks, null, 2));
  zip.file("references.json", JSON.stringify(references, null, 2));
  zip.file("folders.json", JSON.stringify(folders, null, 2));
  zip.file("style_presets.json", JSON.stringify(stylePresets, null, 2));
  zip.file("storyboard_sheets.json", JSON.stringify(storyboardSheets, null, 2));

  // ── 사용자 저장 다이얼로그 ──
  // 기본 파일명: single 은 프로젝트 제목, selection 은 "first-and-N-more",
  // workspace 는 날짜 스탬프. 사용자가 dialog 에서 suggestedName 을 명시했으면
  // 그쪽이 우선.
  let defaultBase: string;
  if (req.scope === "single" && projects.length > 0) {
    defaultBase = String(projects[0].title ?? "project");
  } else if (req.scope === "selection" && projects.length > 0) {
    const firstTitle = String(projects[0].title ?? "project");
    defaultBase =
      projects.length === 1 ? firstTitle : `${firstTitle}-and-${projects.length - 1}-more`;
  } else {
    defaultBase = `workspace-${new Date().toISOString().slice(0, 10)}`;
  }
  const defaultName = sanitizeName(req.suggestedName || defaultBase) + ".preflowproj";
  let dialogTitle: string;
  if (req.scope === "single") dialogTitle = "Export Project";
  else if (req.scope === "selection") dialogTitle = "Export Selected Projects";
  else dialogTitle = "Export Workspace";
  const picked = await dialog.showSaveDialog({
    title: dialogTitle,
    defaultPath: defaultName,
    filters: [{ name: "Pre-Flow Project Pack", extensions: ["preflowproj"] }],
  });
  if (picked.canceled || !picked.filePath) {
    return {
      canceled: true as const,
      project_count: projects.length,
      reference_count: references.length,
      total_size_bytes: totalSize,
    };
  }

  await fs.promises.mkdir(path.dirname(picked.filePath), { recursive: true });
  await pipeline(
    zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }),
    fs.createWriteStream(picked.filePath),
  );

  return {
    canceled: false as const,
    saved_path: picked.filePath,
    project_count: projects.length,
    reference_count: references.length,
    total_size_bytes: totalSize,
    missing_files: missingFiles,
    base_url: getLocalServerBaseUrl(),
  };
}
