/**
 * 라이브러리 레퍼런스 1개 → 아이데이션(Agent) 채팅 첨부(ChatImage) 빌더.
 * - 정지 이미지: 원본 다운스케일 webp 1장.
 * - 영상/GIF: 정지 썸네일(poster) 1장 + mediaKind(작성칸 좌상단 뱃지) + 화면엔
 *   안 보이는 extraFrames(sampled_frames)/AI 분석 caption 을 LLM 에만 동반.
 *
 * LibraryPage(현재 워크스페이스) 와 LibraryImportDialog(cross-workspace, rewrite
 * URL) 양쪽에서 재사용한다. 입력은 ReferenceItem / CrossWorkspaceReference 모두를
 * 수용하는 최소 형태.
 */
import { urlToStorageImageBase64 } from "./referenceLibrary";
import type { ChatImage } from "@/components/agent/agentTypes";

export interface AgentAttachSource {
  kind: string;
  title: string;
  file_url?: string | null;
  thumbnail_url?: string | null;
  ai_suggestions?: Record<string, unknown> | null;
}

type AiSug = Record<string, any> | null | undefined;

function pickRefStr(sug: AiSug, key: string, prefKo: boolean): string {
  if (!sug) return "";
  const a = prefKo ? sug[`${key}_ko`] : sug[key];
  const b = prefKo ? sug[key] : sug[`${key}_ko`];
  const v = typeof a === "string" && a.trim() ? a : typeof b === "string" && b.trim() ? b : "";
  return typeof v === "string" ? v.trim() : "";
}
function pickRefArr(sug: AiSug, key: string, prefKo: boolean): string[] {
  if (!sug) return [];
  const a = prefKo ? sug[`${key}_ko`] : sug[key];
  const b = prefKo ? sug[key] : sug[`${key}_ko`];
  const arr = Array.isArray(a) && a.length ? a : Array.isArray(b) ? b : [];
  return arr.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0);
}

/** ai_suggestions → 한/영 요약 caption(LLM 전용). */
export function buildRefCaption(item: AgentAttachSource, prefKo: boolean): string {
  const sug = item.ai_suggestions as AiSug;
  if (!sug) return "";
  const isMotion = item.kind === "video" || item.kind === "gif";
  const L = (ko: string, en: string) => (prefKo ? ko : en);
  const lines: string[] = [];
  const title = item.title?.trim();
  const scene = pickRefStr(sug, "scene_description", prefKo);
  const style = pickRefStr(sug, "visual_style", prefKo);
  const motion = pickRefStr(sug, "motion_notes", prefKo);
  const shot = pickRefStr(sug, "shot_type", prefKo);
  const color = pickRefStr(sug, "color_notes", prefKo);
  const moods = pickRefArr(sug, "mood_labels", prefKo);
  const tags = pickRefArr(sug, "suggested_tags", prefKo);
  const kindLabel = item.kind === "video" ? L("영상", "video") : item.kind === "gif" ? L("GIF", "gif") : L("이미지", "image");
  if (title) lines.push(`• ${L("자료", "Asset")}: ${title} (${kindLabel})`);
  if (scene) lines.push(`• ${L("장면", "Scene")}: ${scene}`);
  if (isMotion && motion) lines.push(`• ${L("모션", "Motion")}: ${motion}`);
  if (isMotion && shot) lines.push(`• ${L("샷", "Shot")}: ${shot}`);
  if (style) lines.push(`• ${L("스타일", "Style")}: ${style}`);
  if (color) lines.push(`• ${L("색감", "Color")}: ${color}`);
  if (moods.length) lines.push(`• ${L("무드", "Mood")}: ${moods.join(", ")}`);
  if (tags.length) lines.push(`• ${L("태그", "Tags")}: ${tags.slice(0, 8).join(", ")}`);
  return lines.join("\n");
}

/** ai_suggestions.sampled_frames 에서 균등 간격으로 최대 max 장. */
export function extraFramesFromRef(item: AgentAttachSource, max: number): Array<{ base64: string; mediaType: string }> {
  const sug = item.ai_suggestions as AiSug;
  const frames = sug?.sampled_frames;
  if (!Array.isArray(frames) || frames.length === 0 || max <= 0) return [];
  const valid = frames.filter((f: any) => f && typeof f.base64 === "string" && f.base64.length > 0);
  if (valid.length === 0) return [];
  const n = Math.min(max, valid.length);
  const picked: any[] = [];
  if (n >= valid.length) picked.push(...valid);
  else for (let i = 0; i < n; i += 1) picked.push(valid[Math.round((i * (valid.length - 1)) / (n - 1 || 1))]);
  return picked.map((f: any) => ({
    base64: f.base64 as string,
    mediaType: typeof f.mediaType === "string" && f.mediaType.startsWith("image/") ? f.mediaType : "image/jpeg",
  }));
}

/** 레퍼런스 1개 → ChatImage 1장(+ 숨김 프레임/caption). 쓸 이미지가 없으면 null. */
export async function buildAgentAttachmentForRef(item: AgentAttachSource, prefKo: boolean): Promise<ChatImage | null> {
  const isMotion = item.kind === "video" || item.kind === "gif";
  // video: file_url 은 mp4 라 <img> 디코드 불가 → poster(thumbnail_url) 만 사용.
  // gif: file_url(gif) 첫 프레임 디코드 가능하니 thumbnail 우선·file_url 폴백.
  // 정지 이미지: 원본(file_url) 우선.
  const src =
    item.kind === "video"
      ? item.thumbnail_url
      : item.kind === "gif"
        ? item.thumbnail_url || item.file_url
        : item.file_url || item.thumbnail_url;
  if (!src) return null;
  try {
    const { base64, mediaType } = await urlToStorageImageBase64(src, 1280, 0.82);
    const img: ChatImage = { base64, mediaType, preview: `data:${mediaType};base64,${base64}` };
    if (isMotion) {
      img.mediaKind = item.kind as "gif" | "video";
      const frames = extraFramesFromRef(item, 4);
      if (frames.length > 0) img.extraFrames = frames;
    }
    const caption = buildRefCaption(item, prefKo);
    if (caption) img.caption = caption;
    return img;
  } catch {
    return null;
  }
}
