import { app, dialog } from "electron";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { getStorageBasePath } from "./paths";
import { getLocalServerBaseUrl } from "./constants";
import { dbInsert, dbUpdate, deserializeRow, generateId, runQuery } from "./db-utils";

type PackImportStrategy = "skip" | "keepBoth" | "mergeMetadata";

/**
 * Pack 안의 reference 들이 들고 있는 `folder:*` 태그를 import 시점에 어떻게
 * 다룰지 결정하는 축. duplicate strategy(skip/keepBoth/mergeMetadata) 와는
 * 독립적으로 적용된다.
 *
 *  - "recreate": pack 의 폴더 트리 그대로 라이브러리에 재현. destination 이
 *    있으면 그 아래에 mount (예: pack 의 `Sports/Soccer` + destination=`7`
 *    → `7/Sports/Soccer`). 라이브러리에 같은 top-level segment 가 이미 있어
 *    충돌하면 ` (1)`, ` (2)` ... suffix 로 자동 회피.
 *  - "flatten": pack 의 모든 `folder:*` 태그를 떼어내고 destination 폴더
 *    태그 하나만 부여. destination 이 없으면 폴더 없는 자료로 들어감.
 *
 * Pack 안에 `folder:*` 태그가 하나도 없으면 두 모드의 결과가 같다(다만
 * recreate 의 경우 root-level ref 는 destination 이 있으면 그 destination
 * 으로 들어감 — "이 pack 트리 전체를 destination 아래로" 의미를 살리기 위함).
 */
type PackFolderStrategy = "recreate" | "flatten";

type FolderRemap = Map<string, string>;

interface PackReferenceRow {
  id: string;
  kind: string;
  title: string;
  file_relpath?: string | null;
  thumbnail_relpath?: string | null;
  tags?: string[] | string | null;
  notes?: string | null;
  color_palette?: unknown;
  timestamp_notes?: unknown;
  content_hash?: string | null;
  [key: string]: unknown;
}

interface PackManifest {
  version: 1;
  kind: "preflowlib" | "preflowpack";
  library_id?: string | null;
  total_size_bytes?: number | null;
  project?: { name?: string | null } | null;
}

interface ProjectLinkRow {
  reference_source_id?: string | null;
  reference_id?: string | null;
  target?: string | null;
  annotation?: string | null;
  time_range?: unknown;
}

type ExistingReference = Record<string, unknown> & {
  id: string;
  title?: string;
  content_hash?: string | null;
  tags?: unknown;
  notes?: string | null;
  color_palette?: unknown;
  timestamp_notes?: unknown;
};

const REFERENCE_COLUMNS = new Set([
  "kind", "title", "file_url", "thumbnail_url", "mime_type", "file_size",
  "content_hash", "duration_sec", "width", "height", "tags", "notes", "rating",
  "is_favorite", "source_url", "cover_at_sec", "timestamp_notes", "color_palette",
  "ai_suggestions", "classification_status", "classified_at", "origin_project_id",
  "source_app", "source_library", "source_id", "imported_at", "pinned_at",
  "deleted_at", "last_used_at",
]);

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "reference";
}

function packTempPath(): string {
  return path.join(app.getPath("userData"), "tmp", `pack-${generateId()}.zip`);
}

function assertTempPath(tempPath: string): string {
  const tmpRoot = path.resolve(app.getPath("userData"), "tmp");
  const resolved = path.resolve(tempPath);
  const rel = path.relative(tmpRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !resolved.endsWith(".zip")) {
    throw new Error("Invalid pack temp path.");
  }
  return resolved;
}

function existingBySource(sourceLibrary: string, sourceId: string): ExistingReference | null {
  const row = runQuery(
    `SELECT * FROM reference_items
     WHERE source_app = ? AND source_library = ? AND source_id = ?
     ORDER BY created_at ASC LIMIT 1`,
    ["preflow-pack", sourceLibrary, sourceId],
  )[0];
  return row ? deserializeRow(row) as ExistingReference : null;
}

const FOLDER_TAG_PREFIX = "folder:";

function isFolderTag(tag: string): boolean {
  return tag.startsWith(FOLDER_TAG_PREFIX);
}

function folderPathOf(tag: string): string {
  return tag.slice(FOLDER_TAG_PREFIX.length);
}

function normalizeFolderPath(input: string): string {
  return input
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Pack 안 모든 reference 의 `folder:*` 태그에서 첫 세그먼트(top-level 폴더)
 * 만 unique 하게 모아 정렬해서 반환. 이게 "재현 시 라이브러리 루트(또는
 * destination 아래) 에 새로 등장할 폴더 후보" 와 1:1 대응 — 충돌 검사 단위
 * 도 이 top-level 기준이라 사용자 멘탈 모델("폴더 통째로 옮긴다") 과 일치.
 */
function collectPackTopLevelFolders(references: PackReferenceRow[]): string[] {
  const set = new Set<string>();
  for (const ref of references) {
    for (const raw of normalizeArray(ref.tags).map(String)) {
      if (!isFolderTag(raw)) continue;
      const segments = folderPathOf(raw).split("/").filter(Boolean);
      if (segments.length > 0) set.add(segments[0]);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * 현재 라이브러리에 존재하는 모든 폴더 경로를 SQL 한 번으로 수집.
 * `reference_items.tags` 가 JSON 문자열로 직렬화돼 저장돼 있으니 LIKE 로
 * 거의 모든 row 를 거른 뒤(완전 조건부 매칭은 JS) 파싱한다. 휴지통 항목은
 * 제외 — 휴지통의 폴더 태그가 살아 있어도 사용자 입장에서는 "비어 있는"
 * 폴더로 보이기 때문에 충돌 회피 대상으로 포함하면 어색하다.
 */
function listLibraryFolderPaths(): Set<string> {
  const rows = runQuery(
    `SELECT tags FROM reference_items
     WHERE deleted_at IS NULL AND tags LIKE ?`,
    ['%"folder:%'],
  );
  const paths = new Set<string>();
  for (const row of rows) {
    for (const raw of normalizeArray((row as { tags?: unknown }).tags).map(String)) {
      if (!isFolderTag(raw)) continue;
      const path = normalizeFolderPath(folderPathOf(raw));
      if (path) paths.add(path);
    }
  }
  return paths;
}

/**
 * `recreate` 모드에서 destination prefix 와 충돌 회피 suffix 를 한 번에
 * 풀어내는 remap 표를 만든다. key = pack 의 top-level segment, value = 새
 * top-level segment(이미 destination 이 prefix 로 붙은 형태가 아니라 그냥
 * "Sports" 또는 "Sports (1)"). transformTags 가 destination 을 따로 더해
 * 최종 경로를 만든다.
 *
 * 충돌 검사 단위는 destination + new top-level. 예) destination=`7`,
 * pack=`Sports`. `7/Sports` 가 라이브러리에 (정확히 또는 하위로) 존재하면
 * `Sports (1)` 시도, 다시 `7/Sports (1)` 가 있으면 `Sports (2)` … 999 회까지.
 *
 * 충돌 비교는 case-insensitive — 사용자 입장에서 `Purple` 과 `purple` 은
 * 같은 폴더로 인식하므로 import 시 자동 rename 이 걸려야 사이드바에
 * 두 개가 따로 생기는 혼란을 막는다. 저장 시에는 원본 casing 을 그대로
 * 유지(remap value 에 넣는 candidate 는 `topLevel` 의 원본 case 를 보존).
 */
function buildFolderRemap(
  packTopLevels: string[],
  destinationPath: string | null,
  existingPaths: Set<string>,
): FolderRemap {
  const remap: FolderRemap = new Map();
  const pickedPathsLower = new Set<string>();
  const existingPathsLower = new Set<string>();
  for (const p of existingPaths) existingPathsLower.add(p.toLowerCase());
  const fullPath = (segment: string) => (destinationPath ? `${destinationPath}/${segment}` : segment);
  const isTaken = (segment: string) => {
    const fullLower = fullPath(segment).toLowerCase();
    if (pickedPathsLower.has(fullLower)) return true;
    const prefix = `${fullLower}/`;
    for (const p of existingPathsLower) {
      if (p === fullLower || p.startsWith(prefix)) return true;
    }
    return false;
  };
  for (const topLevel of packTopLevels) {
    let candidate = topLevel;
    let n = 1;
    while (isTaken(candidate)) {
      candidate = `${topLevel} (${n})`;
      n += 1;
      if (n > 999) throw new Error(`Too many folder name conflicts for "${topLevel}".`);
    }
    remap.set(topLevel, candidate);
    pickedPathsLower.add(fullPath(candidate).toLowerCase());
  }
  return remap;
}

interface FolderTransformOpts {
  folderStrategy: PackFolderStrategy;
  destinationPath: string | null;
  folderRemap: FolderRemap;
}

/**
 * 한 reference 의 tags 배열을 folder strategy 에 맞춰 변환. 비-폴더 태그
 * (색상, 카테고리 등) 는 항상 보존.
 *
 *  - flatten + dest: `folder:*` 모두 제거 + `folder:<dest>` 단일 부여
 *  - flatten + no dest: `folder:*` 모두 제거 (root 로 평탄화)
 *  - recreate + dest: 각 `folder:X/Y` → `folder:<dest>/<remap[X]>/Y`,
 *    pack root 인 ref 는 `folder:<dest>` 부여 ("트리 전체를 dest 아래로")
 *  - recreate + no dest: 각 `folder:X/Y` → `folder:<remap[X]>/Y` 그대로
 */
function transformTagsForImport(originalTags: unknown, opts: FolderTransformOpts): string[] {
  const tags = normalizeArray(originalTags).map(String);
  const nonFolder = tags.filter((tag) => !isFolderTag(tag));
  const folderTags = tags.filter(isFolderTag);

  if (opts.folderStrategy === "flatten") {
    if (opts.destinationPath) return [...nonFolder, `${FOLDER_TAG_PREFIX}${opts.destinationPath}`];
    return nonFolder;
  }

  // recreate
  if (folderTags.length === 0) {
    if (opts.destinationPath) return [...nonFolder, `${FOLDER_TAG_PREFIX}${opts.destinationPath}`];
    return nonFolder;
  }

  const remapped = folderTags.map((tag) => {
    const segments = folderPathOf(tag).split("/").filter(Boolean);
    if (segments.length === 0) return tag;
    const newTop = opts.folderRemap.get(segments[0]) ?? segments[0];
    const newSegments = [newTop, ...segments.slice(1)];
    const joined = newSegments.join("/");
    const finalPath = opts.destinationPath ? `${opts.destinationPath}/${joined}` : joined;
    return `${FOLDER_TAG_PREFIX}${finalPath}`;
  });
  return [...new Set([...nonFolder, ...remapped])];
}

async function readPack(tempPath: string) {
  const buffer = await fs.promises.readFile(tempPath);
  const zip = await JSZip.loadAsync(buffer);
  const manifest = parseJson<PackManifest | null>(await zip.file("manifest.json")?.async("string"), null);
  const references = parseJson<PackReferenceRow[]>(await zip.file("references.json")?.async("string"), []);
  const projectLinks = parseJson<{ links: ProjectLinkRow[] }>(await zip.file("project_links.json")?.async("string"), { links: [] });
  // 캔버스 작업 (위치/노트/연결/뷰) — 옛 pack 에는 없을 수 있으므로 null 허용.
  const canvasLayouts = parseJson<Record<string, unknown> | null>(
    await zip.file("canvas_layouts.json")?.async("string"),
    null,
  );
  // 새 export 는 항상 kind === "preflowlib". 옛 `.preflowpack` 파일은 같은
  // 데이터 모양 + project_links.json 만 추가된 형태라 분기 없이 동일하게
  // 처리한다 — kind 는 historical metadata 로만 남는다.
  if (!manifest || manifest.version !== 1 || (manifest.kind !== "preflowlib" && manifest.kind !== "preflowpack")) {
    throw new Error("Invalid Pre-Flow library pack.");
  }
  return { zip, manifest, references, projectLinks, canvasLayouts };
}

/**
 * 임의 경로(파일 picker / 드래그-드랍 / Add → Choose Files 진입점) 에서
 * 선택된 .preflowlib / .preflowpack 파일을 temp 로 복사한 뒤 미리보기를
 * 만들어 돌려준다. 다이얼로그 기반 `previewPackFromDisk` 와 핵심 로직을
 * 공유 — 사용자 입력 경로를 받느냐, 자체 다이얼로그를 띄우느냐만 다름.
 */
export async function previewPackFromPath(srcPath: string) {
  if (!srcPath) throw new Error("Pack file path is required.");
  const tempPath = packTempPath();
  await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
  await fs.promises.copyFile(srcPath, tempPath);
  const { zip, manifest, references, canvasLayouts } = await readPack(tempPath);
  const sourceLibrary = manifest.library_id || "main";
  const duplicates = references.flatMap((ref) => {
    const existing = existingBySource(sourceLibrary, ref.id);
    return existing ? [{
      source_id: ref.id,
      existing_reference_id: existing.id,
      title: existing.title,
      content_hash: existing.content_hash ?? null,
    }] : [];
  });
  const kindDistribution: Record<string, number> = {};
  const missingFiles: string[] = [];
  for (const ref of references) {
    kindDistribution[ref.kind] = (kindDistribution[ref.kind] ?? 0) + 1;
    for (const rel of [ref.file_relpath, ref.thumbnail_relpath]) {
      if (rel && !zip.file(rel)) missingFiles.push(rel);
    }
  }
  const topLevelFolders = collectPackTopLevelFolders(references);
  return {
    tempPath,
    manifest,
    item_count: references.length,
    kind_distribution: kindDistribution,
    total_size_bytes: manifest.total_size_bytes ?? 0,
    duplicates,
    missing_files: missingFiles,
    /** Pack 안에 `folder:*` 태그가 한 개라도 있는지 — 다이얼로그가 폴더
     *  배치 라디오 그룹을 보일지 결정하는 데 사용. */
    has_folder_structure: topLevelFolders.length > 0,
    /** Pack 의 unique top-level 폴더 segment 목록. 다이얼로그 chip 미리보기
     *  + 클라이언트 측 충돌 (1) 표시 계산에 사용. */
    top_level_folders: topLevelFolders,
    /** Pack 에 동봉된 캔버스 작업 — 있으면 import 직후 renderer 가 받아
     *  `mergeCanvasLayouts` 로 병합. 없거나 옛 pack 이면 null. */
    canvas_layouts: canvasLayouts ?? null,
  };
}

export async function previewPackFromDisk() {
  const picked = await dialog.showOpenDialog({
    title: "Import Pre-Flow Library",
    properties: ["openFile"],
    // 새 export 는 항상 .preflowlib 이지만, 옛 .preflowpack 파일도 동일한
    // import 파이프라인으로 처리되니 선택 가능하도록 남겨 둔다.
    filters: [{ name: "Pre-Flow Library", extensions: ["preflowlib", "preflowpack"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { canceled: true };
  }
  return previewPackFromPath(picked.filePaths[0]);
}

async function copyZipEntry(zip: JSZip, relPath: string | null | undefined, referenceId: string): Promise<string | null> {
  if (!relPath) return null;
  const entry = zip.file(relPath);
  if (!entry) return null;
  const ext = path.extname(relPath) || ".bin";
  const relative = `${new Date().toISOString().slice(0, 7)}/${referenceId}/${sanitizeName(path.basename(relPath, ext))}${ext}`;
  const target = path.join(getStorageBasePath(), "references", relative);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, await entry.async("nodebuffer"));
  return `${getLocalServerBaseUrl()}/storage/file/references/${relative.replace(/\\/g, "/")}`;
}

/**
 * Library UI 의 현재 컨텍스트(폴더 / Favorites) + folder strategy 결정
 * 결과를 묶어 importRow / mergeMetadata / applyContextOverlay 세 분기에
 * 동일하게 전달한다. transform 은 미리 만들어 둔 폴더 변환 함수.
 */
type ImportContext = {
  forceFavorite?: boolean;
  transformTags: (originalTags: unknown) => string[];
};

function importRow(
  ref: PackReferenceRow,
  sourceLibrary: string,
  id: string,
  urls: { fileUrl: string | null; thumbnailUrl: string | null },
  context: ImportContext,
) {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ref)) {
    if (REFERENCE_COLUMNS.has(key)) row[key] = value;
  }
  row.tags = context.transformTags(row.tags);
  if (context.forceFavorite) {
    row.is_favorite = true;
  }
  row.id = id;
  // URL-only reference(YouTube/Behance/Instagram 등) 는 zip 에 파일이 없어
  // `urls.fileUrl` / `urls.thumbnailUrl` 가 null. 이전 코드는 이들을 무조건
  // 덮어써 위 for-loop 에서 ref 로부터 복사된 *원본 외부 URL* 까지 null 로
  // 잃었다 → import 후 회색 비디오 아이콘만 남던 버그.
  // 규칙: zip 의 로컬 사본이 있으면 그 경로로 덮어쓰고, 없으면 원본 외부 URL
  // 을 그대로 유지한다. thumbnail 이 둘 다 비어 있을 때만 file_url 을 폴백
  // 으로 — 이미지 reference 의 기존 동작 보존.
  if (urls.fileUrl) row.file_url = urls.fileUrl;
  if (urls.thumbnailUrl) {
    row.thumbnail_url = urls.thumbnailUrl;
  } else if (urls.fileUrl && !row.thumbnail_url) {
    row.thumbnail_url = urls.fileUrl;
  }
  row.source_app = "preflow-pack";
  row.source_library = sourceLibrary;
  row.source_id = ref.id;
  row.imported_at = new Date().toISOString();
  row.created_at = new Date().toISOString();
  row.updated_at = new Date().toISOString();
  delete row.promoted_asset_ids;
  return row;
}

function mergeMetadata(existing: ExistingReference, ref: PackReferenceRow, context: ImportContext) {
  const transformedPackTags = context.transformTags(ref.tags);
  const tags = [...new Set([
    ...normalizeArray(existing.tags).map(String),
    ...transformedPackTags,
  ])];
  const notes = [existing.notes, ref.notes].filter((value) => typeof value === "string" && value.trim()).join("\n\n");
  const updates: Record<string, unknown> = {
    tags,
    notes: notes || null,
    color_palette: normalizeArray(existing.color_palette).length ? existing.color_palette : normalizeArray(ref.color_palette),
    timestamp_notes: [...normalizeArray(existing.timestamp_notes), ...normalizeArray(ref.timestamp_notes)],
    updated_at: new Date().toISOString(),
  };
  if (context.forceFavorite) updates.is_favorite = true;
  dbUpdate("reference_items", updates, { id: existing.id });
}

/**
 * "Skip duplicates" 일 때도, 사용자가 폴더 / Favorites 같은 Library UI
 * 컨텍스트(또는 folder strategy 의 destination) 를 가진 채 import 했다면
 * 그 의도를 살리려고 기존 row 의 tags / is_favorite 만 비파괴적으로
 * overlay 한다. 다이얼로그 상단의 컨텍스트 힌트와 실제 결과가 어긋나는
 * 문제(duplicate-only pack 을 폴더에 드래그 했을 때 row 가 그 폴더에 안
 * 잡히는 현상)를 막기 위함.
 *
 * 그 외 metadata(notes, color_palette, timestamp_notes 등)는 손대지 않아
 * "skip" 의 본래 의미(파일/메타 보존) 와도 충돌하지 않는다. transform
 * 결과가 기존 tags 대비 추가가 없고 favorite 도 변화 없으면 no-op.
 *
 * 핵심: ADD-only — 기존 폴더 태그를 절대 제거하지 않는다. flatten 모드라
 * 신규 row 였다면 폴더 태그가 1개로 정리되겠지만, 기존 row 는 원래 폴더가
 * 살아 있는 게 사용자에게 덜 놀라운 동작.
 */
function applyContextOverlay(existing: ExistingReference, ref: PackReferenceRow, context: ImportContext): boolean {
  const updates: Record<string, unknown> = {};
  const existingTags = normalizeArray(existing.tags).map(String);
  const transformedPackTags = context.transformTags(ref.tags);
  const merged = [...new Set([...existingTags, ...transformedPackTags])];
  if (merged.length !== existingTags.length) {
    updates.tags = merged;
  }
  if (context.forceFavorite && !existing.is_favorite) {
    updates.is_favorite = true;
  }
  if (Object.keys(updates).length === 0) return false;
  updates.updated_at = new Date().toISOString();
  dbUpdate("reference_items", updates, { id: existing.id });
  return true;
}

/**
 * Pack 의 reference 들을 어느 프로젝트에 묶을지 결정. 명시적으로 mount 가
 * 지정됐으면 거기, 아니면 pack 안에 `project_links.json` (그리고 그 안의
 * `links` 가 비어 있지 않음) 이 들어 있을 때만 새 "Imported" 프로젝트를
 * 자동 생성. 옛 `.preflowpack` 파일도 같은 메타파일을 들고 있으니 분기 단서가
 * 통일된다 — 더 이상 `manifest.kind` 로 판단하지 않는다.
 */
function ensureImportedProject(
  manifest: PackManifest,
  hasProjectLinks: boolean,
  mountProjectId?: string | null,
): string | null {
  if (mountProjectId) return mountProjectId;
  if (!hasProjectLinks) return null;
  const id = generateId();
  dbInsert("projects", {
    id,
    user_id: "local",
    title: manifest.project?.name ? `${manifest.project.name} (Imported)` : "Imported Reference Pack",
    status: "draft",
    created_at: new Date().toISOString(),
  });
  return id;
}

export async function applyPack(input: {
  tempPath: string;
  strategy: PackImportStrategy;
  mountProjectId?: string | null;
  /**
   * Pack 의 `folder:*` 태그 처리 방식. 미지정이면 "flatten"
   * (destination 이 있으면 그 폴더로, 없으면 root) 으로 안전 폴백.
   */
  folderStrategy?: PackFolderStrategy;
  /**
   * Library UI 의 활성 폴더 경로 (예: "Sports/Soccer"). `folder:` prefix
   * 없는 normalized path 만 받는다. flatten 시 destination, recreate 시
   * pack 트리의 mount point 로 동시에 작동.
   */
  destinationFolderPath?: string | null;
  /** Favorites quick filter 에서 import 했을 때 is_favorite 를 강제 적용. */
  forceFavorite?: boolean;
}) {
  const tempPath = assertTempPath(input.tempPath);
  const { zip, manifest, references, projectLinks } = await readPack(tempPath);
  const sourceLibrary = manifest.library_id || "main";
  const sourceToNewId = new Map<string, string>();
  const missingFiles: string[] = [];

  const folderStrategy: PackFolderStrategy = input.folderStrategy === "recreate" ? "recreate" : "flatten";
  const destinationPath = (() => {
    const raw = typeof input.destinationFolderPath === "string" ? input.destinationFolderPath : "";
    const cleaned = normalizeFolderPath(raw.replace(/^folder:/, ""));
    return cleaned ? cleaned : null;
  })();
  // recreate 일 때만 충돌 회피용 remap 이 필요. flatten 은 pack 폴더 태그를
  // 모두 떼므로 충돌 검사 자체가 무의미.
  const folderRemap: FolderRemap = folderStrategy === "recreate"
    ? buildFolderRemap(collectPackTopLevelFolders(references), destinationPath, listLibraryFolderPaths())
    : new Map();

  // 최종적으로 reference 에 박힌 모든 folder 경로 (`folder:` prefix 없이).
  // applyPack 종료 시 created_folder_paths 로 반환해 LibraryPage 가 사용자
  // 폴더 캐시에 영구 등록한다 — 수동 폴더와 동일하게 모든 아이템이
  // 사라져도 사이드바에 남도록 하기 위함.
  const touchedFolderPaths = new Set<string>();
  const context: ImportContext = {
    forceFavorite: Boolean(input.forceFavorite),
    transformTags: (originalTags) => {
      const next = transformTagsForImport(originalTags, {
        folderStrategy,
        destinationPath,
        folderRemap,
      });
      for (const tag of next) {
        if (typeof tag === "string" && tag.startsWith(FOLDER_TAG_PREFIX)) {
          touchedFolderPaths.add(folderPathOf(tag));
        }
      }
      return next;
    },
  };
  let inserted = 0;
  let skipped = 0;
  let merged = 0;
  let copiedFiles = 0;

  for (const ref of references) {
    const existing = existingBySource(sourceLibrary, ref.id);
    if (existing && input.strategy === "skip") {
      // 사용자 의도("이 폴더에 떨어뜨림" / "Favorites 에서 추가") 는 skip
      // 이라도 살린다 — file/메타는 안 건드리되 폴더 태그·is_favorite 만
      // overlay. duplicate-only pack 을 폴더에 드래그 했을 때 결과가
      // 다이얼로그 힌트와 어긋나는 케이스를 막기 위함.
      applyContextOverlay(existing, ref, context);
      sourceToNewId.set(ref.id, existing.id);
      skipped += 1;
      continue;
    }
    if (existing && input.strategy === "mergeMetadata") {
      mergeMetadata(existing, ref, context);
      sourceToNewId.set(ref.id, existing.id);
      merged += 1;
      continue;
    }
    const nextId = generateId();
    const fileUrl = await copyZipEntry(zip, ref.file_relpath, nextId);
    const thumbnailUrl = await copyZipEntry(zip, ref.thumbnail_relpath, nextId);
    if (ref.file_relpath && !fileUrl) missingFiles.push(ref.file_relpath);
    if (ref.thumbnail_relpath && !thumbnailUrl) missingFiles.push(ref.thumbnail_relpath);
    if (fileUrl) copiedFiles += 1;
    if (thumbnailUrl && thumbnailUrl !== fileUrl) copiedFiles += 1;
    dbInsert("reference_items", importRow(ref, sourceLibrary, nextId, { fileUrl, thumbnailUrl }, context));
    sourceToNewId.set(ref.id, nextId);
    inserted += 1;
  }

  const linkRows = projectLinks.links ?? [];
  const projectId = ensureImportedProject(manifest, linkRows.length > 0, input.mountProjectId);
  if (projectId) {
    for (const link of linkRows) {
      const sourceId = String(link.reference_source_id ?? link.reference_id ?? "");
      const referenceId = sourceToNewId.get(sourceId);
      if (!referenceId) continue;
      dbInsert("project_reference_links", {
        id: generateId(),
        project_id: projectId,
        reference_id: referenceId,
        target: link.target ?? "brief",
        annotation: link.annotation ?? null,
        time_range: link.time_range ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  try {
    await fs.promises.unlink(tempPath);
  } catch {
    /* best effort */
  }
  // touchedFolderPaths 는 leaf 만 담고 있을 수 있어, 사이드바 트리가
  // 끊기지 않도록 모든 ancestor 경로까지 함께 노출한다 (LibraryPage 가
  // userFolderPaths 로 등록).
  const createdFolderPaths = new Set<string>();
  for (const path of touchedFolderPaths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      createdFolderPaths.add(parts.slice(0, i).join("/"));
    }
  }

  return {
    inserted,
    skipped,
    merged,
    copied_files: copiedFiles,
    missing_files: missingFiles,
    created_folder_paths: [...createdFolderPaths].sort(),
  };
}
