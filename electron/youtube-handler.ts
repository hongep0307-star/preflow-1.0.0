/**
 * YouTube 메타/자막 ingest 핸들러.
 *
 * v1 전략:
 *   1. videoId 파싱 (watch?v= / youtu.be / shorts/ / embed/)
 *   2. oEmbed (https://www.youtube.com/oembed?...) 로 title/author/thumbnail 획득
 *   3. timedtext 자동 자막 시도 (best-effort, 실패해도 ingest 자체는 ready)
 *
 * 외부 npm 의존성 0 — Node 내장 fetch 만 사용.
 * `youtube-transcript` 패키지를 도입할 수도 있으나 v1 에서는 실패 시 graceful 하게
 * 빈 transcript 로 폴백하는 best-effort 방식이 유지보수가 쉽다.
 */
import { fetchWithRetry } from "./http-utils";

export interface YoutubeIngestResult {
  videoId: string;
  url: string;
  title?: string;
  channel?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  transcript?: string;
  /** 자막을 가져오지 못한 경우 사용자에게 보여줄 안내 */
  transcriptWarning?: string;
}

/* 지원 URL 포맷은 src/lib/youtube.ts 의 YOUTUBE_URL_REGEX 와 동일하게 유지.
 *
 *   - youtube.com/watch?v=<ID>
 *   - youtu.be/<ID>
 *   - youtube.com/{shorts,embed,v,live}/<ID>
 *   - youtube-nocookie.com/embed/<ID>
 *
 * "/live/" 와 "youtube-nocookie.com" 누락이 라이브 스트림 / 개인정보보호 임베드
 * URL 의 썸네일 추출이 실패하는 원인이었음. */
const VIDEO_ID_REGEXES = [
  /(?:youtube(?:-nocookie)?\.com\/watch\?[^#]*?v=|youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:shorts|embed|v|live)\/)([A-Za-z0-9_-]{11})/,
  /^([A-Za-z0-9_-]{11})$/,
];

function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  for (const re of VIDEO_ID_REGEXES) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchOembed(canonicalUrl: string): Promise<{ title?: string; author?: string; thumbnail?: string }> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const res = await fetchWithRetry(
      oembedUrl,
      { method: "GET" },
      { label: "yt-oembed", timeoutMs: 15_000, retries: 2 },
    );
    if (!res.ok) return {};
    const json = (await res.json()) as any;
    return {
      title: json?.title,
      author: json?.author_name,
      thumbnail: json?.thumbnail_url,
    };
  } catch (e) {
    console.warn("[yt-ingest] oembed failed:", (e as Error).message);
    return {};
  }
}

/**
 * timedtext 엔드포인트 best-effort 시도. 자동 자막 (asr) 영어 우선.
 * 영어 자막이 있으면 가져오고, 없으면 한국어 시도, 그래도 없으면 빈 string.
 *
 * 실패 모드가 너무 많아 (지역락/연령제한/자막없음) 모두 catch + warn 만 하고
 * 분석 시점에는 transcript 가 있으면 추가 컨텍스트, 없으면 썸네일+메타로만 분석.
 */
async function fetchTranscriptBestEffort(videoId: string): Promise<{ transcript: string; warning?: string }> {
  const langs = ["en", "ko", "ja"];
  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`;
      const res = await fetchWithRetry(
        url,
        { method: "GET" },
        { label: `yt-timedtext:${lang}`, timeoutMs: 10_000, retries: 0 },
      );
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.length < 10) continue;
      try {
        const json = JSON.parse(text);
        const events = json?.events as any[] | undefined;
        if (!events?.length) continue;
        const lines: string[] = [];
        for (const ev of events) {
          if (!ev?.segs) continue;
          const segText = ev.segs.map((s: any) => s?.utf8 ?? "").join("");
          const trimmed = segText.replace(/\n/g, " ").trim();
          if (trimmed) lines.push(trimmed);
        }
        const transcript = lines.join(" ").slice(0, 30_000);
        if (transcript.length > 50) return { transcript };
      } catch {
        /* not json3 — skip */
      }
    } catch {
      /* try next lang */
    }
  }
  return {
    transcript: "",
    warning: "자막을 자동으로 가져오지 못했습니다. 썸네일과 메타데이터만으로 분석합니다.",
  };
}

export async function handleYoutubeIngest(body: any): Promise<YoutubeIngestResult | { error: string }> {
  const url = body?.url as string | undefined;
  if (!url) return { error: "url is required" };
  const videoId = parseVideoId(url);
  if (!videoId) return { error: "유효하지 않은 YouTube URL 입니다." };
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const [oembed, transcriptResult] = await Promise.all([
    fetchOembed(canonical),
    fetchTranscriptBestEffort(videoId),
  ]);
  return {
    videoId,
    url: canonical,
    title: oembed.title,
    channel: oembed.author,
    thumbnailUrl: oembed.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    transcript: transcriptResult.transcript || undefined,
    transcriptWarning: transcriptResult.warning,
  };
}
