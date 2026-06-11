/**
 * Non-YouTube 링크 썸네일 자동 캡처.
 *
 * Eagle 의 "Add Web Link" 시 페이지 미리보기를 자동 채워주는 동작과 동등한 결과를 목표로 한다.
 *
 * 3단계 best-effort 전략:
 *   1. og:image / twitter:image 메타 시도 — Behance, 일반 블로그, 잘 큐레이션된
 *      소셜 게시물 대부분이 여기서 해결.
 *   2. 호스트별 공식 oEmbed JSON — TikTok / Vimeo / Flickr / SoundCloud 등
 *      `thumbnail_url` 을 명시적으로 노출하는 사이트. SPA 렌더 대기 없이 단번에
 *      깨끗한 미디어 스틸을 얻을 수 있다.
 *   3. hidden BrowserWindow 로 실제 페이지 로드 후 `webContents.capturePage()` —
 *      위 둘 다 실패했을 때만. 캡처 직전에 사이트 URL 을 임베드 경로로 정규화하고,
 *      로그인/쿠키 모달 같은 오버레이는 DOM 에서 제거해 화면을 정리한다.
 *
 * 어느 단계든 실패하면 `null` 처럼 동작 (= 에러 객체) 하고 호출 측은 그 경우
 * 썸네일 없이 link reference 를 만든다 (= 기존 동작).
 */
import { BrowserWindow, session, type Session } from "electron";
import { fetchWithRetry } from "./http-utils";
import { REAL_UA } from "./constants";

const PREVIEW_PARTITION = "persist:link-preview";

export interface LinkPreviewResult {
  pngBase64: string;
  width: number;
  height: number;
  /** 결과 이미지의 실제 MIME — gif/webp 면 렌더러가 dual-asset(animated original
   *  + 정지 poster) 패턴을 적용한다. screenshot 단계는 항상 image/png. */
  mimeType: string;
  source: "og" | "oembed" | "screenshot";
}

const HTML_FETCH_TIMEOUT_MS = 6_000;
const OG_IMAGE_FETCH_TIMEOUT_MS = 8_000;
const OEMBED_FETCH_TIMEOUT_MS = 6_000;
const SCREENSHOT_LOAD_TIMEOUT_MS = 10_000;
const SCREENSHOT_SETTLE_DELAY_MS = 1_500;
const MAX_HTML_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// ── 공용: 바이트 → MIME ────────────────────────────────────────────────────

/** content-type 헤더는 거짓말할 수 있어서 매직 바이트로 확정한다.
 *  포맷별 시그니처:
 *    GIF: "GIF87a" / "GIF89a"
 *    PNG: 89 50 4E 47
 *    JPEG: FF D8 FF
 *    WebP: "RIFF" .... "WEBP"  (애니메이션 여부는 4KB head 안의 "ANIM" 청크 존재로 판정) */
function detectImageMimeFromBytes(buf: ArrayBuffer, headerHint?: string): string {
  const view = new Uint8Array(buf);
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...view.subarray(start, start + len));
  if (view.length >= 6) {
    const gifMagic = ascii(0, 6);
    if (gifMagic === "GIF87a" || gifMagic === "GIF89a") return "image/gif";
  }
  if (view.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return "image/webp";
  }
  if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) {
    return "image/png";
  }
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
    return "image/jpeg";
  }
  const hint = (headerHint || "").toLowerCase();
  if (hint.startsWith("image/")) return hint.split(";")[0].trim();
  return "image/png";
}

// ── 1단계: og:image ─────────────────────────────────────────────────────────

function extractMetaContent(html: string, attr: "property" | "name", key: string): string | null {
  const reForward = new RegExp(
    `<meta[^>]*?${attr}=["']${key}["'][^>]*?content=["']([^"']+)["']`,
    "i",
  );
  const m1 = html.match(reForward);
  if (m1) return m1[1];
  const reReverse = new RegExp(
    `<meta[^>]*?content=["']([^"']+)["'][^>]*?${attr}=["']${key}["']`,
    "i",
  );
  const m2 = html.match(reReverse);
  return m2 ? m2[1] : null;
}

function pickOgImageUrl(html: string): string | null {
  const candidates = [
    ["property", "og:image:secure_url"] as const,
    ["property", "og:image:url"] as const,
    ["property", "og:image"] as const,
    ["name", "og:image"] as const,
    ["name", "twitter:image:src"] as const,
    ["name", "twitter:image"] as const,
  ];
  for (const [attr, key] of candidates) {
    const val = extractMetaContent(html, attr, key);
    if (val && val.trim()) return val.trim();
  }
  return null;
}

async function tryOgImage(pageUrl: string): Promise<LinkPreviewResult | null> {
  let html: string;
  try {
    const res = await fetchWithRetry(
      pageUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": REAL_UA,
          Accept: "text/html,application/xhtml+xml",
        },
      },
      { label: "link-preview-html", timeoutMs: HTML_FETCH_TIMEOUT_MS, retries: 1 },
    );
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  } catch (e) {
    console.warn("[link-preview] html fetch failed:", (e as Error).message);
    return null;
  }

  const rawOg = pickOgImageUrl(html);
  if (!rawOg) return null;

  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(rawOg, pageUrl).toString();
  } catch {
    return null;
  }
  return fetchImageAsResult(absoluteUrl, pageUrl, "og");
}

async function fetchImageAsResult(
  imageUrl: string,
  refererUrl: string,
  source: LinkPreviewResult["source"],
): Promise<LinkPreviewResult | null> {
  try {
    const imgRes = await fetchWithRetry(
      imageUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": REAL_UA,
          Referer: refererUrl,
          Accept: "image/*",
        },
      },
      { label: `link-preview-${source}`, timeoutMs: OG_IMAGE_FETCH_TIMEOUT_MS, retries: 1 },
    );
    if (!imgRes.ok) return null;
    const contentType = (imgRes.headers.get("content-type") ?? "").toLowerCase();
    const buf = await imgRes.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    const mimeType = detectImageMimeFromBytes(buf, contentType);
    if (!mimeType.startsWith("image/")) return null;
    return {
      pngBase64: Buffer.from(buf).toString("base64"),
      width: 0,
      height: 0,
      mimeType,
      source,
    };
  } catch (e) {
    console.warn(`[link-preview] ${source} image fetch failed:`, (e as Error).message);
    return null;
  }
}

// ── 2단계: 호스트별 oEmbed JSON ────────────────────────────────────────────

/** thumbnail_url 을 명시적으로 노출하는 oEmbed 사이트들. 캡쳐 페이지 렌더 대기
 *  없이 단번에 깨끗한 미디어 스틸을 얻을 수 있어 SPA-heavy 사이트에 결정적이다. */
function pickOembedEndpoint(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return `https://www.tiktok.com/oembed?url=${encodeURIComponent(rawUrl)}`;
  }
  if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
    return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(rawUrl)}`;
  }
  if (host === "flickr.com" || host.endsWith(".flickr.com") || host === "flic.kr") {
    return `https://www.flickr.com/services/oembed/?format=json&url=${encodeURIComponent(rawUrl)}`;
  }
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
    return `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(rawUrl)}`;
  }
  return null;
}

/* Instagram 전용 og:image 폴백.
 *
 * 일반 Instagram 게시물 URL 은 로그인 벽 / 클라이언트 렌더에 막혀 og:image 가
 * 제대로 안 잡힌다. 대신 인스타그램이 제공하는 *공식 임베드 페이지* 인
 * /p/<id>/embed/captioned/ 는:
 *   - 로그인 없이 접근 가능
 *   - 첫 컷에 해당하는 이미지가 og:image 메타로 노출되거나, 본문 HTML 안에
 *     <img class="EmbeddedMediaImage"> 형태로 직접 포함
 *
 * 으로 안정적인 컨텐츠 썸네일을 받을 수 있다. canonicalizeForCapture 가
 * 만들어 둔 임베드 URL 을 그대로 활용해 tryOgImage 를 한 번 더 시도. */
async function tryInstagramEmbedImage(pageUrl: string): Promise<LinkPreviewResult | null> {
  const embed = canonicalizeForCapture(pageUrl);
  if (embed === pageUrl) return null; // not Instagram
  const og = await tryOgImage(embed);
  if (og) return og;

  /* og:image 가 누락된 경우, 임베드 HTML 본문에서 <img class="EmbeddedMediaImage">
     의 src 를 직접 파싱해 폴백. */
  try {
    const res = await fetchWithRetry(
      embed,
      {
        method: "GET",
        headers: {
          "User-Agent": REAL_UA,
          Accept: "text/html,application/xhtml+xml",
        },
      },
      { label: "ig-embed-html", timeoutMs: HTML_FETCH_TIMEOUT_MS, retries: 1 },
    );
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
    /* class 우선, 없으면 첫 <img src> 폴백 (임베드 페이지는 단일 미디어 위주). */
    const classMatch = html.match(/<img[^>]*class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]*src=["']([^"']+)["']/i)
      || html.match(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*EmbeddedMediaImage[^"']*["']/i);
    const fallback = classMatch ? classMatch[1] : null;
    if (!fallback) return null;
    const abs = new URL(fallback, embed).toString();
    return fetchImageAsResult(abs, embed, "og");
  } catch (e) {
    console.warn("[link-preview] instagram embed parse failed:", (e as Error).message);
    return null;
  }
}

async function tryOembedThumbnail(pageUrl: string): Promise<LinkPreviewResult | null> {
  const endpoint = pickOembedEndpoint(pageUrl);
  if (!endpoint) return null;
  try {
    const res = await fetchWithRetry(
      endpoint,
      { method: "GET", headers: { "User-Agent": REAL_UA, Accept: "application/json" } },
      { label: "link-preview-oembed", timeoutMs: OEMBED_FETCH_TIMEOUT_MS, retries: 1 },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { thumbnail_url?: string };
    const thumb = json?.thumbnail_url?.trim();
    if (!thumb) return null;
    return fetchImageAsResult(thumb, pageUrl, "oembed");
  } catch (e) {
    console.warn("[link-preview] oembed fetch failed:", (e as Error).message);
    return null;
  }
}

// ── 3단계: BrowserWindow 스크린샷 ──────────────────────────────────────────

/** 사이트별 "로그인 모달이나 앱설치 배너 없이 콘텐츠만 보여주는" 정규 URL 로 치환.
 *  Instagram 의 /embed/captioned/ 처럼 사이트가 공식으로 제공하는 임베드 경로를
 *  활용해 우리가 DOM 을 후처리하는 부담을 줄인다. */
function canonicalizeForCapture(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      const m = u.pathname.match(/^\/(p|reel|tv)\/([^/]+)/);
      if (m) return `https://www.instagram.com/${m[1]}/${m[2]}/embed/captioned/`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

let cachedSession: Session | null = null;
function getPreviewSession(): Session {
  if (!cachedSession) {
    cachedSession = session.fromPartition(PREVIEW_PARTITION, { cache: true });
    cachedSession.setUserAgent(REAL_UA);
    cachedSession.on("will-download", (e) => e.preventDefault());
  }
  return cachedSession;
}

/** capturePage 직전에 한 번 주입해 일반 모달/쿠키 배너를 제거한다.
 *  너무 공격적이면 정상 콘텐츠도 지울 수 있으니 명백한 오버레이 selector 만 잡는다.
 *  Instagram embed 경로(/embed/captioned/) 같은 깨끗한 페이지에서는 아무 영향 없음. */
async function cleanupOverlays(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(
      `(() => {
        try {
          const sel = [
            'div[role="dialog"]',
            'div[role="presentation"][aria-modal="true"]',
            '[id*="cookie" i][id*="banner" i]',
            '[class*="cookie-banner" i]',
            '[class*="consent" i][class*="banner" i]',
            '[id*="onetrust" i]',
          ];
          document.querySelectorAll(sel.join(',')).forEach(el => el.remove());
          if (document.body) document.body.style.overflow = 'auto';
        } catch (_e) {}
      })()`,
      true,
    );
  } catch {
    /* 페이지 컨텍스트 부재/CSP 등은 무시 */
  }
}

async function tryScreenshot(pageUrl: string): Promise<LinkPreviewResult | null> {
  const targetUrl = canonicalizeForCapture(pageUrl);
  const previewSession = getPreviewSession();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    frame: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: previewSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      images: true,
      webgl: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.setUserAgent(REAL_UA);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.setMenu(null);

  let settled = false;
  const cleanup = () => {
    if (!win.isDestroyed()) {
      win.webContents.removeAllListeners();
      win.destroy();
    }
  };

  try {
    const captured = await new Promise<LinkPreviewResult | null>((resolve) => {
      const finish = (result: LinkPreviewResult | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const hardTimeout = setTimeout(() => {
        console.warn("[link-preview] hard timeout reached");
        finish(null);
      }, SCREENSHOT_LOAD_TIMEOUT_MS + SCREENSHOT_SETTLE_DELAY_MS + 2_000);

      const triggerCapture = async () => {
        try {
          await new Promise<void>((r) => setTimeout(r, SCREENSHOT_SETTLE_DELAY_MS));
          if (settled || win.isDestroyed()) return;
          await cleanupOverlays(win);
          if (settled || win.isDestroyed()) return;
          const image = await win.webContents.capturePage();
          if (settled) return;
          const size = image.getSize();
          const png = image.toPNG();
          if (!png || png.length === 0) {
            finish(null);
            return;
          }
          finish({
            pngBase64: png.toString("base64"),
            width: size.width,
            height: size.height,
            mimeType: "image/png",
            source: "screenshot",
          });
        } catch (e) {
          console.warn("[link-preview] capturePage failed:", (e as Error).message);
          finish(null);
        } finally {
          clearTimeout(hardTimeout);
        }
      };

      win.webContents.once("did-finish-load", () => {
        void triggerCapture();
      });
      win.webContents.once("did-stop-loading", () => {
        void triggerCapture();
      });
      win.webContents.once("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === -3) return;
        console.warn(`[link-preview] did-fail-load ${errorCode}: ${errorDescription}`);
        clearTimeout(hardTimeout);
        finish(null);
      });

      win.webContents.loadURL(targetUrl, { userAgent: REAL_UA }).catch((e) => {
        console.warn("[link-preview] loadURL rejected:", (e as Error).message);
        clearTimeout(hardTimeout);
        finish(null);
      });
    });
    return captured;
  } finally {
    cleanup();
  }
}

// ── 엔트리 ─────────────────────────────────────────────────────────────────

export async function handleLinkPreview(body: any): Promise<LinkPreviewResult | { error: string }> {
  const rawUrl = body?.url as string | undefined;
  if (!rawUrl) return { error: "url is required" };
  let normalized: string;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "Only http(s) URLs are supported." };
    }
    normalized = parsed.toString();
  } catch {
    return { error: "Invalid URL." };
  }

  const og = await tryOgImage(normalized);
  if (og) return og;

  /* Instagram 게시물은 표준 URL 로 og:image 를 못 따는 경우가 잦아, embed
     페이지로 한 번 더 시도. screenshot 폴백보다 안정적이고 컨텐츠 자체의
     첫 컷을 잡을 수 있어 시각 품질도 더 좋다. */
  const igEmbed = await tryInstagramEmbedImage(normalized);
  if (igEmbed) return igEmbed;

  const oembed = await tryOembedThumbnail(normalized);
  if (oembed) return oembed;

  const shot = await tryScreenshot(normalized);
  if (shot) return shot;

  return { error: "Couldn't capture a preview for this link." };
}
