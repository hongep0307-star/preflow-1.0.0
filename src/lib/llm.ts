/**
 * 통합 LLM 디스패처.
 *
 * 호출자 (BriefTab/AgentTab/...) 는 모델 ID 만 알면 되고, provider 별 페이로드
 * 차이는 여기서 흡수한다.
 *
 *   callLLM({ model, system, messages, max_tokens, response_format? })
 *     → { text, raw }
 *
 * 메시지 형식 (provider-agnostic 입력):
 *   {
 *     role: "user" | "assistant",
 *     content: string | Array<TextPart | ImagePart>
 *   }
 *   - TextPart  = { type: "text", text: string }
 *   - ImagePart = { type: "image", mediaType: string, dataBase64: string }
 *
 * 디스패처가 위 정규형을 각 공급자 표준으로 변환:
 *   - Anthropic Claude:
 *       content[i] = { type: "text", text } | { type: "image", source: { type: "base64", media_type, data } }
 *   - OpenAI Chat Completions:
 *       content[i] = { type: "text", text } | { type: "image_url", image_url: { url: "data:<media>;base64,<data>" } }
 */
import { getModelMeta, type ModelId } from "./modelCatalog";
import { callClaude } from "./claude";
import { callOpenAI } from "./openai";

export type LLMRole = "user" | "assistant";

export type LLMTextPart = { type: "text"; text: string };
export type LLMImagePart = {
  type: "image";
  /** 예: "image/png", "image/jpeg" */
  mediaType: string;
  /** Base64 (no data: prefix) */
  dataBase64: string;
};
export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMMessage {
  role: LLMRole;
  /** 단일 string 이면 자동으로 [{ type:"text", text }] 로 래핑 */
  content: string | LLMContentPart[];
}

export interface CallLLMArgs {
  model: ModelId | string;
  system: string;
  messages: LLMMessage[];
  /** 응답 토큰 한도. 미지정 시 카탈로그 maxOutputTokens 사용. */
  max_tokens?: number;
  /** JSON 모드 — OpenAI 만 강제 가능. Claude 는 system prompt 로 유도. */
  response_format?: "json_object" | "text";
  temperature?: number;
}

export interface CallLLMResult {
  /** 응답 본문 텍스트 (provider 구조 차이 평탄화 후) */
  text: string;
  /** 원본 응답 (Claude messages.content[] 또는 OpenAI choices[]) */
  raw: any;
  modelUsed: string;
  provider: "anthropic" | "openai";
}

function ensureContentArray(content: string | LLMContentPart[]): LLMContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function toClaudeMessages(messages: LLMMessage[]): any[] {
  return messages.map((m) => ({
    role: m.role,
    content: ensureContentArray(m.content).map((p) => {
      if (p.type === "text") return { type: "text", text: p.text };
      return {
        type: "image",
        source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 },
      };
    }),
  }));
}

function toOpenAIMessages(system: string, messages: LLMMessage[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    const parts = ensureContentArray(m.content).map((p) => {
      if (p.type === "text") return { type: "text", text: p.text };
      return {
        type: "image_url",
        image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` },
      };
    });
    if (parts.length === 1 && parts[0].type === "text") {
      out.push({ role: m.role, content: (parts[0] as any).text });
    } else {
      out.push({ role: m.role, content: parts });
    }
  }
  return out;
}

function flattenClaudeText(raw: any): string {
  const blocks = raw?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n");
}

function flattenOpenAIText(raw: any): string {
  const choice = raw?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" || typeof c?.text === "string")
      .map((c: any) => c?.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * 단일 LLM 호출 진입점. 모델 ID 의 provider 에 따라 분기한다.
 *
 * 모델 ID 가 카탈로그에 없거나 (가능성 낮지만 prefs 가 stale 한 경우 등)
 * `available: false` 면 명확한 에러로 대신해서 무거운 실패를 막는다.
 */
export async function callLLM(args: CallLLMArgs): Promise<CallLLMResult> {
  const meta = getModelMeta(args.model);
  if (!meta) {
    throw new Error(`Unknown model id: ${args.model}`);
  }
  const maxTokens = args.max_tokens ?? meta.maxOutputTokens;

  if (meta.provider === "anthropic") {
    const raw = await callClaude({
      model: meta.id,
      max_tokens: maxTokens,
      system: args.system,
      messages: toClaudeMessages(args.messages),
    });
    return {
      text: flattenClaudeText(raw),
      raw,
      modelUsed: meta.id,
      provider: "anthropic",
    };
  }

  if (meta.provider === "openai") {
    const body: any = {
      model: meta.id,
      messages: toOpenAIMessages(args.system, args.messages),
      max_completion_tokens: maxTokens,
    };
    if (args.response_format === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (typeof args.temperature === "number") {
      body.temperature = args.temperature;
    }
    const raw = await callOpenAI(body);
    return {
      text: flattenOpenAIText(raw),
      raw,
      modelUsed: meta.id,
      provider: "openai",
    };
  }

  throw new Error(`Unsupported provider for model: ${args.model}`);
}
