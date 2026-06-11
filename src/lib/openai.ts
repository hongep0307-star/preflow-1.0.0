/**
 * OpenAI Chat Completions 프런트 헬퍼.
 *
 * `callClaude()` 와 같은 패턴: 로컬 서버 (`/api/openai-chat`) 로 POST →
 * Electron `handleOpenAIResponses` → OpenAI 본 API 로 프록시.
 *
 * 디스패처 (src/lib/llm.ts) 가 메시지를 OpenAI 표준으로 정규화한 뒤 호출.
 */
import { supabase } from "./supabase";

export interface OpenAIChatPayload {
  model: string;
  /** OpenAI chat/completions 표준 메시지. system/user/assistant role + multimodal content[] */
  messages: any[];
  /** GPT-5.x 는 max_completion_tokens 사용 권장 (구 max_tokens deprecated) */
  max_completion_tokens?: number;
  /** JSON 강제 출력 모드 — DeepAnalysis 같은 구조화 응답에서 사용 */
  response_format?: { type: "json_object" } | { type: "text" };
  temperature?: number;
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export const callOpenAI = async (payload: OpenAIChatPayload): Promise<OpenAIChatResponse> => {
  const { data, error } = await supabase.functions.invoke("openai-chat", {
    body: payload,
  });
  if (error) throw new Error(error.message);
  if (data?.error) {
    throw new Error(data.error.message ?? "OpenAI API error");
  }
  return data as OpenAIChatResponse;
};
