/**
 * Vimeo URL → 인앱 임베드용 player URL. YouTube 의 `youtubeEmbedUrl` 과 같은 역할.
 *
 * Vimeo 자료는 전용 ingest 가 없어 항상 `kind: "link"` 로 저장된다. 프리뷰에서
 * 일반 watch 페이지(vimeo.com/123)를 webview 로 띄우면 동의/로그인 가드 때문에
 * 재생 버튼이 안 뜨는 경우가 많다. `player.vimeo.com/video/<id>` 임베드는 재생
 * 전용이라 바로 플레이어가 떠서 영상이 재생된다.
 *
 * 지원 포맷:
 *   - vimeo.com/123456789
 *   - vimeo.com/123456789/abcdef0123             (비공개 영상 hash)
 *   - vimeo.com/channels/<name>/123456789
 *   - vimeo.com/groups/<name>/videos/123456789
 *   - vimeo.com/album/<id>/video/123456789
 *   - player.vimeo.com/video/123456789
 *
 * www. / player. 서브도메인 모두 허용. 숫자 ID 추출에 실패하면(프로필/검색 등
 * 비영상 URL) null 을 돌려주어 호출부가 일반 link 분기로 폴백한다.
 */

const VIMEO_URL_REGEX =
  /^(?:https?:\/\/)?(?:www\.|player\.)?vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|album\/[^/]+\/video\/)?(\d+)(?:\/([A-Za-z0-9]+))?/;

export function isVimeoUrl(input: string): boolean {
  return VIMEO_URL_REGEX.test(input.trim());
}

/** 자료 URL → player 임베드 URL. 파싱 실패 시 null.
 *  비공개 영상의 hash(두 번째 캡처)는 `?h=` 파라미터로 전달해야 임베드가 허용된다. */
export function vimeoEmbedUrl(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(VIMEO_URL_REGEX);
  if (!m?.[1]) return null;
  const base = `https://player.vimeo.com/video/${m[1]}`;
  return m[2] ? `${base}?h=${m[2]}` : base;
}
