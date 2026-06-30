/* Viewer 전용 platform 라벨 — 메인 앱 src/lib/linkPlatform.ts 의 viewer 사본.
 *
 * 메인 앱은 ReferenceItem 으로부터 youtube/pinterest/instagram/tiktok/behance
 * /url 을 source_url 호스트로 판별해 "Behance" 같은 정식 표기를 보여준다.
 * viewer 도 같은 라벨을 써야 export 결과 그리드의 종류 뱃지가 메인 앱과
 * 동일하게 보인다. 메인 앱 파일을 직접 import 하면 supabase 등 무거운
 * 의존성을 viewer 번들로 끌고 들어오므로 *호스트 매칭 + 라벨 맵* 만 옮긴다. */

import type { ReferenceItem, ReferenceKind } from "./types";

export type LinkPlatform =
  | "youtube"
  | "vimeo"
  | "pinterest"
  | "instagram"
  | "tiktok"
  | "behance"
  | "other";

const LINK_PLATFORM_LABEL: Record<LinkPlatform, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  pinterest: "Pinterest",
  instagram: "Instagram",
  tiktok: "TikTok",
  behance: "Behance",
  other: "URL",
};

const HOST_PATTERNS: ReadonlyArray<{ platform: Exclude<LinkPlatform, "other">; regex: RegExp }> = [
  { platform: "youtube", regex: /^((www|m)\.)?(youtube\.com|youtube-nocookie\.com)$/ },
  { platform: "youtube", regex: /^youtu\.be$/ },
  { platform: "vimeo", regex: /^(www\.|player\.)?vimeo\.com$/ },
  { platform: "pinterest", regex: /^([a-z0-9-]+\.)?pinterest\.([a-z]{2,3})(\.[a-z]{2})?$/ },
  { platform: "pinterest", regex: /^pin\.it$/ },
  { platform: "instagram", regex: /^(www\.)?instagram\.com$/ },
  { platform: "tiktok", regex: /^((www|vm|vt|m)\.)?tiktok\.com$/ },
  { platform: "behance", regex: /^(www\.)?behance\.net$/ },
];

function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

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

/* doc(=비미디어 파일) 서브타입 — 메인 앱 referenceLibrary.detectDocSubtype 의
 *  viewer 사본(순수 함수). mime_type 우선, 없으면 file_url/title 의 확장자로 폴백.
 *  뱃지 라벨 + 뷰어 지원 여부(PDF/Audio 만 인뷰 표시) 판정에 쓴다. */
export type DocSubtype =
  | "pdf"
  | "psd"
  | "font"
  | "archive"
  | "spreadsheet"
  | "presentation"
  | "document"
  | "executable"
  | "html"
  | "code"
  | "audio"
  | "other";

export function detectDocSubtype(mime: string | null | undefined, name?: string | null): DocSubtype {
  const m = (mime ?? "").toLowerCase();
  const ext = (name ?? "").match(/\.[a-z0-9]+(?:[?#]|$)/i)?.[0]?.replace(/[?#]$/, "").toLowerCase() ?? "";

  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m === "image/vnd.adobe.photoshop" || m === "application/x-photoshop" || [".psd", ".psb"].includes(ext)) return "psd";
  if (m.startsWith("font/") || [".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "font";
  if (
    m === "application/zip" || m === "application/x-7z-compressed" || m === "application/x-rar-compressed" ||
    m === "application/vnd.rar" || m === "application/x-tar" || m === "application/gzip" ||
    [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"].includes(ext)
  ) return "archive";
  if (m.includes("spreadsheet") || m.includes("excel") || m === "text/csv" ||
    [".xls", ".xlsx", ".xlsm", ".csv", ".numbers", ".ods"].includes(ext)) return "spreadsheet";
  if (m.includes("presentation") || m.includes("powerpoint") ||
    [".ppt", ".pptx", ".pptm", ".key", ".odp"].includes(ext)) return "presentation";
  if (m.includes("msword") || m.includes("officedocument.wordprocessingml") || m === "application/rtf" ||
    [".doc", ".docx", ".docm", ".rtf", ".odt", ".pages", ".txt", ".md"].includes(ext)) return "document";
  if ([".exe", ".msi", ".dmg", ".pkg", ".app", ".apk", ".deb", ".rpm", ".bat", ".cmd", ".com", ".scr", ".ps1", ".sh", ".bash"].includes(ext)) return "executable";
  if (m === "text/html" || ext === ".html" || ext === ".htm") return "html";
  if ([".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".php", ".lua", ".json", ".yaml", ".yml", ".xml", ".toml", ".ini", ".sql"].includes(ext)) return "code";
  if (m.startsWith("audio/") || [".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"].includes(ext)) return "audio";
  return "other";
}

const DOC_SUBTYPE_LABEL: Record<DocSubtype, string> = {
  pdf: "PDF",
  psd: "PSD",
  font: "Font",
  archive: "ZIP",
  spreadsheet: "Sheet",
  presentation: "Slides",
  document: "Document",
  executable: "App",
  html: "HTML",
  code: "Code",
  audio: "Audio",
  other: "File",
};

/** doc 자료의 인뷰어 표시 모드 — PDF 는 iframe, audio 는 <audio>. 그 외는 미지원. */
export function docViewMode(
  item: Pick<ReferenceItem, "mime_type" | "file_url" | "title">,
): "pdf" | "audio" | null {
  const sub = detectDocSubtype(item.mime_type, item.file_url ?? item.title);
  if (sub === "pdf") return "pdf";
  if (sub === "audio") return "audio";
  return null;
}

/** 더블클릭/모달로 "열 수 있는" 자료인지. doc 은 PDF/Audio 만 열고, 그 외
 *  (zip/문서/실행파일 등) 은 뷰어가 표시 못 하므로 더블클릭을 막는다. */
export function isOpenable(
  item: Pick<ReferenceItem, "kind" | "mime_type" | "file_url" | "title">,
): boolean {
  if (item.kind === "doc") return docViewMode(item) !== null;
  return true;
}

/* 메인 앱 resolveTypeLabel 의 viewer 사본 — Behance 페이지의 GIF 썸네일이
 *  들어와도 "GIF" 가 아닌 "Behance" 로 표시되도록 platform 우선. */
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
    case "doc":
      return DOC_SUBTYPE_LABEL[detectDocSubtype(item.mime_type, item.file_url ?? item.title)];
    default:
      return "Item";
  }
}

export function resolveDisplayKind(
  item: Pick<ReferenceItem, "kind" | "mime_type">,
): ReferenceKind {
  if (item.kind === "gif" && item.mime_type === "image/webp") return "webp";
  return item.kind;
}
