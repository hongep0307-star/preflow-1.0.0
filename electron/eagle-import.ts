import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getLocalServerBaseUrl } from "./constants";
import { dbInsert, dbSelect } from "./db-utils";
import { getStorageBasePath } from "./paths";

type JsonRecord = Record<string, unknown>;

export interface EaglePreview {
  rootPath: string;
  libraryName: string;
  totalItems: number;
  totalBytes: number;
  kinds: Record<string, number>;
  folders: number;
  smartFolders: number;
  tags: number;
  duplicateCandidates: number;
  missingFiles: Array<{ id: string; name: string; reason: string }>;
}

export interface EagleImportResult extends EaglePreview {
  imported: number;
  skipped: number;
  metadataOnly: number;
  failed: Array<{ id: string; name: string; reason: string }>;
}

type EagleItem = {
  id: string;
  name: string;
  ext: string;
  infoDir: string;
  metadata: JsonRecord;
  originalFile?: string;
  thumbnailFile?: string;
  size: number;
  kind: "image" | "webp" | "gif" | "video" | "youtube" | "link";
  folderTags: string[];
  tags: string[];
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "svg"]);
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return asRecord(JSON.parse(raw));
}

function sanitizeSegment(value: string): string {
  const cleaned = [...value]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char))
    .join("");
  return cleaned.replace(/\s+/g, "_").slice(0, 120) || "eagle";
}

function publicStorageUrl(relativePath: string): string {
  const encoded = relativePath.split(/[\\/]+/).map(encodeURIComponent).join("/");
  return `${getLocalServerBaseUrl()}/storage/file/references/${encoded}`;
}

function classifyExt(ext: string, sourceUrl?: string): EagleItem["kind"] {
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (clean === "gif") return "gif";
  if (clean === "webp") return "webp";
  if (VIDEO_EXTENSIONS.has(clean)) return "video";
  if (IMAGE_EXTENSIONS.has(clean)) return "image";
  if (clean === "url" && sourceUrl && /(?:youtube\.com|youtu\.be)/i.test(sourceUrl)) return "youtube";
  return "link";
}

function buildFolderMap(metadata: JsonRecord): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: JsonRecord, parents: string[]) => {
    const id = asString(node.id);
    const name = asString(node.name) || asString(node.title);
    const next = name ? [...parents, name] : parents;
    if (id && next.length > 0) out.set(id, next.join("/"));
    const children = node.children ?? node.folders;
    if (Array.isArray(children)) {
      for (const child of children) visit(asRecord(child), next);
    }
  };
  const folders = metadata.folders;
  if (Array.isArray(folders)) {
    for (const folder of folders) visit(asRecord(folder), []);
  }
  return out;
}

function countFolders(metadata: JsonRecord): number {
  let count = 0;
  const visit = (node: JsonRecord) => {
    count += 1;
    const children = node.children ?? node.folders;
    if (Array.isArray(children)) {
      for (const child of children) visit(asRecord(child));
    }
  };
  if (Array.isArray(metadata.folders)) {
    for (const folder of metadata.folders) visit(asRecord(folder));
  }
  return count;
}

async function findOriginalAndThumbnail(infoDir: string, itemMeta: JsonRecord): Promise<{ originalFile?: string; thumbnailFile?: string; size: number }> {
  const entries = await fs.promises.readdir(infoDir);
  const thumbnail = entries.find((name) => /thumbnail\.(png|jpg|jpeg|webp)$/i.test(name));
  const ext = asString(itemMeta.ext).toLowerCase().replace(/^\./, "");
  const original = entries.find((name) => {
    if (name === "metadata.json") return false;
    if (/thumbnail\.(png|jpg|jpeg|webp)$/i.test(name)) return false;
    if (!ext) return true;
    return name.toLowerCase().endsWith(`.${ext}`);
  });
  const originalFile = original ? path.join(infoDir, original) : undefined;
  let size = asNumber(itemMeta.size) ?? 0;
  if (originalFile) {
    try {
      size = (await fs.promises.stat(originalFile)).size;
    } catch {
      // keep metadata size
    }
  }
  return {
    originalFile,
    thumbnailFile: thumbnail ? path.join(infoDir, thumbnail) : undefined,
    size,
  };
}

async function parseEagleItems(rootPath: string): Promise<{ metadata: JsonRecord; tags: string[]; items: EagleItem[] }> {
  const metadata = await readJson(path.join(rootPath, "metadata.json"));
  const tagsJsonPath = path.join(rootPath, "tags.json");
  const tags = fs.existsSync(tagsJsonPath) ? asStringArray(await readJson(tagsJsonPath)) : [];
  const folderMap = buildFolderMap(metadata);
  const imagesRoot = path.join(rootPath, "images");
  const entries = await fs.promises.readdir(imagesRoot, { withFileTypes: true });
  const items: EagleItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".info")) continue;
    const infoDir = path.join(imagesRoot, entry.name);
    const itemMetaPath = path.join(infoDir, "metadata.json");
    if (!fs.existsSync(itemMetaPath)) continue;
    const itemMeta = await readJson(itemMetaPath);
    if (itemMeta.isDeleted === true) continue;
    const id = asString(itemMeta.id) || entry.name.replace(/\.info$/, "");
    const ext = asString(itemMeta.ext).toLowerCase().replace(/^\./, "");
    const { originalFile, thumbnailFile, size } = await findOriginalAndThumbnail(infoDir, itemMeta);
    const sourceUrl = asString(itemMeta.url);
    const folderTags = asStringArray(itemMeta.folders)
      .map((folderId) => folderMap.get(folderId))
      .filter((folderPath): folderPath is string => Boolean(folderPath))
      .map((folderPath) => `folder:${folderPath}`);
    items.push({
      id,
      name: asString(itemMeta.name) || id,
      ext,
      infoDir,
      metadata: itemMeta,
      originalFile,
      thumbnailFile,
      size,
      kind: classifyExt(ext, sourceUrl),
      folderTags,
      tags: asStringArray(itemMeta.tags),
    });
  }
  return { metadata, tags, items };
}

function makePreview(rootPath: string, metadata: JsonRecord, tags: string[], items: EagleItem[]): EaglePreview {
  const kinds: Record<string, number> = {};
  const byOriginal = new Map<string, number>();
  const missingFiles: EaglePreview["missingFiles"] = [];
  let totalBytes = 0;

  for (const item of items) {
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    totalBytes += item.size;
    if (item.originalFile) byOriginal.set(item.originalFile, (byOriginal.get(item.originalFile) ?? 0) + 1);
    if (!item.originalFile && item.kind !== "youtube" && item.kind !== "link") {
      missingFiles.push({ id: item.id, name: item.name, reason: "Original file not found" });
    }
  }

  return {
    rootPath,
    libraryName: path.basename(rootPath).replace(/\.library$/i, ""),
    totalItems: items.length,
    totalBytes,
    kinds,
    folders: countFolders(metadata),
    smartFolders: Array.isArray(metadata.smartFolders) ? metadata.smartFolders.length : 0,
    tags: tags.length,
    duplicateCandidates: [...byOriginal.values()].filter((count) => count > 1).length,
    missingFiles,
  };
}

export async function previewEagleLibrary(rootPath: string): Promise<EaglePreview> {
  await assertEagleRoot(rootPath);
  const { metadata, tags, items } = await parseEagleItems(rootPath);
  return makePreview(rootPath, metadata, tags, items);
}

async function assertEagleRoot(rootPath: string): Promise<void> {
  const stat = await fs.promises.stat(rootPath);
  if (!stat.isDirectory()) throw new Error("Selected path is not a folder.");
  if (!fs.existsSync(path.join(rootPath, "metadata.json"))) {
    throw new Error("Selected folder is not an Eagle library. metadata.json is missing.");
  }
  if (!fs.existsSync(path.join(rootPath, "images"))) {
    throw new Error("Selected folder is not an Eagle library. images folder is missing.");
  }
}

async function copyIntoReferences(sourcePath: string, libraryName: string, itemId: string, fileName: string): Promise<{ relativePath: string; publicUrl: string }> {
  const relativePath = path.join("eagle", sanitizeSegment(libraryName), sanitizeSegment(itemId), sanitizeSegment(fileName));
  const target = path.join(getStorageBasePath(), "references", relativePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(sourcePath, target);
  return { relativePath, publicUrl: publicStorageUrl(relativePath) };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function parseInternetShortcut(filePath: string | undefined): string {
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.match(/^URL=(.+)$/im)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function timestampNotes(item: EagleItem): Array<{ id: string; atSec?: number; text: string }> {
  const comments = item.metadata.comments;
  if (!Array.isArray(comments)) return [];
  return comments.map((comment) => {
    const row = asRecord(comment);
    return {
      id: asString(row.id) || crypto.randomUUID().replace(/-/g, ""),
      atSec: asNumber(row.duration) ?? undefined,
      text: asString(row.annotation),
    };
  }).filter((note) => note.text.trim().length > 0);
}

export async function importEagleLibrary(rootPath: string): Promise<EagleImportResult> {
  await assertEagleRoot(rootPath);
  const { metadata, tags, items } = await parseEagleItems(rootPath);
  const preview = makePreview(rootPath, metadata, tags, items);
  const libraryName = preview.libraryName;
  const failed: EagleImportResult["failed"] = [];
  let imported = 0;
  let skipped = 0;
  let metadataOnly = 0;

  for (const item of items) {
    try {
      const existing = dbSelect("reference_items", {
        source_app: "eagle",
        source_library: libraryName,
        source_id: item.id,
      }, { limit: 1 });
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      const sourceUrl = asString(item.metadata.url) || parseInternetShortcut(item.originalFile);
      const originalTooLarge = item.kind === "video" && item.size > MAX_VIDEO_BYTES;
      let fileUrl: string | null = null;
      let thumbnailUrl: string | null = null;
      let contentHash: string | null = null;

      if (item.originalFile && !originalTooLarge && item.kind !== "link" && item.kind !== "youtube") {
        const copied = await copyIntoReferences(item.originalFile, libraryName, item.id, path.basename(item.originalFile));
        fileUrl = copied.publicUrl;
        contentHash = await sha256File(item.originalFile);
      }
      if (item.thumbnailFile) {
        thumbnailUrl = (await copyIntoReferences(item.thumbnailFile, libraryName, item.id, path.basename(item.thumbnailFile))).publicUrl;
      }
      if (originalTooLarge) metadataOnly += 1;

      dbInsert("reference_items", {
        kind: item.kind,
        title: item.name,
        file_url: fileUrl,
        thumbnail_url: thumbnailUrl ?? fileUrl,
        mime_type: item.ext ? `${item.kind === "video" ? "video" : "image"}/${item.ext}` : null,
        file_size: item.size || null,
        content_hash: contentHash,
        duration_sec: asNumber(item.metadata.duration),
        width: asNumber(item.metadata.width) ?? asNumber(item.metadata.resolutionWidth),
        height: asNumber(item.metadata.height) ?? asNumber(item.metadata.resolutionHeight),
        tags: [...new Set([...item.tags, ...item.folderTags, "source:eagle", `source:eagle/${libraryName}`])],
        notes: asString(item.metadata.annotation) || null,
        rating: null,
        is_favorite: false,
        source_url: sourceUrl || null,
        cover_at_sec: asNumber(item.metadata.thumbnailAt),
        timestamp_notes: timestampNotes(item),
        color_palette: Array.isArray(item.metadata.palettes) ? item.metadata.palettes : [],
        classification_status: "unclassified",
        source_app: "eagle",
        source_library: libraryName,
        source_id: item.id,
        imported_at: new Date().toISOString(),
      });
      imported += 1;
    } catch (err) {
      failed.push({
        id: item.id,
        name: item.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (Array.isArray(metadata.smartFolders)) {
    for (const smartFolder of metadata.smartFolders) {
      const row = asRecord(smartFolder);
      const name = asString(row.name);
      if (!name) continue;
      try {
        dbInsert("saved_filters", {
          name,
          query: row,
          source_app: "eagle",
          source_id: asString(row.id) || null,
        });
      } catch {
        // Importing references is the core value; unsupported/duplicate filters can be skipped.
      }
    }
  }

  return { ...preview, imported, skipped, metadataOnly, failed };
}
