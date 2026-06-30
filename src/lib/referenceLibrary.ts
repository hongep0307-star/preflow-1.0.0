import {
  LOCAL_SERVER_AUTH_HEADERS,
  LOCAL_SERVER_BASE_URL,
  REFERENCE_UPLOAD_MAX_BYTES,
  REFERENCE_UPLOAD_MAX_LABEL,
} from "@shared/constants";
import { supabase } from "./supabase";
import { dispatchPaletteUpdated, enqueueExtractFromThumbnail } from "./colorPalette";
import { deleteStoredFiles, parseStorageUrl } from "./storageUtils";
import { extractFirstFrame, validateVideoFile, validateVideoMeta, type VideoMeta } from "./videoFrames";
import { extractVideoPosterFile } from "./videoTranscode";
import { ingestYoutube, isYoutubeUrl, YOUTUBE_URL_REGEX } from "./youtube";
import { fetchLinkPreview, type LinkPreviewResult } from "./linkPreview";
import { generateAnimatedPreviewBlob } from "./animatedPreview";
import type { RefAnnotation, RefImageItem, RefItem, RefVideoItem, RefYoutubeItem } from "./refItems";
import type { GptQuality } from "./imageGenPreference";
import { DEFAULT_IMAGE_SEARCH_ENGINE, type ImageSearchEngineId } from "./imageSearchEngines";

const REFERENCES_BUCKET = "references";

export type ReferenceKind = "image" | "webp" | "gif" | "video" | "youtube" | "link" | "doc";
export type ClassificationStatus = "unclassified" | "pending" | "ready" | "failed" | "skipped";

/**
 * `kind: "doc"` 안에서 다시 시각/처리 분기에 쓸 sub-type. `mime_type` 으로
 * 동일 정보를 추론할 수 있지만, 미리 정규화된 토큰을 갖고 있으면 카드 렌더
 * (배지/색/아이콘) 와 검색 매칭이 직관적이라 별도 노출. DB 컬럼을 굳이
 * 새로 만들지 않고 클라이언트에서 mime_type/확장자로부터 매번 도출해도
 * 무방하므로 이 enum 은 *언제든 잘라낼 수 있는* 표현 레이어 토큰으로 쓴다.
 */
export type DocSubtype =
  | "pdf"
  | "psd"
  | "spreadsheet"
  | "presentation"
  | "document"
  | "archive"
  | "font"
  | "html"
  | "code"
  | "audio"
  | "executable"
  | "other";

/* ── kind 분기 헬퍼 ────────────────────────────────────────────────
   `kind === "image" || kind === "webp" || kind === "gif" || kind === "video"`
   같은 *카테고리 묶음 비교* 가 코드베이스 130+ 곳에 흩어져 있어, doc 같은
   새 카테고리를 추가할 때마다 누락되는 곳이 생긴다. 한 곳에서만 정의된
   술어로 정리해 두면 새 kind 추가 시 한 줄만 갱신하면 다른 곳들이 자동
   따라온다. 기존 `=== "image"` 분기는 *명시적 의도* (정지 이미지만 ㅁ만
   취급) 이므로 그대로 두고, *카테고리* 의미만 헬퍼로 흡수.

   - isMediaKind  : 정지/움직이는 *시각 자료* (image/webp/gif/video)
   - isUrlKind    : 외부 URL 자료 (youtube/link)
   - isDocKind    : 일반 문서/바이너리 (doc) — 썸네일이 generic 또는 별도
                    파이프라인(PDF first page, font preview 등) 으로 만들어짐
*/
export function isMediaKind(kind: ReferenceKind): boolean {
  return kind === "image" || kind === "webp" || kind === "gif" || kind === "video";
}
export function isUrlKind(kind: ReferenceKind): boolean {
  return kind === "youtube" || kind === "link";
}
export function isDocKind(kind: ReferenceKind): boolean {
  return kind === "doc";
}

/** AI 분류(비전 분석) 대상 여부. doc(문서/PDF/오디오/zip 등)은 생성된 썸네일
 *  플레이스홀더만 가지므로 시각 분석이 무의미하다(썸네일 placeholder 를 그대로
 *  설명하는 잘못된 무드/태그가 붙어 라이브러리 검색·무드 필터를 오염시킴).
 *  따라서 모든 분류 진입점(자동분류/우클릭/Run AI/백필 재분류)에서 일관되게
 *  제외한다. 추후 오디오 전용 분석(음원 이해 모델)을 살리려면, 이 함수가 audio
 *  subtype 만 통과시키도록 확장하고 별도 audio 분류 경로를 붙이면 된다. */
export function isAiAnalyzable(item: { kind: ReferenceKind }): boolean {
  return !isDocKind(item.kind);
}

/** 영역(region) 코멘트가 가리키는 사각형. 자연 해상도와 무관하게 비율(0~1)로
 *  저장해 어떤 디스플레이 박스에서도 동일 비율로 다시 그릴 수 있게 한다.
 *  (x, y) 는 좌상단, (w, h) 는 너비/높이. 모두 [0, 1] 로 clamp 된 값이라고
 *  가정하지만, 렌더링 측에서도 한 번 더 clamp 해 외부 데이터 / 마이그레이션
 *  데이터 안전성을 보장한다. */
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimestampNote {
  id: string;
  /** 영상 자료 — 노트가 가리키는 시각(초). 영역-only 노트(이미지)에서는 undefined. */
  atSec?: number;
  /** GIF 자료 — 노트가 가리키는 정확한 프레임 인덱스. 영상에서는 undefined.
   *  GIF 는 프레임 duration 이 균등하지 않을 수 있어 atSec 보다 frameIndex
   *  가 정확. 양쪽이 모두 있으면 자료 종류에 따라 우선순위가 갈린다(GIF =
   *  frameIndex, video = atSec). */
  frameIndex?: number;
  /** PDF 자료 — 노트가 가리키는 페이지(1-based, PdfViewer 의 pageIndex 와 동일
   *  기준). 슬라이드 노트는 region 과 함께 쓰여 "N페이지의 특정 영역" 을
   *  표현한다. 영상/GIF/이미지에서는 undefined. */
  pageIndex?: number;
  rangeText?: string;
  text: string;
  /** 자료 위에 드래그로 그린 영역. 시점-only 노트는 undefined.
   *  - video: atSec 시점에서만 표시.
   *  - gif:   frameIndex 프레임에서만 표시.
   *  - pdf:   pageIndex 페이지에서만 표시.
   *  - image: 항상 표시. */
  region?: RegionRect;
}

export interface ColorSwatch {
  color: string;
  ratio?: number;
}

export interface ReferenceItem {
  id: string;
  kind: ReferenceKind;
  title: string;
  file_url?: string | null;
  thumbnail_url?: string | null;
  /** 그리드 자동재생용 경량 animated WebP 프리뷰 URL. GIF/animated-WebP 만
   *  채워지며, 없으면 그리드는 원본(file_url)으로 폴백한다. */
  preview_url?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  content_hash?: string | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  tags: string[];
  notes?: string | null;
  rating?: number | null;
  is_favorite?: boolean;
  source_url?: string | null;
  cover_at_sec?: number | null;
  timestamp_notes: TimestampNote[];
  color_palette: ColorSwatch[];
  ai_suggestions?: Record<string, unknown> | null;
  classification_status?: ClassificationStatus | string | null;
  classified_at?: string | null;
  origin_project_id?: string | null;
  source_app?: string | null;
  source_library?: string | null;
  source_id?: string | null;
  imported_at?: string | null;
  pinned_at?: string | null;
  deleted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_used_at?: string | null;
  /** Promote-to-Asset 으로 만들어진 asset id 목록. reference 본체는 절대
   *  자동 삭제되지 않고, "이 자료에서 만든 asset 이 있다" 메타로 남는다. */
  promoted_asset_ids?: string[];
  /** AI 베리에이션으로 생성된 항목이면 원본 reference 의 id. 빠른 필터
   *  ("Variations") · 그리드 뱃지 · "원본 보기" 의 단일 근거. 일반 업로드/
   *  복제 항목에서는 null. */
  variation_of?: string | null;
}

/** 캔버스 AI 생성 노드의 입력 한 개. provenance(히스토리) 기록용.
 *
 *   - "library": 폴더/라이브러리에 이미 있는 레퍼런스를 입력으로 사용 →
 *     `refId` 로 안정 참조. 그대로 재사용 가능.
 *   - "external": 로컬에서 끌어온 외부 파일. 폴더/그리드에는 노출하지 않되,
 *     원본 전체를 숨김 `provenance` 저장소에 보관(`fullStoreUrl`)해 디스크
 *     원본이 사라져도 고화질 재탕이 가능하게 한다. 중복은 `contentHash` 로
 *     1회만 저장. */
export type GenerationInput =
  | { source: "library"; refId: string; thumbnailUrl?: string }
  | {
      source: "external";
      /** 사용자 디스크의 원위치(식별/표시용). */
      originalPath: string;
      /** 중복 제거 + 식별. */
      contentHash?: string;
      /** provenance 버킷의 원본 전체 URL → 재탕 시 사용. */
      fullStoreUrl: string;
      /** 고스트 노드 미리보기용 썸네일. */
      thumbnailUrl?: string;
    };

/** 생성물(이미지/영상) ReferenceItem 의 출처(provenance) 기록.
 *  `ReferenceItem.ai_suggestions.generation` 에 durable 하게 저장된다
 *  (ai_suggestions 는 자유 JSON 이라 DB 마이그레이션 불필요). 캔버스는 이
 *  데이터에서 provenance 연결선/고스트 노드를 파생 렌더하고(M5), orphanSweep
 *  은 `inputs[].fullStoreUrl`/`thumbnailUrl` 을 참조 집합에 포함한다(M4b). */
export interface GenerationProvenance {
  outputKind: "image" | "video";
  /** "veo-3.1-fast-generate-001" | "gemini-3.1-flash-image" 등. */
  model: string;
  /** aspectRatio, duration, resolution 등 모델 파라미터. */
  params?: Record<string, unknown>;
  /** 해석된 최종 프롬프트 텍스트. */
  prompt?: string;
  /** 프롬프트 카드(note role=prompt) 의 id (있으면). */
  promptNoteId?: string;
  /** 이 결과를 생성한 캔버스 생성 노드(CanvasGenNode) 의 id (있으면).
   *  캔버스가 결과를 *노드 우측* 에 배치하고 gen→결과 저장연결을 거는 데 쓴다. */
  genNodeId?: string;
  /** 생성에 사용된 입력 목록(이미지 + 참조). */
  inputs: GenerationInput[];
  /** ISO timestamp. */
  createdAt: string;
}

export interface ProjectReferenceLink {
  id: string;
  project_id: string;
  reference_id: string;
  target: "brief" | "agent" | "conti" | "asset" | string;
  annotation?: string | null;
  time_range?: RefAnnotation | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SavedFilter {
  id: string;
  name: string;
  query: Record<string, unknown>;
  source_app?: string | null;
  source_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ReferenceListOptions {
  kind?: ReferenceKind;
  tag?: string;
  query?: string;
  limit?: number;
  sortBy?: "created_at" | "updated_at" | "last_used_at" | "title" | "rating" | "file_size";
  ascending?: boolean;
  /** 기본 false — Trash(소프트 삭제) 행을 결과에서 제외한다. true 로 줘야
   *  Trash 가상 폴더처럼 의도적으로 trashed 만 보고 싶을 때 포함시킬 수 있다. */
  includeTrashed?: boolean;
  /** Trash 만 보고 싶을 때 사용. true 면 `deleted_at IS NOT NULL` 만. */
  trashedOnly?: boolean;
}

export interface CreateReferenceInput {
  id?: string;
  kind: ReferenceKind;
  title: string;
  file_url?: string | null;
  thumbnail_url?: string | null;
  preview_url?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  content_hash?: string | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  tags?: string[];
  notes?: string | null;
  rating?: number | null;
  is_favorite?: boolean;
  source_url?: string | null;
  cover_at_sec?: number | null;
  timestamp_notes?: TimestampNote[];
  color_palette?: ColorSwatch[];
  ai_suggestions?: Record<string, unknown> | null;
  classification_status?: ClassificationStatus;
  classified_at?: string | null;
  origin_project_id?: string | null;
  source_app?: string | null;
  source_library?: string | null;
  source_id?: string | null;
  imported_at?: string | null;
  pinned_at?: string | null;
  deleted_at?: string | null;
  /** "최근 사용" 사이드바 필터에 즉시 반영하기 위해 promote/attach 성공 시
   *  patch 로 같이 흘려보낼 수 있도록 허용. linkReferenceToProject 가 별도
   *  경로로 갱신하는 필드와 동일 컬럼이라 충돌 없음. */
  last_used_at?: string | null;
  promoted_asset_ids?: string[];
  variation_of?: string | null;
}

export interface UploadReferenceOptions {
  title?: string;
  tags?: string[];
  notes?: string;
  originProjectId?: string;
  sourceUrl?: string;
  /** Library UI 의 Favorites quick filter 에서 업로드한 경우 true. 새로
   *  생성되는 reference 가 처음부터 별표(★) 상태가 되도록 createReference
   *  의 is_favorite 인자에 그대로 thread. */
  isFavorite?: boolean;
  /** AI 베리에이션 결과를 업로드할 때, 원본 reference id 를 그대로 박아
   *  variation_of 컬럼에 기록한다. createVariation 전용. */
  variationOf?: string | null;
  /** 생성물의 출처(provenance) 등 자유 JSON 메타. 캔버스 생성 노드가
   *  `{ generation: GenerationProvenance }` 를 기록할 때 사용한다.
   *  createReference 의 ai_suggestions 컬럼으로 그대로 thread 된다. */
  aiSuggestions?: Record<string, unknown> | null;
}

type ReferenceRow = Omit<
  ReferenceItem,
  "tags" | "timestamp_notes" | "color_palette" | "is_favorite" | "promoted_asset_ids"
> & {
  tags?: string[] | string | null;
  timestamp_notes?: TimestampNote[] | string | null;
  color_palette?: ColorSwatch[] | string | null;
  is_favorite?: boolean | number | null;
  promoted_asset_ids?: string[] | string | null;
};

type SavedFilterRow = Omit<SavedFilter, "query"> & {
  query?: Record<string, unknown> | string | null;
};

/** local-server 가 fallback 포트로 떠있던 이전 세션에서 저장된 URL이
 *  `http://127.0.0.1:<old-port>/storage/file/...` 형태로 박혀 있을 수 있다.
 *  새로 부팅된 세션의 base URL 이 다르면 `<img src>` / fetch 가 깨지므로,
 *  read 시점에 현재 base URL 로 재조립한다. parse 실패 (외부 URL · YouTube
 *  thumbnail · data: 등) 는 원본 그대로 통과. */
function rewriteStorageUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  const parsed = parseStorageUrl(url);
  if (!parsed) return url;
  const encodedPath = parsed.filePath.split("/").map(encodeURIComponent).join("/");
  return `${LOCAL_SERVER_BASE_URL}/storage/file/${encodeURIComponent(parsed.bucket)}/${encodedPath}`;
}

function fileExtensionFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const pathname = new URL(url).pathname;
    return pathname.match(/\.[^./?#]+$/)?.[0]?.toLowerCase() ?? "";
  } catch {
    return url.split(/[?#]/, 1)[0].match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  }
}

function normalizeReferenceKind(row: ReferenceRow, fileUrl: string | null | undefined): ReferenceKind {
  const kind = row.kind as ReferenceKind;
  if (kind !== "image") return kind;
  const mime = row.mime_type?.toLowerCase() ?? "";
  const ext = fileExtensionFromUrl(fileUrl);
  if (mime === "image/gif" || ext === ".gif") return "gif";
  if (mime === "image/webp" || ext === ".webp") return "webp";
  return "image";
}

/** DB 에서 읽어온 timestamp_notes 의 id 가 누락되어 있거나 같은 자료 안에서
 *  id 가 중복되는 경우를 정리한다. (과거 mergeReferences/duplicateReference 가
 *  id 를 verbatim 으로 옮긴 시기에 생긴 데이터의 safety-net.) Inspector 의 React
 *  key 충돌이 생기면 한 행 클릭/수정/삭제가 다른 행으로 전파되는 증상으로 직결. */
function normalizeTimestampNoteIds(notes: TimestampNote[]): TimestampNote[] {
  if (notes.length === 0) return notes;
  const used = new Set<string>();
  let mutated = false;
  const out = notes.map((note) => {
    let id = typeof note.id === "string" && note.id.length > 0 ? note.id : "";
    if (!id || used.has(id)) {
      id = makeId();
      mutated = true;
    }
    used.add(id);
    return id === note.id ? note : { ...note, id };
  });
  return mutated ? out : notes;
}

function normalizeReference(row: ReferenceRow): ReferenceItem {
  const fileUrl = rewriteStorageUrl(row.file_url);
  const thumbnailUrl = rewriteStorageUrl(row.thumbnail_url);
  return {
    ...row,
    kind: normalizeReferenceKind(row, fileUrl),
    file_url: fileUrl,
    thumbnail_url: thumbnailUrl,
    preview_url: rewriteStorageUrl(row.preview_url),
    tags: parseArray<string>(row.tags),
    timestamp_notes: normalizeTimestampNoteIds(parseArray<TimestampNote>(row.timestamp_notes)),
    color_palette: parseArray<ColorSwatch>(row.color_palette),
    is_favorite: Boolean(row.is_favorite),
    promoted_asset_ids: parseArray<string>(row.promoted_asset_ids),
  };
}

function parseArray<T>(value: T[] | string | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseRecord(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function makeId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "reference";
}

function fileExtension(file: File): string {
  const fromName = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (fromName) return fromName;
  if (file.type === "image/png") return ".png";
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/webp") return ".webp";
  if (file.type === "image/gif") return ".gif";
  if (file.type === "video/mp4") return ".mp4";
  if (file.type === "video/webm") return ".webm";
  if (file.type === "video/quicktime") return ".mov";
  return "";
}

/* 라이브러리는 사용자가 *보관* 만 하는 자료 컬렉션이며, Preflow 자체는 어떤
   파일도 자동 실행하지 않는다(원본은 storage 에 그대로 저장되고, 외부로 끌어
   냈을 때만 OS 가 처리). 사용자가 mock 에서 EXE 까지 포함해 "모든 종류의
   파일을 보관하고 싶다" 고 명시했으므로 deny-list 는 비워 둔다.
   - 함수 시그니처는 유지 — 앞으로 정책이 바뀌어 다시 막아야 할 종류가 생기면
     이 Set 에 한 줄 추가하기만 하면 detect/upload 양쪽 가드가 즉시 적용된다.
   - 호출부는 항상 false 폴백으로 동작 — 보안 정책의 단일 진입점을 남겨 둠. */
const REFERENCE_BLOCKED_EXTENSIONS = new Set<string>([]);

export function isBlockedReferenceExtension(file: File | string): boolean {
  if (REFERENCE_BLOCKED_EXTENSIONS.size === 0) return false;
  const ext = typeof file === "string"
    ? (file.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "")
    : fileExtension(file);
  return ext.length > 0 && REFERENCE_BLOCKED_EXTENSIONS.has(ext);
}

/**
 * MIME / 확장자 → DocSubtype.
 *
 * detectReferenceKind 가 `kind: "doc"` 으로 떨어뜨린 자료에 대해 표시 레이어
 * (카드 배지/아이콘/색상) 와 필터(Types > Document > PDF/Font/...) 가 쓸
 * 정규화된 라벨을 만든다. 매칭 실패 시 "other" — generic 카드로 폴백.
 *
 * EN/KO 표시명은 i18n 키(`library.docSubtype.<id>`) 로 따로 들고 있다.
 */
export function detectDocSubtype(mime: string | null | undefined, name?: string | null): DocSubtype {
  const m = (mime ?? "").toLowerCase();
  const ext = (name ?? "").match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";

  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m === "image/vnd.adobe.photoshop" || m === "application/x-photoshop" || [".psd", ".psb"].includes(ext)) return "psd";
  if (m.startsWith("font/") || [".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "font";
  if (
    m === "application/zip"
    // Windows/일부 브라우저는 .zip 을 application/x-zip-compressed 로 보고한다.
    || m === "application/x-zip-compressed"
    || m === "application/x-7z-compressed"
    || m === "application/x-rar-compressed"
    || m === "application/vnd.rar"
    || m === "application/x-tar"
    || m === "application/gzip"
    || [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"].includes(ext)
  ) return "archive";
  if (
    m.includes("spreadsheet")
    || m.includes("excel")
    || m === "text/csv"
    || [".xls", ".xlsx", ".xlsm", ".csv", ".numbers", ".ods"].includes(ext)
  ) return "spreadsheet";
  if (
    m.includes("presentation")
    || m.includes("powerpoint")
    || [".ppt", ".pptx", ".pptm", ".key", ".odp"].includes(ext)
  ) return "presentation";
  if (
    m.includes("msword")
    || m.includes("officedocument.wordprocessingml")
    || m === "application/rtf"
    || [".doc", ".docx", ".docm", ".rtf", ".odt", ".pages", ".txt", ".md"].includes(ext)
  ) return "document";
  if (
    [".exe", ".msi", ".dmg", ".pkg", ".app", ".apk", ".deb", ".rpm",
     ".bat", ".cmd", ".com", ".scr", ".ps1", ".sh", ".bash"].includes(ext)
  ) return "executable";
  if (m === "text/html" || ext === ".html" || ext === ".htm") return "html";
  if (
    [".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt",
     ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".php", ".lua",
     ".json", ".yaml", ".yml", ".xml", ".toml", ".ini", ".sql"].includes(ext)
  ) return "code";
  if (m.startsWith("audio/") || [".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"].includes(ext)) return "audio";
  return "other";
}

export function detectReferenceKind(file: File): ReferenceKind {
  const ext = fileExtension(file);
  if (file.type === "image/gif" || ext === ".gif") return "gif";
  if (ext === ".apng") return "gif";
  if (file.type === "image/webp" || ext === ".webp") return "webp";
  /* PSD/PSB 는 브라우저 <img> 로 디코드 불가 — image 로 분류하면 깨진 카드가
     된다(일부 환경은 `.psd` 를 image/vnd.adobe.photoshop 으로 보고). doc 으로
     흡수해 업로드 파이프라인이 ag-psd 합성 썸네일을 생성하도록 한다. image/*
     체크보다 *먼저* 가로채야 한다. */
  if ([".psd", ".psb"].includes(ext)) return "doc";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/") || [".mp4", ".mov", ".webm"].includes(ext)) return "video";
  /* deny-list 에 걸리면 "doc" fallback 도 거부. 호출부의 try/catch 가 토스트
     로 사용자에게 이유를 알린다 ("실행 파일은 라이브러리에 보관할 수 없습
     니다" 류). */
  if (isBlockedReferenceExtension(file)) {
    throw new Error(`Blocked file type for security: ${ext || file.name}`);
  }
  /* 그 외 모든 파일은 doc 카테고리로 흡수 — generic 카드로 보존하고,
     일부(PDF/TTF 등) 는 업로드 파이프라인에서 진짜 썸네일을 더한다. */
  return "doc";
}

/**
 * Inspect file magic bytes to detect animated WebP / APNG. Some animated
 * raster images get classified as `kind: "image"` purely from extension
 * (.webp, .png), which then auto-animates when rendered as <img>. Calling
 * this lets the upload pipeline upgrade them to `kind: "gif"` so downstream
 * UI (Conti card, Studio Compare) can route them through the same
 * thumbnail-static + hover-animated treatment as videos.
 */
export async function detectAnimatedRasterKind(file: File): Promise<"gif" | null> {
  const ext = fileExtension(file);
  if (ext !== ".webp" && ext !== ".png") return null;
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  if (ext === ".webp") {
    if (head.length < 12) return null;
    // RIFF....WEBP
    if (head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46) return null;
    if (head[8] !== 0x57 || head[9] !== 0x45 || head[10] !== 0x42 || head[11] !== 0x50) return null;
    // ANIM chunk (extended WebP) signals an animated frame stream.
    for (let i = 12; i < head.length - 4; i++) {
      if (head[i] === 0x41 && head[i + 1] === 0x4e && head[i + 2] === 0x49 && head[i + 3] === 0x4d) return "gif";
    }
    return null;
  }
  // PNG signature
  if (head.length < 16) return null;
  if (head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null;
  // acTL chunk before IDAT signals APNG.
  for (let i = 8; i < head.length - 4; i++) {
    const c0 = head[i];
    const c1 = head[i + 1];
    const c2 = head[i + 2];
    const c3 = head[i + 3];
    if (c0 === 0x61 && c1 === 0x63 && c2 === 0x54 && c3 === 0x4c) return "gif"; // acTL
    if (c0 === 0x49 && c1 === 0x44 && c2 === 0x41 && c3 === 0x54) return null; // IDAT first → not animated
  }
  return null;
}

/**
 * Render the first frame of an image (gif / animated webp / apng / static)
 * to a PNG blob. Used to manufacture a static thumbnail so the Conti card
 * stays still until the user hovers it.
 */
async function extractStaticPosterFromImageFile(file: File): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to load image for poster extraction."));
      el.src = objectUrl;
    });
    const w = img.naturalWidth || img.width || 1280;
    const h = img.naturalHeight || img.height || 720;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return await canvasToBlob(canvas, "image/png");
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Generate a downscaled webp thumbnail for an image / webp reference.
 *
 * 라이브러리 카드는 200~400px 폭으로 렌더되는데 원본 4K/8K JPEG 를 그대로
 * 디코드하면 한 장 당 메인스레드 150~600ms 가 묻혀 *카드 첫 페인트가 freeze* 된다.
 * `LibraryCanvas` 의 `wantHighRes` 로직은 카드가 `HIGH_RES_THRESHOLD_PX (=480)` 이상
 * 으로 줌인됐을 때만 원본을 overlay 로 페이드인하도록 이미 잡혀 있어서, 평상시엔
 * 작은 webp 썸네일만으로 충분하다.
 *
 * 동작:
 *  - `maxEdge` 보다 작거나 같은 이미지는 *원본 그대로 사용* (null 반환) — 한 번 더
 *    decode + encode 하는 비용이 이득보다 큼.
 *  - 다운스케일 결과의 짧은 edge 가 `maxEdge` 가 되도록 비율을 보존(=정사각/세로
 *    이미지에서도 카드 픽셀화 없는 해상도 보장).
 *  - 결과 webp 가 원본의 50% 이상이라면 이득이 미미하므로 null 반환(폴백 = 원본).
 *  - 디코드/인코드 실패는 전부 null 반환 (호출자가 try/catch 로 묶고 원본을
 *    그대로 thumbnail_url 로 쓰도록 폴백).
 *
 * webp 품질 0.82 는 8K JPEG → ~150-300 KB 정도에서 거의 무손실로 보이는 sweet spot.
 */
async function createDownscaledImageWebp(
  file: File,
  maxEdge = 1024,
  quality = 0.82,
): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to load image for thumbnail downscale."));
      el.src = objectUrl;
    });
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    // 이미 충분히 작은 이미지는 다운스케일이 이득 없음 — 원본 사용 (null 반환).
    if (Math.max(w0, h0) <= maxEdge) return null;
    const scale = maxEdge / Math.max(w0, h0);
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 다운스케일링 품질 — Chromium 의 기본 imageSmoothing 은 bilinear 와 비슷한
    // 수준이라 "high" 로 명시해 카드의 가는 선 / 텍스처 모아레를 줄인다.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, "image/webp", quality);
    // 인코드 결과가 원본의 절반 이상이면 굳이 별도 썸네일을 두지 않는다 — 디스크/
    // 메타데이터 부담만 늘고 디코드 이득은 작다(이미 충분히 작은 원본일 가능성).
    if (blob.size >= file.size * 0.5) return null;
    return blob;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Quickly read an image file's natural pixel dimensions without rendering to a
 * canvas. Used at upload time so the new reference row carries `width/height`
 * from day one — which the Shape filter (`aspectBuckets`) needs to bucket
 * items by orientation/ratio. Returns null on any decode failure, so the
 * upload still proceeds with width/height left null (item lands in "Custom"
 * until a later lazy backfill measures it from the grid).
 */
async function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to load image for dimension probe."));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function sha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function blobToBase64(blob: Blob): Promise<{ base64: string; mediaType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
  const [meta, base64 = ""] = dataUrl.split(",");
  const mediaType = meta.match(/^data:(.*?);base64$/)?.[1] || blob.type || "application/octet-stream";
  return { base64, mediaType };
}

export async function urlToBase64(url: string): Promise<{ base64: string; mediaType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read reference media: HTTP ${res.status}`);
  return blobToBase64(await res.blob());
}

/** Claude/OpenAI Vision API 가 직접 받아들이는 이미지 MIME. AVIF/HEIC 등은 미지원
 *  이라 그대로 보내면 거부된다. */
const VISION_SAFE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Vision API 호환 base64. 미지원 포맷(AVIF 등)이거나 Content-Type 이
 *  application/octet-stream 으로 떨어진 경우 <img>+canvas 로 PNG 재인코드한다
 *  (Chromium 이 AVIF 를 디코드). DOM 미가용이거나 디코드 실패 시 원본 그대로
 *  best-effort 반환. */
/** base64 의 첫 바이트(매직 넘버)로 실제 이미지 MIME 을 판별한다.
 *  파일 확장자/HTTP Content-Type 은 거짓말할 수 있다 — 예: Pinterest og:image
 *  는 JPEG 인데 우리가 `poster.png` 로 저장하면 로컬 서버가 image/png 로 서빙해
 *  blobToBase64 가 image/png 로 라벨한다. 이걸 그대로 Claude 에 보내면
 *  "media_type 과 실제 바이트가 다르다"며 400 을 던진다. 판별 불가 시 null. */
function sniffImageMimeFromBase64(b64: string): string | null {
  if (b64.startsWith("/9j/")) return "image/jpeg"; // FF D8 FF
  if (b64.startsWith("iVBORw0KGgo")) return "image/png"; // 89 50 4E 47 0D 0A 1A 0A
  if (b64.startsWith("R0lGOD")) return "image/gif"; // "GIF8"
  if (b64.startsWith("UklGR")) return "image/webp"; // "RIFF" (이미지 컨텍스트에선 WebP)
  return null;
}

export async function urlToVisionBase64(url: string, maxEdge = 1024): Promise<{ base64: string; mediaType: string }> {
  const raw = await urlToBase64(url);
  // 선언된 mediaType 이 아니라 실제 바이트로 MIME 을 확정한다(라벨 불일치 방지).
  const realMime = sniffImageMimeFromBase64(raw.base64) ?? raw.mediaType;
  if (typeof document === "undefined") return { base64: raw.base64, mediaType: realMime };
  const safe = VISION_SAFE_MEDIA_TYPES.has(realMime.toLowerCase());
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      // 데이터 URL 의 선언 MIME 과 무관하게 Chromium 디코더가 바이트를 sniff 한다.
      el.src = `data:${realMime};base64,${raw.base64}`;
    });
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return { base64: raw.base64, mediaType: realMime };
    const needsDownscale = Math.max(w0, h0) > maxEdge;
    // 이미 호환 포맷 + 충분히 작으면 그대로(불필요한 재인코딩 회피).
    // 단 mediaType 은 sniff 로 확정한 realMime 을 쓴다(라벨 불일치 → Claude 400 방지).
    if (safe && !needsDownscale) return { base64: raw.base64, mediaType: realMime };
    // 큰 이미지(또는 미지원 포맷)는 maxEdge 로 다운스케일 + webp 재인코딩.
    // 비전 API 가 큰 원본을 받으면 처리가 느려져(승격 분석이 멈춘 것처럼 보임)
    // 클라이언트에서 미리 줄여 보낸다. Claude/OpenAI 모두 webp 수용.
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { base64: raw.base64, mediaType: realMime };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/webp", 0.85);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return { base64: raw.base64, mediaType: realMime };
    return { base64: dataUrl.slice(comma + 1), mediaType: "image/webp" };
  } catch {
    return { base64: raw.base64, mediaType: realMime };
  }
}

function storagePath(id: string, fileName: string): string {
  const yyyyMm = new Date().toISOString().slice(0, 7);
  return `${yyyyMm}/${id}/${sanitizeFileName(fileName)}`;
}

async function uploadToReferences(path: string, data: File | Blob): Promise<string> {
  const { error } = await supabase.storage.from(REFERENCES_BUCKET).upload(path, data, {
    contentType: data.type || undefined,
    upsert: true,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from(REFERENCES_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("Failed to capture frame.");
  return blob;
}

function drawVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create frame canvas.");
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

function requireSuccess<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Expected data but received null");
  return data;
}

async function localShellPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
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

function getStoredTranscript(item: ReferenceItem): string | undefined {
  const transcript = item.ai_suggestions?.transcript;
  return typeof transcript === "string" && transcript.trim() ? transcript : undefined;
}

export async function listReferences(options: ReferenceListOptions = {}): Promise<ReferenceItem[]> {
  const { data, error } = await supabase
    .from("reference_items")
    .select("*")
    .order(options.sortBy ?? "created_at", { ascending: options.ascending ?? false })
    .limit(options.limit ?? 500);
  const rows = requireSuccess<ReferenceRow[]>(data as ReferenceRow[] | null, error);
  let items = rows.map(normalizeReference);

  // Trash 필터: 기본은 활성(=deleted_at NULL) 행만. trashedOnly 면 반대로.
  // 명시적으로 includeTrashed:true 로 옵트인하지 않는 한 다른 모든 호출자는
  // 자동으로 trash 가 빠진 결과를 받는다 — 매 호출부에서 client-side filter
  // 하다가 빠뜨리는 사고를 막기 위함.
  if (options.trashedOnly) {
    items = items.filter((item) => Boolean(item.deleted_at));
  } else if (!options.includeTrashed) {
    items = items.filter((item) => !item.deleted_at);
  }

  if (options.kind) items = items.filter((item) => item.kind === options.kind);
  if (options.tag) items = items.filter((item) => item.tags.includes(options.tag!));
  if (options.query?.trim()) {
    const q = options.query.trim().toLowerCase();
    items = items.filter((item) => {
      const haystack = [
        item.title,
        item.notes,
        item.source_url,
        ...item.tags,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }
  if (!options.sortBy) {
    items = [...items].sort((a, b) => {
      const pinA = a.pinned_at ? 1 : 0;
      const pinB = b.pinned_at ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
    });
  }
  return items;
}

export async function listSavedFilters(): Promise<SavedFilter[]> {
  const { data, error } = await supabase
    .from("saved_filters")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = requireSuccess<SavedFilterRow[]>(data as SavedFilterRow[] | null, error);
  return rows.map((row) => ({
    ...row,
    query: parseRecord(row.query),
  }));
}

export async function getReference(id: string): Promise<ReferenceItem | null> {
  const { data, error } = await supabase
    .from("reference_items")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeReference(data as ReferenceRow) : null;
}

export async function listReferencesByIds(ids: string[]): Promise<ReferenceItem[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const { data, error } = await supabase
    .from("reference_items")
    .select("*")
    .in("id", uniqueIds);
  const rows = requireSuccess<ReferenceRow[]>(data as ReferenceRow[] | null, error);
  const byId = new Map(rows.map((row) => [row.id, normalizeReference(row)]));
  return uniqueIds.map((id) => byId.get(id)).filter((item): item is ReferenceItem => Boolean(item));
}

export function getReferencePreviewImageUrl(item: ReferenceItem): string | null {
  // For animated raster references (gif / animated webp / apng) prefer the
  // extracted static poster so callers can render a still preview and keep
  // the moving original for hover-only playback. Falls back to the original
  // file when no poster is available (legacy uploads).
  if (item.kind === "gif") return item.thumbnail_url || item.file_url || null;
  // 일반 이미지/정적 webp 도 카드용 다운스케일 thumbnail 을 *우선* 사용한다.
  // ingest 가 `thumbnail.webp` 를 생성해 두면 카드 첫 디코드 비용이 원본 대비
  // ~20~50배 줄어든다. thumbnail 이 없는 레거시 업로드(=D-2 백필 대상)는
  // file_url 로 자연 폴백.
  if (item.kind === "image" || item.kind === "webp") return item.thumbnail_url || item.file_url || null;
  if (item.kind === "video" || item.kind === "youtube") return item.thumbnail_url || null;
  return null;
}

/** "이미지로 검색"(역검색) 에 올릴 소스 이미지 URL. 썸네일을 우선 사용하므로
 *  link(URL)·youtube·video·gif·image·webp 모두 지원한다(전부 시각 썸네일 보유
 *  가능). 문서(doc)는 의도적으로 제외한다. 썸네일도 raster 원본도 없는 항목은
 *  null → 검색 비활성. getReferencePreviewImageUrl 과 달리 link/doc 정책이
 *  달라 별도 함수로 둔다. */
export function getImageSearchSourceUrl(item: ReferenceItem): string | null {
  if (item.kind === "doc") return null;
  if (item.thumbnail_url) return item.thumbnail_url;
  if ((item.kind === "image" || item.kind === "webp" || item.kind === "gif") && item.file_url) {
    return item.file_url;
  }
  return null;
}

/** Set Cover / Regenerate Thumbnail 같은 액션은 storage 의 *같은* 파일명
 *  (cover.png / poster.png) 에 upsert 하므로 thumbnail_url 문자열이 바뀌지
 *  않는다. <img> 는 같은 src 면 디스크/메모리 캐시를 재사용해 새 프레임이
 *  화면에 반영되지 않는다(특히 우측 인스펙터 상단 미리보기 / 그리드 카드).
 *
 *  updated_at 을 cache-bust query 로 붙여 *DB 가 바뀐 시점* 을 한 번 더
 *  fetch 하게 만든다. updated_at 은 rating/tag 같은 텍스트 변경에서도 갱신
 *  되어 1장의 썸네일 추가 fetch 가 발생하지만(보통 수십 KB), Eagle 식
 *  실시간 미리보기 업데이트 가치를 고려하면 합리적 trade-off.
 *
 *  url 이 비어있거나 updated_at 이 없으면 원본 그대로(외부 호스트 URL /
 *  data: / blob: 도 안전하게 통과). */
/* updated_at 기반 캐시 버스터를 URL 끝에 붙이는 헬퍼.
 *
 * 적용 범위 — *우리 storage 경로* 만:
 *   poster.png / cover.png 처럼 고정 파일명에 upsert 되는 자료는 파일은
 *   바뀌었는데 URL 이 그대로라 브라우저 캐시가 옛 비트맵을 그대로 보여주는
 *   문제가 있다. updated_at 기반 ?v= 로 강제 새로 받게 한다.
 *
 * 외부 URL(예: https://i.ytimg.com/vi/<ID>/hqdefault.jpg, og:image CDN)은
 * 호스트별로 쿼리 파라미터 정책이 다르고 — 특히 i.ytimg.com 은 알 수 없는
 * 쿼리 파라미터를 붙이면 **404** 를 반환한다. 그래서 그리드의 외부 썸네일
 * 이 통째로 안 뜨던 회귀가 있었음. 외부 URL 은 우리가 컨텐츠를 바꿀 수도
 * 없고 캐시 무효화도 필요 없으므로 *원본 URL 그대로* 반환한다.
 */
export function withReferenceVersion(
  url: string | null | undefined,
  item: { updated_at?: string | null } | null | undefined,
): string {
  if (!url) return "";
  const updatedAt = item?.updated_at;
  if (!updatedAt) return url;
  /* 우리 storage URL 인지 빠르게 판별 — rewriteStorageUrl 의 입력 패턴과 같음. */
  const isOwnStorage = url.startsWith(LOCAL_SERVER_BASE_URL)
    || /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\//i.test(url)
    || url.startsWith("local-file://");
  if (!isOwnStorage) return url;
  const v = Date.parse(updatedAt);
  if (!Number.isFinite(v)) return url;
  return url.includes("?") ? `${url}&v=${v}` : `${url}?v=${v}`;
}

export async function createReference(input: CreateReferenceInput): Promise<ReferenceItem> {
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? makeId(),
    title: input.title.trim() || "Untitled Reference",
    kind: input.kind,
    file_url: input.file_url ?? null,
    thumbnail_url: input.thumbnail_url ?? null,
    preview_url: input.preview_url ?? null,
    mime_type: input.mime_type ?? null,
    file_size: input.file_size ?? null,
    content_hash: input.content_hash ?? null,
    duration_sec: input.duration_sec ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    tags: input.tags ?? [],
    notes: input.notes ?? null,
    rating: input.rating ?? null,
    is_favorite: input.is_favorite ?? false,
    source_url: input.source_url ?? null,
    cover_at_sec: input.cover_at_sec ?? null,
    timestamp_notes: input.timestamp_notes ?? [],
    color_palette: input.color_palette ?? [],
    ai_suggestions: input.ai_suggestions ?? null,
    classification_status: input.classification_status ?? "unclassified",
    classified_at: input.classified_at ?? null,
    origin_project_id: input.origin_project_id ?? null,
    source_app: input.source_app ?? null,
    source_library: input.source_library ?? null,
    source_id: input.source_id ?? null,
    imported_at: input.imported_at ?? null,
    pinned_at: input.pinned_at ?? null,
    deleted_at: input.deleted_at ?? null,
    variation_of: input.variation_of ?? null,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase.from("reference_items").insert(row).select().single();
  const created = normalizeReference(requireSuccess<ReferenceRow>(data as ReferenceRow | null, error));
  // 신규 생성 직후, 호출자가 미리 color_palette 를 채워 주지 않았다면
  // thumbnail 기준으로 백그라운드 추출. UI 는 카드를 즉시 렌더하고
  // 색팔레트는 결과가 도착하면 PALETTE_UPDATED_EVENT 로 합류한다.
  if (created.thumbnail_url && created.color_palette.length === 0) {
    schedulePaletteExtractFromThumbnail(created.id, created.thumbnail_url);
  }
  return created;
}

export async function updateReference(
  id: string,
  patch: Partial<CreateReferenceInput>,
  opts: { touch?: boolean } = {},
): Promise<ReferenceItem> {
  /* touch=false 는 *메타데이터 전용* 변경(별점 등)에서 updated_at 을 일부러
     건드리지 않기 위한 옵션이다. withReferenceVersion 의 `?v=updated_at` 캐시
     버스터가 updated_at 변화에 묶여 있어, 별점만 바꿔도 썸네일 URL 이 바뀌어
     이미지가 새로 로드(=깜빡임)되고 GIF/animated-WebP 는 첫 프레임으로 리셋된다.
     별점은 이미지 바이트와 무관하므로 updated_at 을 보존해 src 를 안정화한다.
     (recent 정렬은 created_at, lastUsed 정렬은 last_used_at 을 쓰므로 영향 없음.) */
  const { touch = true } = opts;
  const fields = touch ? { ...patch, updated_at: new Date().toISOString() } : { ...patch };
  const { data, error } = await supabase
    .from("reference_items")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  const updated = normalizeReference(requireSuccess<ReferenceRow>(data as ReferenceRow | null, error));
  // patch 가 thumbnail_url 키를 *포함* 하면 (값 비교 없이 키 존재만 보고)
  // 색팔레트 재추출을 트리거. Save Frame as cover, Reset thumbnail,
  // YouTube refresh, 자동 poster 생성 모두 같은 경로로 들어온다.
  // 같은 patch 안에 color_palette 가 함께 들어 있으면(이 함수 자신이
  // 비동기 후속 호출로 부른 케이스 — recursive 안전 확인) 재추출은
  // 스킵 — 이미 결과가 들어 왔다는 뜻이라 무한 루프 위험이 없다.
  if (Object.prototype.hasOwnProperty.call(patch, "thumbnail_url") &&
      !Object.prototype.hasOwnProperty.call(patch, "color_palette")) {
    if (patch.thumbnail_url) {
      schedulePaletteExtractFromThumbnail(id, patch.thumbnail_url);
    } else {
      // null 셋 → 색팔레트도 즉시 클리어. DB 만 패치하고(비동기,
      // 결과 도착 전에 UI 가 갱신되도록) 이벤트도 함께 dispatch.
      void supabase
        .from("reference_items")
        .update({ color_palette: [] })
        .eq("id", id)
        .then(() => dispatchPaletteUpdated(id, []));
    }
  }
  return updated;
}

/** 큐에 enqueue 해 두고 결과가 오면 DB 를 직접 패치하는 fire-and-forget
 *  헬퍼. updateReference 를 다시 호출하지 않고 supabase 로 직접 쓰는
 *  이유는 (a) updated_at 이 다시 튀지 않게 하기 위해서(사용자 의도가
 *  아닌 백그라운드 보강) (b) updateReference 의 hook 에 다시 들어와
 *  recursion 분기 검사를 해야 하는 분기 비용을 줄이기 위해서다. */
function schedulePaletteExtractFromThumbnail(id: string, thumbnailUrl: string): void {
  enqueueExtractFromThumbnail(thumbnailUrl, async (palette) => {
    if (palette.length === 0) return;
    const { error } = await supabase
      .from("reference_items")
      .update({ color_palette: palette })
      .eq("id", id);
    if (error) {
      // 사용자 흐름엔 영향 없는 백그라운드 작업이라 console 만.
      console.warn("[colorPalette] DB save failed:", error.message);
      return;
    }
    dispatchPaletteUpdated(id, palette);
  });
}

/** Eagle 일괄 import 처럼 createReference / updateReference 를 거치지
 *  않고 서버사이드에서 직접 DB 에 들어온 항목들을 위한 backfill.
 *  대상: thumbnail_url 가 있고 color_palette 가 비어 있는 항목. 결과는
 *  schedulePaletteExtractFromThumbnail 와 동일하게 DB 패치 + 윈도우
 *  이벤트로 전파되어 LibraryPage 의 items 상태가 갱신된다.
 *
 *  호출 측은 그저 한 번 호출하면 끝 — 동시성 4 큐가 이미 colorPalette
 *  안에 있어 폭주 방지가 자동. */
export function backfillReferencePalettes(items: ReferenceItem[]): void {
  for (const item of items) {
    if (!item.thumbnail_url) continue;
    if (item.color_palette.length > 0) continue;
    schedulePaletteExtractFromThumbnail(item.id, item.thumbnail_url);
  }
}

export function normalizeFolderPath(path: string): string {
  return path
    .replace(/^folder:/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

export function folderTag(path: string): string {
  const normalized = normalizeFolderPath(path);
  if (!normalized) throw new Error("Folder name is required.");
  return `folder:${normalized}`;
}

export async function getReferencesForFolderTag(tagOrPath: string, opts: { recursive?: boolean } = {}): Promise<ReferenceItem[]> {
  const tag = tagOrPath.startsWith("folder:") ? tagOrPath : folderTag(tagOrPath);
  const rows = await listReferences({ limit: 10_000 });
  return rows.filter((item) => item.tags.some((candidate) => (
    opts.recursive
      ? candidate === tag || candidate.startsWith(`${tag}/`)
      : candidate === tag
  )));
}

export async function listFolderPaths(): Promise<string[]> {
  const rows = await listReferences({ limit: 10_000 });
  const paths = new Set<string>();
  for (const item of rows) {
    for (const tag of item.tags) {
      if (tag.startsWith("folder:")) paths.add(normalizeFolderPath(tag));
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function updateReferenceTags(id: string, makeTags: (item: ReferenceItem) => string[]): Promise<ReferenceItem> {
  const item = await getReference(id);
  if (!item) throw new Error("Reference not found.");
  return updateReference(id, { tags: makeTags(item) });
}

export async function addReferencesToFolder(referenceIds: string[], path: string): Promise<ReferenceItem[]> {
  const tag = folderTag(path);
  const ids = [...new Set(referenceIds.filter(Boolean))];
  const updated: ReferenceItem[] = [];
  for (const id of ids) {
    updated.push(await updateReferenceTags(id, (item) => [...new Set([...item.tags, tag])]));
  }
  return updated;
}

export async function removeReferencesFromFolder(referenceIds: string[], path: string): Promise<ReferenceItem[]> {
  const tag = folderTag(path);
  const ids = [...new Set(referenceIds.filter(Boolean))];
  const updated: ReferenceItem[] = [];
  for (const id of ids) {
    updated.push(await updateReferenceTags(id, (item) => item.tags.filter((candidate) => candidate !== tag)));
  }
  return updated;
}

export async function moveReferencesToFolder(referenceIds: string[], path: string): Promise<ReferenceItem[]> {
  const tag = folderTag(path);
  const ids = [...new Set(referenceIds.filter(Boolean))];
  const updated: ReferenceItem[] = [];
  for (const id of ids) {
    updated.push(await updateReferenceTags(id, (item) => [
      ...item.tags.filter((candidate) => !candidate.startsWith("folder:")),
      tag,
    ]));
  }
  return updated;
}

/* ─────────────────────────────────────────────────────────────────
 * Image thumbnail backfill — D-2.
 *
 * D-1 에서 ingest 파이프라인이 image/webp 자료에 다운스케일 thumbnail.webp 를
 * 생성하도록 바뀌었지만 *기존 자료* 는 여전히 `thumbnail_url === file_url`
 * 상태로 남아 카드 디코드가 느리다(원본 4K/8K 디코드).
 *
 * 본 함수는 라이브러리 전체를 한 번 훑어 백필 대상을 골라 같은 헬퍼
 * (`createDownscaledImageWebp`) 로 thumbnail.webp 를 생성 + 업로드하고
 * `thumbnail_url` 만 갱신한다. 원본 file_url 은 손대지 않는다 — 확대 시
 * `LibraryCanvas` 의 high-res overlay 가 그대로 동작.
 *
 * Storage path 는 ingest 와 동일하게 `storagePath(id, "thumbnail.webp")` 사용.
 * yyyyMm 폴더가 원본과 달라질 수 있지만 file_url / thumbnail_url 이 각각
 * 별도 컬럼이라 무관.
 * ───────────────────────────────────────────────────────────────── */

export interface ThumbnailBackfillProgress {
  done: number;
  total: number;
  success: number;
  failed: number;
  /** 인코드 이득이 미미해 원본 유지를 선택한 경우(헬퍼가 null 반환). */
  skipped: number;
}

/** 라이브러리 전체에서 D-2 백필 대상을 추려낸다.
 *
 *  대상 = `image` 또는 `webp` kind && `file_url` 보유 && `thumbnail_url`
 *  이 없거나 `file_url` 과 동일(=레거시 ingest 결과). */
export function selectThumbnailBackfillCandidates(items: ReferenceItem[]): ReferenceItem[] {
  return items.filter((item) => {
    if (item.kind !== "image" && item.kind !== "webp") return false;
    if (!item.file_url) return false;
    return !item.thumbnail_url || item.thumbnail_url === item.file_url;
  });
}

/** N-동시성 워커 풀. AbortSignal 로 mid-batch 취소 가능. 새 라이브러리에
 *  의존 추가 없이 referenceLibrary 안에서만 쓰는 작은 헬퍼.
 *
 *  cancellation 은 *현재 진행 중인 작업은 끝나기를 기다리고*, 다음 작업부터
 *  스케줄링하지 않는다 — fetch / canvas decode 중간을 강제로 끊으면 메모리
 *  누수가 더 위험. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: safeConcurrency }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** Per-item 결과 객체. `onItem` 콜백을 통해 호출자에게 전달되어, 자동
 *  백필 경로에서 LibraryPage 가 카드 thumbnail 을 in-place 로 교체하거나
 *  workspace-scoped processed-ID set 에 기록할 수 있게 한다. `thumbnailUrl`
 *  은 success 케이스에서만 새 URL, 그 외엔 null. */
export type ThumbnailBackfillItemResult = "success" | "skipped" | "failed";
export interface ThumbnailBackfillItemEvent {
  item: ReferenceItem;
  result: ThumbnailBackfillItemResult;
  thumbnailUrl: string | null;
}

async function backfillOneImageThumbnail(
  item: ReferenceItem,
): Promise<{ result: ThumbnailBackfillItemResult; thumbnailUrl: string | null }> {
  if (!item.file_url) return { result: "failed", thumbnailUrl: null };
  try {
    const res = await fetch(item.file_url);
    if (!res.ok) return { result: "failed", thumbnailUrl: null };
    const blob = await res.blob();
    const mime = item.mime_type || blob.type || "image/jpeg";
    // File 객체로 감싸야 `createDownscaledImageWebp` 가 `URL.createObjectURL`
    // + `<img>.src` 경로로 디코드 가능. 파일명은 헬퍼가 신경 쓰지 않음.
    const file = new File([blob], "source", { type: mime });
    const thumbBlob = await createDownscaledImageWebp(file, 1024, 0.82);
    if (!thumbBlob) {
      // 헬퍼가 null 을 돌렸다 = 이미 충분히 작거나 인코드 이득 부족.
      // thumbnail_url 을 그대로 두는 게 정답(원본을 thumbnail 로 재사용).
      return { result: "skipped", thumbnailUrl: null };
    }
    const thumbUrl = await uploadToReferences(storagePath(item.id, "thumbnail.webp"), thumbBlob);
    await updateReference(item.id, { thumbnail_url: thumbUrl });
    return { result: "success", thumbnailUrl: thumbUrl };
  } catch (err) {
    console.warn("[library] thumbnail backfill failed for", item.id, err);
    return { result: "failed", thumbnailUrl: null };
  }
}

/** 라이브러리 전체에 대해 image/webp 자료의 thumbnail 을 백필한다.
 *
 *  - `items` 가 안 들어오면 내부에서 `listReferences({ limit: 10_000 })` 호출.
 *  - 동시성 기본 3 — 데스크탑 Electron 환경에서 fetch + canvas decode 가
 *    너무 폭주하지 않게.
 *  - onProgress 는 *매 자료 끝날 때마다* 호출되어 다이얼로그 ProgressBar 가
 *    부드럽게 갱신된다.
 *  - AbortSignal 로 사용자 취소 지원 — 현재 진행중인 작업은 완료 후 정지.
 */
export async function backfillImageThumbnails(opts: {
  items?: ReferenceItem[];
  onProgress?: (p: ThumbnailBackfillProgress) => void;
  /** Per-item 후처리 hook. 자동 백필 경로(`thumbnailAutoBackfill`)는 이 hook
   *  으로 (1) LibraryPage items 상태를 in-place 갱신 (2) workspace-scoped
   *  processed-ID set 에 기록 — 두 가지를 동시에 처리한다. 다이얼로그 경로
   *  (D-2 manual) 는 사용하지 않아도 무방하다. */
  onItem?: (event: ThumbnailBackfillItemEvent) => void;
  signal?: AbortSignal;
  concurrency?: number;
} = {}): Promise<ThumbnailBackfillProgress> {
  const source = opts.items ?? await listReferences({ limit: 10_000 });
  const candidates = selectThumbnailBackfillCandidates(source);
  const total = candidates.length;
  const progress: ThumbnailBackfillProgress = { done: 0, total, success: 0, failed: 0, skipped: 0 };
  opts.onProgress?.({ ...progress });
  if (total === 0) return progress;

  await runWithConcurrency(
    candidates,
    opts.concurrency ?? 3,
    async (item) => {
      const { result, thumbnailUrl } = await backfillOneImageThumbnail(item);
      if (result === "success") progress.success += 1;
      else if (result === "skipped") progress.skipped += 1;
      else progress.failed += 1;
      progress.done += 1;
      opts.onProgress?.({ ...progress });
      opts.onItem?.({ item, result, thumbnailUrl });
    },
    opts.signal,
  );

  return progress;
}

/* ── Animated preview 백필 (GIF / animated-WebP) ──────────────────────
   정적 thumbnail 백필(위)이 image/webp 만 다루는 것과 짝을 이루는, GIF 전용
   경량 animated 프리뷰 백필. 신규 업로드는 uploadReferenceFile 에서 즉시
   생성하지만, (a) 기능 도입 이전에 등록된 레거시 GIF (b) main 프로세스가
   프리뷰를 굽지 않는 Eagle import GIF 는 여기서 idle 백필로 채운다. */

/** 백필 대상 = `gif` kind && `file_url` 보유 && `preview_url` 아직 없음. */
export function selectAnimatedPreviewBackfillCandidates(items: ReferenceItem[]): ReferenceItem[] {
  return items.filter((item) => {
    if (item.kind !== "gif") return false;
    if (!item.file_url) return false;
    return !item.preview_url;
  });
}

export type AnimatedPreviewBackfillItemResult = "success" | "skipped" | "failed";
export interface AnimatedPreviewBackfillItemEvent {
  item: ReferenceItem;
  result: AnimatedPreviewBackfillItemResult;
  previewUrl: string | null;
}

async function backfillOneAnimatedPreview(
  item: ReferenceItem,
): Promise<{ result: AnimatedPreviewBackfillItemResult; previewUrl: string | null }> {
  if (!item.file_url) return { result: "failed", previewUrl: null };
  try {
    // generateAnimatedPreviewBlob 가 내부적으로 file_url 을 fetch + 디코드.
    // 정적 단일 프레임 등 부적합 케이스는 null → skipped 로 표시(재시도 무의미).
    const previewBlob = await generateAnimatedPreviewBlob(item.file_url, item.mime_type);
    if (!previewBlob) return { result: "skipped", previewUrl: null };
    const previewUrl = await uploadToReferences(storagePath(item.id, "preview.webp"), previewBlob);
    await updateReference(item.id, { preview_url: previewUrl });
    return { result: "success", previewUrl };
  } catch (err) {
    console.warn("[library] animated preview backfill failed for", item.id, err);
    return { result: "failed", previewUrl: null };
  }
}

/** GIF animated 프리뷰를 라이브러리 전체에 백필한다.
 *
 *  - 동시성 기본 1 — 디코드+인코드가 무거워(프레임당 수십 ms × 수백) 카드
 *    스크롤/디코드와 메인스레드를 다투지 않게 한 항목씩 처리.
 *  - onItem 으로 LibraryPage 가 카드 preview_url 을 in-place 갱신 + processed
 *    set 기록(자동 백필 경로). */
export async function backfillAnimatedPreviews(opts: {
  items?: ReferenceItem[];
  onProgress?: (p: ThumbnailBackfillProgress) => void;
  onItem?: (event: AnimatedPreviewBackfillItemEvent) => void;
  signal?: AbortSignal;
  concurrency?: number;
} = {}): Promise<ThumbnailBackfillProgress> {
  const source = opts.items ?? await listReferences({ limit: 10_000 });
  const candidates = selectAnimatedPreviewBackfillCandidates(source);
  const total = candidates.length;
  const progress: ThumbnailBackfillProgress = { done: 0, total, success: 0, failed: 0, skipped: 0 };
  opts.onProgress?.({ ...progress });
  if (total === 0) return progress;

  await runWithConcurrency(
    candidates,
    opts.concurrency ?? 1,
    async (item) => {
      const { result, previewUrl } = await backfillOneAnimatedPreview(item);
      if (result === "success") progress.success += 1;
      else if (result === "skipped") progress.skipped += 1;
      else progress.failed += 1;
      progress.done += 1;
      opts.onProgress?.({ ...progress });
      opts.onItem?.({ item, result, previewUrl });
    },
    opts.signal,
  );

  return progress;
}

export async function renameFolder(oldPath: string, newPath: string): Promise<{ updated: number; items: ReferenceItem[] }> {
  const oldTag = folderTag(oldPath);
  const newTag = folderTag(newPath);
  if (oldTag === newTag) return { updated: 0, items: [] };
  const rows = await listReferences({ limit: 10_000, includeTrashed: true });
  const changed = rows.filter((item) => item.tags.some((tag) => tag === oldTag || tag.startsWith(`${oldTag}/`)));
  const items: ReferenceItem[] = [];
  for (const item of changed) {
    items.push(await updateReference(item.id, {
      tags: item.tags.map((tag) => {
        if (tag === oldTag) return newTag;
        if (tag.startsWith(`${oldTag}/`)) return `${newTag}/${tag.slice(oldTag.length + 1)}`;
        return tag;
      }),
    }));
  }
  return { updated: items.length, items };
}

/**
 * 폴더 복제 — Eagle 의 "Duplicate folder" 와 동일 의미.
 *
 * 옵션 C 정책 (LibrarySidebar 폴더 폴리시):
 *  - DB row 만 복제. 디스크의 실제 파일은 손대지 않는다 (file_url 동일,
 *    같은 파일을 가리키는 새 reference 행). 이 정책은 디스크 사용량 폭증을
 *    막고, 라이브러리 본질이 "참조 메타" 인 점과 일치한다.
 *  - 복제 폴더 이름은 같은 부모 아래 `${leaf} (Copy)` ~ `${leaf} (Copy N)`
 *    까지 충돌 회피. 폴더 path 충돌은 `listFolderPaths()` 로 사전 확인.
 *  - 자식 references 의 모든 `folder:${oldPath}` 또는 `folder:${oldPath}/...`
 *    태그를 일괄 새 prefix 로 치환. 다른 태그(brand 태그, 일반 태그) 는
 *    그대로 유지 — 의미가 다르므로 건드리지 않음.
 *  - 호출 측은 폴더 prefs 도 함께 카피하고 싶을 수 있으나 그건 호출자가
 *    `folderPreferences.cascadeRenameFolderPrefs` 와 유사한 형태로 별도
 *    처리한다 (의존 방향 유지 — referenceLibrary 는 prefs 모듈을 모름).
 */
export async function duplicateFolder(
  path: string,
): Promise<{ items: ReferenceItem[]; created: number; oldPath: string; newPath: string }> {
  const oldPath = normalizeFolderPath(path);
  if (!oldPath) throw new Error("Folder path is required.");
  const oldTag = folderTag(oldPath);

  // 같은 부모 아래에서 충돌 안 나는 새 leaf 이름 산출.
  const lastSlash = oldPath.lastIndexOf("/");
  const parentPath = lastSlash > 0 ? oldPath.slice(0, lastSlash) : "";
  const oldLeaf = lastSlash > 0 ? oldPath.slice(lastSlash + 1) : oldPath;
  const existingPaths = new Set(await listFolderPaths());
  const candidate = (suffix: string) =>
    parentPath ? `${parentPath}/${oldLeaf}${suffix}` : `${oldLeaf}${suffix}`;
  let newPath = candidate(" (Copy)");
  let n = 2;
  while (existingPaths.has(newPath)) {
    newPath = candidate(` (Copy ${n})`);
    n += 1;
    if (n > 999) throw new Error("Too many duplicates of this folder.");
  }
  const newTag = folderTag(newPath);

  // 원본 폴더 또는 그 자손에 속한 references 만 추출. trash 안 가져옴 —
  // 휴지통의 항목은 사용자가 의도적으로 빼둔 것이라 복제 대상에서 제외.
  const allRows = await listReferences({ limit: 10_000 });
  const sources = allRows.filter((item) =>
    item.tags.some((tag) => tag === oldTag || tag.startsWith(`${oldTag}/`)),
  );

  const items: ReferenceItem[] = [];
  for (const src of sources) {
    const newTags = src.tags.map((tag) => {
      if (tag === oldTag) return newTag;
      if (tag.startsWith(`${oldTag}/`)) return `${newTag}/${tag.slice(oldTag.length + 1)}`;
      return tag;
    });
    // createReference 가 새 id 를 자동 부여. 원본의 timestamp / sync 메타
    // (deleted_at, classified_at 등) 는 사본의 정체성과 무관하므로 reset.
    const created = await createReference({
      kind: src.kind,
      title: src.title,
      file_url: src.file_url ?? null,
      thumbnail_url: src.thumbnail_url ?? null,
      mime_type: src.mime_type ?? null,
      file_size: src.file_size ?? null,
      content_hash: src.content_hash ?? null,
      duration_sec: src.duration_sec ?? null,
      width: src.width ?? null,
      height: src.height ?? null,
      tags: newTags,
      notes: src.notes ?? null,
      rating: src.rating ?? null,
      is_favorite: src.is_favorite ?? false,
      source_url: src.source_url ?? null,
      cover_at_sec: src.cover_at_sec ?? null,
      timestamp_notes: src.timestamp_notes ?? [],
      color_palette: src.color_palette ?? [],
      ai_suggestions: src.ai_suggestions ?? null,
      classification_status:
        (src.classification_status as ClassificationStatus | undefined) ?? "unclassified",
      origin_project_id: src.origin_project_id ?? null,
      source_app: src.source_app ?? null,
      source_library: src.source_library ?? null,
      // source_id 는 외부 소스(Eagle 등) 에서의 dedupe 키라 사본은 비워둠.
      source_id: null,
      imported_at: src.imported_at ?? null,
    });
    items.push(created);
  }

  return { items, created: items.length, oldPath, newPath };
}

export async function deleteFolder(
  path: string,
  opts: { mode: "removeTagOnly" | "trashItems"; recursive?: boolean },
): Promise<{ affected: number; items: ReferenceItem[] }> {
  const tag = folderTag(path);
  const rows = await listReferences({ limit: 10_000, includeTrashed: true });
  const matches = rows.filter((item) => item.tags.some((candidate) => (
    opts.recursive
      ? candidate === tag || candidate.startsWith(`${tag}/`)
      : candidate === tag
  )));
  const items: ReferenceItem[] = [];
  for (const item of matches) {
    if (opts.mode === "trashItems") {
      items.push(await moveReferenceToTrash(item.id));
    } else {
      items.push(await updateReference(item.id, {
        tags: item.tags.filter((candidate) => (
          opts.recursive
            ? candidate !== tag && !candidate.startsWith(`${tag}/`)
            : candidate !== tag
        )),
      }));
    }
  }
  return { affected: items.length, items };
}

export async function toggleReferencePin(item: ReferenceItem): Promise<ReferenceItem> {
  return updateReference(item.id, {
    pinned_at: item.pinned_at ? null : new Date().toISOString(),
  });
}

export async function moveReferenceToTrash(id: string): Promise<ReferenceItem> {
  return updateReference(id, { deleted_at: new Date().toISOString() });
}

export async function restoreReference(id: string): Promise<ReferenceItem> {
  return updateReference(id, { deleted_at: null });
}

export async function resolveReferenceFilePath(item: ReferenceItem): Promise<string> {
  const url = item.file_url || item.thumbnail_url;
  if (!url) throw new Error("This reference has no local file.");
  const result = await localShellPost<{ filePath: string }>("/shell/resolve-path", { url });
  return result.filePath;
}

export async function openReferenceWithDefaultApp(item: ReferenceItem): Promise<void> {
  const url = item.file_url || item.thumbnail_url;
  if (!url) throw new Error("This reference has no local file.");
  await localShellPost<{ ok: true }>("/shell/open-path", { url });
}

export async function showReferenceInFolder(item: ReferenceItem): Promise<void> {
  const url = item.file_url || item.thumbnail_url;
  if (!url) throw new Error("This reference has no local file.");
  await localShellPost<{ ok: true }>("/shell/show-item", { url });
}

async function copyReferenceFileUrl(url: string | null | undefined, targetId: string, label: string): Promise<string | null> {
  if (!url) return null;
  const result = await localShellPost<{ publicUrl: string }>("/storage/copy-reference-file", { url, targetId, label });
  return result.publicUrl;
}

export async function duplicateReference(item: ReferenceItem): Promise<ReferenceItem> {
  const id = makeId();
  let fileUrl: string | null = null;
  let thumbnailUrl: string | null = null;
  let previewUrl: string | null = null;
  if (item.file_url) {
    fileUrl = await copyReferenceFileUrl(item.file_url, id, "original");
  }
  if (item.thumbnail_url) {
    thumbnailUrl = item.thumbnail_url === item.file_url
      ? fileUrl
      : await copyReferenceFileUrl(item.thumbnail_url, id, "thumbnail");
  }
  if (item.preview_url) {
    previewUrl = item.preview_url === item.file_url
      ? fileUrl
      : await copyReferenceFileUrl(item.preview_url, id, "preview");
  }
  return createReference({
    id,
    kind: item.kind,
    title: `${item.title} copy`,
    file_url: fileUrl,
    thumbnail_url: thumbnailUrl,
    preview_url: previewUrl,
    mime_type: item.mime_type,
    file_size: item.file_size,
    content_hash: item.content_hash,
    duration_sec: item.duration_sec,
    width: item.width,
    height: item.height,
    tags: item.tags,
    notes: item.notes,
    rating: item.rating,
    is_favorite: item.is_favorite,
    source_url: item.source_url,
    cover_at_sec: item.cover_at_sec,
    // 노트 id 는 *복사본별로* 새로 부여. 이렇게 안 하면 같은 자료를 여러 번
    // 복제 → 나중에 mergeReferences 로 모았을 때 한 키(id) 가 여러 행을 가리켜
    // Inspector 의 수정·삭제·점프 핸들러가 잘못된 행에 적용된다.
    timestamp_notes: item.timestamp_notes.map((note) => ({ ...note, id: makeId() })),
    color_palette: item.color_palette,
    ai_suggestions: item.ai_suggestions,
    classification_status: item.classification_status as ClassificationStatus,
    classified_at: item.classified_at,
    origin_project_id: item.origin_project_id,
    source_app: item.source_app ?? "preflow",
    source_library: item.source_library ?? "reference-library",
    source_id: item.source_id ?? item.id,
  });
}

/** AI 베리에이션 요청 파라미터. 프롬프트는 호출부(모달)에서 이미 조립된
 *  상태로 들어온다(빠른 변형=내장 템플릿 / 커스텀=사용자 입력). model·
 *  quality 는 Settings 디폴트(getImageModelDefault("variation") 등)에서
 *  읽어 넘긴다. referenceImageUrls 는 커스텀 변형에서 주입한 추가 참조(다중). */
export interface VariationRequest {
  prompt: string;
  /** "nano-banana-2" | "gpt-image-2" */
  model: string;
  /** GPT 계열에서만 의미. NB2 는 무시된다. */
  quality?: GptQuality;
  /** 커스텀 변형에서 주입한 참조 이미지 URL(다중, 선택). */
  referenceImageUrls?: string[];
  imageSize?: string;
}

/** 원본 reference 이미지를 소스로 AI 변형을 생성해 **새 레퍼런스**로 저장한다.
 *
 *  - 생성: openai-image 의 `mode: "variation"` 으로 base64 만 받아온다(핸들러는
 *    저장하지 않음 — 라이브러리 버킷 라우팅을 건드리지 않기 위해).
 *  - 저장: 받은 이미지를 uploadReferenceFile 로 references 버킷에 정상 업로드.
 *  - 메타: 원본의 `folder:` 태그만 승계하고 나머지(일반 태그·AI 분석·노트·별점)
 *    는 비운 "깨끗한" 상태로 들어온다. `variation_of` 에 원본 id 를 기록해
 *    뱃지/빠른 필터의 근거로 삼는다.
 *
 *  Phase 1 은 정지 이미지(image/webp)만 대상. video/gif 변형은 별도(Phase 2). */
export async function createVariation(source: ReferenceItem, req: VariationRequest): Promise<ReferenceItem> {
  if (!source.file_url) {
    throw new Error("원본 이미지가 없는 자료는 베리에이션할 수 없습니다.");
  }
  // 원본/참조를 생성 모델이 받아들이는 포맷으로 정규화한다. AVIF/HEIC 등은
  // OpenAI·NB2 가 "Invalid image file" 로 거부하므로, 렌더러(Chromium)에서
  // 디코드 가능한 포맷으로 재인코딩해 data URL 로 넘긴다(백엔드 downloadImage 가
  // data: 를 직접 해석). 이미 호환 포맷이면 urlToVisionBase64 가 원본을 그대로 둔다.
  const toModelSafeUrl = async (url: string): Promise<string> => {
    try {
      const { base64, mediaType } = await urlToVisionBase64(url, 1536);
      return `data:${mediaType};base64,${base64}`;
    } catch {
      return url; // best-effort — 변환 실패 시 원본 URL 그대로(백엔드가 직접 시도)
    }
  };
  const safeSource = await toModelSafeUrl(source.file_url);
  const safeRefs = await Promise.all((req.referenceImageUrls ?? []).map(toModelSafeUrl));
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      mode: "variation",
      sourceImageUrl: safeSource,
      referenceImageUrls: safeRefs,
      prompt: req.prompt,
      model: req.model,
      quality: req.quality,
      imageSize: req.imageSize,
    },
  });
  if (error) {
    throw new Error(typeof error === "string" ? error : (error as Error)?.message ?? "베리에이션 요청에 실패했습니다.");
  }
  const payload = (data ?? {}) as { imageBase64?: string; mime?: string; usedModel?: string; error?: string };
  if (payload.error) throw new Error(payload.error);
  if (!payload.imageBase64) throw new Error("베리에이션 결과 이미지가 비어 있습니다.");

  const mime = payload.mime ?? "image/png";
  const blob = await (await fetch(`data:${mime};base64,${payload.imageBase64}`)).blob();
  const ext = mime === "image/png" ? "png" : (mime.split("/")[1] ?? "png");
  const baseName = sanitizeFileName(source.title) || "reference";
  const file = new File([blob], `${baseName}-variation.${ext}`, { type: mime });

  // 깨끗한 상태 — 원본의 folder: 태그만 승계, 나머지 메타는 업로드 파이프라인의
  // 기본값(빈 태그·null AI·unclassified)에 맡긴다.
  const folderTags = source.tags.filter((tag) => tag.startsWith("folder:"));
  return uploadReferenceFile(file, {
    title: `${source.title} variation`,
    tags: folderTags,
    originProjectId: source.origin_project_id ?? undefined,
    variationOf: source.id,
  });
}

/** 캔버스 AI 생성 노드의 입력 한 개(라이브러리 이미지). */
export interface CanvasGenerationInput {
  /** 입력 레퍼런스 id — provenance(variation_of / inputs[]) 기록의 안정 키. */
  refId: string;
  /** 모델에 넘길 원본 이미지 URL. */
  fileUrl: string;
  /** 고스트/히스토리 미리보기용 썸네일(있으면). */
  thumbnailUrl?: string | null;
}

export interface CanvasGenerationRequest {
  /** 연결된 프롬프트 카드에서 조립된 최종 프롬프트. */
  prompt: string;
  /** "nano-banana-2" | "gpt-image-2" 등. getImageModelDefault("canvas") 에서. */
  model: string;
  /** GPT 계열에서만 의미. NB2 는 무시. */
  quality?: GptQuality;
  /** "1024x1536" | "1536x1024" | "1024x1024" 등. */
  imageSize?: string;
  /** 연결된 라이브러리 이미지 입력(최소 1개). 첫 번째가 대표 소스. */
  imageInputs: CanvasGenerationInput[];
  /** 프롬프트 카드(note role=prompt) id — provenance 기록용. */
  promptNoteId?: string;
  /** 실행한 캔버스 생성 노드(CanvasGenNode) id — provenance 기록용.
   *  캔버스가 결과를 노드 우측에 배치하고 gen→결과 저장연결을 거는 데 사용. */
  genNodeId?: string;
  /** 결과를 소속시킬 folder: 태그(현재 캔버스 폴더). */
  folderTags?: string[];
  /** 결과 제목 베이스(대표 입력 제목 등). */
  title?: string;
}

/** 캔버스 생성 노드 실행 — 연결된 라이브러리 이미지 + 프롬프트로 새 이미지를
 *  생성해 references 버킷에 적재하고, 출처(provenance)를 결과 아이템의
 *  `ai_suggestions.generation` 에 durable 하게 기록한다.
 *
 *  - 생성: createVariation 과 동일한 openai-image `mode:"variation"` base64 경로
 *    재사용(핸들러는 저장하지 않음). 대표 입력이 sourceImageUrl, 나머지가
 *    referenceImageUrls.
 *  - 출처: `variation_of` = 대표 입력 id (기존 "Variations" 필터/뱃지/파생 엣지와
 *    호환), `ai_suggestions.generation` = GenerationProvenance.
 *
 *  영상 출력은 Vertex API 부재로 보류 — 이 함수는 이미지 전용이며, 이미지 입력이
 *  하나도 없으면(프롬프트 전용) 명시적으로 거부한다(프로젝트 버킷 오염 방지). */
export async function generateCanvasImage(req: CanvasGenerationRequest): Promise<ReferenceItem> {
  if (req.imageInputs.length === 0) {
    throw new Error("이미지 입력을 1개 이상 연결하세요.");
  }
  if (!req.prompt.trim()) {
    throw new Error("프롬프트가 비어 있습니다. 프롬프트 카드를 연결하세요.");
  }
  const toModelSafeUrl = async (url: string): Promise<string> => {
    try {
      const { base64, mediaType } = await urlToVisionBase64(url, 1536);
      return `data:${mediaType};base64,${base64}`;
    } catch {
      return url; // best-effort — 변환 실패 시 원본 URL 그대로
    }
  };
  const [primary, ...rest] = req.imageInputs;
  const safeSource = await toModelSafeUrl(primary.fileUrl);
  const safeRefs = await Promise.all(rest.map((r) => toModelSafeUrl(r.fileUrl)));
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      mode: "variation",
      sourceImageUrl: safeSource,
      referenceImageUrls: safeRefs,
      prompt: req.prompt,
      model: req.model,
      quality: req.quality,
      imageSize: req.imageSize,
    },
  });
  if (error) {
    throw new Error(typeof error === "string" ? error : (error as Error)?.message ?? "생성 요청에 실패했습니다.");
  }
  const payload = (data ?? {}) as { imageBase64?: string; mime?: string; usedModel?: string; error?: string };
  if (payload.error) throw new Error(payload.error);
  if (!payload.imageBase64) throw new Error("생성 결과 이미지가 비어 있습니다.");

  const mime = payload.mime ?? "image/png";
  const blob = await (await fetch(`data:${mime};base64,${payload.imageBase64}`)).blob();
  const ext = mime === "image/png" ? "png" : (mime.split("/")[1] ?? "png");
  const baseName = sanitizeFileName(req.title ?? "") || "canvas";
  const file = new File([blob], `${baseName}-gen.${ext}`, { type: mime });

  const provenance: GenerationProvenance = {
    outputKind: "image",
    model: payload.usedModel ?? req.model,
    params: { imageSize: req.imageSize, quality: req.quality },
    prompt: req.prompt,
    promptNoteId: req.promptNoteId,
    genNodeId: req.genNodeId,
    inputs: req.imageInputs.map(
      (r): GenerationInput => ({ source: "library", refId: r.refId, thumbnailUrl: r.thumbnailUrl ?? undefined }),
    ),
    createdAt: new Date().toISOString(),
  };
  return uploadReferenceFile(file, {
    title: req.title ? `${req.title} generation` : "Canvas generation",
    tags: req.folderTags,
    variationOf: primary.refId,
    aiSuggestions: { generation: provenance },
  });
}

export async function setReferenceCoverFromVideo(item: ReferenceItem, video: HTMLVideoElement): Promise<ReferenceItem> {
  if (item.kind !== "video") throw new Error("Only video references can set a video frame as cover.");
  const canvas = drawVideoFrame(video);
  return setReferenceCoverFromCanvasInternal(item, canvas, Number.isFinite(video.currentTime) ? video.currentTime : null);
}

/** GIF/이미지/(영상) — 임의의 캔버스 프레임을 cover 로 등록. video 변형과
 *  동일한 정책(파일명 고정 cover.png, 직전 thumbnail 정리, width/height 갱신).
 *  `atSec` 인자가 주어지면 cover_at_sec 컬럼에도 기록(영상에서만 의미가 있고
 *  GIF/이미지에서는 null 로 두면 됨). */
export async function setReferenceCoverFromCanvas(
  item: ReferenceItem,
  canvas: HTMLCanvasElement,
  atSec: number | null = null,
): Promise<ReferenceItem> {
  return setReferenceCoverFromCanvasInternal(item, canvas, atSec);
}

/** 임의의 이미지 Blob/File 을 cover 로 등록 — Eagle 스타일 "Custom thumbnail"
 *  기능에 사용. 로컬 파일 선택, 클립보드 페이스트, 외부 드롭 등 모든 경로의
 *  이미지 입력을 단일 함수로 처리한다.
 *  PNG/JPEG/WebP/GIF 등 <img> 가 디코드할 수 있는 모든 포맷을 받아
 *  HTMLCanvasElement 로 표준화한 뒤 기존 cover 파이프라인(setReferenceCoverFromCanvas)
 *  을 재사용 — 파일명을 cover.png 로 고정해 storage 잔재가 쌓이지 않고,
 *  cache-bust 도 thumbnail_url 갱신 시점의 updated_at 으로 자연스럽게 동작한다. */
export async function setReferenceCoverFromBlob(
  item: ReferenceItem,
  blob: Blob,
): Promise<ReferenceItem> {
  if (!blob || blob.size === 0) {
    throw new Error("Empty image data.");
  }
  if (blob.type && !blob.type.startsWith("image/")) {
    throw new Error(`Unsupported file type: ${blob.type}. Use an image file.`);
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode image."));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) {
      throw new Error("Image has no dimensions.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas context.");
    ctx.drawImage(img, 0, 0);
    return setReferenceCoverFromCanvasInternal(item, canvas, null);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function setReferenceCoverFromCanvasInternal(
  item: ReferenceItem,
  canvas: HTMLCanvasElement,
  atSec: number | null,
): Promise<ReferenceItem> {
  const blob = await canvasToBlob(canvas, "image/png");
  // 파일명을 `cover.png` 로 고정 — `upsert: true` 가 같은 경로를 덮어써
  // 매번 cover_<ms>.png 가 누적되던 문제를 차단. 영상 currentTime 정보는
  // `cover_at_sec` 컬럼이 별도로 보유하므로 파일명에 인코딩할 필요 없음.
  // 직전 thumbnail_url 이 다른 파일을 가리키고 있었다면(예: 자동 생성된
  // poster.png 또는 이전 cover_xxx.png) 함께 정리해 디스크 잔재를 방지.
  await deletePriorThumbnailIfReplaceable(item, storagePath(item.id, "cover.png"));
  const thumbnailUrl = await uploadToReferences(storagePath(item.id, "cover.png"), blob);
  return updateReference(item.id, {
    thumbnail_url: thumbnailUrl,
    cover_at_sec: atSec !== null && Number.isFinite(atSec) ? atSec : null,
    width: canvas.width,
    height: canvas.height,
  });
}

export async function saveVideoFrameAsReference(item: ReferenceItem, video: HTMLVideoElement): Promise<ReferenceItem> {
  if (item.kind !== "video") throw new Error("Only video references can save frames.");
  const canvas = drawVideoFrame(video);
  const timestamp = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  return saveCanvasFrameAsReferenceInternal(item, canvas, timestamp, "video-frame");
}

/** GIF/이미지 — 임의의 캔버스 프레임을 *새 image reference* 로 저장. 영상의
 *  saveVideoFrameAsReference 와 동일한 정책이지만 source tag 가 자료 종류에
 *  따라 갈린다(GIF = `source:gif-frame`, video = `source:video-frame`).
 *  이미지에서 호출할 일은 거의 없지만 시그니처 호환을 위해 허용. */
export async function saveCanvasFrameAsReference(
  item: ReferenceItem,
  canvas: HTMLCanvasElement,
  atSec: number = 0,
): Promise<ReferenceItem> {
  const sourceTag = item.kind === "gif" ? "gif-frame" : item.kind === "video" ? "video-frame" : "frame";
  return saveCanvasFrameAsReferenceInternal(item, canvas, atSec, sourceTag);
}

async function saveCanvasFrameAsReferenceInternal(
  item: ReferenceItem,
  canvas: HTMLCanvasElement,
  atSec: number,
  sourceTag: string,
): Promise<ReferenceItem> {
  const blob = await canvasToBlob(canvas, "image/png");
  const frameId = makeId();
  const frameUrl = await uploadToReferences(storagePath(frameId, `${sanitizeFileName(item.title)}_frame.png`), blob);
  const timestamp = Number.isFinite(atSec) ? atSec : 0;
  // file_size / width / height 를 함께 저장해 인스펙터의 Properties 패널이
  // Unknown 으로 떨어지지 않게 한다. 일반 이미지 import 와 동일하게 blob 크기 +
  // 캔버스 해상도를 그대로 사용한다.
  return createReference({
    id: frameId,
    kind: "image",
    title: `${item.title} frame ${formatSeconds(timestamp)}`,
    file_url: frameUrl,
    thumbnail_url: frameUrl,
    mime_type: "image/png",
    file_size: blob.size,
    width: canvas.width,
    height: canvas.height,
    tags: [...new Set([...item.tags, "frame", `source:${sourceTag}`])],
    notes: item.notes,
    source_url: item.file_url ?? item.source_url ?? null,
    source_app: "preflow",
    source_library: "reference-library",
    source_id: item.id,
  });
}

/** 프리뷰 크롭 — 잘라낸 이미지를 *새 reference* 로 저장한다.
 *  원본의 tags(폴더 `folder:` 태그 포함)와 notes 를 상속해 같은 폴더에 들어가고,
 *  source_id 로 출처를 남긴다. 비파괴 — 원본은 그대로 둔다. */
export async function saveCroppedImageAsNewReference(
  item: ReferenceItem,
  blob: Blob,
  width: number,
  height: number,
): Promise<ReferenceItem> {
  const newId = makeId();
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
  const fileUrl = await uploadToReferences(
    storagePath(newId, `${sanitizeFileName(item.title)}_crop.${ext}`),
    blob,
  );
  return createReference({
    id: newId,
    kind: "image",
    title: `${item.title} (crop)`,
    file_url: fileUrl,
    thumbnail_url: fileUrl,
    mime_type: blob.type || "image/png",
    file_size: blob.size,
    width,
    height,
    tags: [...new Set([...item.tags, "crop"])],
    notes: item.notes,
    source_url: item.file_url ?? item.source_url ?? null,
    source_app: "preflow",
    source_library: "reference-library",
    source_id: item.id,
  });
}

/** 프리뷰 크롭 — 잘라낸 이미지를 *원본 reference 에 덮어쓴다*.
 *  새 storage 경로에 올리고 file_url/thumbnail_url/해상도/크기를 교체한다.
 *  URL 이 바뀌므로 그리드/프리뷰가 즉시 새 비트맵을 가져온다(캐시 문제 없음).
 *  이전 원본/썸네일 파일은 best-effort 로 정리해 orphan 을 막는다. 파괴적. */
export async function overwriteReferenceImage(
  item: ReferenceItem,
  blob: Blob,
  width: number,
  height: number,
): Promise<ReferenceItem> {
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
  const priorFileUrl = item.file_url;
  const priorThumb = item.thumbnail_url;
  const fileUrl = await uploadToReferences(
    storagePath(item.id, `crop-${Date.now()}.${ext}`),
    blob,
  );
  const updated = await updateReference(item.id, {
    file_url: fileUrl,
    thumbnail_url: fileUrl,
    mime_type: blob.type || "image/png",
    file_size: blob.size,
    width,
    height,
  });
  const toDelete = [...new Set([priorFileUrl, priorThumb])].filter(
    (u): u is string => Boolean(u) && u !== fileUrl,
  );
  if (toDelete.length > 0) {
    try {
      await deleteStoredFiles(toDelete);
    } catch {
      /* 정리 실패는 무시 — 데이터는 이미 새 파일로 교체 완료. */
    }
  }
  return updated;
}

function loadVideoElement(src: string, seekSec: number): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
    };
    video.onerror = () => {
      cleanup();
      reject(new Error("Failed to load video for thumbnail regeneration."));
    };
    video.onloadedmetadata = () => {
      const target = Math.max(0, Math.min(seekSec, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : seekSec));
      video.currentTime = target || 0.1;
    };
    video.onseeked = () => {
      cleanup();
      resolve(video);
    };
  });
}

export async function regenerateReferenceThumbnail(item: ReferenceItem): Promise<ReferenceItem> {
  if (item.kind === "image" || item.kind === "webp" || item.kind === "gif") {
    if (!item.file_url) throw new Error("This reference has no stored image file.");
    return updateReference(item.id, { thumbnail_url: item.file_url });
  }
  if (item.kind === "youtube") {
    if (!item.source_url) throw new Error("This YouTube reference has no source URL.");
    const ingested = await ingestYoutube(item.source_url).catch(() => null);
    const videoId = item.source_url?.match(YOUTUBE_URL_REGEX)?.[1];
    return updateReference(item.id, {
      thumbnail_url: ingested?.thumbnailUrl ?? (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : item.thumbnail_url ?? null),
      duration_sec: ingested?.durationSec ?? item.duration_sec ?? null,
      ai_suggestions: ingested?.transcript ? { ...(item.ai_suggestions ?? {}), transcript: ingested.transcript } : item.ai_suggestions ?? null,
    });
  }
  if (item.kind === "video") {
    if (!item.file_url) throw new Error("This video reference has no stored file.");
    const video = await loadVideoElement(item.file_url, item.cover_at_sec ?? 0.1);
    const canvas = drawVideoFrame(video);
    const blob = await canvasToBlob(canvas, "image/png");
    // 파일명을 `poster.png` 로 고정 — 업로드 시점의 자동 생성 poster.png 와
    // 동일한 경로라 `upsert: true` 가 자연스럽게 덮어씀. 직전 thumbnail_url
    // 이 cover.png 같은 다른 파일을 가리키고 있었다면 같이 정리.
    await deletePriorThumbnailIfReplaceable(item, storagePath(item.id, "poster.png"));
    const thumbnailUrl = await uploadToReferences(storagePath(item.id, "poster.png"), blob);
    return updateReference(item.id, {
      thumbnail_url: thumbnailUrl,
      width: canvas.width,
      height: canvas.height,
    });
  }
  if (item.kind === "link") {
    if (!item.source_url) throw new Error("This link reference has no source URL.");
    const preview = await fetchLinkPreview(item.source_url);
    if (!preview) throw new Error("Couldn't capture a preview for this link.");
    const uploaded = await uploadLinkPreviewPoster(item.id, preview).catch((e) => {
      throw new Error(`Failed to save link preview: ${(e as Error).message}`);
    });
    await deletePriorThumbnailIfReplaceable(item, storagePath(item.id, "poster.png"));
    return updateReference(item.id, {
      thumbnail_url: uploaded.thumbnailUrl,
      // 캡처 결과가 GIF/WebP 면 애니메이션 원본도 함께 갱신 — 기존엔 정지 이미지였다
      // 가 이번 Regenerate 로 동영상성 미리보기가 잡혔다면 file_url/mime_type 까지
      // 채워서 그리드 호버 애니메이션이 즉시 동작하게 한다.
      file_url: uploaded.fileUrl ?? item.file_url ?? null,
      mime_type: uploaded.mimeType ?? item.mime_type ?? null,
      width: uploaded.width ?? item.width,
      height: uploaded.height ?? item.height,
    });
  }
  throw new Error("Thumbnail regeneration is not available for this reference kind.");
}

/** 새 썸네일을 같은 폴더에 올리기 직전, 이전 thumbnail_url 이 가리키던
 *  파일을 안전하게 정리한다. 다음 두 케이스는 절대 지우지 않아야 한다:
 *    1. thumbnail_url 이 file_url 과 동일 (정적 이미지 reference 의 기본형)
 *    2. thumbnail_url 이 이번에 덮어쓸 새 경로와 같은 파일
 *       — upsert 로 자연 교체되므로 굳이 삭제 호출이 필요 없음.
 *  로컬 스토리지 외부 URL(YouTube hqdefault 등)은 parseStorageUrl 이 null 을
 *  반환해 deleteStoredFiles 가 자동 no-op 하므로 별도 가드 불필요. */
async function deletePriorThumbnailIfReplaceable(item: ReferenceItem, nextRelativePath: string): Promise<void> {
  const prior = item.thumbnail_url;
  if (!prior) return;
  if (prior === item.file_url) return;
  const parsed = parseStorageUrl(prior);
  if (!parsed) return;
  if (parsed.bucket === REFERENCES_BUCKET && parsed.filePath === nextRelativePath) return;
  await deleteStoredFiles([prior]);
}

/** 같은 시점·같은 영역·같은 본문의 노트를 하나로 보는 키. 부동소수 atSec 은
 *  소수점 2자리, region 좌표는 3자리에서 끊어 마이크로 차이는 동일 노트로 본다.
 *  비교 대상이 한 쪽만 anchor 가 있는 경우(예: 한쪽은 atSec, 한쪽은 frameIndex)
 *  는 다른 노트로 취급. */
function timestampNoteDedupKey(note: TimestampNote): string {
  const at = Number.isFinite(note.atSec) ? (note.atSec as number).toFixed(2) : "_";
  const fi = Number.isFinite(note.frameIndex) ? String(note.frameIndex) : "_";
  const text = (note.text ?? "").trim();
  const region = note.region
    ? `${note.region.x.toFixed(3)},${note.region.y.toFixed(3)},${note.region.w.toFixed(3)},${note.region.h.toFixed(3)}`
    : "_";
  return `${at}|${fi}|${text}|${region}`;
}

/** 노트 배열에서 (a) 동일 시점·동일 본문 중복 제거, (b) 충돌하는 id 재발급.
 *  duplicateReference 가 timestamp_notes 를 verbatim 으로 복사하기 때문에
 *  복제본 두 개 이상을 keep 으로 병합하면 같은 id 의 노트가 여러 개 생긴다.
 *  이 상태에서 React key 가 중복되어 일부 행의 클릭/수정/삭제가 다른 행으로
 *  잘못 전파되는 증상이 발생 — 이 함수가 단일 진입점에서 차단한다. */
function dedupeTimestampNotes(notes: TimestampNote[]): TimestampNote[] {
  const seenKeys = new Set<string>();
  const usedIds = new Set<string>();
  const out: TimestampNote[] = [];
  for (const note of notes) {
    const key = timestampNoteDedupKey(note);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    let id = typeof note.id === "string" && note.id.length > 0 ? note.id : makeId();
    while (usedIds.has(id)) {
      id = makeId();
    }
    usedIds.add(id);
    out.push({ ...note, id });
  }
  return out;
}

export async function mergeReferences(keepId: string, mergeIds: string[]): Promise<{ keep: ReferenceItem; trashed: ReferenceItem[] }> {
  const keep = await getReference(keepId);
  if (!keep) throw new Error("Reference to keep was not found.");
  const mergeItems = await listReferencesByIds(mergeIds.filter((id) => id !== keepId));
  if (mergeItems.length === 0) return { keep, trashed: [] };
  const mergedTags = [...new Set([...keep.tags, ...mergeItems.flatMap((item) => item.tags)])];
  const mergedNotes = [keep.notes, ...mergeItems.map((item) => item.notes)]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("\n\n");
  const mergedTimestampNotes = dedupeTimestampNotes([
    ...keep.timestamp_notes,
    ...mergeItems.flatMap((item) => item.timestamp_notes),
  ]);
  const mergedPalette = keep.color_palette.length > 0 ? keep.color_palette : mergeItems.find((item) => item.color_palette.length > 0)?.color_palette ?? [];
  const nextKeep = await updateReference(keep.id, {
    tags: mergedTags,
    notes: mergedNotes || null,
    timestamp_notes: mergedTimestampNotes,
    color_palette: mergedPalette,
    rating: Math.max(keep.rating ?? 0, ...mergeItems.map((item) => item.rating ?? 0)) || null,
  });
  const trashed: ReferenceItem[] = [];
  for (const item of mergeItems) {
    trashed.push(await moveReferenceToTrash(item.id));
  }
  return { keep: nextKeep, trashed };
}

function formatSeconds(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  const mm = Math.floor(safe / 60).toString().padStart(2, "0");
  const ss = (safe % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export async function deleteReference(id: string): Promise<void> {
  const item = await getReference(id);
  if (!item) return;
  const { error } = await supabase.from("reference_items").delete().eq("id", id);
  if (error) throw new Error(error.message);
  // 1) DB 가 아는 URL 들은 명시 삭제 — 가장 일반적인 경로.
  await deleteStoredFiles([item.file_url, item.thumbnail_url, item.preview_url]);
  // 2) 같은 reference 가 차지하는 폴더(`<yyyy-mm>/<refId>/`) 안에는 DB 컬럼이
  //    추적하지 않는 잔재가 남을 수 있다 — 과거 cover_<ms>.png / poster_regen_<ts>.png,
  //    중간 실패한 임시 파일 등. file_url / thumbnail_url 의 부모 폴더를
  //    훑어 남은 파일까지 전부 정리. 두 URL 의 부모가 다른 month 폴더라면
  //    각각 따로 sweep (예: 4월에 업로드 → 5월에 cover 변경한 케이스).
  await sweepReferenceFolders(item);
}

/** reference 가 점유 중인 폴더 전체를 list + remove. supabase.storage list 가
 *  flat readdir 이라 재귀하지 않으므로, 알려진 URL 들의 parent dir 만 훑는다.
 *  중복 폴더는 dedup. 실패는 warn 으로 삼키고 orphan sweep 이 후속 회수. */
async function sweepReferenceFolders(item: ReferenceItem): Promise<void> {
  const parents = new Set<string>();
  for (const url of [item.file_url, item.thumbnail_url, item.preview_url]) {
    const parsed = parseStorageUrl(url);
    if (!parsed || parsed.bucket !== REFERENCES_BUCKET) continue;
    const slash = parsed.filePath.lastIndexOf("/");
    if (slash <= 0) continue;
    parents.add(parsed.filePath.slice(0, slash));
  }
  if (parents.size === 0) return;
  await Promise.all(
    [...parents].map(async (folder) => {
      try {
        const res = await supabase.storage.from(REFERENCES_BUCKET).list(folder);
        const names = (res?.data ?? []) as Array<{ name: string }>;
        if (names.length === 0) return;
        const paths = names.map((entry) => `${folder}/${entry.name}`);
        const removeRes = await supabase.storage.from(REFERENCES_BUCKET).remove(paths);
        if (removeRes?.error) {
          console.warn("[library] sweep folder failed", folder, removeRes.error);
        }
      } catch (err) {
        console.warn("[library] sweep folder threw", folder, err);
      }
    }),
  );
}

export async function uploadReferenceFile(file: File, options: UploadReferenceOptions = {}): Promise<ReferenceItem> {
  if (file.size > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new Error(`${REFERENCE_UPLOAD_MAX_LABEL} 이하 파일만 Reference Library에 저장할 수 있습니다.`);
  }
  /* Deny-list 안전망 — UI 의 accept/필터를 우회해 들어오는 드래그-드랍/
     폴더 import 경로에서도 실행 파일을 한 번 더 차단. detectReferenceKind
     가 이미 throw 하지만, 호출 순서가 바뀌더라도 이 위치의 가드는 항상
     실행되도록 대칭으로 둠. */
  if (isBlockedReferenceExtension(file)) {
    throw new Error("실행 파일은 라이브러리에 보관할 수 없습니다.");
  }
  let kind = detectReferenceKind(file);
  if (kind === "image" || kind === "webp") {
    // Promote animated WebP / APNG up to `gif` so the rest of the pipeline
    // (Conti hover preview, Studio Compare placeholder) can treat them as
    // playable media instead of rendering them through a plain <img>.
    const animatedKind = await detectAnimatedRasterKind(file);
    if (animatedKind) kind = animatedKind;
  }
  if (kind === "video") {
    const validation = validateVideoFile(file);
    if (validation.ok !== true) throw new Error(validation.reason);
  }

  const id = makeId();
  const baseTitle = options.title?.trim() || file.name.replace(/\.[^.]+$/, "") || "Untitled Reference";

  /* doc 카테고리 — image/video 와 다른 *generic* 업로드 경로.
     - 공통: 원본을 그대로 storage 에 업로드, mime_type 보존
     - 썸네일: PDF / 폰트는 *진짜* 이미지 썸네일을 생성해 함께 업로드. 그
              외 sub-type (PPT / XLS / ZIP / HTML …) 은 thumbnail_url=null
              로 두고 그리드/인스펙터의 generic 카드(아이콘 + 확장자 배지)
              로 폴백. 썸네일 생성 단계의 실패는 전부 catch 해 일반 카드
              로 자연 폴백 — 진짜 썸네일이 없다고 doc import 자체가 실패
              하면 안 된다. */
  if (kind === "doc") {
    const hash = await sha256(file);
    const originalPath = storagePath(id, file.name || `reference${fileExtension(file)}`);
    const fileUrl = await uploadToReferences(originalPath, file);

    let thumbnailUrl: string | null = null;
    /* PSD 전용 — 풀해상도 프리뷰 URL/native 해상도. 프리뷰 패널이 이미지처럼
       줌·팬 하도록 ai_suggestions.psdPreview 로 durable 저장한다. */
    let psdPreviewUrl: string | null = null;
    let psdWidth: number | undefined;
    let psdHeight: number | undefined;
    try {
      const subtype = detectDocSubtype(file.type, file.name);
      /* sub-type 별 fallback ladder:
         · pdf            → first-page render (pdfjs)
         · font           → "Aa Gg 가나" 단문 render (FontFace)
         · office (ppt/xls/doc) → OOXML 임베디드 썸네일 → 셸 아이콘
         · 그 외 (zip/exe/html/code/audio/other) → 셸 아이콘
         어느 단계든 throw 하지 않고 null 로 떨어지면 다음 폴백 — 마지막까지
         null 이면 thumbnail_url=null 로 generic hue 카드 자연 폴백. */
      const docThumbs = await import("./docThumbnails");
      let thumbBlob: Blob | null = null;
      let stepLog = "";
      if (subtype === "pdf") {
        thumbBlob = await docThumbs.renderPdfFirstPageThumbnail(file);
        stepLog = `pdf:${thumbBlob ? "ok" : "fail"}`;
      } else if (subtype === "psd") {
        /* Eagle 식 원본 크기 프리뷰 — 풀해상도 합성을 preview.webp 로 굽고,
           그리드용 작은 썸네일은 별도로. 둘 다 한 번의 PSD 파싱으로 생성. */
        const rasters = await docThumbs.renderPsdRasters(file);
        if (rasters) {
          thumbBlob = rasters.thumb;
          psdWidth = rasters.width;
          psdHeight = rasters.height;
          psdPreviewUrl = await uploadToReferences(storagePath(id, "preview.webp"), rasters.full);
          stepLog = `psd:ok(${rasters.width}x${rasters.height})`;
        } else {
          thumbBlob = await docThumbs.renderShellIconThumbnail(file);
          stepLog = `psd:fail,shell:${thumbBlob ? "ok" : "fail"}`;
        }
      } else if (subtype === "font") {
        thumbBlob = await docThumbs.renderFontPreviewThumbnail(file);
        stepLog = `font:${thumbBlob ? "ok" : "fail"}`;
      } else if (subtype === "presentation" || subtype === "spreadsheet" || subtype === "document") {
        thumbBlob = await docThumbs.renderOfficeEmbeddedThumbnail(file);
        stepLog = `office-embed:${thumbBlob ? "ok" : "fail"}`;
        if (!thumbBlob) {
          thumbBlob = await docThumbs.renderShellIconThumbnail(file);
          stepLog += `,shell:${thumbBlob ? "ok" : "fail"}`;
        }
      } else {
        // archive / executable / html / code / audio / other
        thumbBlob = await docThumbs.renderShellIconThumbnail(file);
        stepLog = `shell:${thumbBlob ? "ok" : "fail"}`;
      }
      /* 진단용 — 어떤 폴백 단계에서 success/fail 했는지 한 줄로. 사용자 콘솔
         에서 ZIP/EXE 가 generic 카드로 떨어지는 원인(preload IPC 미연결 vs
         OS shell icon 미지원 등) 을 한눈에 식별. */
      console.log(`[library] doc thumb ${subtype} (${file.name}) → ${stepLog}`);
      if (thumbBlob) {
        thumbnailUrl = await uploadToReferences(storagePath(id, "thumbnail.png"), thumbBlob);
      }
    } catch (err) {
      console.warn("[library] doc thumbnail generation failed", err);
    }

    return createReference({
      id,
      kind,
      title: baseTitle,
      file_url: fileUrl,
      thumbnail_url: thumbnailUrl,
      /* PSD 는 file.type 이 비어 octet-stream 으로 떨어지는 환경이 많아, 저장
         후 종류/서브타입 판정이 빗나간다. 업로드 시점 파일명(.psd) 으로
         확정해 표준 mime 을 박아두면 그리드 배지·인스펙터 종류·색 분기가
         모두 일관되게 PSD 로 표시된다. */
      mime_type: detectDocSubtype(file.type, file.name) === "psd"
        ? "image/vnd.adobe.photoshop"
        : (file.type || "application/octet-stream"),
      file_size: file.size,
      content_hash: hash,
      /* PSD 는 합성 native 해상도를 기록해 인스펙터가 썸네일 크기가 아닌
         실제 크기를 표시하게 한다(그 외 doc 은 미정). */
      width: psdWidth,
      height: psdHeight,
      tags: options.tags,
      notes: options.notes,
      source_url: options.sourceUrl,
      origin_project_id: options.originProjectId,
      is_favorite: options.isFavorite,
      /* PSD 풀해상도 프리뷰 URL — 프리뷰 패널의 이미지 줌·팬 분기가 사용.
         자유 JSON 이라 DB 마이그레이션 없이 durable 저장된다. */
      ai_suggestions: psdPreviewUrl ? { psdPreview: psdPreviewUrl } : null,
      /* AI 분류는 doc 자료에 의미가 없는 데다 image-only 파이프라인이라
         실행되어도 즉시 실패. 처음부터 "skipped" 로 기록해 인스펙터의 AI
         탭 stepper 가 idle 빈 상태로 유지되도록 한다(failed 빨간 상태가
         아닌 회색 비활성). */
      classification_status: "skipped",
    });
  }

  if (kind === "video") {
    /* 포스터 추출 사다리:
       1) 렌더러 <video> 디코드(extractFirstFrame) — H.264 mp4/mov 등 빠른 경로
       2) 실패 시 메인 ffmpeg(extractVideoPosterFile) — ProRes/HEVC MOV 등
          브라우저가 못 푸는 코덱도 첫 프레임을 PNG 로 추출(Eagle 동등)
       3) 둘 다 실패하면 썸네일 없이 업로드(thumbnail_url=null) — 그리드는
          video 플레이스홀더로 폴백. 업로드 자체는 절대 막지 않는다. */
    let meta: VideoMeta | null = null;
    let posterBlob: Blob | null = null;
    try {
      const r = await extractFirstFrame(file);
      meta = r.meta;
      posterBlob = await (await fetch(`data:${r.poster.mediaType};base64,${r.poster.base64}`)).blob();
    } catch (rendererErr) {
      console.warn("[library] renderer poster failed, trying ffmpeg", rendererErr);
      const ff = await extractVideoPosterFile(file);
      if (ff) {
        meta = ff.meta;
        posterBlob = ff.blob;
      }
    }
    // 길이를 알 수 있으면(둘 중 하나라도 성공) 10분 한도를 강제. 메타를 전혀
    // 못 얻은 경우(둘 다 실패) 길이 검증은 생략하고 업로드는 계속한다.
    if (meta && meta.durationSec > 0) {
      const metaValidation = validateVideoMeta(meta);
      if (metaValidation.ok !== true) throw new Error(metaValidation.reason);
    }
    const hash = await sha256(file);
    const originalPath = storagePath(id, file.name || `reference${fileExtension(file)}`);
    const fileUrl = await uploadToReferences(originalPath, file);
    const thumbnailUrl = posterBlob
      ? await uploadToReferences(storagePath(id, "poster.png"), posterBlob)
      : null;
    return createReference({
      id,
      kind,
      title: baseTitle,
      file_url: fileUrl,
      thumbnail_url: thumbnailUrl,
      mime_type: file.type || "video/*",
      file_size: file.size,
      content_hash: hash,
      duration_sec: meta?.durationSec,
      width: meta?.widthPx,
      height: meta?.heightPx,
      tags: options.tags,
      notes: options.notes,
      source_url: options.sourceUrl,
      origin_project_id: options.originProjectId,
      is_favorite: options.isFavorite,
    });
  }

  const hash = await sha256(file);
  const originalPath = storagePath(id, file.name || `reference${fileExtension(file)}`);
  const fileUrl = await uploadToReferences(originalPath, file);
  // For animated raster images (gif / animated webp / apng) extract a static
  // first-frame poster.png so consumers can show a still thumbnail and only
  // animate on hover, matching the video reference contract. If extraction
  // fails (some browsers refuse to decode the first frame), we transparently
  // fall back to using the original file as its own thumbnail.
  let thumbnailUrl = fileUrl;
  let previewUrl: string | null = null;
  if (kind === "gif") {
    const posterBlob = await extractStaticPosterFromImageFile(file);
    if (posterBlob) {
      thumbnailUrl = await uploadToReferences(storagePath(id, "poster.png"), posterBlob);
    }
    // 그리드 자동재생용 경량 animated WebP 프리뷰를 함께 구워 둔다. 원본
    // (수 MB, 풀해상도)을 그리드가 직접 재생하면 메인스레드가 길게 멈추므로,
    // ≤360px·~12fps 프리뷰로 대체한다. 실패해도 업로드/poster 는 그대로 —
    // 그리드는 원본으로 자연 폴백한다(non-blocking).
    try {
      const objectUrl = URL.createObjectURL(file);
      try {
        const previewBlob = await generateAnimatedPreviewBlob(objectUrl, file.type || "image/gif");
        if (previewBlob) {
          previewUrl = await uploadToReferences(storagePath(id, "preview.webp"), previewBlob);
        }
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (err) {
      console.warn("[library] animated preview generation failed (using original):", err);
    }
  } else if (kind === "image" || kind === "webp") {
    // 일반 이미지(jpg/png/heic/avif…) / 정적 webp 도 카드용 다운스케일 thumbnail
    // 을 한 번 만들어 둔다 — 원본은 4K/8K 인 경우가 흔해서 카드(200~400px) 에
    // 그대로 디코드시키면 메인스레드 freeze 가 길어진다. 다운스케일 결과가
    // 의미 없는 경우(이미 작은 원본, 인코드 이득 미미)는 헬퍼가 null 반환 →
    // 기존 동작 그대로 fileUrl 을 thumbnail_url 로 쓴다. LibraryCanvas 의
    // wantHighRes 로직(`HIGH_RES_THRESHOLD_PX=480`) 이 카드를 줌인하면
    // file_url 원본을 overlay 로 페이드인하므로 화질 손실은 없다.
    try {
      const thumbBlob = await createDownscaledImageWebp(file, 1024, 0.82);
      if (thumbBlob) {
        thumbnailUrl = await uploadToReferences(storagePath(id, "thumbnail.webp"), thumbBlob);
      }
    } catch (err) {
      console.warn("[library] image thumbnail generation failed (using original):", err);
    }
  }
  // 자연 해상도를 같이 저장 — Shape 필터(`aspectBuckets`)가 측정 안 된
  // 항목을 모두 Custom 으로 떨어뜨리도록 바뀌었기 때문에, width/height 가
  // 비어 있으면 4:3/16:9/Square 같은 선택에 영 안 잡힌다. 신규 업로드는
  // 여기서 한 번 더 읽어 둔다(실패해도 업로드 자체는 진행 — 이후 그리드
  // 렌더에서 lazy backfill 이 보강한다).
  const dims = await readImageDimensions(file);
  return createReference({
    id,
    kind,
    title: baseTitle,
    file_url: fileUrl,
    thumbnail_url: thumbnailUrl,
    preview_url: previewUrl,
    mime_type: file.type || (kind === "gif" ? "image/gif" : kind === "webp" ? "image/webp" : "image/*"),
    file_size: file.size,
    content_hash: hash,
    width: dims?.width,
    height: dims?.height,
    tags: options.tags,
    notes: options.notes,
    source_url: options.sourceUrl,
    origin_project_id: options.originProjectId,
    is_favorite: options.isFavorite,
    variation_of: options.variationOf ?? null,
    ai_suggestions: options.aiSuggestions ?? null,
  });
}

export async function createYoutubeReference(url: string, options: UploadReferenceOptions = {}): Promise<ReferenceItem> {
  const trimmed = url.trim();
  if (!isYoutubeUrl(trimmed)) throw new Error("YouTube URL이 아닙니다.");
  try {
    const ingested = await ingestYoutube(trimmed);
    return createReference({
      kind: "youtube",
      title: options.title?.trim() || ingested.title || "YouTube Reference",
      thumbnail_url: ingested.thumbnailUrl,
      duration_sec: ingested.durationSec,
      tags: options.tags,
      notes: options.notes,
      source_url: ingested.url,
      origin_project_id: options.originProjectId,
      is_favorite: options.isFavorite,
      ai_suggestions: ingested.transcript ? { transcript: ingested.transcript } : null,
    });
  } catch {
    const videoId = trimmed.match(YOUTUBE_URL_REGEX)?.[1];
    return createReference({
      kind: "youtube",
      title: options.title?.trim() || "YouTube Reference",
      thumbnail_url: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null,
      tags: options.tags,
      notes: options.notes,
      source_url: trimmed,
      origin_project_id: options.originProjectId,
      is_favorite: options.isFavorite,
      classification_status: "skipped",
    });
  }
}

/**
 * URL 문자열 자체에서 사람이 읽기 좋은 제목을 유추한다. 현재는 Behance
 * gallery URL (`behance.net/gallery/{id}/{slug}`) 의 프로젝트 슬러그를
 * URL-decode 해 제목으로 사용한다 — 예) `.../gallery/233440639/Horizon-Capital?...`
 * → "Horizon-Capital". 유추할 수 없으면 null 을 반환해 호출부가 URL 원본으로
 * 폴백하게 한다. 슬러그의 하이픈은 Behance 가 만든 식별자이므로 그대로 둔다.
 */
export function deriveLinkTitleFromUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  // Behance: /gallery/{id}/{slug}
  if (/^(www\.)?behance\.net$/.test(host)) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const galleryIdx = parts.indexOf("gallery");
    const slug = galleryIdx >= 0 ? parts[galleryIdx + 2] : undefined;
    if (slug) {
      try {
        const decoded = decodeURIComponent(slug).trim();
        if (decoded) return decoded;
      } catch {
        return slug.trim() || null;
      }
    }
  }

  return null;
}

export async function createLinkReference(url: string, options: UploadReferenceOptions = {}): Promise<ReferenceItem> {
  const trimmed = url.trim();
  if (isYoutubeUrl(trimmed)) return createYoutubeReference(trimmed, options);

  // id 를 미리 발급해서 og:image / 페이지 캡처 결과를 같은 스토리지 경로
  // (poster.png) 로 업로드하고 한 번의 createReference 안에 묶는다. 이렇게
  // 해야 row 가 처음 등장하는 순간부터 thumbnail_url 이 채워져 있어 그리드가
  // 깜빡이지 않는다 — uploadReferenceFile 의 image 분기 패턴과 동일.
  const id = makeId();
  let thumbnailUrl: string | null = null;
  let fileUrl: string | null = null;
  let mimeType: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  const preview = await fetchLinkPreview(trimmed);
  if (preview) {
    try {
      const uploaded = await uploadLinkPreviewPoster(id, preview);
      thumbnailUrl = uploaded.thumbnailUrl;
      fileUrl = uploaded.fileUrl;
      mimeType = uploaded.mimeType;
      width = uploaded.width;
      height = uploaded.height;
    } catch (e) {
      // 캡처 자체는 잡혔지만 스토리지 업로드만 실패한 경우 — link 저장 자체는
      // 막지 않고 썸네일만 비워둔다. 사용자는 인스펙터에서 Regenerate 로 재시도 가능.
      console.warn("[link-preview] poster upload failed:", (e as Error).message);
    }
  }

  return createReference({
    id,
    kind: "link",
    title: options.title?.trim() || deriveLinkTitleFromUrl(trimmed) || trimmed,
    tags: options.tags,
    notes: options.notes,
    source_url: trimmed,
    thumbnail_url: thumbnailUrl,
    // GIF/animated WebP 인 경우만 file_url 이 채워짐 — LibraryGrid 가 mime_type
    // 으로 분기해 호버시 애니메이션 재생을 토글한다.
    file_url: fileUrl,
    mime_type: mimeType,
    width,
    height,
    origin_project_id: options.originProjectId,
    is_favorite: options.isFavorite,
    classification_status: "skipped",
  });
}

/**
 * og:image / oEmbed thumbnail 응답이 정지 이미지라면 단일 poster.png 만 올리고,
 * GIF / animated WebP 라면 dual-asset 패턴 (애니메이션 원본 = file_url,
 * 스마트 정지 프레임 = thumbnail_url) 으로 둘 다 올린다. 그리드는 mime_type
 * 으로 분기해 호버시에만 애니메이션이 재생되도록 만든다.
 */
async function uploadLinkPreviewPoster(
  id: string,
  preview: LinkPreviewResult,
): Promise<{
  thumbnailUrl: string;
  fileUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}> {
  const mime = preview.mimeType || "image/png";
  const dataUrl = `data:${mime};base64,${preview.pngBase64}`;
  const originalBlob = await (await fetch(dataUrl)).blob();
  const typedOriginal = originalBlob.type ? originalBlob : new Blob([originalBlob], { type: mime });

  const isAnimatedCandidate = mime === "image/gif" || mime === "image/webp";

  if (isAnimatedCandidate) {
    // 1) 애니메이션 원본은 그대로 보관 (file_url) — 호버시 재생용.
    const ext = mime === "image/gif" ? "gif" : "webp";
    const fileUrl = await uploadToReferences(storagePath(id, `source.${ext}`), typedOriginal);

    // 2) 그리드 정지 프레임은 "검은 페이드인" 같은 함정을 피하기 위해 여러
    //    프레임 중 휘도 / 대비 점수가 가장 높은 것을 선택 (스마트 프레임).
    //    ImageDecoder 미지원이거나 디코드 실패 시 첫 프레임으로 자연 폴백.
    let posterBlob: Blob | null = await pickBestPosterFrame(typedOriginal, mime);
    if (!posterBlob) {
      posterBlob = await extractStaticPosterFromImageFile(
        new File([typedOriginal], `source.${ext}`, { type: mime }),
      );
    }
    let thumbnailUrl: string;
    let width: number | null = preview.width || null;
    let height: number | null = preview.height || null;
    if (posterBlob) {
      thumbnailUrl = await uploadToReferences(storagePath(id, "poster.png"), posterBlob);
      if (!width || !height) {
        const measured = await readImageDimensions(
          new File([posterBlob], "poster.png", { type: posterBlob.type || "image/png" }),
        );
        if (measured) {
          width = measured.width;
          height = measured.height;
        }
      }
    } else {
      // 정지 프레임 추출 자체가 실패하면 일단 애니메이션 원본을 썸네일로도 사용 —
      // 자동 루프 재생되지만 적어도 그리드에 빈 칸은 안 보임.
      thumbnailUrl = fileUrl;
    }
    return { thumbnailUrl, fileUrl, mimeType: mime, width, height };
  }

  // 정지 이미지 — 현행 단일 poster 경로 유지.
  const thumbnailUrl = await uploadToReferences(storagePath(id, "poster.png"), typedOriginal);
  let width: number | null = preview.width || null;
  let height: number | null = preview.height || null;
  if (!width || !height) {
    const measured = await readImageDimensions(
      new File([typedOriginal], "poster.png", { type: typedOriginal.type || "image/png" }),
    );
    if (measured) {
      width = measured.width;
      height = measured.height;
    }
  }
  return { thumbnailUrl, fileUrl: null, mimeType: mime, width, height };
}

/**
 * GIF / animated WebP 에서 "썸네일로 쓰기 좋은" 프레임을 점수 기반으로 선택.
 *
 * 전략:
 *   1) `ImageDecoder` 로 frameCount 를 알아낸다 (단일 프레임이면 즉시 폴백).
 *   2) 균등 간격으로 최대 8 프레임 샘플링.
 *   3) 각 프레임을 64×64 캔버스로 다운샘플 후 luminance 의 mean/std 계산.
 *   4) 너무 어둡거나(mean < 0.05) 너무 단조로운(std < 0.05) 프레임은 페널티,
 *      그 외엔 std (대비) 가 큰 것을 선호 — "콘텐츠가 가득 찬 프레임".
 *
 * `ImageDecoder` 미지원/실패면 null 반환 → 호출 측이 기존 첫프레임 추출로 폴백.
 */
async function pickBestPosterFrame(blob: Blob, mimeType: string): Promise<Blob | null> {
  const ImageDecoderCtor = (globalThis as unknown as {
    ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => {
      tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
      decode: (opts: { frameIndex: number }) => Promise<{ image: ImageBitmap | VideoFrame }>;
      close?: () => void;
    };
  }).ImageDecoder;
  if (!ImageDecoderCtor) return null;

  let decoder: InstanceType<NonNullable<typeof ImageDecoderCtor>>;
  try {
    decoder = new ImageDecoderCtor({ data: await blob.arrayBuffer(), type: mimeType });
    await decoder.tracks.ready;
  } catch {
    return null;
  }

  try {
    const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
    if (frameCount <= 1) {
      const { image } = await decoder.decode({ frameIndex: 0 });
      return frameToPngBlob(image);
    }

    const sampleCount = Math.min(8, frameCount);
    let bestScore = -Infinity;
    let bestImage: ImageBitmap | VideoFrame | null = null;
    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.min(frameCount - 1, Math.floor((i / sampleCount) * frameCount));
      try {
        const { image } = await decoder.decode({ frameIndex: idx });
        const score = scoreFrameContent(image);
        if (score > bestScore) {
          bestScore = score;
          if (bestImage && "close" in bestImage && typeof bestImage.close === "function") {
            bestImage.close();
          }
          bestImage = image;
        } else if ("close" in image && typeof image.close === "function") {
          image.close();
        }
      } catch {
        /* 한 프레임 디코드 실패는 무시 */
      }
    }
    if (!bestImage) return null;
    const out = await frameToPngBlob(bestImage);
    if ("close" in bestImage && typeof bestImage.close === "function") {
      bestImage.close();
    }
    return out;
  } finally {
    try {
      decoder.close?.();
    } catch {
      /* noop */
    }
  }
}

/** 프레임을 64×64 캔버스로 다운샘플 후 휘도 mean/std 점수를 계산.
 *  Y = 0.2126R + 0.7152G + 0.0722B (sRGB). 검은 페이드인 / 흰 단색 / 단조 패턴
 *  은 mean 또는 std 가 낮아 자연스럽게 페널티. */
function scoreFrameContent(image: ImageBitmap | VideoFrame): number {
  const w = 64;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  try {
    ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, w, h);
  } catch {
    return 0;
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let sumY = 0;
  let sumY2 = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    sumY += y;
    sumY2 += y * y;
  }
  const mean = sumY / n;
  const variance = Math.max(0, sumY2 / n - mean * mean);
  const std = Math.sqrt(variance);
  const meanPenalty = mean < 0.05 ? 0.3 : mean > 0.97 ? 0.4 : 1;
  const stdPenalty = std < 0.05 ? 0.3 : 1;
  return std * meanPenalty * stdPenalty;
}

async function frameToPngBlob(image: ImageBitmap | VideoFrame): Promise<Blob | null> {
  // VideoFrame 도 drawImage 의 CanvasImageSource 로 받아들여진다 (Chromium).
  const anyImage = image as unknown as { displayWidth?: number; displayHeight?: number; width?: number; height?: number };
  const w = anyImage.displayWidth ?? anyImage.width ?? 0;
  const h = anyImage.displayHeight ?? anyImage.height ?? 0;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, w, h);
  } catch {
    return null;
  }
  return canvasToBlob(canvas, "image/png");
}

/** Eagle 처럼 link/youtube 레퍼런스를 OS 기본 브라우저로 띄운다 — 그리드에서
 *  더블클릭 시 호출. http(s) 외 스킴은 메인이 거부하므로 여기선 단순 위임만. */
export async function openReferenceSourceUrl(item: ReferenceItem): Promise<void> {
  const url = item.source_url?.trim();
  if (!url) throw new Error("This reference has no source URL.");
  await localShellPost<{ ok: true }>("/shell/open-external", { url });
}

/** 임의의 http(s) URL 을 OS 기본 브라우저(크롬 등)로 연다. 이미지 검색 결과
 *  페이지처럼 동적으로 만든 외부 URL 을 열 때 사용. http(s) 외 스킴은
 *  메인 프로세스가 거부하므로 여기선 단순 위임만. */
export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) throw new Error("No URL to open.");
  await localShellPost<{ ok: true }>("/shell/open-external", { url: trimmed });
}

/** 미리보기 이미지를 캔버스로 JPEG 로 재인코딩해 base64 를 돌려준다.
 *  렌더러(Chromium)는 webp/gif/png/jpg 를 모두 디코드할 수 있어, Imgur 가
 *  거부하는 webp 썸네일도 안전한 JPEG 로 바꿀 수 있다. storage 는 CORS(*) 라
 *  crossOrigin 로드 후 canvas export 가 tainted 되지 않는다. 너무 큰 이미지는
 *  최대 변 2048px 로 다운스케일(검색엔 충분, 업로드 가볍게). */
async function imageUrlToJpegBase64(url: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for search."));
    img.src = url;
  });
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("Image has no dimensions.");
  const max = 2048;
  if (Math.max(w, h) > max) {
    const s = max / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Failed to encode image.");
  return dataUrl.slice(comma + 1);
}

/** 이미지로 검색 — 미리보기 이미지를 JPEG 로 변환해 메인으로 보내면, 메인이
 *  Imgur 에 업로드한 뒤 그 공개 URL 로 외부 브라우저에서 선택 엔진(Google
 *  Lens / Yandex / TinEye)의 by-URL 검색을 연다. 로컬 파일도 검색 가능.
 *
 *  link/youtube 의 썸네일은 외부 CDN(i.ytimg.com, og:image 등) 일 수 있는데,
 *  그런 외부 이미지는 CORS 가 없어 canvas 변환이 실패한다(crossOrigin 로드
 *  에러 또는 tainted). 그 경우 URL 을 메인으로 넘겨 메인이 직접 받아 업로드
 *  하도록 폴백한다(외부 썸네일은 대개 jpg/png 라 Imgur 가 그대로 수용). */
export async function searchByImage(
  imageUrl: string,
  engine: ImageSearchEngineId = DEFAULT_IMAGE_SEARCH_ENGINE,
): Promise<void> {
  const url = imageUrl?.trim();
  if (!url) throw new Error("No image to search.");
  try {
    const imageBase64 = await imageUrlToJpegBase64(url);
    await localShellPost<{ ok: true }>("/api/lens-search", { imageBase64, engine });
  } catch {
    await localShellPost<{ ok: true }>("/api/lens-search", { url, engine });
  }
}

/** 하위 호환 — 기존 호출부(Google Lens 직행)를 그대로 유지하기 위한 래퍼. */
export async function lensSearchByImage(imageUrl: string): Promise<void> {
  return searchByImage(imageUrl, "google-lens");
}

/** 외부 이미지 직링크를 메인이 받아 바이트로 돌려준 뒤, 실제 이미지 자료로
 *  라이브러리에 저장한다. 외부 검색 결과(Yandex/Lens 페이지)에서 끌어온
 *  이미지를 "링크 북마크" 가 아니라 진짜 이미지 카드로 담기 위함. 다운로드/
 *  content-type 검증은 메인(/api/fetch-image)이 담당한다. */
export async function downloadImageAsReference(
  imageUrl: string,
  options: UploadReferenceOptions = {},
): Promise<ReferenceItem> {
  const url = imageUrl?.trim();
  if (!url) throw new Error("No image URL to download.");
  const { bytes, mime, filename } = await localShellPost<{
    bytes: string;
    mime: string;
    filename: string;
  }>("/api/fetch-image", { url });

  // base64 → Uint8Array → File. atob 는 바이너리 문자열을 주므로 charCodeAt 으로
  // 바이트 복원. 큰 이미지에서도 충분히 빠르다(50MB 상한).
  const binary = atob(bytes);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) buf[i] = binary.charCodeAt(i);
  const file = new File([buf], filename || "image.jpg", { type: mime || "image/jpeg" });
  return uploadReferenceFile(file, options);
}

export async function linkReferenceToProject(input: {
  projectId: string;
  referenceId: string;
  target: ProjectReferenceLink["target"];
  annotation?: string;
  timeRange?: RefAnnotation;
}): Promise<ProjectReferenceLink> {
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from("project_reference_links")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("reference_id", input.referenceId)
    .eq("target", input.target)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);

  if (existing) {
    await supabase.from("reference_items").update({ last_used_at: now, updated_at: now }).eq("id", input.referenceId);
    return existing as ProjectReferenceLink;
  }

  const row = {
    id: makeId(),
    project_id: input.projectId,
    reference_id: input.referenceId,
    target: input.target,
    annotation: input.annotation ?? null,
    time_range: input.timeRange ?? null,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase.from("project_reference_links").insert(row).select().single();
  if (error) throw new Error(error.message);
  await supabase.from("reference_items").update({ last_used_at: now, updated_at: now }).eq("id", input.referenceId);
  return data as ProjectReferenceLink;
}

/**
 * 각 reference 가 몇 개의 (프로젝트, target) 쌍에 연결돼 있는지 집계.
 *
 * 같은 reference 가 한 프로젝트의 brief / agent / conti 세 곳에 동시에 붙어
 * 있을 수 있으므로 "사용된 프로젝트 수" 보다 "사용된 (프로젝트,target) 수" 가
 * Inspector/Grid 의 "이 자료는 어디서 쓰이고 있나요?" 질문에 더 충실하다.
 *
 * 빈 배열이 들어오면 빈 record 반환 — 호출부에서 `?? 0` 로 안전하게 사용.
 */
export async function getReferenceUsageCounts(referenceIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(referenceIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from("project_reference_links")
    .select("reference_id, project_id, target")
    .in("reference_id", ids);
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const row of (data as Array<{ reference_id: string; project_id: string; target: string }> | null) ?? []) {
    const key = `${row.reference_id}:${row.project_id}:${row.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[row.reference_id] = (counts[row.reference_id] ?? 0) + 1;
  }
  return counts;
}

export async function listProjectReferenceLinks(input: {
  projectId: string;
  target?: ProjectReferenceLink["target"];
}): Promise<ProjectReferenceLink[]> {
  let query = supabase
    .from("project_reference_links")
    .select("*")
    .eq("project_id", input.projectId)
    .order("created_at", { ascending: true });
  if (input.target) query = query.eq("target", input.target);
  const { data, error } = await query;
  const rows = requireSuccess<ProjectReferenceLink[]>(data as ProjectReferenceLink[] | null, error);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.project_id}:${row.reference_id}:${row.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getReferencesForProject(projectId: string, target?: ProjectReferenceLink["target"]): Promise<ReferenceItem[]> {
  const links = await listProjectReferenceLinks({ projectId, target });
  return listReferencesByIds(links.map((link) => link.reference_id));
}

export async function unlinkReferenceFromProject(input: {
  projectId: string;
  referenceId: string;
  target: ProjectReferenceLink["target"];
}): Promise<void> {
  const { error } = await supabase
    .from("project_reference_links")
    .delete()
    .eq("project_id", input.projectId)
    .eq("reference_id", input.referenceId)
    .eq("target", input.target);
  if (error) throw new Error(error.message);
}

/** 라이브러리 자료의 풍부한 메타 (notes / tags / timestamp_notes / color_palette)
 *  를 Brief 의 단일 `RefAnnotation` 으로 직렬화한다.
 *
 *  매핑 정책 (v1 — 정보 손실 최소화에 집중):
 *    - `item.notes`           → annotation.notes 의 첫 블록 (사용자가 쓴 자유 본문)
 *    - `item.tags`            → annotation.notes 에 "Tags: a, b, c" 한 줄
 *    - `item.timestamp_notes` → annotation.notes 에 "Timestamp notes:" 헤더 + 항목별 줄.
 *      video 는 `[mm:ss]`, gif 는 `[#frameIndex+1]`, image (region-only) 는 `[region]`
 *      접두로 시점/위치를 보존.
 *    - 영상에서 timestamp 노트가 *정확히 1개* 이고 atSec 이 있으면 추가로
 *      `annotation.rangeText` 도 채워 video 샘플링 구간 힌트로 활용
 *      (Brief 의 `parseTimeRange` 가 단일 시점은 거부하므로 `±2s` 범위로 확장).
 *
 *  결과가 비어 있으면 undefined 를 돌려 caller (referenceToRefItem) 가 빈 객체
 *  대신 omit 하도록 함 — Brief 의 `hasAnnotation` 가드와 일관성. */
export function buildAnnotationFromLibrary(item: ReferenceItem): RefAnnotation | undefined {
  const noteLines: string[] = [];

  // (1) 라이브러리 자유 본문 — 가장 사용자 의도가 강한 텍스트라 최상단.
  const freeNotes = item.notes?.trim();
  if (freeNotes) {
    noteLines.push(freeNotes);
  }

  // (2) 태그 — 모델이 mood/style/object 분류에 활용. "Tags:" 접두로 그루핑.
  //     폴더 태그(`folder:...`) 는 시맨틱 가치가 낮아 제외.
  const userTags = (item.tags ?? []).filter((tag) => tag && !tag.startsWith("folder:"));
  if (userTags.length > 0) {
    noteLines.push(`Tags: ${userTags.join(", ")}`);
  }

  // (3) timestamp_notes — 영상/GIF/이미지 모두 처리. 시점 anchor 가 있으면
  //     접두로 보존 (예: "[00:12] camera dolly in"), 영상은 mm:ss, gif 는 #N.
  const tNotes = item.timestamp_notes ?? [];
  if (tNotes.length > 0) {
    const lines = tNotes
      .map((note) => {
        const text = (note.text ?? "").trim();
        if (!text) return null;
        let prefix = "";
        if (item.kind === "video" && Number.isFinite(note.atSec)) {
          prefix = `[${formatSeconds(note.atSec as number)}] `;
        } else if (item.kind === "gif" && Number.isFinite(note.frameIndex)) {
          prefix = `[#${(note.frameIndex as number) + 1}] `;
        } else if (note.region) {
          prefix = "[region] ";
        }
        return `${prefix}${text}`;
      })
      .filter((line): line is string => Boolean(line));
    if (lines.length > 0) {
      if (noteLines.length > 0) noteLines.push(""); // 빈 줄 separator
      noteLines.push("Timestamp notes:");
      for (const line of lines) noteLines.push(line);
    }
  }

  if (noteLines.length === 0) return undefined;

  const annotation: RefAnnotation = {
    notes: noteLines.join("\n"),
  };

  // (4) 영상에서 단일 시점 노트가 있고 atSec 이 명확하면 샘플링 힌트 추가.
  //     parseTimeRange 는 start < end 조건이라 단일 시점은 ±2s 로 확장.
  if (item.kind === "video" && tNotes.length === 1) {
    const only = tNotes[0];
    if (Number.isFinite(only.atSec)) {
      const at = only.atSec as number;
      const start = Math.max(0, at - 2);
      const end = at + 2;
      annotation.rangeText = `${formatSeconds(start)}~${formatSeconds(end)}`;
      annotation.startSec = start;
      annotation.endSec = end;
    }
  }

  return annotation;
}

export async function referenceToRefItem(item: ReferenceItem, annotation?: RefAnnotation): Promise<RefItem> {
  const addedAt = item.created_at ?? new Date().toISOString();
  if (item.kind === "youtube") {
    const videoId = item.source_url?.match(YOUTUBE_URL_REGEX)?.[1] ?? "";
    const ref: RefYoutubeItem = {
      kind: "youtube",
      id: `library_${item.id}`,
      addedAt,
      url: item.source_url ?? "",
      videoId,
      title: item.title,
      thumbnailUrl: item.thumbnail_url ?? undefined,
      durationSec: item.duration_sec ?? undefined,
      transcript: getStoredTranscript(item),
      status: videoId ? "ready" : "error",
      errorMsg: videoId ? undefined : "Missing YouTube video id",
      annotation,
    };
    return ref;
  }

  if (item.kind === "video") {
    if (!item.thumbnail_url) throw new Error("Video reference is missing a thumbnail.");
    const poster = await urlToBase64(item.thumbnail_url);
    const ref: RefVideoItem = {
      kind: "video",
      id: `library_${item.id}`,
      addedAt,
      fileName: item.title,
      fileSize: item.file_size ?? 0,
      durationSec: item.duration_sec ?? 0,
      posterBase64: poster.base64,
      status: "ready",
      // Library-sourced video has no original `File` handle — but the local
      // server can stream the stored file via `file_url`. BriefTab/Conti use
      // `remote_url` to do real frame sampling instead of falling back to
      // poster-only when `file` is missing.
      remoteUrl: item.file_url ?? undefined,
      annotation,
    };
    return ref;
  }

  if (item.kind === "image" || item.kind === "webp" || item.kind === "gif") {
    if (!item.file_url) throw new Error("Image reference is missing a file URL.");
    const image = await urlToBase64(item.file_url);
    const ref: RefImageItem = {
      kind: "image",
      id: `library_${item.id}`,
      addedAt,
      base64: image.base64,
      mediaType: image.mediaType,
      preview: item.file_url,
      annotation,
    };
    return ref;
  }

  if (item.kind === "link") {
    // URL 레퍼런스는 링크 프리뷰 썸네일을 시각 입력으로 써서 "썸네일 기준" 분석한다.
    // 썸네일이 없으면 분석에 쓸 시각 정보가 없으므로 변환 불가(호출부가 skip).
    const src = item.thumbnail_url ?? item.file_url;
    if (!src) throw new Error("Link reference has no thumbnail to analyze.");
    const image = await urlToBase64(src);
    const ref: RefImageItem = {
      kind: "image",
      id: `library_${item.id}`,
      addedAt,
      base64: image.base64,
      mediaType: image.mediaType,
      preview: src,
      annotation,
    };
    return ref;
  }

  throw new Error(`Reference kind "${item.kind}" cannot be converted to a Brief RefItem.`);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Promote to Asset
 *
 * 라이브러리의 image/gif 자료를 프로젝트 asset(캐릭터/배경/아이템)으로 승격.
 * - 새 asset 행을 생성하면서 `photo_url` 은 원본 file_url 그대로 참조
 *   (별도 파일 복제 없음 — 같은 storage URL 을 가리킨다).
 * - reference 본체는 절대 삭제하지 않고, `promoted_asset_ids` 메타에
 *   생성된 asset id 만 추가한다 ("이 자료에서 만든 자산이 있다" 표시).
 * - asset 측에는 `source_reference_id` 를 남겨 역참조 가능.
 *
 * video / youtube / link 는 정적 asset 으로 적합하지 않으므로 호출부에서
 * disable 한다 (UI 가드). 함수 자체도 안전하게 throw 한다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export type PromoteAssetType = "character" | "item" | "background";

export interface PromoteToAssetInput {
  reference: ReferenceItem;
  projectId: string;
  assetType: PromoteAssetType;
  /** asset 의 `tag_name`. 사용자가 비워두면 reference.title 에서 파생. */
  tagName?: string;
  /** 선택. asset 의 `space_description` (background) 또는 `outfit_description` 등.
   *  지금은 단일 문자열을 받고 호출부가 적절한 컬럼으로 분기. */
  description?: string;
}

/** assets 테이블에 그대로 insert 되는 row 모양. cross-workspace 핸드오프 큐에도
 *  이 형태 그대로 직렬화된다(단일 진실원). */
export interface PromotedAssetRecord {
  id: string;
  project_id: string;
  asset_type: PromoteAssetType;
  tag_name: string;
  photo_url: string;
  source_type: "library";
  source_reference_id: string;
  ai_description: string | null;
  outfit_description: string | null;
  role_description: string | null;
  signature_items: string | null;
  space_description: string | null;
  created_at: string;
  /** Cross-workspace 전용(assets 테이블에 저장되지 않는 transient 필드).
   *  스토리지는 워크스페이스별로 분리돼 있어 라이브러리 file_url 은 프로젝트
   *  워크스페이스에서 404 가 된다. 그래서 승격 시점(라이브러리 활성)에 이미지
   *  바이트를 base64 로 실어 두고, drain 시점(프로젝트 활성)에 프로젝트 스토리지
   *  로 업로드해 photo_url 을 그 URL 로 교체한다. drain 후 insert 전에 제거. */
  photo_base64?: string;
  photo_media_type?: string;
}

const MEDIA_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** 스토리지 보관용 이미지 base64. 큰 원본을 webp(maxEdge 2048)로 다운스케일해
 *  LS/디스크 부담을 줄이고 모든 워크스페이스에서 렌더 가능한 포맷으로 정규화한다.
 *  DOM 미가용/디코드 실패 시 원본 바이트 그대로 best-effort. */
export async function urlToStorageImageBase64(
  url: string,
  maxEdge = 2048,
  quality = 0.9,
): Promise<{ base64: string; mediaType: string }> {
  const raw = await urlToBase64(url);
  if (typeof document === "undefined") return raw;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = `data:${raw.mediaType};base64,${raw.base64}`;
    });
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return raw;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/webp", quality);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return raw;
    return { base64: dataUrl.slice(comma + 1), mediaType: "image/webp" };
  } catch {
    return raw;
  }
}

/** input → assets row 빌더. DB 접근 없는 순수 함수. same-workspace 즉시 insert 와
 *  cross-workspace 큐 적재가 동일 row 를 쓰도록 단일화한다. */
export function buildPromotedAssetRecord(input: PromoteToAssetInput): PromotedAssetRecord {
  const { reference, projectId, assetType } = input;
  // 정지 이미지(image/webp)는 원본(file_url) 우선 — 풀해상도가 정체성에 유리.
  // 그 외(gif/video/link/youtube)는 정지 프레임인 thumbnail_url 을 asset 사진으로
  // 사용한다(콘티가 모든 kind 를 thumbnail 로 쓰는 것과 동일 정책).
  const isStillImage = reference.kind === "image" || reference.kind === "webp";
  const photoUrl = isStillImage
    ? reference.file_url ?? reference.thumbnail_url ?? null
    : reference.thumbnail_url ?? reference.file_url ?? null;
  if (!photoUrl) {
    throw new Error("This reference has no image or thumbnail to use as the asset photo.");
  }
  const tagName = (input.tagName?.trim() || reference.title.trim() || "asset").replace(/^@/, "");
  const desc = input.description?.trim() || null;
  return {
    id: makeId(),
    project_id: projectId,
    asset_type: assetType,
    tag_name: tagName,
    photo_url: photoUrl,
    source_type: "library",
    source_reference_id: reference.id,
    // 타입별 설명 매핑. 캐릭터 설명이 버려지던 갭 수정: character → outfit_description.
    ai_description: assetType === "item" ? desc : null,
    outfit_description: assetType === "character" ? desc : null,
    role_description: null,
    signature_items: null,
    space_description: assetType === "background" ? desc : null,
    created_at: new Date().toISOString(),
  };
}

/** reference 의 promote 추적 메타(promoted_asset_ids/last_used_at) 갱신.
 *  reference 가 *현재 활성 워크스페이스* 에 있을 때만 성공하므로, cross-workspace
 *  전환 후 호출하면 실패한다 → 호출부에서 best-effort 로 감싼다. */
export async function recordReferencePromotion(
  reference: ReferenceItem,
  assetId: string,
): Promise<ReferenceItem> {
  const nextPromoted = [...new Set([...(reference.promoted_asset_ids ?? []), assetId])];
  // promote 성공 == "이 자료를 프로젝트에서 *실제로 사용*" — last_used_at 도 같이
  // 찍어 "최근 사용" 사이드바 필터가 새로고침 후에도 이 자료를 잡도록 한다.
  return updateReference(reference.id, {
    promoted_asset_ids: nextPromoted,
    last_used_at: new Date().toISOString(),
  });
}

export async function promoteReferenceToAsset(input: PromoteToAssetInput): Promise<{ assetId: string; reference: ReferenceItem }> {
  const record = buildPromotedAssetRecord(input);
  const { error } = await supabase.from("assets").insert(record);
  if (error) throw new Error(error.message);
  // 추적 메타 갱신은 best-effort — 실패해도 에셋 생성 자체는 성공으로 본다.
  let updated = input.reference;
  try {
    updated = await recordReferencePromotion(input.reference, record.id);
  } catch (err) {
    console.warn("[promote] reference tracking update failed (non-fatal):", err);
  }
  return { assetId: record.id, reference: updated };
}

/* ━━━━━ Cross-workspace promote 핸드오프 큐 ━━━━━
 * 에셋은 *프로젝트 워크스페이스 DB* 에 들어가야 한다(assets.project_id 가
 * projects.id 를 FK 참조). 그런데 라이브러리를 다른 워크스페이스에서 보고 있으면
 * 활성 DB 가 달라 즉시 insert 가 "FOREIGN KEY constraint failed" 로 실패한다.
 * 그래서 (1) 소스 워크스페이스에서 reference 추적 메타만 갱신, (2) assets row 를
 * LS 큐에 적재, (3) 프로젝트 워크스페이스로 전환(reload), (4) AssetsTab 이 mount
 * 시 큐를 drain 해 그 DB 에 insert 한다. (Agent 채팅 첨부 핸드오프와 동일 패턴.) */
const PENDING_PROMOTE_KEY = (projectId: string) => `ff_pending_promote_${projectId}`;

export function readPendingPromotes(projectId: string): PromotedAssetRecord[] {
  try {
    const raw = localStorage.getItem(PENDING_PROMOTE_KEY(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PromotedAssetRecord[]) : [];
  } catch {
    return [];
  }
}

export function enqueuePendingPromote(projectId: string, record: PromotedAssetRecord): void {
  try {
    const next = [...readPendingPromotes(projectId), record];
    localStorage.setItem(PENDING_PROMOTE_KEY(projectId), JSON.stringify(next));
  } catch {
    /* ignore quota 등 */
  }
}

export function clearPendingPromotes(projectId: string): void {
  try {
    localStorage.removeItem(PENDING_PROMOTE_KEY(projectId));
  } catch {
    /* ignore */
  }
}

/** 큐에 쌓인 assets row 를 *현재 활성 DB* 에 insert. AssetsTab mount 시 호출.
 *  insert 에 성공한 항목만 큐에서 제거(부분 실패는 보존). 이미 들어간 행의 PK
 *  충돌은 성공으로 간주(중복 drain 안전). 새로 반영된 개수를 반환한다. */
export async function drainPendingPromotes(projectId: string): Promise<number> {
  const pending = readPendingPromotes(projectId);
  if (!pending.length) return 0;
  let inserted = 0;
  const remaining: PromotedAssetRecord[] = [];
  for (const record of pending) {
    const { photo_base64, photo_media_type, ...row } = record;
    // Cross-workspace 로 실려 온 이미지 바이트를 *현재(프로젝트) 워크스페이스*
    // 스토리지로 업로드해 photo_url 을 워크스페이스-로컬 URL 로 교체한다. 업로드
    // 실패 시엔 원래 photo_url(라이브러리) 로라도 insert 한다(이미지가 깨질 수는
    // 있으나 에셋 자체는 보존).
    if (photo_base64) {
      try {
        const mediaType = photo_media_type || "image/webp";
        const ext = MEDIA_TYPE_EXT[mediaType.toLowerCase()] || "webp";
        const blob = await (await fetch(`data:${mediaType};base64,${photo_base64}`)).blob();
        const filePath = `${projectId}/promoted-${record.id}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("assets")
          .upload(filePath, blob, { contentType: mediaType, upsert: true });
        if (!upErr) {
          row.photo_url = supabase.storage.from("assets").getPublicUrl(filePath).data.publicUrl;
        }
      } catch (err) {
        console.warn("[promote] cross-workspace photo upload failed (keeping original URL):", err);
      }
    }
    const { error } = await supabase.from("assets").insert(row);
    if (!error) {
      inserted++;
      continue;
    }
    // 이미 삽입됨(중복 drain) → PK/unique 충돌은 성공으로 간주하고 큐에서 제거.
    if (/unique|primary key|assets\.id/i.test(error.message)) {
      inserted++;
      continue;
    }
    remaining.push(record);
  }
  if (remaining.length) {
    try {
      localStorage.setItem(PENDING_PROMOTE_KEY(projectId), JSON.stringify(remaining));
    } catch {
      /* ignore */
    }
  } else {
    clearPendingPromotes(projectId);
  }
  return inserted;
}
