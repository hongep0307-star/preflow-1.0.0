// ── 이미지로 검색 (Imgur 경유 + 멀티 엔진, 외부 브라우저) ──────────
// 구글은 "raw 업로드 → 결과 열기" 를 세션 토큰 검사로 막고(앱 내장 업로드는
// 모두 403/만료), 일부 익명 호스트(catbox/litterbox)는 회사 보안(Defender)이
// C2 로 차단한다. 그래서 평판 호스트(Imgur)를 경유한다:
//   1) 자료 이미지를 Imgur 에 익명 업로드해 *공개 URL* 을 얻고
//   2) 그 URL 로 OS 기본 브라우저(크롬 등)에서 선택 엔진의 by-URL 검색을 연다.
// 검색 서버가 공개 URL 을 직접 가져가 검색하므로, 사용자 브라우저의 자기 세션
// 에서 결과가 정상 표시된다(세션/403 문제 없음).
//
// 엔진(렌더러 src/lib/imageSearchEngines.ts 와 문자열 id 로 계약):
//   · google-lens : 시각 검색 + 객체 인식
//   · yandex      : 시각 유사도 최강(Pinterest 핀 다수 노출)
//   · tineye      : 역방향 이미지(원본/사용처 추적)
// Bing 은 by-URL 비주얼 검색 파라미터가 불안정해 제외.
//
// 프라이버시: 이미지가 Imgur(공개) 에 업로드된다. URL 은 추측 불가능한 랜덤.

import { shell } from "electron";

import { getSettings } from "./settings";

export type ImageSearchEngineId = "google-lens" | "yandex" | "tineye";

const DEFAULT_ENGINE: ImageSearchEngineId = "google-lens";

/** 엔진별 by-URL 검색 딥링크 빌더. publicUrl 은 Imgur 직링크. */
const ENGINE_URL_BUILDERS: Record<ImageSearchEngineId, (publicUrl: string) => string> = {
  "google-lens": (u) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}`,
  yandex: (u) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}`,
  tineye: (u) => `https://www.tineye.com/search?url=${encodeURIComponent(u)}`,
};

function resolveEngine(engine: unknown): ImageSearchEngineId {
  return engine === "yandex" || engine === "tineye" || engine === "google-lens"
    ? engine
    : DEFAULT_ENGINE;
}

// 공개 기본 Client-ID — 설정(imgur_client_id) 이 없을 때 폴백. 공유 ID 라
// rate-limit 이 빡빡하므로, 자주 쓰면 본인 Imgur 앱 Client-ID 설정 권장.
const DEFAULT_IMGUR_CLIENT_ID = "546c25a59c58ad7";

/** Imgur 에 익명 업로드하고 공개 직링크(i.imgur.com/...) 를 반환한다. 입력은
 *  렌더러가 canvas 로 변환해 보낸 JPEG 바이트라 포맷 호환은 보장된다. */
async function uploadToImgur(image: Buffer): Promise<string> {
  const clientId = (getSettings().imgur_client_id || DEFAULT_IMGUR_CLIENT_ID).trim();
  const form = new FormData();
  form.append("image", image.toString("base64"));
  form.append("type", "base64");

  const res = await fetch("https://api.imgur.com/3/image", {
    method: "POST",
    headers: { Authorization: `Client-ID ${clientId}` },
    body: form,
  });
  const json = (await res.json().catch(() => null)) as { data?: { link?: string } } | null;
  const link = json?.data?.link;
  if (!res.ok || !link) {
    throw new Error(
      `imgur upload failed: ${res.status} ${JSON.stringify(json?.data ?? json).slice(0, 200)}`,
    );
  }
  return link;
}

/** 자료 이미지로 선택 엔진의 by-URL 검색을 외부 브라우저에서 연다. */
export async function runImageSearch(
  image: Buffer,
  engine: ImageSearchEngineId | string = DEFAULT_ENGINE,
): Promise<void> {
  const engineId = resolveEngine(engine);
  const publicUrl = await uploadToImgur(image);
  await shell.openExternal(ENGINE_URL_BUILDERS[engineId](publicUrl));
}
