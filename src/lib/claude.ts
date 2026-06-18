import { supabase } from './supabase';

/**
 * system 문자열을 Anthropic content 블록 배열로 감싸고 prompt caching
 * (cache_control: ephemeral)을 부여한다. 거대한 시스템 프롬프트는 세션 내
 * 턴마다 동일하므로, 2번째 턴부터 캐시 히트로 prefill(TTFT) 비용이 줄어든다.
 * Anthropic 은 system 으로 string 또는 블록 배열을 모두 허용한다.
 */
export const toClaudeSystem = (system: string): any => {
  if (!system) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
};

export type ClaudePayload = {
  model: string;
  max_tokens: number;
  /** string 또는 cache_control 이 부여된 content 블록 배열 */
  system: any;
  messages: any[];
};

export const callClaude = async (payload: ClaudePayload) => {
  const { data, error } = await supabase.functions.invoke('claude-proxy', {
    body: payload,
  });

  if (error) throw new Error(error.message);
  if (data.error) throw new Error(data.error.message ?? 'Claude API error');

  return data;
};

/** 스트리밍 변형 — SSE Response 를 그대로 반환(디스패처가 파싱). */
export const callClaudeStream = async (payload: ClaudePayload): Promise<Response> => {
  return supabase.functions.stream('claude-proxy-stream', { body: payload });
};
