/**
 * Reference 패널 통합 데이터 모델.
 *
 * 기존 BriefTab 의 `refImages: ImageItem[]` 가 image-only 였던 것을
 * `refItems: RefItem[]` 로 일원화해 image + youtube + video 를 한 곳에 담는다.
 *
 * 모델별 가용성 (Claude=image only, GPT-5.x=all) 은 호출자가 카탈로그 메타
 * (`supportsVideoFrames`) 와 비교해 `ignoredByModel` 플래그로 표시.
 *
 * 영속화 (localStorage) 는 SerializableRefItem 으로 변환해 저장 — File 객체와
 * frames 배열은 메모리만, 메타와 base64 (image/poster) 만 직렬화.
 */

export type RefItemKind = "image" | "youtube" | "video";

/**
 * 사용자가 해당 레퍼런스에 붙이는 부연설명.
 * - `rangeText`: 원문 그대로 보관 (예: "00:12~00:15"). image 에서는 사용 안 함.
 * - `startSec/endSec`: `parseTimeRange` 가 성공했을 때만 채워짐. 비디오 샘플링
 *   구간 클리핑에 쓰이며, 파싱 실패 시 undefined (그때는 rangeText 만 프롬프트에 노출).
 * - `notes`: 보고 싶은 포인트. 줄바꿈/하이픈 원문 그대로. 프롬프트에서 들여쓰기만 보정.
 */
export interface RefAnnotation {
  rangeText?: string;
  startSec?: number;
  endSec?: number;
  notes?: string;
}

export interface RefItemBase {
  id: string;
  kind: RefItemKind;
  addedAt: string;
  /** 현재 선택된 모델이 이 종류를 지원하지 않을 때 true (UI 회색, 분석 시 제외) */
  ignoredByModel?: boolean;
  /** 사용자 부연설명 (구간 + 포인트). kind 별로 사용 필드가 일부 다름. */
  annotation?: RefAnnotation;
  /** brief_attachments 테이블 행 ID (영구 저장본). 옛 draft 데이터는 비어 있고,
   *  새로 추가되는 항목은 업로드 성공 직후 채워진다. UI 는 이 값으로 영구
   *  저장된 항목인지 (= 디바이스 이전·export 시 보존되는지) 알 수 있다. */
  attachmentId?: string;
}

export interface RefImageItem extends RefItemBase {
  kind: "image";
  base64: string;
  mediaType: string;
  preview: string;
  file?: File;
}

export interface RefYoutubeItem extends RefItemBase {
  kind: "youtube";
  url: string;
  videoId: string;
  title?: string;
  channel?: string;
  thumbnailUrl?: string;
  transcript?: string;
  durationSec?: number;
  status: "loading" | "ready" | "error";
  errorMsg?: string;
}

export interface RefVideoItem extends RefItemBase {
  kind: "video";
  fileName: string;
  fileSize: number;
  durationSec: number;
  posterBase64: string;
  /** DB 백업 포스터의 storage URL(poster_url). posterBase64 가 비어도 이 URL 로
   *  썸네일을 표시한다(이미지의 previewUrl 과 동일 패턴). */
  posterUrl?: string;
  /** 분석 직전 추출 (메모리만, 영속화 X) */
  frames?: { base64: string; t: number; mediaType: string }[];
  /** File 핸들 — 새로고침 시 사라지므로 사용자에게 재드롭 안내 필요 */
  file?: File;
  /** 라이브러리에서 import 된 영상의 storage URL (file 핸들이 없는 정상 케이스).
   *  `sampleFrames` 가 file 우선, 없으면 이 URL 로 프레임을 추출한다. */
  remoteUrl?: string;
  status: "sampling" | "ready" | "error";
  errorMsg?: string;
}

export type RefItem = RefImageItem | RefYoutubeItem | RefVideoItem;

/* ━━━━━ 직렬화 ━━━━━ */

export interface SerializableRefImage {
  kind: "image";
  id: string;
  addedAt: string;
  base64: string;
  mediaType: string;
  annotation?: RefAnnotation;
  /** brief_attachments 행 ID — 영구 저장본 연결 (있을 때만). */
  attachmentId?: string;
  /** DB 백업 항목의 storage URL(file_url). attachmentId 가 있으면 base64 를
   *  localStorage 에 중복 저장하지 않고 이 URL 로 프리뷰를 복원한다(quota 절약). */
  previewUrl?: string;
}
export interface SerializableRefYoutube {
  kind: "youtube";
  id: string;
  addedAt: string;
  url: string;
  videoId: string;
  title?: string;
  channel?: string;
  thumbnailUrl?: string;
  transcript?: string;
  durationSec?: number;
  annotation?: RefAnnotation;
  attachmentId?: string;
}
export interface SerializableRefVideo {
  kind: "video";
  id: string;
  addedAt: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  posterBase64: string;
  /** Library-import 영상은 storage URL 로도 프레임 샘플링이 가능하므로
   *  직렬화에 보존한다. file 핸들은 직렬화하지 않음. */
  remoteUrl?: string;
  annotation?: RefAnnotation;
  attachmentId?: string;
  /** DB 백업 포스터의 storage URL. posterBase64 가 비어도 썸네일을 표시한다. */
  posterUrl?: string;
}
export type SerializableRefItem =
  | SerializableRefImage
  | SerializableRefYoutube
  | SerializableRefVideo;

let _idCounter = 0;
export const makeRefId = (kind: RefItemKind) =>
  `${kind}_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;

export const toDataUrl = (base64: string, mediaType: string) =>
  `data:${mediaType};base64,${base64}`;

/** storage URL(http/https) 인지 — data: URL 과 구분해 슬림 직렬화 여부 판단. */
const isHttpUrl = (url: string | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url);

/** RefItem[] → 직렬화 (frames/file 제외).
 *  DB 백업 항목(attachmentId + storage URL preview)은 base64 를 비워 localStorage
 *  quota 누적을 막는다. 복원은 previewUrl 로 한다. http preview 가 아직 없으면
 *  (마이그레이션 전) base64 를 유지해 프리뷰 유실을 방지. */
export function toSerializableRefItems(items: RefItem[]): SerializableRefItem[] {
  return items
    .map<SerializableRefItem | null>((it) => {
      if (it.kind === "image") {
        const slim = !!it.attachmentId && isHttpUrl(it.preview);
        return {
          kind: "image",
          id: it.id,
          addedAt: it.addedAt,
          base64: slim ? "" : it.base64,
          mediaType: it.mediaType,
          annotation: it.annotation,
          attachmentId: it.attachmentId,
          previewUrl: slim ? it.preview : undefined,
        };
      }
      if (it.kind === "youtube") {
        // status==="loading" 이거나 error 인 경우도 url 만 있으면 복원해서 재시도 가능
        return {
          kind: "youtube",
          id: it.id,
          addedAt: it.addedAt,
          url: it.url,
          videoId: it.videoId,
          title: it.title,
          channel: it.channel,
          thumbnailUrl: it.thumbnailUrl,
          transcript: it.transcript,
          durationSec: it.durationSec,
          annotation: it.annotation,
          attachmentId: it.attachmentId,
        };
      }
      if (it.kind === "video") {
        return {
          kind: "video",
          id: it.id,
          addedAt: it.addedAt,
          fileName: it.fileName,
          fileSize: it.fileSize,
          durationSec: it.durationSec,
          posterBase64: it.posterBase64,
          remoteUrl: it.remoteUrl,
          annotation: it.annotation,
          attachmentId: it.attachmentId,
          posterUrl: it.posterUrl,
        };
      }
      return null;
    })
    .filter((x): x is SerializableRefItem => x !== null);
}

/** 직렬화 → RefItem[] (file/frames 는 비어있음 — 사용자가 영상은 재드롭 필요) */
export function fromSerializableRefItems(serialized: SerializableRefItem[]): RefItem[] {
  return serialized.map<RefItem>((s) => {
    if (s.kind === "image") {
      // 슬림 항목(base64 빔)은 previewUrl(storage URL)로 프리뷰 복원.
      const preview = s.previewUrl || (s.base64 ? toDataUrl(s.base64, s.mediaType) : "");
      return {
        kind: "image",
        id: s.id,
        addedAt: s.addedAt,
        base64: s.base64,
        mediaType: s.mediaType,
        preview,
        annotation: s.annotation,
        attachmentId: s.attachmentId,
      };
    }
    if (s.kind === "youtube") {
      return {
        kind: "youtube",
        id: s.id,
        addedAt: s.addedAt,
        url: s.url,
        videoId: s.videoId,
        title: s.title,
        channel: s.channel,
        thumbnailUrl: s.thumbnailUrl,
        transcript: s.transcript,
        durationSec: s.durationSec,
        status: "ready",
        annotation: s.annotation,
        attachmentId: s.attachmentId,
      };
    }
    return {
      kind: "video",
      id: s.id,
      addedAt: s.addedAt,
      fileName: s.fileName,
      fileSize: s.fileSize,
      durationSec: s.durationSec,
      posterBase64: s.posterBase64,
      posterUrl: s.posterUrl,
      remoteUrl: s.remoteUrl,
      status: "ready",
      annotation: s.annotation,
      attachmentId: s.attachmentId,
    };
  });
}

/** 모델 가용성 기준으로 각 RefItem 의 ignoredByModel 플래그를 다시 계산. */
export function recomputeIgnoredByModel(items: RefItem[], supportsVideoFrames: boolean): RefItem[] {
  return items.map((it) => {
    if (it.kind === "image") return { ...it, ignoredByModel: false };
    return { ...it, ignoredByModel: !supportsVideoFrames };
  });
}

export interface RefSummary {
  images: number;
  youtubes: number;
  videos: number;
  ignored: number;
}

export function summarize(items: RefItem[]): RefSummary {
  const out: RefSummary = { images: 0, youtubes: 0, videos: 0, ignored: 0 };
  for (const it of items) {
    if (it.ignoredByModel) out.ignored++;
    if (it.kind === "image") out.images++;
    else if (it.kind === "youtube") out.youtubes++;
    else if (it.kind === "video") out.videos++;
  }
  return out;
}

export function summarizeLabel(s: RefSummary): string {
  const parts: string[] = [];
  if (s.images > 0) parts.push(`${s.images} image${s.images > 1 ? "s" : ""}`);
  if (s.youtubes > 0) parts.push(`${s.youtubes} link${s.youtubes > 1 ? "s" : ""}`);
  if (s.videos > 0) parts.push(`${s.videos} video${s.videos > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/* ━━━━━ Annotation utilities ━━━━━ */

/** annotation 에 의미있는 값이 하나라도 있는지 — UI 인디케이터/프롬프트 포함 여부 판단용. */
export function hasAnnotation(ann?: RefAnnotation): boolean {
  if (!ann) return false;
  const hasRange = !!(ann.rangeText && ann.rangeText.trim());
  const hasNotes = !!(ann.notes && ann.notes.trim());
  return hasRange || hasNotes;
}

/**
 * 사용자 입력 구간 문자열을 초 단위로 파싱.
 * 허용 포맷:
 *   - "mm:ss ~ mm:ss"
 *   - "hh:mm:ss - hh:mm:ss"
 *   - "12 ~ 18"  (초 단위 정수)
 * 구분자: `~` | `-` | `–` | `—` (공백 허용)
 * start >= end 또는 음수 등 이상값이면 null 반환 — 호출자는 rangeText 만 프롬프트에 쓸 것.
 */
export function parseTimeRange(text: string | undefined | null): { startSec: number; endSec: number } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s*[~\-–—]\s*/);
  if (parts.length !== 2) return null;
  const toSec = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const m = t.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = m[3] !== undefined ? Number(m[3]) : null;
    const frac = m[4] !== undefined ? Number(`0.${m[4]}`) : 0;
    // mm:ss vs hh:mm:ss 구분
    const base = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return base + frac;
  };
  const start = toSec(parts[0]);
  const end = toSec(parts[1]);
  if (start === null || end === null) return null;
  if (!(end > start) || start < 0) return null;
  return { startSec: start, endSec: end };
}

/**
 * 프롬프트용 주석 블록을 `indent` 들여쓰기로 정리해 반환.
 * rangeText 가 있으면 "Time range: xxx" 1줄, notes 가 있으면 "Focus points:" 헤더 + 줄별 하이픈.
 * 라벨이 영어인 이유: 나머지 분석 프롬프트/출력 스키마가 영어 기반이라 일관성 유지.
 */
export function formatAnnotationLines(ann: RefAnnotation | undefined, opts: { includeRange: boolean; indent?: string }): string[] {
  if (!hasAnnotation(ann)) return [];
  const indent = opts.indent ?? "  ";
  const out: string[] = [];
  const range = ann!.rangeText?.trim();
  if (opts.includeRange && range) {
    out.push(`${indent}Time range: ${range}`);
  }
  const notes = ann!.notes?.trim();
  if (notes) {
    out.push(`${indent}Focus points:`);
    for (const raw of notes.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // 사용자가 이미 "- " 로 시작하면 중복 금지.
      const bullet = /^[-•*]/.test(line) ? line.replace(/^[-•*]\s*/, "") : line;
      out.push(`${indent}- ${bullet}`);
    }
  }
  return out;
}
