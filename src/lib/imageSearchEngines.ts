// ── 이미지로 검색 엔진 레지스트리 (렌더러) ──────────────────────────
// "이미지로 검색" 컨텍스트 서브메뉴가 노출할 엔진 목록의 단일 소스.
//
// 실제 검색 URL 빌드는 메인(electron/lensSearch.ts)이 담당한다 — 자료
// 이미지를 Imgur 에 익명 업로드해 *공개 URL* 을 얻은 뒤 엔진별 딥링크를
// 외부 브라우저로 열기 때문. 여기서는 메뉴에 필요한 id + i18n 라벨 키만
// 둔다. 메인의 builder map 과는 문자열 id 로 계약을 맞춘다.
//
// Bing 은 by-URL 비주얼 검색 파라미터가 자주 바뀌어(불안정) 제외했다.
// Google Lens / Yandex / TinEye 는 검증된 공개 딥링크라 안정적이다.

export type ImageSearchEngineId = "google-lens" | "yandex" | "tineye";

export interface ImageSearchEngineMeta {
  id: ImageSearchEngineId;
  /** uiCopy.ts 의 라벨 키 */
  labelKey: string;
}

export const IMAGE_SEARCH_ENGINES: ImageSearchEngineMeta[] = [
  { id: "google-lens", labelKey: "library.grid.ctx.searchByImage.googleLens" },
  { id: "yandex", labelKey: "library.grid.ctx.searchByImage.yandex" },
  { id: "tineye", labelKey: "library.grid.ctx.searchByImage.tineye" },
];

export const DEFAULT_IMAGE_SEARCH_ENGINE: ImageSearchEngineId = "google-lens";

export function isImageSearchEngineId(value: unknown): value is ImageSearchEngineId {
  return (
    value === "google-lens" ||
    value === "yandex" ||
    value === "tineye"
  );
}
