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
import { callClaude, callClaudeStream, toClaudeSystem } from "./claude";
import { callOpenAI, callOpenAIStream } from "./openai";

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
  /**
   * GPT-5.x reasoning 강도. 가벼운 턴은 "low"/"minimal" 로 추론 시간을 줄이고,
   * 컷 기획처럼 사고가 필요한 턴만 "medium" 으로. OpenAI provider 에만 적용되며,
   * 미지정 시 주입하지 않아 기존 호출 동작을 바꾸지 않는다.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
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
      system: toClaudeSystem(args.system),
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
    const body = buildOpenAIBody(meta.id, args, maxTokens);
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

function buildOpenAIBody(modelId: string, args: CallLLMArgs, maxTokens: number): any {
  const body: any = {
    model: modelId,
    messages: toOpenAIMessages(args.system, args.messages),
    max_completion_tokens: maxTokens,
  };
  if (args.response_format === "json_object") {
    body.response_format = { type: "json_object" };
  }
  if (typeof args.temperature === "number") {
    body.temperature = args.temperature;
  }
  if (args.reasoningEffort) {
    body.reasoning_effort = args.reasoningEffort;
  }
  return body;
}

// ── 스트리밍 ─────────────────────────────────────────────────────────────

export interface CallLLMStreamCallbacks {
  /** delta 도착마다 호출. fullText = 누적 텍스트, deltaText = 이번 조각. */
  onDelta: (fullText: string, deltaText: string) => void;
  /** 취소 신호 — abort 되면 스트림 소비를 멈춘다. */
  signal?: AbortSignal;
}

/** SSE 라인 파서: data/event 라인을 이벤트 단위로 yield. */
async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let curEvent: string | undefined;
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          curEvent = undefined;
          continue;
        }
        if (line.startsWith("event:")) curEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) yield { event: curEvent, data: line.slice(5).trim() };
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

async function consumeAnthropicSSE(res: Response, cb: CallLLMStreamCallbacks): Promise<string> {
  let full = "";
  for await (const { event, data } of sseEvents(res, cb.signal)) {
    if (data === "[DONE]") break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (event === "error" || json?.type === "error") {
      const err = json?.error;
      throw new Error((typeof err === "string" ? err : err?.message) ?? json?.error ?? "Claude stream error");
    }
    if (json?.type === "content_block_delta" && json?.delta?.type === "text_delta") {
      const d: string = json.delta.text ?? "";
      if (d) {
        full += d;
        cb.onDelta(full, d);
      }
    }
  }
  return full;
}

async function consumeOpenAISSE(res: Response, cb: CallLLMStreamCallbacks): Promise<string> {
  let full = "";
  for await (const { event, data } of sseEvents(res, cb.signal)) {
    if (data === "[DONE]") break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (event === "error" || json?.error) {
      const err = json?.error;
      throw new Error((typeof err === "string" ? err : err?.message) ?? "OpenAI stream error");
    }
    const d = json?.choices?.[0]?.delta?.content;
    if (typeof d === "string" && d) {
      full += d;
      cb.onDelta(full, d);
    }
  }
  return full;
}

/**
 * 스트리밍 LLM 호출. 토큰이 도착하는 대로 `onDelta` 로 흘리고, 종료 시
 * 비스트리밍 callLLM 과 동일한 CallLLMResult 를 반환한다(raw 는 스트림이라 null).
 */
export async function callLLMStream(
  args: CallLLMArgs,
  cb: CallLLMStreamCallbacks,
): Promise<CallLLMResult> {
  const meta = getModelMeta(args.model);
  if (!meta) {
    throw new Error(`Unknown model id: ${args.model}`);
  }
  const maxTokens = args.max_tokens ?? meta.maxOutputTokens;

  if (meta.provider === "anthropic") {
    const res = await callClaudeStream({
      model: meta.id,
      max_tokens: maxTokens,
      system: toClaudeSystem(args.system),
      messages: toClaudeMessages(args.messages),
    });
    const text = await consumeAnthropicSSE(res, cb);
    return { text, raw: null, modelUsed: meta.id, provider: "anthropic" };
  }

  if (meta.provider === "openai") {
    const body = buildOpenAIBody(meta.id, args, maxTokens);
    const res = await callOpenAIStream(body);
    const text = await consumeOpenAISSE(res, cb);
    return { text, raw: null, modelUsed: meta.id, provider: "openai" };
  }

  throw new Error(`Unsupported provider for model: ${args.model}`);
}
