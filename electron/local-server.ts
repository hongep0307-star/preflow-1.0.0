import http from "http";
import { dialog, shell } from "electron";
import { getSettings, setSettings } from "./settings";
import { getStorageBasePath } from "./paths";
import {
  activateWorkspace,
  createWorkspaceAt,
  detectConflictCopies,
  getActiveWorkspace,
  loadExistingWorkspace,
  WorkspaceLockedError,
} from "./workspace";
import {
  findWorkspace,
  getLastActive,
  listWorkspaces,
  renameWorkspace,
  unregisterWorkspace,
} from "./workspaceRegistry";
import { getDb } from "./db";
import Database from "better-sqlite3";
import type {
  ListWorkspacesResponse,
  WorkspaceCounts,
  WorkspaceKind,
  WorkspaceMeta,
} from "../shared/workspace";
import {
  handleClaudeProxy,
  handleClaudeProxyStream,
  handleEnhanceInpaintPrompt,
  handleTranslateAnalysis,
  handleAnalyzeReferenceImages,
  handleOpenaiImage,
  handleOpenAIResponses,
  handleOpenAIChatStream,
} from "./api-handlers";
import { runImageSearch } from "./lensSearch";
import { handleYoutubeIngest } from "./youtube-handler";
import { handleLinkPreview } from "./link-preview-handler";
import { importEagleLibrary, previewEagleLibrary } from "./eagle-import";
import { exportLibraryPack } from "./packExport";
import { exportLibraryAsHtml } from "./htmlExport";
import { applyPack, previewPackFromDisk, previewPackFromPath } from "./packImport";
import { exportProjPack } from "./projPackExport";
import {
  applyProjPack,
  previewProjPackFromDisk,
  previewProjPackFromPath,
} from "./projPackImport";
import { cleanupOrphanFiles, previewOrphanFiles } from "./orphanSweep";
import {
  getStorageUsage,
  getStorageUsageByProject,
  type StorageUsage,
  type StorageUsageByProject,
} from "./storageMaintenance";
import {
  dbSelect,
  dbInsert,
  dbUpdate,
  dbDelete,
  dbUpsert,
} from "./db-utils";
import path from "path";
import fs from "fs";

import { getLocalServerAuthToken, getLocalServerBaseUrl, LOCAL_SERVER_PORT, REAL_UA, setLocalServerPort } from "./constants";
import { REFERENCE_UPLOAD_MAX_BYTES, REFERENCE_UPLOAD_MAX_LABEL } from "../shared/constants";
export { LOCAL_SERVER_PORT };

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type JsonBody = Record<string, unknown>;

function asJsonBody(value: unknown): JsonBody {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonBody) : {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStatus(err: unknown): number {
  return typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : 500;
}

// JSON body 한도는 base64 팽창(약 4/3 배) + form/manifest 오버헤드를 감안해
// 업로드 상한보다 여유를 두지만, 디스크에 떨어지는 실제 파일 크기는 항상
// `REFERENCE_UPLOAD_MAX_BYTES` 로 제한한다.
const MAX_JSON_BODY_BYTES = Math.ceil(REFERENCE_UPLOAD_MAX_BYTES * 1.5);

function parseBody(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new HttpError(413, `Request body too large. Limit is ${Math.round(maxBytes / 1024 / 1024)}MB.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(asJsonBody(raw.trim() ? JSON.parse(raw) : {}));
      } catch {
        reject(new HttpError(400, "Malformed JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

/** Raw(바이너리) 업로드 바디를 Buffer 로 모은다. base64 JSON 우회 경로의
 *  ~33% 팽창 + 거대한 문자열 할당(대용량에서 fetch 실패) 을 피하기 위한
 *  `/storage/upload-raw` 전용. 한도는 `REFERENCE_UPLOAD_MAX_BYTES`(실제 디스크
 *  파일 크기 기준) 로 직접 검증한다 — JSON body 한도와 달리 팽창분이 없다. */
function readRawBody(req: http.IncomingMessage, maxBytes = REFERENCE_UPLOAD_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new HttpError(413, `Reference uploads must be ${REFERENCE_UPLOAD_MAX_LABEL} or smaller.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* 실험 ④ (2026-05-14, 실패로 검증): PNG/JPG/WEBP 만 application/octet-stream
 * 으로 응답해도 Chromium 의 byte-level sniffer 가 binary signature
 * (PNG magic / JPEG SOI / WEBP RIFF) 를 직접 보고 image-mode 를 켠다.
 * 응답 MIME 은 *완전 무시* — image-mode trigger 와 무관함을 확정. 따라서
 * 정상 image MIME 으로 환원. (외부 export 가 destination 측에서 응답
 * Content-Type 을 보는 케이스 — 예: <a download> attribute 처리 — 에는
 * image/* 가 필요할 수 있어 안전을 위해 원복.) */
const STORAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  /* doc 자료 인앱 프리뷰용 — `kind:"doc"` 의 sub-type 들이 webview/pdfjs/
     <audio> 로 렌더되려면 정확한 MIME 이 필요하다. octet-stream 으로 떨어지면
     webview 는 다운로드(우리가 deny)로 인식해 검은 화면이 뜬다. */
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

// Phase 2.4: /storage/usage 응답 TTL 캐시. LibraryPage 마운트 + 액션 후마다
// 호출돼 매번 모든 버킷을 풀 워크하던 비용을 줄인다. cleanup / orphan 정리
// 같이 디스크가 실제로 변하는 액션 후엔 invalidate 해서 stale 표시를 방지.
const STORAGE_USAGE_TTL_MS = 30_000;
let storageUsageCache: { value: StorageUsage; expiresAt: number } | null = null;
// 대시보드 카드의 프로젝트별 사이즈 칩용 별도 캐시. usage 와 같은 walk 비용
// 이지만 응답 형태가 다르고 호출 주체도 다르므로(LibraryPage vs Dashboard)
// 캐시 키도 분리. invalidate 는 항상 같이 비워 stale 노출을 일관되게 막는다.
let storageUsageByProjectCache: { value: StorageUsageByProject; expiresAt: number } | null = null;

async function readCachedStorageUsage(): Promise<StorageUsage> {
  const now = Date.now();
  if (storageUsageCache && storageUsageCache.expiresAt > now) {
    return storageUsageCache.value;
  }
  const value = await getStorageUsage();
  storageUsageCache = { value, expiresAt: now + STORAGE_USAGE_TTL_MS };
  return value;
}

async function readCachedStorageUsageByProject(): Promise<StorageUsageByProject> {
  const now = Date.now();
  if (storageUsageByProjectCache && storageUsageByProjectCache.expiresAt > now) {
    return storageUsageByProjectCache.value;
  }
  const value = await getStorageUsageByProject();
  storageUsageByProjectCache = { value, expiresAt: now + STORAGE_USAGE_TTL_MS };
  return value;
}

function invalidateStorageUsageCache(): void {
  storageUsageCache = null;
  storageUsageByProjectCache = null;
}

// Storage layout is: <userData>/storage/<bucket>/<projectId|...>/<file>
// The renderer must not be allowed to choose arbitrary buckets — that would
// let a malicious script overwrite app config files etc.
const ALLOWED_BUCKETS = new Set(["assets", "contis", "briefs", "style-presets", "mood", "references"]);

function resolveBucketPath(bucket: string, sub: string): string {
  if (!ALLOWED_BUCKETS.has(bucket)) {
    throw new Error(`Disallowed bucket: ${bucket}`);
  }
  const base = getStorageBasePath();
  const target = path.resolve(base, bucket, sub);
  // Defense-in-depth: even if `sub` is "../../escape", the resolved path must
  // remain inside <base>/<bucket>/.
  const bucketRoot = path.resolve(base, bucket);
  if (target !== bucketRoot && !target.startsWith(bucketRoot + path.sep)) {
    throw new Error(`Path traversal detected: ${bucket}/${sub}`);
  }
  return target;
}

function resolveStorageReadPath(relative: string): string {
  const base = path.resolve(getStorageBasePath());
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${relative}`);
  }
  return target;
}

/** 다른(비활성) 워크스페이스의 storage 파일 경로 해석 — 레지스트리에 등록된
 *  워크스페이스의 `<path>/storage/` 루트 기준. 미등록 id 와 traversal 차단. */
function resolveCrossWorkspaceStoragePath(workspaceId: string, relative: string): string {
  const ws = findWorkspace(workspaceId);
  if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
  const base = path.resolve(path.join(ws.path, "storage"));
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${relative}`);
  }
  return target;
}

/** GET 정적 파일 응답(access/stat/Range/stream) 공용 — /storage/file/ 과
 *  /cross-workspace/file/ 양쪽에서 재사용. */
async function streamStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fullPath: string,
): Promise<void> {
  try {
    await fs.promises.access(fullPath);
  } catch {
    console.warn("[local-server] 404:", req.url, "→", fullPath);
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const stat = await fs.promises.stat(fullPath);
  const contentType = STORAGE_MIME[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(fullPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(fullPath).pipe(res);
}

/** 원본 reference URL(file_url/thumbnail_url)을 cross-workspace file 서빙 URL 로
 *  rewrite. 활성 storage 기준 URL 은 타 워크스페이스에서 404 나므로 필수. */
function rewriteCrossWorkspaceUrl(url: unknown, ws: WorkspaceMeta, baseUrl: string): string | null {
  if (typeof url !== "string" || !url) return null;
  const marker = "/storage/file/";
  const mIdx = url.indexOf(marker);
  let rel: string | null = null;
  if (mIdx >= 0) {
    rel = url.slice(mIdx + marker.length).split(/[?#]/)[0];
  } else if (url.startsWith("local-file://")) {
    const abs = decodeURIComponent(url.slice("local-file://".length)).replace(/\\/g, "/");
    const root = path.join(ws.path, "storage").replace(/\\/g, "/");
    if (abs.startsWith(root + "/")) rel = abs.slice(root.length + 1);
  }
  if (!rel) return url;
  return `${baseUrl}/cross-workspace/file/${encodeURIComponent(ws.id)}/${rel}`;
}

/** 비활성(보통 라이브러리) 워크스페이스의 reference_items 를 readonly 로 조회.
 *  thumbnail/file URL 은 cross-workspace 서빙 URL 로 rewrite, 폴더 목록도 같이 반환.
 *  readInactiveWorkspaceCounts 와 동일한 ephemeral readonly 패턴. */
function handleCrossWorkspaceReferences(body: any): { references: any[]; folders: string[] } {
  const workspaceId = String(body?.workspaceId ?? "");
  const ws = findWorkspace(workspaceId);
  if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
  const dbPath = path.join(ws.path, "preflow.db");
  if (!fs.existsSync(dbPath)) return { references: [], folders: [] };
  const filter: "all" | "favorite" | "recent" =
    body?.filter === "favorite" || body?.filter === "recent" ? body.filter : "all";
  const query = typeof body?.query === "string" ? body.query.trim().toLowerCase() : "";
  const limit = Math.min(Math.max(Number(body?.limit) || 500, 1), 1000);
  const baseUrl = getLocalServerBaseUrl();
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let sql = `SELECT * FROM reference_items WHERE deleted_at IS NULL`;
    if (filter === "favorite") sql += ` AND is_favorite = 1`;
    if (filter === "recent") sql += ` AND last_used_at IS NOT NULL`;
    const order = filter === "recent" ? "last_used_at DESC" : "COALESCE(pinned_at, created_at) DESC";
    sql += ` ORDER BY ${order} LIMIT ${limit}`;
    const rows = db.prepare(sql).all() as any[];
    const folderSet = new Set<string>();
    const references = rows.map((r) => {
      let tags: string[] = [];
      try {
        const p = JSON.parse(r.tags ?? "[]");
        if (Array.isArray(p)) tags = p.filter((x: unknown): x is string => typeof x === "string");
      } catch {
        /* corrupt tags — skip */
      }
      for (const tg of tags) if (tg.startsWith("folder:")) folderSet.add(tg.slice("folder:".length));
      let ai: unknown = null;
      try {
        ai = r.ai_suggestions ? JSON.parse(r.ai_suggestions) : null;
      } catch {
        ai = null;
      }
      return {
        id: r.id,
        kind: r.kind,
        title: r.title ?? "",
        file_url: rewriteCrossWorkspaceUrl(r.file_url, ws, baseUrl),
        thumbnail_url: rewriteCrossWorkspaceUrl(r.thumbnail_url, ws, baseUrl),
        mime_type: r.mime_type ?? null,
        tags,
        is_favorite: !!r.is_favorite,
        last_used_at: r.last_used_at ?? null,
        ai_suggestions: ai,
        width: r.width ?? null,
        height: r.height ?? null,
        duration_sec: r.duration_sec ?? null,
      };
    });
    const filtered = query
      ? references.filter(
          (r) =>
            (r.title || "").toLowerCase().includes(query) ||
            r.tags.some((t: string) => t.toLowerCase().includes(query)),
        )
      : references;
    return { references: filtered, folders: [...folderSet].sort((a, b) => a.localeCompare(b)) };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 비활성(보통 프로젝트) 워크스페이스의 대시보드 폴더(`folders` 테이블)를 readonly 로
 *  조회. "스마트 브리프 매치 → 프로젝트 내보내기" 다이얼로그가 대상 워크스페이스의
 *  폴더 목록을 전환 없이 보여주는 데 쓴다. handleCrossWorkspaceReferences 와 동일한
 *  ephemeral readonly 패턴. */
function handleCrossWorkspaceFolders(body: any): { folders: Array<{ id: string; name: string }> } {
  const workspaceId = String(body?.workspaceId ?? "");
  const ws = findWorkspace(workspaceId);
  if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
  const dbPath = path.join(ws.path, "preflow.db");
  if (!fs.existsSync(dbPath)) return { folders: [] };
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT id, name FROM folders ORDER BY created_at`).all() as Array<{
      id: string;
      name: string;
    }>;
    return {
      folders: rows.map((r) => ({ id: String(r.id), name: String(r.name ?? "") })),
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Eagle Library 루트 폴더인지 가볍게 판별 — `metadata.json` 과 `images`
 * 디렉터리 두 신호만으로 충분히 구분 가능. 본격 검증/에러 메시지는
 * `previewEagleLibrary` 의 `assertEagleRoot` 가 담당.
 */
async function isEagleLibraryFolder(rootPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(rootPath);
    if (!stat.isDirectory()) return false;
    const [metadataExists, imagesExists] = await Promise.all([
      fs.promises.access(path.join(rootPath, "metadata.json")).then(() => true).catch(() => false),
      fs.promises.access(path.join(rootPath, "images")).then(() => true).catch(() => false),
    ]);
    return metadataExists && imagesExists;
  } catch {
    return false;
  }
}

/* 폴더 import 시 수집할 *후보* 확장자.
   - 미디어(jpg/png/webp/gif/mp4/mov/webm) 는 변함없이 이미지/영상 분류
   - doc 카테고리 흡수: PDF/오피스/폰트/압축/HTML/오디오/실행파일 등 포함
     (라이브러리는 자동 실행하지 않으므로 EXE/MSI 도 보관 가능)
   - 의도적으로 *제외* :
     · 코드 소스(.js/.ts/.py 등) — node_modules 가 없는 폴더라도 수십 만개
       단위로 수집되어 사용자에게 의도하지 않은 import 폭격이 될 수 있어
       의도된 import 흐름(Choose Files 로 직접 선택) 이 아닌 *폴더 드래그*
       경로에서는 일단 제외. 향후 별도 토글이 들어오면 합류시킬 후보. */
const MEDIA_FILE_EXTENSIONS = new Set([
  // 이미지
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".apng",
  // 영상
  ".mp4", ".mov", ".webm",
  // 문서(PDF/오피스/HWP/RTF/마크다운/일반 텍스트)
  ".pdf",
  ".doc", ".docx", ".docm", ".odt", ".rtf", ".pages", ".hwp", ".hwpx",
  ".xls", ".xlsx", ".xlsm", ".csv", ".numbers", ".ods",
  ".ppt", ".pptx", ".pptm", ".key", ".odp",
  ".txt", ".md",
  // 폰트
  ".ttf", ".otf", ".woff", ".woff2",
  // 압축
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz",
  // 웹
  ".html", ".htm",
  // 오디오 (Brief 같은 곳에서 BGM 레퍼런스로 쓰일 수 있어 통과)
  ".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a",
  // 실행 파일 / 인스톨러 / OS 패키지 — 라이브러리는 보관만, 자동 실행 없음
  ".exe", ".msi", ".dmg", ".pkg", ".app", ".apk", ".deb", ".rpm",
]);

/**
 * 폴더 안의 미디어 파일을 재귀로 수집. Eagle 이 아닌 일반 폴더를 사용자가
 * "Choose Files > Folder" 또는 드래그-드랍으로 던졌을 때 한 번에 모든
 * 미디어를 ingest 하기 위한 입력. node_modules / .git / dot 폴더는 스킵.
 * 폴더당 5,000 파일 정도면 수 초 내 끝날 정도의 단순 BFS.
 */
async function collectMediaFiles(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        queue.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_FILE_EXTENSIONS.has(ext)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function resolveStorageUrlToPath(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new HttpError(400, "Missing file URL.");
  }
  const storageBase = path.resolve(getStorageBasePath());
  let target: string;

  if (rawUrl.startsWith("local-file://")) {
    let rawPath = decodeURIComponent(rawUrl.slice("local-file://".length).split(/[?#]/)[0]).replace(/\//g, path.sep);
    if (/^\\[A-Za-z]:/.test(rawPath)) rawPath = rawPath.slice(1);
    target = path.resolve(rawPath);
  } else {
    const match = rawUrl.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\/(.+)$/i);
    if (!match?.[1]) throw new HttpError(400, "URL is not a local storage file.");
    target = resolveStorageReadPath(decodeURIComponent(match[1].split(/[?#]/)[0]));
  }

  const rel = path.relative(storageBase, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(403, "File is outside app storage.");
  }
  return target;
}

function sanitizeCopyName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "reference";
}

async function copyReferenceStorageFile(rawUrl: unknown, targetId: unknown, label: unknown): Promise<{ publicUrl: string; filePath: string }> {
  if (typeof targetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(targetId)) {
    throw new HttpError(400, "Invalid target reference id.");
  }
  const sourcePath = resolveStorageUrlToPath(rawUrl);
  await fs.promises.access(sourcePath);
  const ext = path.extname(sourcePath) || ".bin";
  const sourceBase = path.basename(sourcePath, ext);
  const safeLabel = typeof label === "string" && label.trim() ? label.trim() : sourceBase;
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const relative = `${yyyyMm}/${targetId}/${sanitizeCopyName(safeLabel)}${ext}`;
  const targetPath = resolveBucketPath("references", relative);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
  return {
    publicUrl: `${getLocalServerBaseUrl()}/storage/file/references/${relative}`,
    filePath: relative,
  };
}

function decodeUploadPayload(dataB64: unknown): Buffer {
  if (typeof dataB64 !== "string" || !dataB64) {
    throw new HttpError(400, "Missing upload data.");
  }
  const approxBytes = Math.floor((dataB64.length * 3) / 4);
  const tooLargeMsg = `Reference uploads must be ${REFERENCE_UPLOAD_MAX_LABEL} or smaller.`;
  if (approxBytes > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new HttpError(413, tooLargeMsg);
  }
  const buffer = Buffer.from(dataB64, "base64");
  if (buffer.byteLength > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new HttpError(413, tooLargeMsg);
  }
  return buffer;
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (req.headers["x-preflow-token"] === getLocalServerAuthToken()) return true;
  if (process.env.VITE_DEV_SERVER_URL) return true;
  // In dev the renderer is served from Vite and can be reloaded directly
  // without Electron's query token. Keep production strict while allowing
  // the known dev origin to talk to the local server.
  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  if (devOrigin) {
    const allowed = new URL(devOrigin).origin;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (origin === allowed || (typeof referer === "string" && referer.startsWith(allowed))) {
      return true;
    }
  }
  return false;
}

// ── Workspace handlers ─────────────────────────────────────────────
// /workspace/* 라우트의 비즈니스 로직. 모두 동기 SQLite 쿼리 + 파일 IO 라
// 별도 모듈로 빼지 않고 여기 모아 둠. 카운트 쿼리는 default 워크스페이스의
// "한 DB 가 두 워크스페이스로 보임" 특수성을 처리한다 — same path 인 ws 가
// 여러 개면 같은 카운트가 양쪽 모두에 잡힌다.

function getCountsForActiveWorkspace(kind: WorkspaceKind): WorkspaceCounts["projectCount" | "itemCount"] {
  // 활성 워크스페이스의 DB 는 이미 열려 있는 핸들을 그대로 쓴다. 비활성
  // 워크스페이스는 `readInactiveWorkspaceCounts` 가 readonly 로 열어 조회.
  try {
    const db = getDb();
    if (kind === "project") {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM projects WHERE COALESCE(status, 'active') = 'active' AND deleted_at IS NULL`,
      ).get() as { n: number };
      return row.n;
    }
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM reference_items WHERE deleted_at IS NULL`,
    ).get() as { n: number };
    return row.n;
  } catch {
    return null;
  }
}

/** 비활성 워크스페이스의 `preflow.db` 를 readonly 로 짧게 열어 한 번 카운트
 *  쿼리만 돌리고 즉시 닫는다. WAL + readonly 모드라 활성 DB 와 동시 오픈
 *  되어도 충돌 없음(다른 PC 가 락 파일을 들고 있어도 readonly 는 가능).
 *
 *  실패 케이스(파일 없음 / 스키마 누락 / 권한 거부) 에서는 0 이 아닌 null
 *  을 반환한다 — UI 의 "—" 표시가 잘못된 0 보다 정직하기 때문.
 *  N(워크스페이스 수)이 한 자릿수라 매번 list 요청마다 도는 비용은 무시할
 *  만하므로 캐시 없이 단순 구현. */
function readInactiveWorkspaceCounts(ws: WorkspaceMeta): {
  projectCount: number | null;
  itemCount: number | null;
} {
  const dbPath = path.join(ws.path, "preflow.db");
  if (!fs.existsSync(dbPath)) return { projectCount: null, itemCount: null };
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (ws.kind === "project") {
      // deleted_at 는 휴지통 도입 후 추가된 컬럼이라, 아직 한 번도 활성화되지
      // 않아 마이그레이션이 안 돈 옛 워크스페이스 DB 에는 없을 수 있다. 그
      // 경우 readonly 핸들이라 ALTER 도 못 하므로, 컬럼 유무를 먼저 확인해
      // 쿼리를 갈라 "no such column" throw 로 카운트가 통째로 null(—) 이
      // 되는 회귀를 막는다.
      const hasDeletedAt = (
        db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
      ).some((c) => c.name === "deleted_at");
      const sql = hasDeletedAt
        ? `SELECT COUNT(*) AS n FROM projects WHERE COALESCE(status, 'active') = 'active' AND deleted_at IS NULL`
        : `SELECT COUNT(*) AS n FROM projects WHERE COALESCE(status, 'active') = 'active'`;
      const row = db.prepare(sql).get() as { n: number } | undefined;
      return { projectCount: row?.n ?? 0, itemCount: null };
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM reference_items WHERE deleted_at IS NULL`)
      .get() as { n: number } | undefined;
    return { projectCount: null, itemCount: row?.n ?? 0 };
  } catch (err) {
    // 스키마가 아직 안 만들어진 워크스페이스, 다른 프로세스가 락을 들고
    // 있는 비표준 케이스 등을 모두 흡수 — 카운트는 null 로 떨어뜨리고
    // 부팅/리스트는 계속 진행.
    console.warn(
      `[workspace-counts] readonly count failed for ${ws.id} (${dbPath}):`,
      err instanceof Error ? err.message : err,
    );
    return { projectCount: null, itemCount: null };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function buildListWorkspacesResponse(): ListWorkspacesResponse {
  const ws = listWorkspaces();
  const active = getActiveWorkspace();
  const counts: WorkspaceCounts[] = ws.map((w) => {
    // 활성 워크스페이스, 그리고 활성과 같은 path 를 공유하는 형제(default
    // 프로젝트 ↔ default 라이브러리) 는 이미 열린 핸들을 재사용.
    if (active && (w.id === active.id || w.path === active.path)) {
      return {
        id: w.id,
        projectCount: w.kind === "project" ? getCountsForActiveWorkspace("project") : null,
        itemCount: w.kind === "library" ? getCountsForActiveWorkspace("library") : null,
      };
    }
    // 비활성 워크스페이스 — 디스크에서 readonly 로 한 번 열어 카운트.
    return { id: w.id, ...readInactiveWorkspaceCounts(w) };
  });
  return {
    workspaces: ws,
    counts,
    active: active?.id ?? null,
    // kind 별 마지막 활성 ID — WorkspaceSwitcher 의 quick-switch 가 반대
    // kind 의 "최근 사용 워크스페이스" 로 즉시 점프하는 데 사용한다.
    lastActive: getLastActive(),
    // 활성 워크스페이스 폴더에 OneDrive 충돌 사본이 보이면 노출 — UI 가
    // 데이터 유실 위험을 경고한다. 비활성 워크스페이스까지 스캔하지는 않음
    // (활성 폴더만이 현재 손상 위험에 직접 노출된 대상).
    conflictCopies: active ? detectConflictCopies(active.path) : [],
  };
}

async function handleWorkspaceCreate(body: JsonBody): Promise<unknown> {
  const kind = body.kind as WorkspaceKind | undefined;
  const name = typeof body.name === "string" ? body.name : "";
  // 폴더 직접 명시도 가능하지만, UX 일관성을 위해 dialog 로 받는 흐름을 기본
  // 으로 — 클라이언트가 path 를 안 주면 dialog 띄움.
  let folderPath = typeof body.path === "string" ? body.path : "";
  if (!folderPath) {
    const picked = await dialog.showOpenDialog({
      title: "Choose a folder for the new workspace",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true, workspace: null };
    }
    folderPath = picked.filePaths[0];
  }
  if (!kind || (kind !== "project" && kind !== "library")) {
    throw new HttpError(400, "kind must be 'project' or 'library'");
  }
  const ws = await createWorkspaceAt({ kind, name, path: folderPath });
  return { canceled: false, workspace: ws };
}

async function handleWorkspaceLoad(body: JsonBody): Promise<unknown> {
  let folderPath = typeof body.path === "string" ? body.path : "";
  if (!folderPath) {
    const picked = await dialog.showOpenDialog({
      title: "Open existing workspace folder",
      properties: ["openDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true, workspace: null };
    }
    folderPath = picked.filePaths[0];
  }
  const hint = body.hint as { kind?: WorkspaceKind; name?: string } | undefined;
  const ws = loadExistingWorkspace(folderPath, hint);
  return { canceled: false, workspace: ws };
}

async function handleWorkspaceActivate(body: JsonBody): Promise<unknown> {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new HttpError(400, "id is required");
  const force = body.force === true;
  try {
    const ws = await activateWorkspace(id, { force });
    return { ok: true, workspace: ws, conflictCopies: detectConflictCopies(ws.path) };
  } catch (err) {
    if (err instanceof WorkspaceLockedError) {
      return { ok: false, locked: true, lock: err.lock };
    }
    throw err;
  }
}

// ── Canvas layout handlers ─────────────────────────────────────────
// Library Canvas 의 폴더별 배치를 활성 워크스페이스 DB(canvas_layouts) 에
// 영속화한다. 렌더러(canvasLayout.ts) 가 메모리 캐시를 authoritative 로 들고
// 있고, 이 라우트는 hydrate(list) 와 debounced flush(save) 두 가지만 처리한다.
// 제네릭 /db/* 라우트는 id/created_at 강제 + 화이트리스트 때문에 이 테이블
// 형태에 맞지 않아 전용 핸들러로 둔다(컬럼은 고정 식별자, 값은 파라미터 바인딩).
function handleCanvasList(): Array<{ context_key: string; layout: string }> {
  const db = getDb();
  return db
    .prepare(`SELECT context_key, layout FROM canvas_layouts`)
    .all() as Array<{ context_key: string; layout: string }>;
}

function handleCanvasSave(body: JsonBody): { ok: true; upserted: number; deleted: number } {
  const upserts = Array.isArray(body.upserts) ? body.upserts : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  const db = getDb();
  const now = new Date().toISOString();
  const upStmt = db.prepare(
    `INSERT INTO canvas_layouts (context_key, layout, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(context_key) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
  );
  const delStmt = db.prepare(`DELETE FROM canvas_layouts WHERE context_key = ?`);
  let upserted = 0;
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const u of upserts as Array<{ contextKey?: unknown; layout?: unknown }>) {
      if (!u || typeof u.contextKey !== "string" || !u.contextKey) continue;
      // layout 은 이미 객체로 도착 — 문자열화해 단일 컬럼에 저장.
      const json = typeof u.layout === "string" ? u.layout : JSON.stringify(u.layout ?? {});
      upStmt.run(u.contextKey, json, now);
      upserted += 1;
    }
    for (const k of deletes as unknown[]) {
      if (typeof k !== "string" || !k) continue;
      delStmt.run(k);
      deleted += 1;
    }
  });
  tx();
  return { ok: true, upserted, deleted };
}

// ── 이미지로 검색 (Google Lens, Imgur 경유) ────────────────────────
// 기본 경로: 렌더러가 미리보기 이미지를 canvas 로 JPEG(base64) 변환해 보내준다
// (Chromium 이 webp/gif 까지 디코드 → Imgur 호환 포맷 보장). 폴백: 외부 CDN
// 썸네일(youtube/og:image 등) 은 CORS 로 canvas 변환이 안 돼 url 만 온다 —
// 메인이 로컬 storage 면 디스크에서, 외부면 fetch 로 바이트를 확보한다.
// 확보한 바이트를 Imgur 에 올려 공개 URL 로 외부 브라우저에서 Lens 를 연다.
async function handleLensSearch(body: JsonBody): Promise<{ ok: true }> {
  const b64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  let buffer: Buffer;
  if (b64) {
    buffer = Buffer.from(b64, "base64");
  } else {
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!rawUrl) throw new HttpError(400, "imageBase64 or url is required");
    const isLocal =
      rawUrl.startsWith("local-file://") ||
      /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\//i.test(rawUrl);
    if (isLocal) {
      buffer = await fs.promises.readFile(resolveStorageUrlToPath(rawUrl));
    } else {
      const res = await fetch(rawUrl);
      if (!res.ok) throw new HttpError(502, `Failed to fetch image: ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    }
  }
  if (buffer.length === 0) throw new HttpError(400, "image is empty or invalid");
  const engine = typeof body.engine === "string" ? body.engine : undefined;
  await runImageSearch(buffer, engine);
  return { ok: true };
}

// ── 외부 이미지 URL → 바이트 다운로드 (드롭/붙여넣기로 실제 이미지 저장) ──
// 외부 검색 결과(Yandex/Lens 페이지)에서 끌어온 이미지를 라이브러리에 *진짜
// 이미지 자료* 로 저장하기 위해, 렌더러가 이미지 직링크를 넘기면 메인이 받아
// 바이트를 돌려준다. 렌더러 fetch 는 CORS 로 막히는 호스트(i.pinimg.com 등) 가
// 많아 메인에서 받는다. Referer 를 origin 으로 위장(핫링크 차단 완화)하고
// content-type 이 image/* 인 응답만, 최대 바이트 제한 안에서 통과시킨다.
// 결과는 JSON 라우터 계약에 맞춰 base64 로 직렬화해 돌려준다.
const FETCH_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

async function handleFetchImage(
  body: JsonBody,
): Promise<{ bytes: string; mime: string; filename: string }> {
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) throw new HttpError(400, "url is required");
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "invalid url");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new HttpError(400, "only http(s) urls are allowed");
  }

  const res = await fetch(rawUrl, {
    headers: {
      "User-Agent": REAL_UA,
      Referer: `${target.protocol}//${target.host}/`,
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new HttpError(502, `Failed to fetch image: ${res.status}`);

  const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) {
    throw new HttpError(415, `not an image: ${mime || "unknown content-type"}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.length === 0) throw new HttpError(502, "image is empty");
  if (buffer.length > FETCH_IMAGE_MAX_BYTES) {
    throw new HttpError(413, "image is too large");
  }

  // 파일명 — URL pathname 의 basename, 없으면 mime 기반 기본 확장자.
  const extByMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
  };
  let filename = path.basename(decodeURIComponent(target.pathname || "")).split("?")[0] || "";
  if (!filename || !path.extname(filename)) {
    filename = `image${extByMime[mime] || ".jpg"}`;
  }

  return { bytes: buffer.toString("base64"), mime, filename };
}

function handleWorkspaceRename(body: JsonBody): unknown {
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!id || !name) throw new HttpError(400, "id and name are required");
  return { workspace: renameWorkspace(id, name) };
}

function handleWorkspaceDisconnect(body: JsonBody): unknown {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new HttpError(400, "id is required");
  const ws = findWorkspace(id);
  if (!ws) throw new HttpError(404, "workspace not found");
  if (ws.isDefault) throw new HttpError(400, "cannot disconnect default workspace");
  if (getActiveWorkspace()?.id === id) {
    throw new HttpError(400, "cannot disconnect the currently active workspace; switch first");
  }
  unregisterWorkspace(id);
  return { ok: true };
}

function handleWorkspaceShowInExplorer(body: JsonBody): unknown {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new HttpError(400, "id is required");
  const ws = findWorkspace(id);
  if (!ws) throw new HttpError(404, "workspace not found");
  // 신뢰 경계: registry 에 등록된 path 만 허용. 사용자가 Add 다이얼로그에서
  // 명시적으로 골랐던(or 부트스트랩이 default 로 채운) 폴더이므로 임의 경로
  // 노출 위험 없음. shell.showItemInFolder 는 Windows 탐색기에서 해당
  // 디렉터리를 선택 상태로 띄운다.
  shell.showItemInFolder(ws.path);
  return { ok: true };
}

async function handleWorkspaceDelete(body: JsonBody): Promise<unknown> {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new HttpError(400, "id is required");
  const ws = findWorkspace(id);
  if (!ws) throw new HttpError(404, "workspace not found");
  if (ws.isDefault) throw new HttpError(400, "cannot delete default workspace");
  if (getActiveWorkspace()?.id === id) {
    throw new HttpError(400, "cannot delete the currently active workspace; switch first");
  }
  // 레지스트리에서 먼저 제거 — 폴더 삭제 실패해도 레지스트리만 클린해지면
  // 사용자 입장에서는 "사라진" 워크스페이스. 이후 폴더 삭제는 best-effort.
  unregisterWorkspace(id);
  try {
    await fs.promises.rm(ws.path, { recursive: true, force: true });
    return { ok: true, folderRemoved: true };
  } catch (err) {
    console.warn("[workspace] folder delete failed:", err);
    return { ok: true, folderRemoved: false, error: errorMessage(err) };
  }
}

/** 실제로 한 번 listen 시도. 실패하면 Error(code 포함) 을 reject. */
function listenOnce(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const actual = (server.address() as { port: number } | null)?.port ?? port;
      resolve(actual);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startLocalServer(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Preflow-Token");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || "";

      if (req.method === "GET" && url.startsWith("/storage/file/")) {
        // ?t=cacheBuster 같은 쿼리스트링이 붙어 들어와도 파일 lookup이 깨지지 않도록 strip
        const rawRelative = url.slice("/storage/file/".length).split(/[?#]/)[0];
        const relative = decodeURIComponent(rawRelative);
        let fullPath: string;
        try {
          fullPath = resolveStorageReadPath(relative);
        } catch {
          res.writeHead(403);
          res.end();
          return;
        }
        await streamStaticFile(req, res, fullPath);
        return;
      }

      // 비활성(라이브러리) 워크스페이스 storage 파일 서빙 — 가져오기 모달이 타
      // 워크스페이스 썸네일/이미지를 페이지 전환 없이 렌더/fetch 할 수 있게 한다.
      // 경로: /cross-workspace/file/<workspaceId>/<relative...>
      if (req.method === "GET" && url.startsWith("/cross-workspace/file/")) {
        const rest = url.slice("/cross-workspace/file/".length).split(/[?#]/)[0];
        const slash = rest.indexOf("/");
        if (slash < 0) {
          res.writeHead(400);
          res.end();
          return;
        }
        const workspaceId = decodeURIComponent(rest.slice(0, slash));
        const relative = decodeURIComponent(rest.slice(slash + 1));
        let fullPath: string;
        try {
          fullPath = resolveCrossWorkspaceStoragePath(workspaceId, relative);
        } catch {
          res.writeHead(403);
          res.end();
          return;
        }
        await streamStaticFile(req, res, fullPath);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      if (!isAuthorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        // 바이너리 업로드 — base64 JSON 경로(/storage/upload) 는 대용량(>~250MB)
        // 에서 거대한 문자열 + JSON.stringify 로 렌더러 fetch 가 실패한다. raw
        // octet-stream 바디는 스트리밍돼 메모리/크기에 안전. bucket/path 는 쿼리로
        // 받고, 바디는 parseBody(JSON) 를 거치지 않고 직접 읽는다.
        if (url.startsWith("/storage/upload-raw")) {
          const parsed = new URL(url, "http://127.0.0.1");
          const bucket = parsed.searchParams.get("bucket") || "";
          const fp = parsed.searchParams.get("path") || "";
          const fullPath = resolveBucketPath(bucket, fp);
          const uploadBuffer = await readRawBody(req);
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, uploadBuffer);
          invalidateStorageUsageCache();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: null }));
          return;
        }

        // tsconfig.node.json 의 strict 모드에서 JsonBody = Record<string, unknown>
        // 을 destructure 하면 각 필드가 unknown 으로 잡혀 dbSelect/dbInsert
        // 같은 string-기반 함수에 그대로 못 넘긴다. 이 라우터의 모든 path 는
        // 호출 직후 assertTable / assertColumns / Boolean(...) 같은 런타임
        // 검증을 다시 한 번 하므로, 진입 시점에 한 번 Record<string, any> 로
        // 좁혀 destructure 비용을 없앤다 — 안전성은 downstream validator 에
        // 위임하는 기존 설계(=routes 가 dumb proxy) 와 일관.
        const body = (await parseBody(req)) as Record<string, any>;

        // ── 스트리밍(SSE) 라우트 ───────────────────────────────────────
        // 제너릭 JSON 응답(아래 if/else → res.end(JSON.stringify))과 달리,
        // 여기서는 text/event-stream 헤더를 먼저 내보내고 핸들러가 업스트림
        // SSE 를 res 로 직접 파이프한다. 헤더를 이미 쓴 뒤이므로 바깥 catch 의
        // res.writeHead 재호출을 피하려 자체 try/catch 후 즉시 return 한다.
        if (url === "/api/claude-proxy-stream" || url === "/api/openai-chat-stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          try {
            if (url === "/api/claude-proxy-stream") await handleClaudeProxyStream(body, res);
            else await handleOpenAIChatStream(body, res);
          } catch (err) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`);
            } catch {
              /* socket already closed */
            }
          } finally {
            res.end();
          }
          return;
        }

        let result: unknown;

        if (url === "/db/select") {
          const { table, where, options } = body;
          result = dbSelect(table, where, options);
        } else if (url === "/db/insert") {
          const { table, data } = body;
          result = dbInsert(table, data);
        } else if (url === "/db/update") {
          const { table, data, where } = body;
          result = dbUpdate(table, data, where);
        } else if (url === "/db/delete") {
          const { table, where } = body;
          result = dbDelete(table, where);
        } else if (url === "/db/upsert") {
          const { table, data, conflictKeys } = body;
          result = dbUpsert(table, data, conflictKeys);
        } else if (url === "/storage/upload") {
          const { bucket, filePath: fp, data: dataB64 } = body;
          const fullPath = resolveBucketPath(bucket, fp);
          const uploadBuffer = decodeUploadPayload(dataB64);
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, uploadBuffer);
          invalidateStorageUsageCache();
          result = { error: null };
        } else if (url === "/storage/getPublicUrl") {
          const { bucket, filePath: fp } = body;
          const fullPath = resolveBucketPath(bucket, fp);
          result = { data: { publicUrl: `local-file://${fullPath.replace(/\\/g, "/")}` } };
        } else if (url === "/storage/copy-reference-file") {
          result = await copyReferenceStorageFile(body?.url, body?.targetId, body?.label);
        } else if (url === "/storage/remove") {
          const { bucket, filePaths } = body;
          await Promise.all(
            (filePaths as string[]).map(async (fp) => {
              try {
                await fs.promises.unlink(resolveBucketPath(bucket, fp));
              } catch {
                /* ignore missing files / disallowed paths */
              }
            }),
          );
          invalidateStorageUsageCache();
          result = { error: null };
        } else if (url === "/storage/list") {
          const { bucket, folder, options } = body;
          try {
            const dir = resolveBucketPath(bucket, folder ?? "");
            const files = await fs.promises.readdir(dir);
            const limit = options?.limit ?? 1000;
            const offset = options?.offset ?? 0;
            result = {
              data: files.slice(offset, offset + limit).map((name: string) => ({ name })),
              error: null,
            };
          } catch {
            result = { data: [], error: null };
          }
        } else if (url === "/storage/usage") {
          result = await readCachedStorageUsage();
        } else if (url === "/storage/usage/by-project") {
          result = await readCachedStorageUsageByProject();
        } else if (url === "/storage/orphans/preview") {
          result = await previewOrphanFiles({ includeReferences: Boolean(body?.includeReferences) });
        } else if (url === "/storage/orphans/cleanup") {
          result = await cleanupOrphanFiles({ includeReferences: Boolean(body?.includeReferences) });
          invalidateStorageUsageCache();
        } else if (url === "/eagle/select-library") {
          const picked = await dialog.showOpenDialog({
            title: "Select Eagle Library",
            properties: ["openDirectory"],
          });
          if (picked.canceled || picked.filePaths.length === 0) {
            result = { canceled: true, rootPath: null, preview: null };
          } else {
            const rootPath = picked.filePaths[0];
            result = { canceled: false, rootPath, preview: await previewEagleLibrary(rootPath) };
          }
        } else if (url === "/library/pick-folder") {
          // Add 메뉴의 "Choose Files > Folder" 항목과 폴더 드래그-드랍에서
          // 공통으로 사용. 사용자가 고른 폴더가 Eagle Library 면 preview 를
          // 곧장 돌려주고, 그렇지 않으면 폴더 안의 미디어 파일을 재귀로
          // 모아 paths 로 반환한다 — 렌더러에서는 file:// 로 읽어
          // uploadReferenceFile 와 동일한 ingest 파이프를 태운다.
          const picked = await dialog.showOpenDialog({
            title: "Select Folder",
            properties: ["openDirectory"],
          });
          if (picked.canceled || picked.filePaths.length === 0) {
            result = { canceled: true, rootPath: null, isEagleLibrary: false, eaglePreview: null, mediaFiles: [] };
          } else {
            const rootPath = picked.filePaths[0];
            const isEagle = await isEagleLibraryFolder(rootPath);
            if (isEagle) {
              result = {
                canceled: false,
                rootPath,
                isEagleLibrary: true,
                eaglePreview: await previewEagleLibrary(rootPath),
                mediaFiles: [],
              };
            } else {
              result = {
                canceled: false,
                rootPath,
                isEagleLibrary: false,
                eaglePreview: null,
                mediaFiles: await collectMediaFiles(rootPath),
              };
            }
          }
        } else if (url === "/library/scan-folder") {
          // 드래그-드랍 등 외부에서 이미 알고 있는 폴더 경로에 대해
          // Eagle 여부 + 미디어 파일 목록을 받아오는 보조 endpoint.
          const rootPath = String(body?.rootPath ?? "").trim();
          if (!rootPath) {
            throw new HttpError(400, "rootPath is required.");
          }
          const isEagle = await isEagleLibraryFolder(rootPath);
          if (isEagle) {
            result = {
              rootPath,
              isEagleLibrary: true,
              eaglePreview: await previewEagleLibrary(rootPath),
              mediaFiles: [],
            };
          } else {
            result = {
              rootPath,
              isEagleLibrary: false,
              eaglePreview: null,
              mediaFiles: await collectMediaFiles(rootPath),
            };
          }
        } else if (url === "/eagle/preview") {
          const { rootPath } = body;
          result = await previewEagleLibrary(String(rootPath ?? ""));
        } else if (url === "/eagle/import") {
          const { rootPath } = body;
          result = await importEagleLibrary(String(rootPath ?? ""));
        } else if (url === "/pack/export") {
          // Pack/* 라우트들은 원래 strict 한 *Request 타입을 받지만 이 라우터는
          // dumb proxy 역할이라 body 의 정확한 형태는 호출 대상 함수가 검증한다.
          // body 진입 시점의 단일 cast 와 일관되게, 여기서도 unknown→대상 타입의
          // 경유 cast 를 명시해 TS 의 "missing property" 거부를 우회한다.
          result = await exportLibraryPack(body as unknown as Parameters<typeof exportLibraryPack>[0]);
        } else if (url === "/pack/export-html") {
          // HTML Viewer Export — read-only 정적 뷰어 패키지(.zip 또는 .html).
          // packExport 와 거의 같은 scope 시스템을 쓰지만 출력은 외부 공유용
          // viewer 번들이라 별도 route 로 분리.
          result = await exportLibraryAsHtml(body as unknown as Parameters<typeof exportLibraryAsHtml>[0]);
        } else if (url === "/pack/preview") {
          result = await previewPackFromDisk();
        } else if (url === "/pack/preview-from-path") {
          // Add → Choose Files / 드래그-드랍 진입점에서 사용. 사용자가 이미
          // 골랐거나 드롭한 .preflowlib / .preflowpack 의 절대경로를 받아
          // 다이얼로그 없이 곧장 미리보기를 만든다.
          result = await previewPackFromPath(String(body?.path ?? ""));
        } else if (url === "/pack/import") {
          result = await applyPack(body as unknown as Parameters<typeof applyPack>[0]);
        } else if (url === "/pack/export-project") {
          // Phase 3 — .preflowproj 팩 export. body: { scope, projectId?,
          // projectIds?, includeFiles?, includeReferences?, suggestedName? }.
          // scope 화이트리스트로 좁혀 알 수 없는 값은 single 로 격하.
          const rawScope = body?.scope;
          const scope: "single" | "selection" | "workspace" =
            rawScope === "workspace" ? "workspace" : rawScope === "selection" ? "selection" : "single";
          const projectIds = Array.isArray(body?.projectIds)
            ? (body!.projectIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
            : null;
          result = await exportProjPack({
            scope,
            projectId: typeof body?.projectId === "string" ? (body.projectId as string) : null,
            projectIds,
            includeFiles: body?.includeFiles !== false,
            includeReferences: body?.includeReferences !== false,
            suggestedName: typeof body?.suggestedName === "string" ? (body.suggestedName as string) : undefined,
          });
        } else if (url === "/pack/preview-project") {
          result = await previewProjPackFromDisk();
        } else if (url === "/pack/preview-project-from-path") {
          // 드래그-드랍 / Open 다이얼로그 외부에서 받은 .preflowproj 절대경로
          // 진입점.
          result = await previewProjPackFromPath(String(body?.path ?? ""));
        } else if (url === "/pack/import-project") {
          result = await applyProjPack({ tempPath: String(body?.tempPath ?? "") });
        } else if (url === "/shell/resolve-path") {
          const filePath = resolveStorageUrlToPath(body?.url);
          result = { filePath };
        } else if (url === "/shell/open-path") {
          const filePath = resolveStorageUrlToPath(body?.url);
          const error = await shell.openPath(filePath);
          if (error) throw new HttpError(500, error);
          result = { ok: true };
        } else if (url === "/shell/show-item") {
          const filePath = resolveStorageUrlToPath(body?.url);
          shell.showItemInFolder(filePath);
          result = { ok: true };
        } else if (url === "/shell/open-external") {
          // Eagle 처럼 link/youtube 레퍼런스를 더블클릭 시 OS 기본 브라우저로
          // 원본 페이지를 띄우기 위해 사용. file:// 등 다른 스킴은 막아
          // 임의의 로컬 경로/실행 파일을 외부 핸들러로 흘리지 않도록 한다.
          const externalUrl = String(body?.url ?? "").trim();
          if (!/^https?:\/\//i.test(externalUrl)) {
            throw new HttpError(400, "Only http(s) URLs are allowed.");
          }
          await shell.openExternal(externalUrl);
          result = { ok: true };
        } else if (url === "/settings/get") {
          result = getSettings();
        } else if (url === "/settings/set") {
          setSettings(body);
          result = getSettings();
        } else if (url === "/api/claude-proxy") {
          result = await handleClaudeProxy(body);
        } else if (url === "/api/enhance-inpaint-prompt") {
          result = await handleEnhanceInpaintPrompt(body);
        } else if (url === "/api/translate-analysis") {
          result = await handleTranslateAnalysis(body);
        } else if (url === "/api/analyze-reference-images") {
          result = await handleAnalyzeReferenceImages(body);
        } else if (url === "/api/openai-image") {
          result = await handleOpenaiImage(body);
        } else if (url === "/api/openai-chat") {
          result = await handleOpenAIResponses(body);
        } else if (url === "/api/youtube-ingest") {
          result = await handleYoutubeIngest(body);
        } else if (url === "/api/link-preview") {
          result = await handleLinkPreview(body);
        } else if (url === "/api/lens-search") {
          result = await handleLensSearch(body);
        } else if (url === "/api/fetch-image") {
          result = await handleFetchImage(body);
        } else if (url === "/workspace/list") {
          result = buildListWorkspacesResponse();
        } else if (url === "/workspace/create") {
          result = await handleWorkspaceCreate(body);
        } else if (url === "/workspace/load") {
          result = await handleWorkspaceLoad(body);
        } else if (url === "/workspace/activate") {
          result = await handleWorkspaceActivate(body);
        } else if (url === "/workspace/rename") {
          result = handleWorkspaceRename(body);
        } else if (url === "/workspace/disconnect") {
          result = handleWorkspaceDisconnect(body);
        } else if (url === "/workspace/delete") {
          result = await handleWorkspaceDelete(body);
        } else if (url === "/workspace/show-in-explorer") {
          result = handleWorkspaceShowInExplorer(body);
        } else if (url === "/cross-workspace/references") {
          result = handleCrossWorkspaceReferences(body);
        } else if (url === "/cross-workspace/folders") {
          result = handleCrossWorkspaceFolders(body);
        } else if (url === "/canvas/list") {
          result = handleCanvasList();
        } else if (url === "/canvas/save") {
          result = handleCanvasSave(body);
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        console.error(`[local-server] ${url} error:`, err);
        res.writeHead(errorStatus(err), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errorMessage(err) }));
      }
    });

    void (async () => {
    // ── 포트 바인딩 전략 ─────────────────────────────────────────────
    // 1. 선호 포트 19876 을 3 회까지 재시도 (TIME_WAIT / zombie 해제 대기).
    // 2. 그래도 EADDRINUSE 면 port=0 으로 OS 가 할당해 주는 랜덤 포트 사용.
    // 3. 실제 bind 된 포트를 setLocalServerPort() 로 기록해서 main/renderer
    //    양쪽이 올바른 URL 을 쓰도록 한다.
    const maxRetries = 3;
    let lastErr: NodeJS.ErrnoException | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const port = await listenOnce(server, LOCAL_SERVER_PORT);
        setLocalServerPort(port);
        console.log(`[local-server] Running on port ${port}`);
        resolve(port);
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EADDRINUSE") {
          reject(e);
          return;
        }
        lastErr = e;
        if (attempt < maxRetries - 1) {
          console.warn(
            `[local-server] Port ${LOCAL_SERVER_PORT} busy, retry ${attempt + 1}/${maxRetries - 1} in ${500 * (attempt + 1)}ms`,
          );
          await sleep(500 * (attempt + 1));
        }
      }
    }

    // Fallback: OS 가 할당하는 랜덤 포트로 시도.
    console.warn(
      `[local-server] Preferred port ${LOCAL_SERVER_PORT} unavailable after retries (${lastErr?.message}). Falling back to a random port.`,
    );
    try {
      const port = await listenOnce(server, 0);
      setLocalServerPort(port);
      console.log(`[local-server] Running on fallback port ${port}`);
      resolve(port);
    } catch (err) {
      reject(err);
    }
    })();
  });
}
