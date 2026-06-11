/**
 * YouTube 메타/자막 ingest 의 프런트 헬퍼.
 *
 * BriefTab 의 Reference 패널에서 사용자가 URL 을 붙여넣으면 즉시 호출.
 * 핸들러 호출 자체는 빠르지만 oEmbed/timedtext 가 막힐 수 있으므로
 * 실패 시 fallback 결과 (videoId + 썸네일 추정 URL) 를 반환해 UI 가
 * 항상 칩을 그릴 수 있게 한다.
 */
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

export interface YoutubeIngestResult {
  videoId: string;
  url: string;
  title?: string;
  channel?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  transcript?: string;
  transcriptWarning?: string;
}

/* YouTube URL 매처.
 *
 * 지원 포맷:
 *   - youtube.com/watch?v=<ID>          (표준)
 *   - youtu.be/<ID>                      (short link)
 *   - youtube.com/shorts/<ID>           (Shorts)
 *   - youtube.com/embed/<ID>            (embed)
 *   - youtube.com/v/<ID>                (구 임베드)
 *   - youtube.com/live/<ID>             (라이브 스트림 — 누락돼 있던 케이스)
 *   - youtube-nocookie.com/embed/<ID>   (개인정보보호 임베드)
 *
 * m. / www. 서브도메인 모두 허용. */
export const YOUTUBE_URL_REGEX =
  /^(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?[^#]*?v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export function isYoutubeUrl(input: string): boolean {
  return YOUTUBE_URL_REGEX.test(input.trim());
}

/** 자료 URL → 인앱 iframe 임베드용 URL.
 *
 *  - 도메인은 항상 `youtube-nocookie.com` 을 사용한다. nocookie 임베드는
 *    youtube.com 보다 *embed/Referer 검증이 느슨해* prod (file:// origin)
 *    환경에서 임베드 거부 (player error 153 / ERR_BLOCKED_BY_RESPONSE) 가
 *    훨씬 적게 발생한다. 일반 watch 페이지에서 가져온 ID 도 그대로 사용 가능.
 *  - `?origin=https://www.youtube.com` 은 IFrame API 의 postMessage 출처를
 *    youtube.com 으로 고정해 동일출처 정책 우회.
 *  - `?rel=0` 은 추천 영상을 같은 채널로만 제한해 사용자 경험을 일관되게.
 *
 *  파싱 실패시 null — 호출부에서 일반 link 분기로 폴백.
 *
 *  과거에는 LibraryPreviewPanel / LibraryInspector / viewer PreviewModal 셋이
 *  각자 같은 정규식을 갖고 있었다 → 한 곳 고치면 다른 곳이 흔들리는 fragile
 *  상태. 모두 이 함수를 import 해서 단일 진실원으로 통합. */
export function youtubeEmbedUrl(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(YOUTUBE_URL_REGEX);
  if (!m?.[1]) return null;
  return `https://www.youtube-nocookie.com/embed/${m[1]}?origin=https%3A%2F%2Fwww.youtube.com&rel=0`;
}

export async function ingestYoutube(url: string): Promise<YoutubeIngestResult> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}/api/youtube-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `YouTube ingest HTTP ${res.status}`);
  }
  const data = (await res.json()) as YoutubeIngestResult & { error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}
