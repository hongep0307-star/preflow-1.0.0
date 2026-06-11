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
  | "pinterest"
  | "instagram"
  | "tiktok"
  | "behance"
  | "other";

const LINK_PLATFORM_LABEL: Record<LinkPlatform, string> = {
  youtube: "YouTube",
  pinterest: "Pinterest",
  instagram: "Instagram",
  tiktok: "TikTok",
  behance: "Behance",
  other: "URL",
};

const HOST_PATTERNS: ReadonlyArray<{ platform: Exclude<LinkPlatform, "other">; regex: RegExp }> = [
  { platform: "youtube", regex: /^((www|m)\.)?(youtube\.com|youtube-nocookie\.com)$/ },
  { platform: "youtube", regex: /^youtu\.be$/ },
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

/* 메인 앱 resolveTypeLabel 의 viewer 사본 — Behance 페이지의 GIF 썸네일이
 *  들어와도 "GIF" 가 아닌 "Behance" 로 표시되도록 platform 우선. */
export function resolveTypeLabel(
  item: Pick<ReferenceItem, "kind" | "source_url" | "mime_type">,
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
