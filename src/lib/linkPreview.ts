/**
 * 렌더러용 링크 프리뷰 헬퍼.
 *
 * Eagle 처럼 일반 웹 링크(Behance, Instagram, 일반 블로그 등) 등록 시 페이지
 * 미리보기를 자동으로 잡아오기 위한 IPC wrapper. 실제 캡처는 Electron 메인
 * 프로세스의 `/api/link-preview` 가 담당하며, 이쪽은 best-effort 로 결과를
 * 받아오고 어떤 오류든 `null` 로 흡수해 호출 측 로직이 단순해지도록 한다.
 */
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

export interface LinkPreviewResult {
  pngBase64: string;
  width: number;
  height: number;
  /** 결과 바이트의 실제 MIME — image/gif 또는 image/webp 면 호출 측이 dual-asset
   *  (animated original + 정지 poster) 패턴을 적용해 그리드에서 호버시에만
   *  애니메이션이 재생되도록 만든다. screenshot 폴백은 항상 image/png. */
  mimeType: string;
  source: "og" | "oembed" | "screenshot";
}

export async function fetchLinkPreview(url: string): Promise<LinkPreviewResult | null> {
  try {
    const res = await fetch(`${LOCAL_SERVER_BASE_URL}/api/link-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<LinkPreviewResult> & { error?: string };
    if (data.error || !data.pngBase64) return null;
    const allowedSources = ["og", "oembed", "screenshot"] as const;
    const source = (allowedSources as readonly string[]).includes(data.source as string)
      ? (data.source as LinkPreviewResult["source"])
      : "og";
    const mimeType = typeof data.mimeType === "string" && data.mimeType.startsWith("image/")
      ? data.mimeType
      : "image/png";
    return {
      pngBase64: data.pngBase64,
      width: Number(data.width) || 0,
      height: Number(data.height) || 0,
      mimeType,
      source,
    };
  } catch {
    return null;
  }
}
