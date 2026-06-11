/**
 * 브리프 첨부물(이미지·PDF·비디오·YouTube 등) 의 영속 저장 API.
 *
 * 옛 구현은 이 자료들을 모두 browser localStorage 에 base64 로만 들고 있어:
 *   1) quota 초과 시 묵시적 폐기  → 사용자가 모르는 사이 데이터 손실
 *   2) `.preflowproj` export 누락 → 다른 디바이스/profile 로 옮기면 사라짐
 *   3) 새 디바이스에서 시작하면 영구 손실
 * 세 경로의 데이터 손실 핫스팟이었다.
 *
 * 이 모듈은 첨부물을 디스크 + SQLite 의 1등 시민 (`brief_attachments` 테이블 +
 * `storage/briefs/{projectId}/` 디스크 폴더) 으로 영속화한다. 사용자가
 * 명시적으로 add/remove 하기 전까지 모든 자료가 보존된다.
 *
 * 단일 진실 소스 (single source of truth):
 *   - 메타데이터: `brief_attachments` SQLite 행
 *   - 바이너리: storage 디스크 파일 (`file_url`, `poster_url` 가리킴)
 *   - 외부 URL (YouTube 등): 행의 `external_url` 컬럼
 *
 * orphanSweep 보호: `electron/orphanSweep.ts:collectReferencedKeys` 에서
 * `file_url`, `poster_url` 를 참조 집합에 포함시킨다. 따라서 행이 살아 있는 한
 * 디스크 파일도 안전.
 *
 * CASCADE: `ON DELETE CASCADE` (FK to `projects.id`). 프로젝트 삭제 시 자동
 * 정리. orphan sweep 가 그 직후 디스크 파일을 후속 청소.
 */

import { supabase } from "./supabase";

/* ━━━━━ Types ━━━━━ */

/** RefAnnotation 과 호환. refItems.ts 의 RefAnnotation 과 같은 모양이지만,
 *  이 모듈이 다른 모듈로의 import 순환을 피하기 위해 자체 정의 유지. */
export interface BriefAttachmentAnnotation {
  rangeText?: string;
  startSec?: number;
  endSec?: number;
  notes?: string;
}

export type BriefAttachmentKind = "image" | "pdf" | "video" | "youtube" | "note";

/** 'brief' = composer 영역의 첨부물 / 'reference' = 레퍼런스 패널의 항목.
 *  로딩 시 UI 분할에 사용되며, 같은 kind 라도 role 이 다르면 별개 슬롯에
 *  렌더된다. */
export type BriefAttachmentRole = "brief" | "reference";

/** brief_attachments 테이블 행 (TypeScript shape). */
export interface BriefAttachmentRow {
  id: string;
  project_id: string;
  kind: BriefAttachmentKind;
  role: BriefAttachmentRole;
  file_url: string | null;
  poster_url: string | null;
  external_url: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  page_count: number | null;
  extracted_text: string | null;
  annotation: BriefAttachmentAnnotation | null;
  display_order: number;
  origin_reference_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/* ━━━━━ Helpers ━━━━━ */

function makeId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
}

function extFromMime(mime: string | null | undefined, fallback = ""): string {
  if (!mime) return fallback;
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  };
  return map[mime] ?? fallback;
}

function extFromFileName(name: string | null | undefined): string {
  if (!name) return "";
  return name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
}

/** storage 내 파일 경로. orphanSweep / projPackExport 가 이 구조를 가정 — 새
 *  구조를 도입할 때는 양쪽 모두 업데이트 필요. */
function storagePathFor(projectId: string, id: string, ext: string): string {
  return `${projectId}/${id}${ext}`;
}

/** storage URL → bucket-relative file path. publicUrl 구조는 `…/storage/file/<bucket>/<rel>`. */
function relPathFromBriefsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/storage\/file\/briefs\/([^?#]+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/* ━━━━━ Storage upload helper ━━━━━ */

async function uploadToBriefs(filePath: string, data: Blob): Promise<string> {
  const { error } = await supabase.storage.from("briefs").upload(filePath, data, {
    contentType: data.type || undefined,
    upsert: true,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from("briefs").getPublicUrl(filePath).data.publicUrl;
}

async function removeBriefsFile(url: string | null): Promise<void> {
  const rel = relPathFromBriefsUrl(url);
  if (!rel) return;
  try {
    await supabase.storage.from("briefs").remove([rel]);
  } catch (err) {
    console.warn("[briefAttachments] storage remove failed:", (err as Error).message);
  }
}

/* ━━━━━ DB I/O ━━━━━ */

/** 한 프로젝트의 모든 첨부물을 display_order, created_at 순으로 반환. */
export async function loadBriefAttachments(projectId: string): Promise<BriefAttachmentRow[]> {
  if (!projectId) return [];
  const { data, error } = await supabase
    .from("brief_attachments")
    .select("*")
    .eq("project_id", projectId)
    .order("display_order", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BriefAttachmentRow[];
  // 부수정렬: 같은 display_order 안에서는 created_at 오름차순.
  return rows.sort((a, b) => {
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
}

/** 특정 첨부물을 DB 에서 삭제하고, 연결된 storage 파일도 best-effort 로 청소.
 *  storage 청소가 실패해도 DB 행은 사라진 뒤이므로 orphan sweep 가 후속 처리. */
export async function deleteBriefAttachment(id: string): Promise<void> {
  if (!id) return;
  // 먼저 파일 URL 들을 알아야 storage cleanup 가능 — 행 삭제 후엔 못 읽음.
  const { data: row } = (await supabase
    .from("brief_attachments")
    .select("file_url,poster_url")
    .eq("id", id)
    .maybeSingle()) as { data: { file_url: string | null; poster_url: string | null } | null };
  const { error } = await supabase.from("brief_attachments").delete().eq("id", id);
  if (error) throw new Error(error.message);
  if (row) {
    await removeBriefsFile(row.file_url);
    await removeBriefsFile(row.poster_url);
  }
}

/** annotation / display_order / extracted_text 등 가벼운 필드 업데이트. */
export async function updateBriefAttachment(
  id: string,
  patch: Partial<
    Pick<
      BriefAttachmentRow,
      "annotation" | "display_order" | "extracted_text" | "filename"
    >
  >,
): Promise<void> {
  if (!id) return;
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.annotation !== undefined) body.annotation = patch.annotation;
  if (patch.display_order !== undefined) body.display_order = patch.display_order;
  if (patch.extracted_text !== undefined) body.extracted_text = patch.extracted_text;
  if (patch.filename !== undefined) body.filename = patch.filename;
  const { error } = await supabase.from("brief_attachments").update(body).eq("id", id);
  if (error) throw new Error(error.message);
}

/** 일괄 reorder — display_order 만 다시 매김. UI 가 drag-and-drop 후 호출. */
export async function reorderBriefAttachments(
  orderedIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  // sequential UPDATE — 작은 N (보통 < 30) 이라 트랜잭션 없이도 충분.
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i];
    const { error } = await supabase
      .from("brief_attachments")
      .update({ display_order: i, updated_at: now })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }
}

/* ━━━━━ Add helpers — kind 별 ━━━━━ */

interface CommonAddOpts {
  role: BriefAttachmentRole;
  /** 정렬 키. 호출자가 명시하지 않으면 0 (DB 가 created_at 으로 tie-break). */
  displayOrder?: number;
  /** 라이브러리 attach 인 경우 원본 reference_items.id. */
  originReferenceId?: string;
  /** 레퍼런스 패널의 timestamp/notes 등. */
  annotation?: BriefAttachmentAnnotation;
}

interface AddImageOpts extends CommonAddOpts {
  filename?: string;
  width?: number;
  height?: number;
}

/** 이미지(jpg/png/webp/gif…) 한 장을 디스크 + DB 에 영구 저장. */
export async function addImageAttachment(
  projectId: string,
  blob: Blob,
  opts: AddImageOpts,
): Promise<BriefAttachmentRow> {
  if (!projectId) throw new Error("projectId is required");
  const id = makeId();
  const ext = extFromMime(blob.type) || extFromFileName(opts.filename) || ".bin";
  const filePath = storagePathFor(projectId, id, ext);
  const url = await uploadToBriefs(filePath, blob);
  try {
    return insertAttachment({
      id,
      project_id: projectId,
      kind: "image",
      role: opts.role,
      file_url: url,
      poster_url: null,
      external_url: null,
      filename: opts.filename ? sanitizeFileName(opts.filename) : null,
      mime_type: blob.type || null,
      size_bytes: blob.size,
      width: opts.width ?? null,
      height: opts.height ?? null,
      duration_sec: null,
      page_count: null,
      extracted_text: null,
      annotation: opts.annotation ?? null,
      display_order: opts.displayOrder ?? 0,
      origin_reference_id: opts.originReferenceId ?? null,
    });
  } catch (err) {
    // DB insert 실패 시 storage 파일은 곧 orphan — best-effort 즉시 청소.
    await removeBriefsFile(url);
    throw err;
  }
}

interface AddPdfOpts extends CommonAddOpts {
  filename: string;
  extractedText: string;
  pageCount: number;
}

/** PDF 한 개를 디스크 + DB 에 영구 저장. 텍스트 추출 결과는 `extracted_text` 컬럼에. */
export async function addPdfAttachment(
  projectId: string,
  blob: Blob,
  opts: AddPdfOpts,
): Promise<BriefAttachmentRow> {
  if (!projectId) throw new Error("projectId is required");
  const id = makeId();
  const ext = extFromMime(blob.type) || extFromFileName(opts.filename) || ".pdf";
  const filePath = storagePathFor(projectId, id, ext);
  const url = await uploadToBriefs(filePath, blob);
  try {
    return insertAttachment({
      id,
      project_id: projectId,
      kind: "pdf",
      role: opts.role,
      file_url: url,
      poster_url: null,
      external_url: null,
      filename: sanitizeFileName(opts.filename),
      mime_type: blob.type || "application/pdf",
      size_bytes: blob.size,
      width: null,
      height: null,
      duration_sec: null,
      page_count: opts.pageCount,
      extracted_text: opts.extractedText,
      annotation: opts.annotation ?? null,
      display_order: opts.displayOrder ?? 0,
      origin_reference_id: opts.originReferenceId ?? null,
    });
  } catch (err) {
    await removeBriefsFile(url);
    throw err;
  }
}

interface AddVideoOpts extends CommonAddOpts {
  filename: string;
  /** 비디오 원본을 디스크에 저장할지. 라이브러리 import 영상처럼 이미 외부에
   *  영구 저장된 경우엔 fileBlob 을 넘기지 말고 remoteUrl 만 지정. */
  fileBlob?: Blob;
  /** Poster (썸네일) — 항상 디스크에 저장. */
  posterBlob: Blob;
  durationSec: number;
  fileSize: number;
  /** 라이브러리에서 import 된 영상이면 external_url 로 저장. */
  remoteUrl?: string;
}

/** 영상 한 개 + 포스터 한 장을 영구 저장. fileBlob 없이 remoteUrl 만 있는
 *  케이스(라이브러리 영상) 도 안전하게 처리. */
export async function addVideoAttachment(
  projectId: string,
  opts: AddVideoOpts,
): Promise<BriefAttachmentRow> {
  if (!projectId) throw new Error("projectId is required");
  const id = makeId();
  let fileUrl: string | null = null;
  if (opts.fileBlob) {
    const ext = extFromMime(opts.fileBlob.type) || extFromFileName(opts.filename) || ".mp4";
    fileUrl = await uploadToBriefs(storagePathFor(projectId, id, ext), opts.fileBlob);
  }
  let posterUrl: string | null = null;
  try {
    const posterExt = extFromMime(opts.posterBlob.type) || ".jpg";
    posterUrl = await uploadToBriefs(
      storagePathFor(projectId, id, `_poster${posterExt}`),
      opts.posterBlob,
    );
  } catch (err) {
    // 포스터 업로드 실패 시 본체 파일도 청소.
    await removeBriefsFile(fileUrl);
    throw err;
  }
  try {
    return insertAttachment({
      id,
      project_id: projectId,
      kind: "video",
      role: opts.role,
      file_url: fileUrl,
      poster_url: posterUrl,
      external_url: opts.remoteUrl ?? null,
      filename: sanitizeFileName(opts.filename),
      mime_type: opts.fileBlob?.type ?? null,
      size_bytes: opts.fileSize,
      width: null,
      height: null,
      duration_sec: opts.durationSec,
      page_count: null,
      extracted_text: null,
      annotation: opts.annotation ?? null,
      display_order: opts.displayOrder ?? 0,
      origin_reference_id: opts.originReferenceId ?? null,
    });
  } catch (err) {
    await removeBriefsFile(fileUrl);
    await removeBriefsFile(posterUrl);
    throw err;
  }
}

interface AddYoutubeOpts extends CommonAddOpts {
  url: string;
  videoId: string;
  title?: string;
  channel?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  /** 일부 모델만 transcript 를 보존해야 함 — annotation 으로 두면 너무 길어
   *  text 필드 자리 차지. 그래서 extracted_text 컬럼을 재활용. */
  transcript?: string;
}

/** YouTube 링크 한 개. 외부 호스팅이라 디스크에 binary 를 저장하지 않는다. */
export async function addYoutubeAttachment(
  projectId: string,
  opts: AddYoutubeOpts,
): Promise<BriefAttachmentRow> {
  if (!projectId) throw new Error("projectId is required");
  const id = makeId();
  // YouTube 메타데이터는 filename 필드에 title 을 보존해 list UI 가 즉시 사용
  // 가능하게 한다.
  return insertAttachment({
    id,
    project_id: projectId,
    kind: "youtube",
    role: opts.role,
    file_url: null,
    poster_url: opts.thumbnailUrl ?? null,
    external_url: opts.url,
    filename: opts.title ? sanitizeFileName(opts.title) : opts.videoId,
    mime_type: null,
    size_bytes: null,
    width: null,
    height: null,
    duration_sec: opts.durationSec ?? null,
    page_count: null,
    extracted_text: opts.transcript ?? null,
    annotation: {
      ...(opts.annotation ?? {}),
      // channel 정보는 별도 컬럼이 없어 annotation.notes 가 비어있을 때만 보존.
      ...(opts.channel && !opts.annotation?.notes ? { notes: `Channel: ${opts.channel}` } : {}),
    },
    display_order: opts.displayOrder ?? 0,
    origin_reference_id: opts.originReferenceId ?? null,
  });
}

/* ━━━━━ DB insert ━━━━━ */

async function insertAttachment(
  row: Omit<BriefAttachmentRow, "created_at" | "updated_at"> & {
    created_at?: string;
    updated_at?: string | null;
  },
): Promise<BriefAttachmentRow> {
  const payload = {
    ...row,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? null,
  };
  const { data, error } = await supabase
    .from("brief_attachments")
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as BriefAttachmentRow;
}
