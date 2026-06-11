/**
 * 모델 컨텍스트 윈도우 기반 히스토리 소프트 트리머.
 *
 * - Claude Sonnet 4 (200k) 와 GPT-5.x (1M) 는 절대 한계가 다르다.
 *   현재 코드는 히스토리를 슬라이스 없이 전부 전송하므로, 긴 대화에서
 *   Claude 가 한계에 부딪힐 위험이 있다. 반대로 GPT-5.x 는 수십 턴이
 *   누적돼도 자연스럽게 활용한다.
 *
 * - 토큰을 정확히 셀 수는 없으니 (tiktoken 의존을 피함) 보수적으로
 *   `chars ≈ tokens * 4` 추정을 쓴다. 한국어/이모지가 많으면 보수성이 더
 *   강해지므로 안전하다. system 프롬프트도 별도 인자로 받아 차감한다.
 *
 * - 트리밍은 "오래된 것부터" 제거. 단, 첫 메시지가 [브리프 분석 결과]
 *   유사 컨텍스트 시드라면 가능하면 보존하도록 옵션을 둔다.
 */

export interface BudgetInputMessage {
  role: "user" | "assistant";
  /** content 는 string 또는 Claude/OpenAI 멀티모달 part 배열일 수 있다. */
  content: any;
}

interface PruneOptions {
  /** 모델의 contextWindow (토큰). */
  contextWindowTokens: number;
  /** 모델 응답에 예약할 토큰 수. */
  reserveOutputTokens: number;
  /** 시스템 프롬프트(전체) — 길이만 사용. */
  systemPromptChars: number;
  /** 안전 마진 비율 (0~1). default 0.85. */
  safetyRatio?: number;
  /** 첫 시드 메시지(role=user, "[브리프 분석 결과]" 등) 보존 시도. default true. */
  preserveSeed?: boolean;
}

const CHARS_PER_TOKEN = 4;

const stringify = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        if (p.type === "text") return String(p.text ?? "");
        if (p.type === "image") return "[image]";
        return "";
      })
      .join("\n");
  }
  return "";
};

const messageChars = (m: BudgetInputMessage): number => stringify(m.content).length;

/**
 * 히스토리를 모델 컨텍스트 한도에 맞춰 잘라낸다.
 *
 * 반환된 배열은 입력 순서를 유지하며, 한도 내라면 그대로 반환.
 * 한도를 초과하면 가장 오래된 (그러나 시드 메시지는 가능한 보존) 메시지부터 drop.
 */
export function pruneHistoryForBudget(
  messages: BudgetInputMessage[],
  opts: PruneOptions,
): BudgetInputMessage[] {
  if (!messages.length) return messages;
  const safety = opts.safetyRatio ?? 0.85;
  const totalBudgetChars =
    Math.max(0, opts.contextWindowTokens * safety - opts.reserveOutputTokens) * CHARS_PER_TOKEN;
  const sysChars = opts.systemPromptChars;
  const availableChars = Math.max(0, totalBudgetChars - sysChars);

  const sizes = messages.map(messageChars);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= availableChars) return messages;

  // 시드 보존: 가장 첫 user 메시지가 명시 컨텍스트면 따로 분리하고,
  // 나머지에서 오래된 것부터 잘라낸다.
  const preserveSeed = opts.preserveSeed ?? true;
  let seed: BudgetInputMessage | null = null;
  let body = messages.slice();
  if (preserveSeed) {
    const first = messages[0];
    const firstStr = stringify(first?.content ?? "");
    if (
      first?.role === "user" &&
      (firstStr.startsWith("[브리프 분석 결과]") || firstStr.startsWith("[Brief Analysis]"))
    ) {
      seed = first;
      body = messages.slice(1);
    }
  }

  let used = seed ? messageChars(seed) : 0;
  // tail 부터 거꾸로 채워 가장 최근 메시지를 우선 보존.
  const kept: BudgetInputMessage[] = [];
  for (let i = body.length - 1; i >= 0; i--) {
    const c = messageChars(body[i]);
    if (used + c > availableChars) break;
    kept.unshift(body[i]);
    used += c;
  }

  // 시드 + tail 도 안 들어가면 (시드 자체가 너무 큼) — 시드도 버리고 최신 메시지만.
  if (kept.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    return [last];
  }

  return seed ? [seed, ...kept] : kept;
}
