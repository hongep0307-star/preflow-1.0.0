import { dialog } from "electron";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import JSZip from "jszip";
import { getStorageBasePath } from "./paths";
import { getLocalServerBaseUrl } from "./constants";
import { dbSelect, deserializeRow, runQuery } from "./db-utils";

type PackScope = "folder" | "selected" | "filtered" | "all" | "projectLinked";

interface ExportPackRequest {
  scope: PackScope;
  ids?: string[];
  folderTag?: string;
  projectId?: string | null;
  includeFiles?: boolean;
  includeSubfolders?: boolean;
  suggestedName?: string;
  /** 캔버스 작업 (위치/노트/연결/뷰) 직렬화 — renderer 의 localStorage 에 있는
   *  `LayoutMap` 을 그대로 받아 `canvas_layouts.json` 으로 동봉. import 시 동일
   *  contextKey 에 병합. */
  canvasLayouts?: Record<string, unknown>;
}

interface ReferenceRow {
  id: string;
  kind: string;
  title: string;
  file_url?: string | null;
  thumbnail_url?: string | null;
  file_size?: number | null;
  tags?: string[] | string | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
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
    .slice(0, 80) || "preflow-library";
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

async function fileExists(filePath: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function allReferences(): ReferenceRow[] {
  return (dbSelect("reference_items", {}, { orderBy: "created_at", ascending: false, limit: 10_000 }) as ReferenceRow[])
    .filter((row) => !row.deleted_at);
}

function resolveRows(req: ExportPackRequest): ReferenceRow[] {
  const ids = new Set((req.ids ?? []).filter(Boolean));
  if (req.scope === "all") return allReferences();
  if (req.scope === "selected" || req.scope === "filtered") {
    if (ids.size === 0) return [];
    return allReferences().filter((row) => ids.has(row.id));
  }
  if (req.scope === "folder") {
    const tag = req.folderTag?.startsWith("folder:") ? req.folderTag : req.folderTag ? `folder:${req.folderTag}` : "";
    if (!tag) return [];
    return allReferences().filter((row) => {
      const tags = normalizeTags(row.tags);
      return req.includeSubfolders === false
        ? tags.includes(tag)
        : tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`));
    });
  }
  if (req.scope === "projectLinked" && req.projectId) {
    const rows = runQuery(
      `SELECT ri.* FROM project_reference_links prl
       JOIN reference_items ri ON ri.id = prl.reference_id
       WHERE prl.project_id = ? AND ri.deleted_at IS NULL
       ORDER BY prl.created_at ASC`,
      [req.projectId],
    ).map((row) => deserializeRow(row) as ReferenceRow);
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }
  return [];
}

function projectLinks(projectId: string | null | undefined, referenceIds: string[]) {
  if (!projectId || referenceIds.length === 0) return [];
  const placeholders = referenceIds.map(() => "?").join(",");
  return runQuery(
    `SELECT * FROM project_reference_links WHERE project_id = ? AND reference_id IN (${placeholders}) ORDER BY created_at ASC`,
    [projectId, ...referenceIds],
  ).map((row) => deserializeRow(row));
}

export async function exportLibraryPack(req: ExportPackRequest) {
  const includeFiles = req.includeFiles !== false;
  const rows = resolveRows(req);
  // .preflowpack 은 .preflowlib 와 데이터적으로 동일했는데 (project_links.json
  // 한 메타파일만 추가) 두 확장자가 사용자 혼동을 키워서 단일 .preflowlib 로
  // 통합했다. projectLinked scope 일 때만 project_links.json 을 추가로 묶고
  // 그것 외에는 일반 라이브러리 pack 과 똑같이 출력한다 — import 측은 이
  // 메타파일 *존재 여부* 로 프로젝트 링크 복원을 분기한다.
  const kind = "preflowlib" as const;
  const extension = "preflowlib";
  const scopeLabel = req.folderTag?.replace(/^folder:/, "") || req.scope;
  const defaultName = sanitizeName(req.suggestedName || `${scopeLabel}-${new Date().toISOString().slice(0, 10)}`) + `.${extension}`;
  const picked = await dialog.showSaveDialog({
    title: "Export Pre-Flow Reference Pack",
    defaultPath: defaultName,
    filters: [{ name: "Pre-Flow Library", extensions: [extension] }],
  });
  if (picked.canceled || !picked.filePath) {
    return { canceled: true, item_count: 0, total_size_bytes: 0, skipped: [] };
  }

  const zip = new JSZip();
  const references: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  let totalSize = 0;

  for (const row of rows) {
    const copy: Record<string, unknown> = { ...row };
    delete copy.promoted_asset_ids;
    const sourceId = row.id;
    if (includeFiles) {
      for (const [urlKey, relKey, dir] of [
        ["file_url", "file_relpath", "files"],
        ["thumbnail_url", "thumbnail_relpath", "thumbnails"],
      ] as const) {
        const sourcePath = resolveStorageUrlToPath(row[urlKey] as string | null | undefined);
        if (await fileExists(sourcePath)) {
          const ext = path.extname(sourcePath!) || ".bin";
          const relPath = `${dir}/${sourceId}${ext}`;
          zip.file(relPath, fs.createReadStream(sourcePath!));
          copy[relKey] = relPath;
          if (urlKey === "file_url") {
            const stat = await fs.promises.stat(sourcePath!);
            totalSize += stat.size;
          }
        } else if (row[urlKey]) {
          skipped.push(`${row.title}: missing ${urlKey}`);
        }
      }
    }
    references.push(copy);
  }

  zip.file("references.json", JSON.stringify(references, null, 2));
  // 캔버스 작업 동봉 — renderer 에서 `getAllCanvasLayouts()` 로 받아온 맵을
  // 그대로 zip 에 박는다. import 측은 `mergeCanvasLayouts` 로 skip 모드 병합.
  // 빈 객체면 굳이 동봉하지 않음 (zip 크기/preview 노이즈 감소).
  if (req.canvasLayouts && typeof req.canvasLayouts === "object" && Object.keys(req.canvasLayouts).length > 0) {
    zip.file("canvas_layouts.json", JSON.stringify(req.canvasLayouts));
  }
  // projectLinked scope 에서만 project_links.json 을 동봉한다. 이 메타파일은
  // import 측에서 mountProjectId 없이도 자동으로 새 프로젝트를 만들어 링크를
  // 복원할 단서로 쓰인다. 다른 scope 에서는 동봉하지 않아 일반
  // 라이브러리 pack 으로만 작동한다.
  const includeProjectLinks = req.scope === "projectLinked" && !!req.projectId;
  const links = includeProjectLinks ? projectLinks(req.projectId, rows.map((row) => row.id)) : [];
  if (includeProjectLinks) {
    zip.file("project_links.json", JSON.stringify({ links }, null, 2));
  }
  const project = req.projectId
    ? (runQuery("SELECT id, title FROM projects WHERE id = ?", [req.projectId])[0] as { id: string; title?: string } | undefined)
    : null;
  const manifest = {
    version: 1,
    kind,
    created_at: new Date().toISOString(),
    app_version: "1.0.0",
    library_id: "main",
    item_count: rows.length,
    total_size_bytes: totalSize,
    include_files: includeFiles,
    scope: req.scope,
    scope_label: scopeLabel,
    project: project ? { id: project.id, name: project.title ?? null } : null,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  await fs.promises.mkdir(path.dirname(picked.filePath), { recursive: true });
  await pipeline(zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }), fs.createWriteStream(picked.filePath));
  return {
    saved_path: picked.filePath,
    item_count: rows.length,
    total_size_bytes: totalSize,
    skipped,
    base_url: getLocalServerBaseUrl(),
  };
}
