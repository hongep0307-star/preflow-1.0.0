/* 라이브러리 Types 필터의 계층 모델 (카테고리 + 리프).
 *
 * 4개 최상위 카테고리(image/video/doc/url) 아래에 세부 리프(포맷/플랫폼/기타)를 둔다.
 * 단일 `MultiFilter<string>` 로 표현한다:
 *   · 카테고리 id  = "image" / "video" / "doc" / "url"
 *   · 리프 id      = "image/png" / "video/mp4" / "doc/pdf" / "url/youtube" / "image/etc" …
 *
 * 매칭 규칙(picker 가 불변식을 보장):
 *   · 같은 카테고리에서 카테고리 id 와 그 리프 id 는 *동시에* include 되지 않는다.
 *     리프를 고르면 그 카테고리는 "선택한 리프만", 카테고리 전체를 고르면 리프 선택은
 *     비워진다(picker 의 toggle 헬퍼가 처리).
 *   · 그 덕에 "이미지 전체 + 영상은 mp4만" 같은 교차 선택이 OR 로 자연스럽게 동작한다.
 *
 * `/` 를 구분자로 쓰며 카테고리/리프 토큰에는 `/` 가 들어가지 않는다.
 */
import { detectDocSubtype, type DocSubtype, type ReferenceItem } from "./referenceLibrary";
import {
  detectLinkPlatform,
  LINK_PLATFORM_LABEL,
  LINK_PLATFORM_ORDER,
  resolveDisplayKind,
} from "./linkPlatform";

export type TypeCategory = "image" | "video" | "doc" | "url";

/** "기타" 리프의 토큰. 각 카테고리에서 알려진 리프에 안 맞는 자료가 모인다. */
export const ETC_LEAF = "etc";

/** 카테고리별 알려진 포맷/플랫폼 리프 토큰(끝에 etc 가 항상 붙는다). */
const IMAGE_FORMATS = ["png", "jpeg", "webp", "gif"] as const;
const VIDEO_FORMATS = ["mp4", "webm", "mov"] as const;
/** 문서 sub-type 중 picker 에 노출할 것(나머지/unknown 은 etc). detectDocSubtype 의
 *  반환값과 1:1. "other" 는 etc 로 접는다. */
const DOC_SUBTYPES: DocSubtype[] = [
  "pdf",
  "psd",
  "presentation",
  "spreadsheet",
  "document",
  "font",
  "archive",
  "html",
  "code",
  "audio",
  "executable",
];

/** doc sub-type → 짧은 라벨(비 i18n 고유 표기). 뷰어 DOC_SUBTYPE_LABEL 와 동일 결. */
const DOC_SUBTYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  psd: "PSD",
  presentation: "Slides",
  spreadsheet: "Sheet",
  document: "Doc",
  font: "Font",
  archive: "ZIP",
  html: "HTML",
  code: "Code",
  audio: "Audio",
  executable: "App",
};

export interface TypeCategorySpec {
  id: TypeCategory;
  /** i18n 키 — picker 가 t() 로 라벨링. */
  labelKey: string;
  /** 하위 리프 전체 id 목록(끝이 `${id}/etc`). */
  leaves: string[];
}

/** picker 가 렌더할 카테고리/리프 구조의 단일 출처. */
export const TYPE_CATEGORY_SPECS: TypeCategorySpec[] = [
  {
    id: "image",
    labelKey: "library.types.image",
    leaves: [...IMAGE_FORMATS.map((f) => `image/${f}`), `image/${ETC_LEAF}`],
  },
  {
    id: "video",
    labelKey: "library.types.video",
    leaves: [...VIDEO_FORMATS.map((f) => `video/${f}`), `video/${ETC_LEAF}`],
  },
  {
    id: "doc",
    labelKey: "library.types.document",
    leaves: [...DOC_SUBTYPES.map((s) => `doc/${s}`), `doc/${ETC_LEAF}`],
  },
  {
    id: "url",
    labelKey: "library.types.url",
    leaves: [...LINK_PLATFORM_ORDER.map((p) => `url/${p}`), `url/${ETC_LEAF}`],
  },
];

/** 리프 id → 표시 라벨. etc 는 호출부(컴포넌트)가 i18n 으로 덮어쓴다. */
export function typeLeafLabel(leafId: string): string {
  const [cat, leaf] = leafId.split("/");
  if (leaf === ETC_LEAF) return "Etc";
  if (cat === "url") {
    return LINK_PLATFORM_LABEL[leaf as keyof typeof LINK_PLATFORM_LABEL] ?? leaf;
  }
  if (cat === "doc") return DOC_SUBTYPE_LABEL[leaf] ?? leaf.toUpperCase();
  // image/video 포맷 — 확장자 대문자 (PNG/JPEG/WEBP/GIF/MP4/WEBM/MOV)
  return leaf.toUpperCase();
}

function normalizeToken(tok: string): string {
  if (tok === "jpg") return "jpeg";
  if (tok === "quicktime") return "mov";
  if (tok === "svg+xml") return "svg";
  return tok;
}

/** mime_type → file_url → title 순으로 포맷 토큰 추출(소문자, 정규화). */
function formatToken(item: Pick<ReferenceItem, "mime_type" | "file_url" | "title">): string {
  if (item.mime_type) {
    const sub = item.mime_type.split("/")[1]?.toLowerCase();
    if (sub) return normalizeToken(sub);
  }
  for (const src of [item.file_url, item.title]) {
    if (!src) continue;
    const m = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    if (m?.[1]) return normalizeToken(m[1].toLowerCase());
  }
  return "";
}

type TypeIds = { category: TypeCategory; leafId: string };

/** 자료 → { 카테고리, 리프 id }. 알 수 없는 kind 면 null. */
export function typeIdsOf(
  item: Pick<ReferenceItem, "kind" | "mime_type" | "file_url" | "title" | "source_url">,
): TypeIds | null {
  const dk = resolveDisplayKind(item);
  if (dk === "image" || dk === "webp" || dk === "gif") {
    // animated/static WebP → "webp", GIF → "gif", 그 외 이미지 → 포맷 토큰
    let leaf: string;
    if (dk === "gif") leaf = "gif";
    else if (dk === "webp") leaf = "webp";
    else {
      const tok = formatToken(item);
      leaf = (IMAGE_FORMATS as readonly string[]).includes(tok) ? tok : ETC_LEAF;
    }
    return { category: "image", leafId: `image/${leaf}` };
  }
  if (dk === "video") {
    const tok = formatToken(item);
    const leaf = (VIDEO_FORMATS as readonly string[]).includes(tok) ? tok : ETC_LEAF;
    return { category: "video", leafId: `video/${leaf}` };
  }
  if (dk === "doc") {
    const sub = detectDocSubtype(item.mime_type ?? null, item.title ?? null);
    const leaf = DOC_SUBTYPES.includes(sub) ? sub : ETC_LEAF;
    return { category: "doc", leafId: `doc/${leaf}` };
  }
  if (dk === "youtube" || dk === "link") {
    const p = detectLinkPlatform(item) ?? "other";
    return { category: "url", leafId: `url/${p === "other" ? ETC_LEAF : p}` };
  }
  return null;
}

/** 단일 자료가 type 필터(계층)에 통과하는지. exclude 가 1순위.
 *  include 가 비면(positive 없음) exclude 만 적용. */
export function matchTypeFilter(
  item: Pick<ReferenceItem, "kind" | "mime_type" | "file_url" | "title" | "source_url">,
  include: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): boolean {
  if (include.size === 0 && exclude.size === 0) return true;
  const ids = typeIdsOf(item);
  if (!ids) return include.size === 0; // 미지의 kind: positive 필터가 있으면 탈락
  const { category, leafId } = ids;
  if (exclude.has(leafId) || exclude.has(category)) return false;
  if (include.size === 0) return true;
  return include.has(leafId) || include.has(category);
}

/** activeItems → 카테고리 id + 리프 id 별 카운트 맵(둘 다 채운다). */
export function computeTypeCounts(
  items: ReadonlyArray<Pick<ReferenceItem, "kind" | "mime_type" | "file_url" | "title" | "source_url">>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const ids = typeIdsOf(item);
    if (!ids) continue;
    map.set(ids.category, (map.get(ids.category) ?? 0) + 1);
    map.set(ids.leafId, (map.get(ids.leafId) ?? 0) + 1);
  }
  return map;
}
