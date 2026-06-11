/**
 * friendlyError — 이미지 생성 계열 API 의 원문 에러를 사용자 친화 문구 키로
 * 매핑한다. LibraryPage 의 `friendlyClassifyError` 와 같은 발상이되, 생성
 * (인페인트 / 앵글 / 릴라이트 / 카메라 변형) 경로용이다.
 *
 * 반환값은 uiCopy 의 번역 "키" 또는 null 이다. 매칭에 실패하면 null 을
 * 돌려주며, 호출부는 null 일 때 기존처럼 원문 메시지를 노출해 정보 손실을
 * 막는다.
 *
 *   const fk = friendlyGenerationError(err);
 *   toast({ description: fk ? t(fk) : (err?.message ?? String(err)) });
 */

const ERROR_PATTERNS: Array<{ test: RegExp; key: string }> = [
  { test: /content_policy|safety|content filter|moderation/i, key: "error.contentPolicy" },
  { test: /rate.?limit|too many requests|429/i, key: "error.rateLimit" },
  { test: /timeout|timed out|ETIMEDOUT|504/i, key: "error.timeout" },
  { test: /network|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/i, key: "error.network" },
  { test: /invalid_input_fidelity_model|input_fidelity|not available on|unsupported (value|parameter)/i, key: "error.modelTier" },
];

/**
 * @returns 매칭된 uiCopy 키, 없으면 null.
 */
export function friendlyGenerationError(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (!raw) return null;
  for (const { test, key } of ERROR_PATTERNS) {
    if (test.test(raw)) return key;
  }
  return null;
}
