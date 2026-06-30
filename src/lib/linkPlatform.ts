/* URL 기반 reference 의 플랫폼 추론 + 표시 라벨.
 *
 * DB 에 별도 `platform` 컬럼이 없고, ReferenceKind 도 image|webp|gif|video|
 * youtube|link 까지만 구분한다. Behance / Pinterest / Instagram / TikTok 같은
 * 외부 플랫폼은 모두 `kind: "link"` 로 들어오기 때문에 라벨/필터링 시점에
 * `source_url` 호스트로 derive 한다 — 한 곳에 정규식과 라벨 매핑을 모아
 * 그리드 배지, 인스펙터, 픽커 드로어, 툴바 필터가 동일 식별을 공유한다.
 *
 * 모든 매칭은 hostname.toLowerCase() 기준이며 서브도메인(예: m.youtube.com,
 * vm.tiktok.com, www.behance.net)을 허용한다. */

import { detectDocSubtype, type ReferenceItem, type ReferenceKind } from "./referenceLibrary";
import { docPresentationOfSubtype } from "./docPresentation";

export type LinkPlatform =
  | "youtube"
  | "vimeo"
  | "pinterest"
  | "instagram"
  | "tiktok"
  | "behance"
  | "other";

/* 표시 라벨 — 공식 표기. 그리드/인스펙터/드로어/툴바 모두 이 맵을 사용. */
export const LINK_PLATFORM_LABEL: Record<LinkPlatform, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  pinterest: "Pinterest",
  instagram: "Instagram",
  tiktok: "TikTok",
  behance: "Behance",
  other: "URL",
};

/* 필터 picker 의 자식 행 순서를 한 곳에서 정의. 사용자가 자주 쓰는 순서로
   배치 — YouTube > Pinterest > Instagram > TikTok > Behance. "other" 는
   부모 URL 행이 직접 다루므로 자식 목록에 포함하지 않는다. */
export const LINK_PLATFORM_ORDER: ReadonlyArray<Exclude<LinkPlatform, "other">> = [
  "youtube",
  "vimeo",
  "pinterest",
  "instagram",
  "tiktok",
  "behance",
];

/* 호스트 매칭 패턴. anchor (^/$) 로 strict 매칭 — `evil-youtube.com.example`
   같은 위조 호스트가 통과하지 않도록. 각 패턴은 hostname.toLowerCase() 와 test. */
const HOST_PATTERNS: ReadonlyArray<{ platform: Exclude<LinkPlatform, "other">; regex: RegExp }> = [
  /* youtu.be 단축 도메인, youtube-nocookie 임베드 도메인까지 포함. */
  { platform: "youtube", regex: /^((www|m)\.)?(youtube\.com|youtube-nocookie\.com)$/ },
  { platform: "youtube", regex: /^youtu\.be$/ },
  /* vimeo 는 watch 도메인(vimeo.com) 과 임베드 플레이어 도메인(player.vimeo.com). */
  { platform: "vimeo", regex: /^(www\.|player\.)?vimeo\.com$/ },
  /* pinterest 는 국가별 TLD (.co.kr, .jp 등) 와 단축 도메인 pin.it 둘 다 받음. */
  { platform: "pinterest", regex: /^([a-z0-9-]+\.)?pinterest\.([a-z]{2,3})(\.[a-z]{2})?$/ },
  { platform: "pinterest", regex: /^pin\.it$/ },
  { platform: "instagram", regex: /^(www\.)?instagram\.com$/ },
  /* tiktok 은 vm.tiktok.com (단축), vt.tiktok.com (Vietnam? 동남아 단축) 까지. */
  { platform: "tiktok", regex: /^((www|vm|vt|m)\.)?tiktok\.com$/ },
  { platform: "behance", regex: /^(www\.)?behance\.net$/ },
];

/* source_url 의 hostname 을 안전하게 뽑는다. URL() 생성자가 실패하는 케이스
   (스킴 누락, 이상한 문자) 에서는 null 반환 — 호출부가 "other" 로 폴백. */
function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    /* 스킴 누락(`youtube.com/watch?v=...`) 도 받아주려면 prefix. URL() 은
       `youtube.com/...` 를 직접 못 먹어서 https:// 를 붙인다. */
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/* URL 계열 reference 의 플랫폼을 식별. 비 URL 계열(image/webp/gif/video) 은
   null. kind=youtube 는 source_url 검사 없이 즉시 youtube — youtube 인제스트
   파이프라인이 이미 kind 를 정확히 박아주므로 host 재검사가 불필요하고, 가끔
   source_url 이 link 변환 중 비어 있는 케이스에도 안전.
   kind=link 는 호스트 매칭 → "other" 폴백. */
export function detectLinkPlatform(
  item: Pick<ReferenceItem, "kind" | "source_url">,
): LinkPlatform | null {
  if (item.kind === "youtube") return "youtube";
  if (item.kind !== "link") return null;
  const host = safeHostname(item.source_url);
  if (!host) return "other";
  for (const { platform, regex } of HOST_PATTERNS) {
    if (regex.test(host)) return platform;
  }
  return "other";
}

/* 분류(카운트 / Types 필터) 용 정규화된 kind. 저장 단계에서
   detectAnimatedRasterKind 가 animated WebP 를 `kind: "gif"` 로 승격해
   GIF 재생 파이프라인을 태우는 부수효과가 있는데, 사용자 시점에선 여전히
   "WebP" 자료다. 본 함수는 mime 으로 그 케이스만 되돌려서, 그리드 배지
   라벨 / Types 필터 매칭 / Types 카운트가 한 정의를 공유하도록 한다.
   동작 분기(재생기 선택 등)는 *원본* item.kind 그대로 사용해야 한다 —
   GifFramePlayer 는 animated WebP 도 함께 처리하므로. */
export function resolveDisplayKind(
  item: Pick<ReferenceItem, "kind" | "mime_type">,
): ReferenceKind {
  if (item.kind === "gif" && item.mime_type === "image/webp") return "webp";
  return item.kind;
}

/* 약어형 확장자(영숫자 ≤5자) 만 lowercase 로 추출. doc 카드 배지에서
   `GIF`/`URL` 처럼 UPPER 표기할 후보를 찾는 데 사용. mime → file_url → title
   순서로 검사하고, 단어형(점/하이픈 포함, 6자 이상) 은 모두 null 로 떨어뜨려
   호출부가 subtype 의 TitleCase 라벨로 폴백하게 한다. */
function pickAcronymExtension(
  item: Pick<ReferenceItem, "mime_type" | "file_url" | "title">,
): string | null {
  const ACRONYM = /^[a-z0-9]{1,5}$/;
  /* MIME subtype 가 octet-stream / vnd.openxmlformats-... 류는 약어가 아니라
     식별 가치가 없다 — file_url/title 의 확장자로 넘어간다. */
  if (item.mime_type) {
    const sub = item.mime_type.split("/")[1]?.toLowerCase();
    if (sub && ACRONYM.test(sub)) return sub;
  }
  for (const source of [item.file_url, item.title]) {
    if (!source) continue;
    const m = source.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    const ext = m?.[1]?.toLowerCase();
    if (ext && ACRONYM.test(ext)) return ext;
  }
  return null;
}

/* 썸네일 배지 / 인스펙터 상단 배지에 표시할 라벨.
 *
 * - URL 계열(youtube/link): 항상 플랫폼 라벨로 표기 → "YouTube"/"Pinterest"/
 *   "Instagram"/"TikTok"/"Behance"/"URL". 사용자 명시: Behance 페이지에서 GIF
 *   썸네일을 가져오더라도 "GIF" 가 아닌 "Behance" 로 표시되어야 한다 (mime
 *   기반 override 는 link 에서는 하지 않음).
 * - 비 URL 계열: kind 라벨이 기본. 단 animated WebP (detectAnimatedRasterKind
 *   가 kind=gif 로 승격한 항목) 은 mime 으로 보정해 "WebP" 표시.
 * - doc 계열: 확장자가 약어형(≤5자, 영숫자)이면 UPPER ("PDF"/"PPTM"/"ZIP")
 *   — `GIF`/`URL` 의 약어 케이싱 규칙과 동일. 그 외 길거나 단어 모양 확장자는
 *   subtype 의 TitleCase 라벨로 폴백 ("Document"/"Spreadsheet"/"Web Page") —
 *   `Image`/`Video` 와 동일한 결. */
export function resolveTypeLabel(
  item: Pick<ReferenceItem, "kind" | "source_url" | "mime_type" | "file_url" | "title">,
): string {
  if (item.kind === "youtube" || item.kind === "link") {
    const platform = detectLinkPlatform(item) ?? "other";
    return LINK_PLATFORM_LABEL[platform];
  }
  if (item.kind === "gif" && item.mime_type === "image/webp") return "WebP";
  switch (item.kind) {
    case "image":
      return "Image";
    case "webp":
      return "WebP";
    case "gif":
      return "GIF";
    case "video":
      return "Video";
    case "doc": {
      /* extensionFromItem 를 *재호출하지 않고* 직접 mime/url/title 에서 약어형
         확장자를 추출 — extensionFromItem 의 최종 폴백이 resolveTypeLabel 이라
         doc 가 호출 측에서 또 들어오면 무한 재귀가 된다. 여기서 직접 잘라 둠. */
      const ext = pickAcronymExtension(item);
      if (ext) return ext.toUpperCase();
      return docPresentationOfSubtype(
        detectDocSubtype(item.mime_type ?? null, item.title ?? null),
      ).labelEn;
    }
    default:
      return "Item";
  }
}

/* 인스펙터 "종류" 필드가 쓰는 *포맷 기준* 라벨 정리기.
 *
 * 기존엔 `mime_type ?? resolveTypeLabel` 로 보여줘서, URL 자료가 썸네일의
 * mime(image/png)을 그대로 노출하는 버그가 있었다. 종류는 "파일이 무엇이냐"
 * 를 사용자 언어로 보여줘야 하므로 kind 별로 일관되게 정한다:
 *
 *   - URL 계열(youtube/link): 항상 플랫폼 라벨(URL/YouTube/Pinterest/…).
 *     썸네일 mime/확장자는 무시 — "이건 웹 링크" 라는 사실이 우선.
 *   - doc 계열: 호출부가 docExtensionTag 로 PSD/PDF/ZIP 등 태그를 준다(여기선
 *     다루지 않음, 아래 resolveFormatLabel 은 비-doc 만 책임).
 *   - 미디어(image/webp/gif/video): 실제 포맷 확장자를 대문자로(PNG/JPEG/MP4/
 *     MOV/WEBP/GIF). mime subtype → file_url → title 순으로 약어형(≤5자) 만
 *     채택하므로 video/quicktime 같은 긴 subtype 은 .mov 확장자로 자연 폴백.
 *     추출 실패 시 kind 라벨(Image/Video/…) 로 폴백. */
export function resolveFormatLabel(
  item: Pick<ReferenceItem, "kind" | "source_url" | "mime_type" | "file_url" | "title">,
): string {
  if (item.kind === "youtube" || item.kind === "link") {
    return LINK_PLATFORM_LABEL[detectLinkPlatform(item) ?? "other"];
  }
  const ext = pickAcronymExtension(item);
  if (ext) return ext.toUpperCase();
  return resolveTypeLabel(item);
}

/** 리스트 뷰의 Extension 컬럼 + Sort 의 "extension" 키가 공유하는 추출 로직.
 *
 *  표기 정책 — "그 포맷의 가장 자연스러운 형태" 를 그대로 노출한다:
 *    · MIME subtype / file_url 확장자 → lowercase ("webp", "gif", "mp4")
 *      파일 시스템의 .확장자 컨벤션과 일치, Eagle/Finder 와 같은 표기.
 *    · platform/kind 폴백 → resolveTypeLabel 의 TitleCase 그대로
 *      ("YouTube", "Pinterest", "Image"). 강제 lowercase 하면 "youtube"
 *      같은 어색한 형태가 되어 가독성이 떨어진다.
 *
 *  5자 초과 확장자는 잘못 추출된 query string fragment 가능성이 커서
 *  platform 라벨로 우회한다. */
export function extensionFromItem(
  item: Pick<ReferenceItem, "kind" | "source_url" | "mime_type" | "file_url" | "title">,
): string {
  if (item.mime_type) {
    const sub = item.mime_type.split("/")[1];
    if (sub) return sub.toLowerCase();
  }
  if (item.file_url) {
    const m = item.file_url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    if (m && m[1].length <= 5) return m[1].toLowerCase();
  }
  return resolveTypeLabel(item);
}
