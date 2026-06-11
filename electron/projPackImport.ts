// .preflowproj 팩 import — preview / apply.
//
// 핵심 전략 — "ID 리매핑은 모든 곳을 string-tree replace 로":
//   1) 팩 안의 모든 행 ID 를 미리 새 ID 로 발급해 oldId → newId 표를 만든다.
//      대상: projects / briefs / scenes / scene_versions / assets / chat_logs /
//      project_reference_links / reference_items / folders / style_presets /
//      storyboard_sheets.
//   2) 각 행을 insert 하기 전에 행의 모든 JSON value 를 walk 하면서 string
//      안에 등장하는 oldId 를 newId 로 replaceAll. UUID-like 32hex ID 라 우연
//      한 부분 매칭 위험은 사실상 0. 이걸로 scenes.tagged_assets,
//      scene_versions.scenes 같은 JSON 안에 박힌 ID 도 자동으로 옮겨간다.
//   3) 같은 string-tree walk 에서 storage URL 도 함께 다시 쓴다 — host/port
//      를 export 시점과 다를 수 있는 현재 local-server base URL 로 교체.
//      project_id 가 path 에 포함된 storage URL 도 (1)의 ID replace 로 자연
//      스럽게 새 project_id 가 박힌 URL 이 된다.
//   4) ZIP 안의 files/<originalRelpath> 를 디스크에 복사할 때, 동일한 ID
//      replace 를 relpath 에 적용 — 결과 디스크 위치는 새 project_id 로
//      재배치된다.
//
// 충돌 전략 (V1 단순화):
//   - 항상 새 ID 로 insert (keepBoth).
//   - projects.title 이 활성 워크스페이스에 이미 있으면 ` (1)`, ` (2)` …
//     suffix 자동.
//   - folders.name / style_presets.name 도 동일한 name 이 있으면 ` (1)` 부여.

import { app, dialog } from "electron";
import fs from "fs";
import path from "path";
import JSZip from "jszip";

import { getStorageBasePath } from "./paths";
import { getLocalServerBaseUrl } from "./constants";
import { dbInsert, generateId, runQuery } from "./db-utils";
import { validateProjManifest, type ProjPackManifest } from "../src/lib/preflowProj";

interface ApplyProjPackInput {
  tempPath: string;
}

// ── 헬퍼 ──────────────────────────────────────────────

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function packTempPath(): string {
  return path.join(app.getPath("userData"), "tmp", `projpack-${generateId()}.zip`);
}

function assertTempPath(tempPath: string): string {
  const tmpRoot = path.resolve(app.getPath("userData"), "tmp");
  const resolved = path.resolve(tempPath);
  const rel = path.relative(tmpRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !resolved.endsWith(".zip")) {
    throw new Error("Invalid project pack temp path.");
  }
  return resolved;
}

/** UUID-like 32hex ID 는 SQLite/JS string 안에서도 그 자체로 unique 토큰
 *  이라 단순 split-join replaceAll 로 안전. 표준 ID 가 아니면 (예: 공백 포함)
 *  무시. */
function isLikelyId(value: string): boolean {
  return /^[a-f0-9-]{8,40}$/i.test(value);
}

function replaceAllSafe(haystack: string, needle: string, replacement: string): string {
  if (!needle || needle === replacement) return haystack;
  return haystack.split(needle).join(replacement);
}

interface RemapTables {
  /** key = old id, value = new id. 모든 도메인 ID 가 한 표에 합쳐 들어간다 —
   *  string-tree walk 가 한 번에 모두 치환할 수 있도록. */
  ids: Map<string, string>;
  /** 행 안의 storage URL 을 새 base URL 로 덮어쓰기 위한 prefix replace 패턴. */
  baseUrl: string;
}

const STORAGE_URL_HOST_RE = /^(https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\/)/i;

function rewriteString(value: string, remap: RemapTables): string {
  let out = value;
  // 1) 모든 ID replace.
  for (const [oldId, newId] of remap.ids) {
    if (out.includes(oldId)) out = replaceAllSafe(out, oldId, newId);
  }
  // 2) storage URL host/port 를 현재 local-server base 로 정규화.
  out = out.replace(STORAGE_URL_HOST_RE, `${remap.baseUrl}/storage/file/`);
  return out;
}

function rewriteValue(value: unknown, remap: RemapTables): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return rewriteString(value, remap);
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, remap));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteValue(v, remap);
    }
    return out;
  }
  return value;
}

function rewriteRow<T extends Record<string, unknown>>(row: T, remap: RemapTables): T {
  return rewriteValue(row, remap) as T;
}

/** 행 안에서 storage URL 만 추출 — collectUrlsFromValue 와 동일 패턴. */
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

// ── pack reader ──────────────────────────────────────

interface PackContents {
  zip: JSZip;
  manifest: ProjPackManifest;
  projects: Array<Record<string, unknown>>;
  briefs: Array<Record<string, unknown>>;
  brief_attachments: Array<Record<string, unknown>>;
  scenes: Array<Record<string, unknown>>;
  scene_versions: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  chat_logs: Array<Record<string, unknown>>;
  project_reference_links: Array<Record<string, unknown>>;
  references: Array<Record<string, unknown>>;
  folders: Array<Record<string, unknown>>;
  style_presets: Array<Record<string, unknown>>;
  storyboard_sheets: Array<Record<string, unknown>>;
}

async function readProjPack(tempPath: string): Promise<PackContents> {
  const buffer = await fs.promises.readFile(tempPath);
  const zip = await JSZip.loadAsync(buffer);

  const manifestRaw = parseJson<unknown>(await zip.file("manifest.json")?.async("string"), null);
  validateProjManifest(manifestRaw);
  const manifest = manifestRaw as ProjPackManifest;

  const readJsonArray = async (name: string) =>
    parseJson<Array<Record<string, unknown>>>(await zip.file(name)?.async("string"), []);

  return {
    zip,
    manifest,
    projects: await readJsonArray("projects.json"),
    briefs: await readJsonArray("briefs.json"),
    // brief_attachments — 옛 팩 (v1 export 시점 이전) 에는 이 파일이 없을 수
    // 있으므로 readJsonArray 가 빈 배열로 반환되는 게 자연스러운 fallback.
    brief_attachments: await readJsonArray("brief_attachments.json"),
    scenes: await readJsonArray("scenes.json"),
    scene_versions: await readJsonArray("scene_versions.json"),
    assets: await readJsonArray("assets.json"),
    chat_logs: await readJsonArray("chat_logs.json"),
    project_reference_links: await readJsonArray("project_reference_links.json"),
    references: await readJsonArray("references.json"),
    folders: await readJsonArray("folders.json"),
    style_presets: await readJsonArray("style_presets.json"),
    // storyboard_sheets — 콘티 시트 테스트 갤러리. 옛 팩(이 기능 추가 전
    // export)에는 이 파일이 없어 빈 배열 fallback.
    storyboard_sheets: await readJsonArray("storyboard_sheets.json"),
  };
}

// ── preview ──────────────────────────────────────────

export async function previewProjPackFromPath(srcPath: string) {
  if (!srcPath) throw new Error("Project pack path is required.");
  const tempPath = packTempPath();
  await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
  await fs.promises.copyFile(srcPath, tempPath);

  const pack = await readProjPack(tempPath);

  const projectTitles = pack.projects.map((p) => String(p.title ?? "")).filter(Boolean);
  const existingTitles = new Set(
    (runQuery("SELECT title FROM projects") as Array<{ title?: string }>)
      .map((r) => String(r.title ?? ""))
      .filter(Boolean),
  );
  const titleCollisions = projectTitles.filter((t) => existingTitles.has(t));

  // 누락 파일 — references / 모든 행이 가리키는 storage URL 이 ZIP 안의
  // files/<relpath> 로 존재하지 않는 경우.
  const missing: string[] = [];
  if (pack.manifest.include_files) {
    const allRows = [
      ...pack.projects,
      ...pack.briefs,
      ...pack.brief_attachments,
      ...pack.scenes,
      ...pack.scene_versions,
      ...pack.assets,
      ...pack.references,
      ...pack.style_presets,
      ...pack.storyboard_sheets,
    ];
    const urls = new Set<string>();
    for (const row of allRows) {
      for (const v of Object.values(row)) collectUrlsFromValue(v, urls);
    }
    for (const url of urls) {
      const rel = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\/(.+)$/i)?.[1];
      const decoded = rel ? decodeURIComponent(rel.split(/[?#]/)[0]) : null;
      if (decoded && !pack.zip.file(`files/${decoded}`)) missing.push(decoded);
    }
  }

  return {
    tempPath,
    manifest: pack.manifest,
    project_count: pack.projects.length,
    reference_count: pack.references.length,
    total_size_bytes: pack.manifest.total_size_bytes ?? 0,
    project_titles: projectTitles,
    title_collisions: titleCollisions,
    missing_files: missing,
  };
}

export async function previewProjPackFromDisk() {
  const picked = await dialog.showOpenDialog({
    title: "Import Project Pack",
    properties: ["openFile"],
    filters: [{ name: "Pre-Flow Project Pack", extensions: ["preflowproj"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { canceled: true as const };
  }
  return previewProjPackFromPath(picked.filePaths[0]);
}

// ── apply ────────────────────────────────────────────

const PROJECT_COLUMNS = new Set([
  "id", "user_id", "title", "client", "deadline", "status", "video_format",
  "active_version_id", "folder_id", "conti_style_id", "thumbnail_url",
  "thumbnail_crop", "is_favorite", "last_visited_at", "updated_at", "created_at",
]);
const BRIEF_COLUMNS = new Set([
  "id", "project_id", "raw_text", "analysis", "analysis_en", "mood_image_urls",
  "mood_bookmarks", "lang", "source_type", "image_urls", "created_at",
]);
const BRIEF_ATTACHMENT_COLUMNS = new Set([
  "id", "project_id", "kind", "role", "file_url", "poster_url", "external_url",
  "filename", "mime_type", "size_bytes", "width", "height", "duration_sec",
  "page_count", "extracted_text", "annotation", "display_order",
  "origin_reference_id", "created_at", "updated_at",
]);
const SCENE_COLUMNS = new Set([
  "id", "project_id", "scene_number", "title", "description", "camera_angle",
  "location", "mood", "duration_sec", "tagged_assets", "conti_image_url",
  "conti_image_history", "source", "conti_image_crop", "is_transition",
  "is_final", "is_highlight", "highlight_kind", "highlight_reason",
  "transition_type", "sketches", "created_at",
]);
const ASSET_COLUMNS = new Set([
  "id", "project_id", "asset_type", "tag_name", "photo_url", "ai_description",
  "outfit_description", "role_description", "space_description",
  "signature_items", "photo_crop", "photo_variations", "source_type", "created_at",
  "character_sheet_url", "character_sheet_generated_at", "character_sheet_source_url",
  "use_character_sheet", "character_sheet_style",
  "character_board_url", "character_board_generated_at", "character_board_source_url",
  "character_ref_mode", "source_reference_id",
]);
const SCENE_VERSION_COLUMNS = new Set([
  "id", "project_id", "version_number", "version_name", "scenes",
  "display_order", "is_active", "created_at",
]);
const CHAT_LOG_COLUMNS = new Set(["id", "project_id", "role", "content", "created_at"]);
const PROJECT_REF_LINK_COLUMNS = new Set([
  "id", "project_id", "reference_id", "target", "annotation", "time_range",
  "created_at", "updated_at",
]);
const REFERENCE_COLUMNS = new Set([
  "id", "kind", "title", "file_url", "thumbnail_url", "mime_type", "file_size",
  "content_hash", "duration_sec", "width", "height", "tags", "notes", "rating",
  "is_favorite", "source_url", "cover_at_sec", "timestamp_notes", "color_palette",
  "ai_suggestions", "classification_status", "classified_at", "origin_project_id",
  "source_app", "source_library", "source_id", "imported_at", "created_at",
  "pinned_at", "deleted_at", "updated_at", "last_used_at",
]);
const STORYBOARD_SHEET_COLUMNS = new Set([
  "id", "project_id", "url", "size_used", "cut_count", "cols", "rows",
  "scene_ids", "video_format", "created_at",
]);
const FOLDER_COLUMNS = new Set(["id", "user_id", "name", "created_at"]);
const STYLE_PRESET_COLUMNS = new Set([
  "id", "user_id", "name", "description", "reference_image_urls",
  "style_prompt", "thumbnail_url", "is_default", "created_at",
]);

function pickColumns<T extends Record<string, unknown>>(
  row: T,
  whitelist: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (whitelist.has(k)) out[k] = v;
  }
  return out;
}

function uniqueTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 1; n < 999; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Too many title collisions for "${base}"`);
}

export async function applyProjPack(input: ApplyProjPackInput) {
  const tempPath = assertTempPath(input.tempPath);
  const pack = await readProjPack(tempPath);

  // ── 1) ID remap 표 사전 발급 ──
  const idRemap = new Map<string, string>();
  const seedIds = (rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const oldId = String(row.id ?? "");
      if (!oldId || !isLikelyId(oldId)) continue;
      if (idRemap.has(oldId)) continue;
      idRemap.set(oldId, generateId());
    }
  };
  seedIds(pack.projects);
  seedIds(pack.briefs);
  seedIds(pack.brief_attachments);
  seedIds(pack.scenes);
  seedIds(pack.scene_versions);
  seedIds(pack.assets);
  seedIds(pack.chat_logs);
  seedIds(pack.project_reference_links);
  seedIds(pack.references);
  seedIds(pack.folders);
  seedIds(pack.style_presets);
  // storyboard_sheets.id 도 remap 표에 넣어야 (a) 시트 자체 PK 가 새 ID 로
  // insert 되고 (b) mood 버킷 파일 relpath 에 sheetId 가 박혀 있을 경우
  // 파일 복사 위치도 함께 재배치된다. scene_ids(JSON)는 scenes seed 로 이미
  // 표에 있는 scene ID 들이 rewriteRow walk 에서 자동 치환된다.
  seedIds(pack.storyboard_sheets);

  const remap: RemapTables = {
    ids: idRemap,
    baseUrl: getLocalServerBaseUrl(),
  };

  // ── 2) 제목 충돌 회피 ──
  const existingProjectTitles = new Set(
    (runQuery("SELECT title FROM projects") as Array<{ title?: string }>)
      .map((r) => String(r.title ?? ""))
      .filter(Boolean),
  );
  const renamedTitles: string[] = [];
  const titlePicked = new Set<string>(existingProjectTitles);
  const projectTitleRemap = new Map<string, string>(); // oldId → finalTitle
  for (const proj of pack.projects) {
    const oldId = String(proj.id ?? "");
    const baseTitle = String(proj.title ?? "Untitled");
    const finalTitle = uniqueTitle(baseTitle, titlePicked);
    titlePicked.add(finalTitle);
    if (finalTitle !== baseTitle) renamedTitles.push(finalTitle);
    projectTitleRemap.set(oldId, finalTitle);
  }

  // 폴더/프리셋 이름 충돌 회피 (옵션 — 단순히 ` (n)` suffix).
  const existingFolderNames = new Set(
    (runQuery("SELECT name FROM folders") as Array<{ name?: string }>)
      .map((r) => String(r.name ?? ""))
      .filter(Boolean),
  );
  const folderPicked = new Set<string>(existingFolderNames);
  const folderNameRemap = new Map<string, string>();
  for (const folder of pack.folders) {
    const oldId = String(folder.id ?? "");
    const baseName = String(folder.name ?? "Untitled Folder");
    const finalName = uniqueTitle(baseName, folderPicked);
    folderPicked.add(finalName);
    folderNameRemap.set(oldId, finalName);
  }

  const existingPresetNames = new Set(
    (runQuery("SELECT name FROM style_presets") as Array<{ name?: string }>)
      .map((r) => String(r.name ?? ""))
      .filter(Boolean),
  );
  const presetPicked = new Set<string>(existingPresetNames);
  const presetNameRemap = new Map<string, string>();
  for (const preset of pack.style_presets) {
    const oldId = String(preset.id ?? "");
    const baseName = String(preset.name ?? "Untitled Preset");
    const finalName = uniqueTitle(baseName, presetPicked);
    presetPicked.add(finalName);
    presetNameRemap.set(oldId, finalName);
  }

  // ── 3) 행 변환 + 컬럼 화이트리스트 적용 함수 ──
  const transformAndPick = <T extends Record<string, unknown>>(
    row: T,
    whitelist: ReadonlySet<string>,
  ): Record<string, unknown> => {
    const rewritten = rewriteRow(row, remap);
    return pickColumns(rewritten, whitelist);
  };

  let importedProjects = 0;
  let importedReferences = 0;
  let copiedFiles = 0;
  const missingFiles: string[] = [];

  // ── 4) 의존성 순서대로 insert ──
  // 4a) folders
  for (const folder of pack.folders) {
    const oldId = String(folder.id ?? "");
    const finalName = folderNameRemap.get(oldId) ?? String(folder.name ?? "Untitled Folder");
    const row = transformAndPick(folder, FOLDER_COLUMNS);
    row.name = finalName;
    row.user_id = "local";
    dbInsert("folders", row);
  }

  // 4b) style_presets
  for (const preset of pack.style_presets) {
    const oldId = String(preset.id ?? "");
    const finalName = presetNameRemap.get(oldId) ?? String(preset.name ?? "Untitled Preset");
    const row = transformAndPick(preset, STYLE_PRESET_COLUMNS);
    row.name = finalName;
    row.user_id = "local";
    // is_default 는 절대 import 로 인해 true 가 되면 안 됨 — 활성 워크스페이
    // 스의 기본 프리셋을 침범할 수 있어 import 본은 항상 false.
    row.is_default = false;
    dbInsert("style_presets", row);
  }

  // 4c) projects (제목 rename 적용)
  for (const proj of pack.projects) {
    const oldId = String(proj.id ?? "");
    const finalTitle = projectTitleRemap.get(oldId) ?? String(proj.title ?? "Untitled");
    const row = transformAndPick(proj, PROJECT_COLUMNS);
    row.title = finalTitle;
    row.user_id = "local";
    dbInsert("projects", row);
    importedProjects += 1;
  }

  // 4d) reference_items (프로젝트가 가리키는 스냅샷)
  for (const ref of pack.references) {
    const row = transformAndPick(ref, REFERENCE_COLUMNS);
    // import 흔적을 남겨 추후 dedupe / 추적 가능하게.
    row.source_app = "preflow-projpack";
    row.source_library = "project";
    row.source_id = String(ref.id ?? "");
    row.imported_at = new Date().toISOString();
    dbInsert("reference_items", row);
    importedReferences += 1;
  }

  // 4e) 자식 행들 — 단순 insert.
  const insertChildren = (
    rows: Array<Record<string, unknown>>,
    table: string,
    whitelist: ReadonlySet<string>,
  ) => {
    for (const r of rows) {
      const transformed = transformAndPick(r, whitelist);
      dbInsert(table, transformed);
    }
  };
  insertChildren(pack.briefs, "briefs", BRIEF_COLUMNS);
  // brief_attachments — Step B 마이그레이션으로 도입된 브리프 첨부물 1등 시민.
  // 옛 팩에는 비어 있어 no-op. 새 팩은 디스크 파일까지 함께 복원되어 첨부물
  // 100% 영구화.
  insertChildren(pack.brief_attachments, "brief_attachments", BRIEF_ATTACHMENT_COLUMNS);
  insertChildren(pack.scenes, "scenes", SCENE_COLUMNS);
  insertChildren(pack.scene_versions, "scene_versions", SCENE_VERSION_COLUMNS);
  insertChildren(pack.assets, "assets", ASSET_COLUMNS);
  insertChildren(pack.chat_logs, "chat_logs", CHAT_LOG_COLUMNS);
  insertChildren(pack.project_reference_links, "project_reference_links", PROJECT_REF_LINK_COLUMNS);
  // storyboard_sheets — 콘티 시트 갤러리. 옛 팩에는 비어 있어 no-op. 새 팩은
  // mood 버킷 이미지까지 함께 복원된다.
  insertChildren(pack.storyboard_sheets, "storyboard_sheets", STORYBOARD_SHEET_COLUMNS);

  // ── 5) ZIP 안 storage 파일 복사 (project_id substring replace 적용) ──
  if (pack.manifest.include_files) {
    const filesFolder = pack.zip.folder("files");
    if (filesFolder) {
      const entries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
      filesFolder.forEach((relativePath, entry) => {
        if (!entry.dir) entries.push({ name: relativePath, entry });
      });

      for (const { name: relPath, entry } of entries) {
        // 원본 relPath 안에 있을 수 있는 oldProjectId 등을 newProjectId 로
        // 치환해 새 디스크 위치 결정.
        let newRelPath = relPath;
        for (const [oldId, newId] of idRemap) {
          if (newRelPath.includes(oldId)) {
            newRelPath = replaceAllSafe(newRelPath, oldId, newId);
          }
        }
        const target = path.join(getStorageBasePath(), newRelPath);
        const storageBase = path.resolve(getStorageBasePath());
        const resolved = path.resolve(target);
        const safeRel = path.relative(storageBase, resolved);
        if (safeRel.startsWith("..") || path.isAbsolute(safeRel)) {
          // 안전 체크 — 절대 일어나선 안 되지만 보호.
          missingFiles.push(relPath);
          continue;
        }
        try {
          await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
          await fs.promises.writeFile(resolved, await entry.async("nodebuffer"));
          copiedFiles += 1;
        } catch {
          missingFiles.push(relPath);
        }
      }
    }
  }

  try {
    await fs.promises.unlink(tempPath);
  } catch {
    /* best effort */
  }

  return {
    imported_projects: importedProjects,
    imported_references: importedReferences,
    copied_files: copiedFiles,
    renamed_titles: renamedTitles,
    missing_files: missingFiles,
  };
}
