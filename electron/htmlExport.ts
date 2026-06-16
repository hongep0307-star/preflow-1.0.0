import { app, dialog } from "electron";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import JSZip from "jszip";
import { getStorageBasePath } from "./paths";
import { dbSelect } from "./db-utils";
import { buildViewerHtml, buildFolderNodes, type ViewerFolderNode } from "./htmlExportBuilder";

export { buildViewerHtml };

/* HTML Viewer Export — read-only 정적 뷰어 패키지 빌더.
 *
 * 메인 앱의 electron/packExport.ts 가 `.preflowlib` ZIP (앱에서 재import
 * 가능한 데이터 팩) 을 만든다면, 이쪽은 *외부 공유* 용도. 받는 사람은
 * 앱이 없어도 더블클릭으로 브라우저에서 그리드 + 영상 + 코멘트를 볼 수
 * 있다.
 *
 * 두 출력 포맷:
 *   - "zip"        : index.html + assets/files/<id>.<ext> + assets/thumbnails/<id>.<ext>
 *   - "single-html": 모든 미디어를 base64 data URI 로 index.html 한 장에 인라인
 *
 * Vite 멀티 entry 가 미리 빌드해둔 `dist/viewer.html` + 관련 자산을 읽어
 *   1) 모든 <script src> / <link rel=stylesheet href> 를 인라인하고
 *   2) `<script>window.__PREFLOW_VIEWER_DATA__ = {...};</script>` 를 주입
 * 하여 단일 HTML 문서를 만든다. 이렇게 만든 HTML 은 file:// 더블클릭에서
 * 별도 fetch 없이 즉시 동작한다 — JSON 도 inline <script> 라 CORS/file://
 * fetch 정책에 막히지 않는다. */

interface ExportHtmlRequest {
  scope: "folder" | "selected" | "filtered" | "all";
  ids?: string[];
  folderTag?: string;
  includeSubfolders?: boolean;
  suggestedName?: string;
  /** 뷰어 헤더에 노출할 제목. 비우면 scopeLabel 폴백. */
  title?: string;
  /** "zip" | "single-html". 기본 "zip". */
  format?: "zip" | "single-html";
  /** export 한 앱의 UI 언어 — 뷰어 초기 언어 기본값으로 직렬화. */
  language?: "ko" | "en";
  /** 뷰어 폴더 트리를 한정할 폴더 경로 목록("folder:" 접두 유무 무관). folder
   *  scope 가 아닌데도(예: 다중 폴더 선택 / 활성 폴더에서 선택 export) 트리를
   *  그 폴더(들)로만 보이게 하고 싶을 때 사용. folder scope 면 folderTag 가
   *  우선. (하위호환: 단일 string 도 허용.) */
  folderScope?: string | string[];
}

interface ReferenceRow {
  id: string;
  kind: string;
  title: string;
  file_url?: string | null;
  thumbnail_url?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  tags?: string[] | string | null;
  notes?: string | null;
  source_url?: string | null;
  cover_at_sec?: number | null;
  timestamp_notes?: unknown;
  deleted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  imported_at?: string | null;
  color_palette?: unknown;
  ai_suggestions?: unknown;
  [key: string]: unknown;
}

interface ColorSwatchOut {
  color: string;
  /** 해당 색이 썸네일에서 차지하는 픽셀 비중(0..1). viewer 가 swatch 를
   *  ratio 내림차순으로 표시할 때 사용. 메인 앱의 ColorSwatch.ratio 와
   *  동일 시맨틱이라 그대로 직렬화. */
  ratio?: number;
  /** legacy 호환 — 현 파이프라인에선 채워지지 않음. */
  count?: number;
}

interface AiSuggestionsOut {
  suggested_tags?: string[];
  suggested_tags_ko?: string[];
  mood_labels?: string[];
  mood_labels_ko?: string[];
  visual_style?: string;
  visual_style_ko?: string;
  motion_notes?: string;
  motion_notes_ko?: string;
  brief_fit?: string;
  brief_fit_ko?: string;
  conti_use?: string;
  conti_use_ko?: string;
}

/* viewer/types.ts 의 ReferenceItem 과 1:1 매칭되는 직렬화 형태.
 *  여기 정의를 그대로 JSON 으로 넣으면 viewer 가 그대로 받아 쓴다. */
interface ViewerReference {
  id: string;
  kind: "image" | "webp" | "gif" | "video" | "youtube" | "link" | "doc";
  title: string;
  file_url: string | null;
  thumbnail_url: string | null;
  mime_type: string | null;
  file_size: number | null;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  tags: string[];
  notes: string | null;
  source_url: string | null;
  timestamp_notes: Array<Record<string, unknown>>;
  created_at: string | null;
  updated_at: string | null;
  imported_at: string | null;
  cover_at_sec: number | null;
  color_palette: ColorSwatchOut[];
  ai_suggestions: AiSuggestionsOut | null;
}

interface ViewerData {
  title: string;
  generated_at: string;
  item_count: number;
  items: ViewerReference[];
  /** export 시점 폴더 구조 스냅샷. viewer 는 부재 시 tags 폴백. */
  folders?: ViewerFolderNode[];
  /** 뷰어 초기 언어 기본값. */
  source_language?: "ko" | "en";
}

export interface ExportHtmlResult {
  canceled?: boolean;
  saved_path?: string;
  item_count: number;
  total_size_bytes: number;
  skipped: string[];
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

function normalizeTimestampNotes(value: unknown): Array<Record<string, unknown>> {
  /* dbSelect 가 이미 JSON_COLUMNS 를 deserialize 해주지만, 라이브러리 외부
   *  유입(e.g. 옛 데이터) 대비로 문자열도 한 번 더 파싱. */
  let arr: unknown = value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function normalizeKind(raw: unknown): ViewerReference["kind"] {
  if (
    raw === "webp" ||
    raw === "gif" ||
    raw === "video" ||
    raw === "youtube" ||
    raw === "link" ||
    raw === "doc"
  ) {
    return raw;
  }
  return "image";
}

function normalizeColorPalette(value: unknown): ColorSwatchOut[] {
  let arr: unknown = value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const color = typeof obj.color === "string" ? obj.color : null;
      if (!color) return null;
      // ratio: 정상 경로(메인 앱 색 추출). count: 레거시 호환. 둘 다 없으면
      // color 만 직렬화 — viewer 는 ratio 누락 시 0 으로 fallback 해 정렬.
      const ratio = typeof obj.ratio === "number" ? obj.ratio : undefined;
      const count = typeof obj.count === "number" ? obj.count : undefined;
      const out: ColorSwatchOut = { color };
      if (ratio !== undefined) out.ratio = ratio;
      if (count !== undefined) out.count = count;
      return out;
    })
    .filter((entry): entry is ColorSwatchOut => entry !== null)
    .slice(0, 8);
}

/* ai_suggestions 의 *읽기 전용 사용자 표시 필드* 만 좁혀서 viewer 에 전달.
 *  raw / transcript 처럼 큰 JSON 은 export 결과 크기를 부풀리고 viewer 가
 *  사용하지 않으므로 명시적으로 제외. */
function normalizeAiSuggestions(value: unknown): AiSuggestionsOut | null {
  let obj: unknown = value;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const src = obj as Record<string, unknown>;
  const out: AiSuggestionsOut = {};
  const pickStrArr = (key: keyof AiSuggestionsOut) => {
    const v = src[key as string];
    if (Array.isArray(v)) {
      const arr = v.map((x) => (typeof x === "string" ? x : null)).filter((x): x is string => Boolean(x));
      if (arr.length) (out as Record<string, unknown>)[key as string] = arr;
    }
  };
  const pickStr = (key: keyof AiSuggestionsOut) => {
    const v = src[key as string];
    if (typeof v === "string" && v.trim()) {
      (out as Record<string, unknown>)[key as string] = v;
    }
  };
  pickStrArr("suggested_tags");
  pickStrArr("suggested_tags_ko");
  pickStrArr("mood_labels");
  pickStrArr("mood_labels_ko");
  pickStr("visual_style");
  pickStr("visual_style_ko");
  pickStr("motion_notes");
  pickStr("motion_notes_ko");
  pickStr("brief_fit");
  pickStr("brief_fit_ko");
  pickStr("conti_use");
  pickStr("conti_use_ko");
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "preflow-share"
  );
}

/* packExport.ts 의 동일 함수와 1:1 매핑되는 로컬 사본.
 *  cross-import 의존성을 만들지 않기 위해 의도적으로 복제. (양쪽 모두
 *  ./paths 와 getStorageBasePath 만 공유.) */
function resolveStorageUrlToPath(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const storageBase = path.resolve(getStorageBasePath());
  let target: string;
  if (rawUrl.startsWith("local-file://")) {
    let rawPath = decodeURIComponent(
      rawUrl.slice("local-file://".length).split(/[?#]/)[0],
    ).replace(/\//g, path.sep);
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
  return (
    dbSelect("reference_items", {}, {
      orderBy: "created_at",
      ascending: false,
      limit: 10_000,
    }) as ReferenceRow[]
  ).filter((row) => !row.deleted_at);
}

function resolveRows(req: ExportHtmlRequest): ReferenceRow[] {
  const ids = new Set((req.ids ?? []).filter(Boolean));
  if (req.scope === "all") return allReferences();
  if (req.scope === "selected" || req.scope === "filtered") {
    if (ids.size === 0) return [];
    return allReferences().filter((row) => ids.has(row.id));
  }
  if (req.scope === "folder") {
    const tag = req.folderTag?.startsWith("folder:")
      ? req.folderTag
      : req.folderTag
        ? `folder:${req.folderTag}`
        : "";
    if (!tag) return [];
    return allReferences().filter((row) => {
      const tags = normalizeTags(row.tags);
      return req.includeSubfolders === false
        ? tags.includes(tag)
        : tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`));
    });
  }
  if (ids.size > 0) {
    return allReferences().filter((row) => ids.has(row.id));
  }
  return [];
}

/* ── MIME 추정 ─────────────────────────────────────────────────────
 *
 * 단일 HTML 모드에서 data: URI 를 만들려면 정확한 MIME 이 필요. row.mime_type
 * 이 있으면 그대로 쓰고, 없으면 확장자에서 폴백. */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function guessMime(filePath: string, fallback?: string | null): string {
  if (fallback && typeof fallback === "string" && fallback.includes("/")) return fallback;
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/* ── 빌트인 뷰어 자산 로딩 ─────────────────────────────────────────────
 *
 * Vite 빌드 결과는 `<repo>/dist/viewer.html` + `<repo>/dist/assets/*` 에
 * 위치한다. dev 와 packaged 모두 main 프로세스에서 보는 절대 경로는
 *   dev:       <repo>/dist
 *   packaged:  <app.getAppPath()>/dist  (electron-builder `files: ["dist/**\/*"]`)
 * 으로 일치한다 (app.getAppPath 는 asar 풀려도 패키지 루트를 반환).
 *
 * asar 안에서도 fs.promises.readFile 가 그대로 동작하므로 별도 추출이
 * 필요 없다. */
function getDistDir(): string {
  return path.join(app.getAppPath(), "dist");
}

interface ViewerBundle {
  /** index.html 의 src/href 가 모두 인라인된 단일 HTML 문자열.
   *  최종 사용자에게 줄 때 `<script>window.__PREFLOW_VIEWER_DATA__ = ...;
   *  </script>` 를 `</body>` 직전에 한 번 더 주입해 완성. */
  html: string;
}

async function loadViewerBundle(): Promise<ViewerBundle> {
  const dist = getDistDir();
  const viewerHtmlPath = path.join(dist, "viewer.html");
  const viewerHtml = await fs.promises.readFile(viewerHtmlPath, "utf8");

  /* 모든 `<script src="./assets/...">` 와 `<link rel="stylesheet"
   *  href="./assets/...">` 를 찾아서 같은 파일을 읽고 inline 으로 치환.
   *
   *  주의:
   *    - `<link rel="modulepreload" href="...">` 같은 *preload 힌트* 는
   *      삭제. 단일 HTML 에서는 의미 없고, 외부 fetch 를 유발해 file://
   *      환경에서 잘못된 에러 로그를 띄울 수 있다.
   *    - Pretendard CDN `<link>` 는 https://… 절대 URL 이라 우리 정규식
   *      (`./assets/...`) 에 안 잡혀 자연히 보존됨. */
  let html = viewerHtml;

  /* modulepreload 제거. */
  html = html.replace(
    /\s*<link[^>]*rel=["']modulepreload["'][^>]*>\s*/g,
    "\n    ",
  );

  /* <script type="module" crossorigin src="./assets/foo.js"></script>
   *  →  <script type="module">{file 내용}</script>
   *
   *  module 속성을 유지하는 이유: 우리 entry 가 ESM 모듈로 빌드되어
   *  top-level await / import 구문이 들어 있을 수 있어 type=module 이
   *  필요. 단일 HTML 안의 inline <script type="module"> 도 브라우저가
   *  정상 처리한다. */
  const scriptRe = /<script\b([^>]*?)\bsrc=["']\.\/?([^"']+)["']([^>]*)><\/script>/g;
  const scriptMatches: Array<{ full: string; attrsBefore: string; relPath: string; attrsAfter: string }> = [];
  for (const m of html.matchAll(scriptRe)) {
    scriptMatches.push({ full: m[0], attrsBefore: m[1] || "", relPath: m[2], attrsAfter: m[3] || "" });
  }
  for (const entry of scriptMatches) {
    const assetPath = path.join(dist, entry.relPath);
    let body = "";
    try {
      body = await fs.promises.readFile(assetPath, "utf8");
    } catch (err) {
      throw new Error(
        `Viewer asset missing: ${entry.relPath} (resolved: ${assetPath}). ` +
          `Did you run \`npm run build\` so dist/viewer.html and dist/assets are available?`,
      );
    }
    /* attrs 중 src 는 빠진 상태로 들어왔지만 type/crossorigin 등 다른
     *  속성은 유지. crossorigin 은 inline 에는 의미 없지만 남겨도 무해. */
    const attrs = `${entry.attrsBefore}${entry.attrsAfter}`.replace(/\s+/g, " ").trim();
    const openTag = attrs ? `<script ${attrs}>` : "<script>";
    /* </script> 이 본문에 들어 있으면 HTML 파서가 거기서 닫아버리므로 escape. */
    const safeBody = body.replace(/<\/script\s*>/gi, "<\\/script>");
    /* ⚠ String.prototype.replace 의 *문자열* replacement 는 `$&`, `$$`,
     *  `$1` 같은 패턴을 백레퍼런스로 해석한다. JS 번들에는 React 의
     *  `mapChildren` 처럼 `"$&/"` 를 인자로 쓰는 코드가 들어 있어, 그대로
     *  replacement 로 넘기면 `$&` 가 *매칭된 원본 <script> 태그* 로 치환돼
     *  번들 곳곳에 잘못된 script 태그가 박힌다 (= 검은 화면 + 텍스트 노출
     *  사고). 함수형 replacement 는 이 패턴 해석을 우회한다. */
    html = html.replace(entry.full, () => `${openTag}${safeBody}</script>`);
  }

  /* <link rel="stylesheet" href="./assets/foo.css">
   *  →  <style>{file 내용}</style>
   *
   *  Pretendard 같은 절대 URL CDN <link> 는 매처가 ./ 시작에만 걸리도록
   *  해서 자동으로 보존된다. */
  const linkRe =
    /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*?)\bhref=["']\.\/?([^"']+)["']([^>]*)>/g;
  const linkMatches: Array<{ full: string; relPath: string }> = [];
  for (const m of html.matchAll(linkRe)) {
    linkMatches.push({ full: m[0], relPath: m[3] });
  }
  /* href 가 rel 앞에 오는 경우도 처리. */
  const linkRe2 =
    /<link\b([^>]*?)\bhref=["']\.\/?([^"']+)["']([^>]*?)\brel=["']stylesheet["']([^>]*)>/g;
  for (const m of html.matchAll(linkRe2)) {
    linkMatches.push({ full: m[0], relPath: m[2] });
  }
  for (const entry of linkMatches) {
    const assetPath = path.join(dist, entry.relPath);
    let body = "";
    try {
      body = await fs.promises.readFile(assetPath, "utf8");
    } catch (err) {
      throw new Error(
        `Viewer stylesheet missing: ${entry.relPath} (resolved: ${assetPath}).`,
      );
    }
    /* </style> escape — CSS 안에 거의 안 나오지만 안전장치. */
    const safeBody = body.replace(/<\/style\s*>/gi, "<\\/style>");
    /* 함수형 replacement — script 인라인과 동일하게 `$` 패턴 해석 회피. */
    html = html.replace(entry.full, () => `<style>${safeBody}</style>`);
  }

  return { html };
}

/* ── 행 변환 ───────────────────────────────────────────────────────
 *
 * DB row 를 viewer 가 기대하는 모양으로 좁힌다. viewer 가 안 보는 컬럼
 * (promoted_asset_ids 같은 내부 메타) 은 전부 떼어내 export 결과물의
 * 크기를 줄인다. file_url 은 호출자가 ZIP/single-html 분기에서 덮어
 * 쓰므로 여기선 null. */
function toViewerReference(row: ReferenceRow): ViewerReference {
  const kind = normalizeKind(row.kind);
  /* youtube 는 원격 썸네일(i.ytimg.com) URL 만 있고 로컬 파일이 없는 경우가
   *  많다. resolveStorageUrlToPath 가 원격 URL 은 null 을 돌려줘 그대로 두면
   *  뷰어에 썸네일이 안 뜬다. 원격 URL 을 기본값으로 보존해 (온라인에서)
   *  카드/인스펙터가 썸네일을 보이게 한다. 로컬 썸네일이 존재하면 아래
   *  export 루프가 이 값을 ZIP 상대경로 / data: URI 로 덮어쓴다. */
  const remoteYoutubeThumb =
    kind === "youtube" &&
    typeof row.thumbnail_url === "string" &&
    /^https?:\/\//i.test(row.thumbnail_url)
      ? row.thumbnail_url
      : null;
  return {
    id: String(row.id),
    kind,
    title: typeof row.title === "string" ? row.title : "",
    file_url: null,
    thumbnail_url: remoteYoutubeThumb,
    mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
    file_size: typeof row.file_size === "number" ? row.file_size : null,
    duration_sec: typeof row.duration_sec === "number" ? row.duration_sec : null,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
    tags: normalizeTags(row.tags),
    notes: typeof row.notes === "string" ? row.notes : null,
    source_url: typeof row.source_url === "string" ? row.source_url : null,
    timestamp_notes: normalizeTimestampNotes(row.timestamp_notes),
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    imported_at: typeof row.imported_at === "string" ? row.imported_at : null,
    cover_at_sec: typeof row.cover_at_sec === "number" ? row.cover_at_sec : null,
    color_palette: normalizeColorPalette(row.color_palette),
    ai_suggestions: normalizeAiSuggestions(row.ai_suggestions),
  };
}

/* ── 메인 export ───────────────────────────────────────────────────
 *
 * "zip" 분기:
 *   - JSZip 으로 index.html + assets/files/<id>.<ext> + assets/thumbnails/<id>.<ext>
 *   - viewer 의 file_url/thumbnail_url 은 같은 ZIP 내의 상대 경로
 *
 * "single-html" 분기:
 *   - 모든 미디어를 base64 로 읽어 data: URI 로 file_url 에 직접 박음
 *   - 결과는 한 장의 .html 파일
 *   - 큰 영상이 들어가면 결과 크기가 폭증할 수 있음 (호출자가 사용자에게
 *     경고하는 정책은 다이얼로그 측 책임)
 *
 * 두 경우 모두 skipped[] 로 누락 파일을 누적해 호출자가 토스트 노출. */
export async function exportLibraryAsHtml(req: ExportHtmlRequest): Promise<ExportHtmlResult> {
  const format: "zip" | "single-html" = req.format === "single-html" ? "single-html" : "zip";
  const rows = resolveRows(req);

  const scopeLabel = req.folderTag?.replace(/^folder:/, "") || req.scope;
  /* 폴더 범위 export 면 폴더 트리를 그 폴더(들) 하위로만 한정한다. 한 자료가
   *  여러 폴더에 태깅돼 있어도(예: test_01 자료가 test_02/브리프매치에도
   *  속함) 내보낸 폴더 밖의 유령 폴더가 트리에 섞이지 않게 한다.
   *  folder scope 면 folderTag 우선, 아니면 folderScope(단일 string 또는
   *  다중 string[]) 를 정규화해 배열로 만든다. */
  const folderScopePaths: string[] =
    req.scope === "folder" && req.folderTag
      ? [req.folderTag.replace(/^folder:/, "")]
      : req.folderScope
        ? (Array.isArray(req.folderScope) ? req.folderScope : [req.folderScope]).map((s) =>
            s.replace(/^folder:/, ""),
          )
        : [];
  const today = new Date().toISOString().slice(0, 10);
  const baseName = sanitizeName(req.suggestedName || `${scopeLabel}-${today}`);
  const extension = format === "zip" ? "zip" : "html";
  const defaultName = `${baseName}.${extension}`;

  const filters = format === "zip"
    ? [{ name: "Pre-Flow HTML Viewer (ZIP)", extensions: ["zip"] }]
    : [{ name: "Pre-Flow HTML Viewer", extensions: ["html"] }];
  const picked = await dialog.showSaveDialog({
    title: "Export as HTML Viewer",
    defaultPath: defaultName,
    filters,
  });
  if (picked.canceled || !picked.filePath) {
    return { canceled: true, item_count: 0, total_size_bytes: 0, skipped: [] };
  }

  /* viewer bundle 은 두 포맷 공통 — 데이터만 다르게 주입. */
  const bundle = await loadViewerBundle();

  const skipped: string[] = [];
  let totalSize = 0;
  const items: ViewerReference[] = [];

  if (format === "zip") {
    /* ── ZIP 분기 ──────────────────────────────────────────────── */
    const zip = new JSZip();
    for (const row of rows) {
      const ref = toViewerReference(row);
      const fileSrc = resolveStorageUrlToPath(row.file_url);
      if (await fileExists(fileSrc)) {
        if (ref.kind === "gif") {
          /* gif / 애니메이션 webp 는 뷰어가 ImageDecoder(=fetch 기반)로 프레임을
           *  읽는다. ZIP 을 file:// 로 더블클릭해 열면 상대경로 fetch 가 브라우저
           *  보안에 막혀 프레임 디코드가 실패한다(→ 폴백 + 컨트롤 없음). 따라서
           *  gif 만 data: URI 로 인라인해 file:// 에서도 fetch 가 되어 재생/프레임/
           *  루프 컨트롤이 정상 동작하게 한다. (gif 는 보통 작아 인라인 부담 적음) */
          try {
            const buf = await fs.promises.readFile(fileSrc!);
            const mime = guessMime(fileSrc!, typeof row.mime_type === "string" ? row.mime_type : null);
            ref.file_url = `data:${mime};base64,${buf.toString("base64")}`;
            ref.mime_type = mime;
            totalSize += buf.byteLength;
          } catch {
            skipped.push(`${row.title}: failed to read file`);
          }
        } else {
          const ext = path.extname(fileSrc!) || ".bin";
          const rel = `assets/files/${row.id}${ext}`;
          zip.file(rel, fs.createReadStream(fileSrc!));
          ref.file_url = rel;
          try {
            const stat = await fs.promises.stat(fileSrc!);
            totalSize += stat.size;
          } catch {
            /* stat 실패는 무시 — 크기 합산에서만 빠짐. */
          }
        }
      } else if (row.file_url && row.kind !== "youtube" && row.kind !== "link") {
        skipped.push(`${row.title}: missing file_url`);
      }

      const thumbSrc = resolveStorageUrlToPath(row.thumbnail_url);
      if (await fileExists(thumbSrc)) {
        const ext = path.extname(thumbSrc!) || ".bin";
        const rel = `assets/thumbnails/${row.id}${ext}`;
        zip.file(rel, fs.createReadStream(thumbSrc!));
        ref.thumbnail_url = rel;
      } else if (row.thumbnail_url) {
        /* thumbnail 누락은 viewer 가 자체 placeholder 로 처리하므로 사용자
         *  안내 가치가 낮음 — skipped 에 누적하지 않음. */
      }

      items.push(ref);
    }

    const viewerData: ViewerData = {
      title: req.title?.trim() || scopeLabel || "Pre-Flow Viewer",
      generated_at: new Date().toISOString(),
      item_count: items.length,
      items,
      folders: buildFolderNodes(items, folderScopePaths, req.includeSubfolders),
      source_language: req.language === "ko" || req.language === "en" ? req.language : undefined,
    };
    const finalHtml = buildViewerHtml(bundle.html, viewerData);
    zip.file("index.html", finalHtml);

    await fs.promises.mkdir(path.dirname(picked.filePath), { recursive: true });
    await pipeline(
      zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }),
      fs.createWriteStream(picked.filePath),
    );
  } else {
    /* ── 단일 HTML 분기 ──────────────────────────────────────────── */
    for (const row of rows) {
      const ref = toViewerReference(row);
      const fileSrc = resolveStorageUrlToPath(row.file_url);
      if (await fileExists(fileSrc)) {
        try {
          const buf = await fs.promises.readFile(fileSrc!);
          const mime = guessMime(fileSrc!, typeof row.mime_type === "string" ? row.mime_type : null);
          ref.file_url = `data:${mime};base64,${buf.toString("base64")}`;
          ref.mime_type = mime;
          totalSize += buf.byteLength;
        } catch {
          skipped.push(`${row.title}: failed to read file`);
        }
      } else if (row.file_url && row.kind !== "youtube" && row.kind !== "link") {
        skipped.push(`${row.title}: missing file_url`);
      }

      const thumbSrc = resolveStorageUrlToPath(row.thumbnail_url);
      if (await fileExists(thumbSrc)) {
        try {
          const buf = await fs.promises.readFile(thumbSrc!);
          const mime = guessMime(thumbSrc!, null);
          ref.thumbnail_url = `data:${mime};base64,${buf.toString("base64")}`;
        } catch {
          /* 썸네일 인라인 실패는 grid placeholder 로 폴백 — 무해. */
        }
      }

      items.push(ref);
    }

    const viewerData: ViewerData = {
      title: req.title?.trim() || scopeLabel || "Pre-Flow Viewer",
      generated_at: new Date().toISOString(),
      item_count: items.length,
      items,
      folders: buildFolderNodes(items, folderScopePaths, req.includeSubfolders),
      source_language: req.language === "ko" || req.language === "en" ? req.language : undefined,
    };
    const finalHtml = buildViewerHtml(bundle.html, viewerData);

    await fs.promises.mkdir(path.dirname(picked.filePath), { recursive: true });
    await fs.promises.writeFile(picked.filePath, finalHtml, "utf8");
  }

  return {
    saved_path: picked.filePath,
    item_count: items.length,
    total_size_bytes: totalSize,
    skipped,
  };
}
