import { nativeImage } from "electron";
import type { ServerResponse } from "node:http";
import { getSettings } from "./settings";
import { getStorageBasePath } from "./paths";
import { getLocalServerBaseUrl } from "./constants";
import { fetchWithRetry } from "./http-utils";
import fs from "fs";
import path from "path";
import crypto from "crypto";

function storageFileUrl(fullPath: string): string {
  const base = getStorageBasePath();
  const relative = path.relative(base, fullPath).replace(/\\/g, "/");
  return `${getLocalServerBaseUrl()}/storage/file/${relative}`;
}

function resolveStorageFilePath(rawPath: string): string {
  const base = path.resolve(getStorageBasePath());
  const target = path.resolve(path.normalize(rawPath.replace(/^\/+/, "")));
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Blocked file outside storage: ${target}`);
  }
  return target;
}

export async function handleClaudeProxy(body: any) {
  const settings = getSettings();
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다.");
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    },
    { label: "claude", timeoutMs: 120_000, retries: 2 },
  );
  return await response.json();
}

/**
 * OpenAI Chat Completions 프록시. GPT-5.x 텍스트/멀티모달 호출의 단일 입구.
 *
 * Responses API 가 아닌 Chat Completions 를 쓰는 이유:
 *   - 5.4 / 5.5 / 5.5-pro 모두 chat/completions 엔드포인트로 호출 가능
 *   - Anthropic messages 스키마와 1:1 매핑이 쉬워 디스패처 (src/lib/llm.ts)
 *     의 정규화 로직이 간결해짐
 *   - vision/멀티모달 파트 (image_url + base64 data URI) 가 표준 chat 메시지
 *     content 배열로 그대로 들어감
 *
 * body 형식 (디스패처가 Chat Completions 표준에 맞춰 보냄):
 *   { model, messages, max_completion_tokens, response_format?, temperature? }
 *
 * 응답은 OpenAI 가 반환하는 그대로 (choices[0].message.content) 평탄화는 호출 측에서.
 */
export async function handleOpenAIResponses(body: any) {
  const settings = getSettings();
  const apiKey = settings.openai_api_key;
  if (!apiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  if (apiKey.startsWith("sk-ant-")) {
    throw new Error("OpenAI 필드에 Anthropic 키가 입력되어 있습니다. Settings에서 올바른 OpenAI API Key를 입력하세요.");
  }
  const response = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { label: "openai-chat", timeoutMs: 180_000, retries: 1 },
  );
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[openai-chat] HTTP ${response.status}:`, errText.slice(0, 500));
    let errMsg = `OpenAI HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errText);
      errMsg = parsed?.error?.message ?? errMsg;
    } catch {}
    throw new Error(errMsg);
  }
  return await response.json();
}

/* ─────────────────────────────────────────────────────────────
 *  Streaming proxies (SSE)
 *
 *  非스트리밍 핸들러(handleClaudeProxy / handleOpenAIResponses)는 응답을
 *  통째로 버퍼링해 반환하므로, 긴 컷 기획 응답에서 첫 글자까지 수십 초가
 *  걸린다. 아래 스트리밍 변형은 업스트림(Anthropic/OpenAI)의 SSE 바이트를
 *  클라이언트(렌더러)로 그대로 파이프해서, 디스패처(src/lib/llm.ts)가
 *  provider 별 delta 를 파싱하며 점진 렌더하도록 한다.
 *
 *  local-server 가 이 두 함수를 호출하기 전에 text/event-stream 헤더를 이미
 *  내보낸 상태다. 여기서는 res.write(...) 로 chunk 만 흘리고, res.end() 는
 *  호출자(local-server)가 finally 에서 처리한다.
 * ───────────────────────────────────────────────────────────── */

function writeSSEError(res: ServerResponse, message: string) {
  try {
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  } catch {
    /* socket already closed */
  }
}

/** 업스트림 SSE Response 의 바이트를 그대로 클라이언트로 전달. */
async function pipeUpstreamSSE(upstream: Response, res: ServerResponse) {
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    let msg = `HTTP ${upstream.status}`;
    try {
      msg = JSON.parse(txt)?.error?.message ?? msg;
    } catch {
      if (txt) msg = txt.slice(0, 300);
    }
    writeSSEError(res, msg);
    return;
  }
  const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
}

export async function handleClaudeProxyStream(body: any, res: ServerResponse) {
  const settings = getSettings();
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) {
    writeSSEError(res, "ANTHROPIC_API_KEY가 설정되지 않았습니다.");
    return;
  }
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  await pipeUpstreamSSE(upstream, res);
}

export async function handleOpenAIChatStream(body: any, res: ServerResponse) {
  const settings = getSettings();
  const apiKey = settings.openai_api_key;
  if (!apiKey) {
    writeSSEError(res, "OPENAI_API_KEY가 설정되지 않았습니다.");
    return;
  }
  if (apiKey.startsWith("sk-ant-")) {
    writeSSEError(res, "OpenAI 필드에 Anthropic 키가 입력되어 있습니다. Settings에서 올바른 OpenAI API Key를 입력하세요.");
    return;
  }
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...body, stream: true }),
  });
  await pipeUpstreamSSE(upstream, res);
}

export async function handleEnhanceInpaintPrompt(body: any) {
  const settings = getSettings();
  ensureGoogleCredentials(settings);
  const { prompt, hasMask, assetDescriptions, sourceImageBase64, tagImageBase64 } = body;
  if (!prompt) return { error: "prompt is required" };

  // Gemini 가 SOURCE (보존용) + TAG (정체성 묘사용) 두 장을 직접 보고
  // 1) PRESERVE: 원본에서 보존해야 할 요소 목록
  // 2) TAG_IDENTITY: 태그 에셋의 구체적 식별 특징
  // 두 블록을 프롬프트에 주입 → 이후 NB2 가 "인물 날리기" / "일반화" 실수 둘 다 줄어듦.
  //
  // 과거에는 hasMask=true 일 때만 이미지를 봤는데, 그 경우 브러시 없이 태그로만
  // 호출하면 Gemini 가 TAG_IDENTITY 블록을 만들지 않아 NB2 가 태그 에셋을
  // 제너릭하게 해석하는 문제가 있었다. 마스크 유무와 무관하게 이미지가 주어지면
  // 보고 PRESERVE / TAG_IDENTITY 블록을 생성하도록 바꾼다.
  const hasSourceImage = !!sourceImageBase64;
  const hasTagImage = !!tagImageBase64;

  const systemPrompt = `You are an expert prompt writer for high-precision image inpainting/editing.

Your job:
1. If the input is not in English, translate it to natural English first.
2. Classify the request as one of: REMOVAL, REPLACEMENT, ADDITION, or MODIFICATION.
3. Rewrite it into a SHORT, EXTREMELY SPECIFIC editing prompt optimized for image editing AI.
${hasSourceImage ? `
═══ SCENE PRESERVATION (CRITICAL) ═══
You will be given the SOURCE scene image. Study it first and silently identify every element that must be preserved outside the edit target (${hasMask ? "the area OUTSIDE the painted mask" : "every subject/element NOT explicitly targeted by the user's edit request"}):
 - all people (count, pose, clothing, facial features, gaze direction, position)
 - background environment and layout
 - other objects (furniture, props, vehicles, etc.)
 - lighting direction, color temperature, shadows
 - camera angle, framing, depth of field, color grading

Then include a concise "PRESERVE:" block in the output prompt that explicitly lists these elements so the downstream image model does not drop or alter them. Example:
  PRESERVE: 1 male character on the left wearing a navy suit, facing camera; industrial warehouse interior; cool blue-teal color grading; low-angle shot.
` : ""}${hasTagImage ? `
═══ TAG IDENTITY (CRITICAL) ═══
You will also be given the TAG reference image — the exact object the user wants ${hasMask ? "placed inside the masked region" : "to appear as the edit target (the object/character/prop referenced by the user's request)"}. Study it and write a "TAG_IDENTITY:" block that lists every visually distinctive feature the downstream model MUST reproduce so the object is immediately recognizable:
 - object category and specific model/type (e.g., "AR-15 carbine", "Hermès Birkin bag 30cm", "Porsche 911 Carrera")
 - overall shape and proportions
 - dominant colors and color distribution (be specific: "matte black polymer body with tan FDE grip and handguard")
 - materials and surface finish (matte/glossy/brushed/leather/etc.)
 - markings, logos, stickers, text, serial patterns
 - distinguishing attachments or details (e.g., "red-dot sight on top rail", "angled foregrip", "bronze hardware")

The output prompt must instruct the image model to match ALL of these identity features exactly, while adapting only viewing angle, lighting, and scale to blend with SOURCE. Do NOT let the model generate a generic version of the object.

Example TAG_IDENTITY block:
  TAG_IDENTITY: AR-15 carbine with matte black upper/lower receiver, 16" barrel, tan FDE furniture (grip, handguard, stock), black picatinny top rail with red-dot optic, angled foregrip under handguard, black 30-round polymer magazine.
` : ""}
═══ REMOVAL REQUESTS ═══
Detection: words like "remove", "delete", "erase", "없애", "제거", "삭제", "지워"
Rules:
- Primary instruction: "Completely remove [object] from the image."
- Secondary instruction: "Fill the area with the natural continuation of the surrounding background."
- CRITICAL: "Do NOT replace the removed object with any other object."
- CRITICAL: "Do NOT add anything new. The area should look as if the object was never there."

═══ UNIVERSAL RULES ═══
- Keep the prompt FOCUSED (up to ~14 sentences including PRESERVE and TAG_IDENTITY blocks).
- The FIRST sentence must be the primary action on ${hasMask ? "the masked region" : "the edit target referenced by the user"}.
- The edit must fill the ENTIRE ${hasMask ? "masked region" : "edit target"} with photorealistic content that seamlessly continues the surrounding skin, hair, and background — matching neighboring texture, color, lighting, and grain. The result must NEVER contain flat white, gray, blurred, smeared, or empty patches anywhere in the edited area. ${hasMask ? "Where the brush extends beyond the actual edit target, reconstruct the natural surface underneath (skin, background) rather than leaving a blank fill." : ""}
- Never introduce creative additions the user didn't ask for.
- Always end with: Preserve all ${hasMask ? "unmasked" : "non-target"} content exactly as-is — same people, same background, same lighting, same composition. Match the tag identity exactly ${hasMask ? "inside the masked region" : "on the targeted object"}.
${assetDescriptions ? `\nAdditional asset notes (supplementary — the TAG reference image is authoritative):\n${assetDescriptions}` : ""}${hasMask ? "\n[User painted a brush mask on the target area.]" : "\n[No brush mask. Full-image edit.]"}

Return ONLY the final prompt. No explanations. No markdown.`;

  try {
    // Multimodal parts: [SOURCE label + image] + [TAG label + image] + [user request text]
    const userParts: any[] = [];
    if (hasSourceImage) {
      userParts.push({ text: "[SOURCE scene image — everything OUTSIDE the mask must be preserved]" });
      userParts.push({ inlineData: { mimeType: "image/png", data: sourceImageBase64 } });
    }
    if (hasTagImage) {
      userParts.push({ text: "[TAG reference image — the object to place INSIDE the masked region; reproduce its identity exactly]" });
      userParts.push({ inlineData: { mimeType: "image/png", data: tagImageBase64 } });
    }
    userParts.push({ text: `User edit request: ${prompt}` });

    const data = await callVertexGemini(settings, "gemini-2.0-flash", {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: userParts }],
    });
    const enhanced = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || prompt;
    console.log(
      "[enhance-inpaint] hasSourceImage:",
      hasSourceImage,
      "| hasTagImage:",
      hasTagImage,
      "| enhanced length:",
      enhanced.length,
    );
    return { enhanced };
  } catch (e) {
    console.error("Vertex Gemini enhance error:", e);
    return { enhanced: prompt, fallback: true };
  }
}

// v2 fields: enum/literal/numeric/boolean values that must NOT be translated
// (translate-analysis 는 자연어만 번역하고 이 필드들은 원본 그대로 보존해야 함)
const TRANSLATE_KEEP_AS_IS_KEYS = [
  "content_type",
  "secondary_type",
  "classification_confidence",
  "hook_strategy.primary",
  "hook_strategy.alternatives",
  "hook_strategy.pattern_interrupt",
  "pacing.format",
  "pacing.duration",
  "pacing.edit_rhythm",
  "pacing.scene_count",
  "pacing.silent_viewable",
  "pacing.captions_required",
  "hero_visual.brand_reveal_timing",
  "hero_visual.product_reveal_timing",
  "hero_visual.logo_placement",
  "product_info.urgency.type",
  "abcd_compliance.attract.score",
  "abcd_compliance.brand.score",
  "abcd_compliance.connect.score",
  "abcd_compliance.direct.score",
  "abcd_compliance.total",
  "narrative.story_structure",
  "narrative.emotional_beats[].intensity",
];

export async function handleTranslateAnalysis(body: any) {
  const settings = getSettings();
  ensureGoogleCredentials(settings);
  const { mode, analysis, fieldValue, fieldPath, direction } = body;
  if (mode === "full") {
    const directionText = direction === "ko_to_en" ? "Korean to English" : "English to Korean";
    const systemPrompt = `You are a professional translator for advertising/marketing analysis.
RULES:
- Translate ALL natural-language text values in the JSON
- Preserve the EXACT JSON structure and key names
- Keep proper nouns, brand names, game titles as-is
- DO NOT translate enum/literal values. Keep these fields EXACTLY as-is (values are enums or numbers, not natural language):
${TRANSLATE_KEEP_AS_IS_KEYS.map((k) => `  - ${k}`).join("\n")}
- Any field whose value looks like a timing token ("0-3s", "3-5s", "5-10s"), format token ("9:16", "16:9", "1:1", "4:5"), duration token ("6s", "15s", "30s", "45s", "60s"), or an identifier with underscores (e.g. "product_launch", "unboxing_reveal", "time_limited", "first_frame") must also be kept as-is.
- Numbers and booleans are never translated.
- Return ONLY valid JSON, no markdown fences.`;
    const data = await callVertexGemini(settings, "gemini-2.5-flash", {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: `Translate this analysis JSON from ${directionText}. Return ONLY valid JSON:\n\n${JSON.stringify(analysis)}` }] }],
      generationConfig: { maxOutputTokens: 6000, temperature: 0.1 },
    });
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Empty AI response");
    const jsonStr = content.trim().replace(/```json\s?|```/g, "").trim();
    return { translated: JSON.parse(jsonStr) };
  }
  if (mode === "field") {
    // field-level translation: skip if fieldPath is in the enum keep-as-is list
    if (fieldPath && TRANSLATE_KEEP_AS_IS_KEYS.some((k) => fieldPath === k || fieldPath.startsWith(`${k}.`))) {
      return { translated: fieldValue };
    }
    const directionText = direction === "ko_to_en" ? "Korean to natural English" : "English to natural Korean";
    const data = await callVertexGemini(settings, "gemini-2.0-flash", {
      contents: [{ parts: [{ text: `Translate from ${directionText}. ${fieldPath ? `This is the "${fieldPath}" field of a marketing analysis. ` : ""}Keep proper nouns as-is. Return ONLY the translated text:\n\n${fieldValue}` }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.1 },
    });
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) throw new Error("Empty AI response");
    try { return { translated: JSON.parse(content) }; } catch { return { translated: content }; }
  }
  return { error: "Invalid mode" };
}

export async function handleAnalyzeReferenceImages(body: any) {
  const settings = getSettings();
  ensureGoogleCredentials(settings);
  const { images, imageUrls, mode } = body;
  const isStyleOnly = mode === "style_only";
  const prompt = isStyleOnly
    ? "Describe the visual style of this image. Return ONLY a single short English paragraph (max 2 sentences) describing: rendering technique, line style, color palette, lighting mood, texture. Do NOT mention subjects or content."
    : "이 이미지의 색감, 카메라 앵글, 편집 스타일, 전체적인 무드를 영상 제작 관점에서 간결하게 설명해줘. 한국어로 답변해줘.";
  const parts: any[] = [];
  if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
    for (const url of imageUrls) {
      try { const resp = await fetch(url); if (!resp.ok) continue; const buf = Buffer.from(await resp.arrayBuffer()); const ct = resp.headers.get("content-type") || "image/png"; const mimeType = ct.startsWith("image/") ? ct.split(";")[0] : "image/png"; parts.push({ inlineData: { mimeType, data: buf.toString("base64") } }); } catch {}
    }
  } else if (images && Array.isArray(images)) {
    for (const img of images) parts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
  }
  if (parts.length === 0) return { error: "이미지가 없습니다." };
  parts.push({ text: prompt });
  try {
    const data = await callVertexGemini(settings, "gemini-2.5-flash", {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: isStyleOnly ? 256 : 512, temperature: 0.3 },
    });
    return { analysis: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "" };
  } catch (err: any) {
    console.warn("[analyze-reference-images] skipped:", err?.message ?? err);
    return { analysis: "", skipped: true };
  }
}

/**
 * Phase 2.0 — In-flight job dedup for `/api/openai-image`.
 *
 * Why: when the renderer reloads (Ctrl+R, hot reload, or a manual project
 * page refresh), any pending generation it had in flight gets dropped on
 * the renderer side, but the main process keeps running and the underlying
 * `fetch(...)` to OpenAI/Vertex is still alive. Without dedup, the next
 * mount reads the same job from `localStorage` and fires a *fresh* call —
 * so the user pays for two generations and gets back whichever response
 * happens to win. With dedup, a second call carrying the same `__jobId`
 * simply re-attaches to the original promise and returns its eventual
 * result. Net effect: the renderer can refresh freely while a generation
 * is in flight, with zero duplicate API spend.
 *
 * Contract:
 *   - Renderer puts `__jobId: <stable string>` into the `body` for any
 *     openai-image call it wants to be dedup-able. The job id MUST be
 *     persisted to `localStorage` BEFORE the first call so a refreshing
 *     renderer can find the same id and ask for re-attachment.
 *   - Main process strips/ignores `__jobId` for the actual provider
 *     call; it's only used as the dedup key.
 *   - Settled promises are kept in the map for an extra `RESULT_TTL_MS`
 *     so a renderer that mounts moments after the call settled (but
 *     before the periodic reconciler picked up the saved file) can still
 *     retrieve the result without firing a new call.
 *   - Calls without `__jobId` bypass the dedup path entirely (legacy
 *     compat — Mood Ideation, Style Transfer Bulk, etc.).
 *
 * Memory: Map size is bounded by concurrent in-flight jobs + 30 s of
 * settled-but-cached results, both small in practice. No explicit cap,
 * but the timed delete keeps it from leaking across long sessions.
 */
const inflightOpenaiImageJobs = new Map<string, Promise<unknown>>();
const RESULT_TTL_MS = 30_000;

export async function handleOpenaiImage(body: any) {
  const jobId =
    typeof body?.__jobId === "string" && body.__jobId.length > 0 ? body.__jobId : null;
  if (jobId) {
    const existing = inflightOpenaiImageJobs.get(jobId);
    if (existing) {
      console.log(`[openai-image] dedup: reattaching to in-flight jobId=${jobId}`);
      return await existing;
    }
  }
  const promise = handleOpenaiImageInner(body);
  if (jobId) {
    inflightOpenaiImageJobs.set(jobId, promise);
    void promise.finally(() => {
      // Hold the settled value for a short grace window so a refresh
      // racing the natural completion can still re-attach. After the
      // window, drop the entry — the saved file already lives in
      // storage and `findSavedContiUrl` will pick it up.
      setTimeout(() => {
        if (inflightOpenaiImageJobs.get(jobId) === promise) {
          inflightOpenaiImageJobs.delete(jobId);
        }
      }, RESULT_TTL_MS);
    });
  }
  return await promise;
}

async function handleOpenaiImageInner(body: any) {
  const settings = getSettings();
  if (body.mode === "ping") return { ok: true };
  const openaiKey = settings.openai_api_key;
  const storagePath = getStorageBasePath();

  // save_local — the renderer hands us a pre-made image (base64) and we just
  // persist it to storage + return a public URL. Used by Camera Variations
  // Contact Sheet when the user picks one of the 9 client-split tiles, so
  // we can keep the splitter in the renderer (no sharp/pngjs dep needed in
  // the electron bundle) while still getting a normal storage URL we can
  // write into the scene record.
  if (body.mode === "save_local") {
    const { imageBase64, projectId, sceneNumber, suffix = "local", folder } = body;
    // Same bucket routing as the main inpaint path — see comment there.
    if (!imageBase64 || !projectId || sceneNumber === undefined) {
      return { error: "Missing required fields: imageBase64, projectId, sceneNumber" };
    }
    try {
      const buf = Buffer.from(imageBase64, "base64");
      const bucket =
        folder === "mood" ? "mood" : folder === "assets" ? "assets" : folder === "chat" ? "chat" : "contis";
      const filePath = await saveToStorage(
        storagePath,
        bucket,
        projectId,
        `scene-${sceneNumber}-${suffix}-${Date.now()}.png`,
        buf,
      );
      return { publicUrl: storageFileUrl(filePath), usedModel: `save-local:${suffix}` };
    } catch (e) {
      return { error: "save_local failed", detail: String(e) };
    }
  }

  // variation — Reference Library AI 베리에이션. style_transfer 의 축약판으로,
  // 원본 reference 이미지를 소스로 새 이미지를 생성해 **base64 만** 돌려준다.
  // 저장은 하지 않는다(renderer 가 uploadReferenceFile 로 references 버킷에
  // 저장하므로 여기서 projectId/sceneNumber/bucket 라우팅이 필요 없다).
  //   · model "gpt-image-2" (또는 "gpt") → callGptVisionGenerate (품질 적용)
  //   · 그 외(기본 "nano-banana-2")       → callVertexNB2
  // referenceImageUrls 는 커스텀 변형에서 주입한 추가 참조(다중). source 가
  // 항상 image[0] 이 되도록 맨 앞에 배치한다.
  if (body.mode === "variation") {
    const {
      sourceImageUrl,
      referenceImageUrls = [],
      prompt,
      imageSize,
      model: vModel,
      quality: vQuality,
      nb2ImageSize,
    } = body as {
      sourceImageUrl?: string;
      referenceImageUrls?: string[];
      prompt?: string;
      imageSize?: string;
      model?: string;
      quality?: string;
      nb2ImageSize?: "1K" | "2K";
    };
    if (!sourceImageUrl || !prompt) {
      return { error: "Missing required fields: sourceImageUrl, prompt" };
    }
    const size = imageSize ?? "1024x1536";
    const refUrls = [sourceImageUrl, ...referenceImageUrls].filter(Boolean);
    const isGpt = typeof vModel === "string" && vModel.startsWith("gpt");
    const vq: string = vQuality ?? settings.gpt_image_quality ?? "high";
    console.log("[variation] model=", vModel, "size=", size, "refCount=", refUrls.length, "quality=", isGpt ? vq : "(n/a)");
    try {
      let buf: Buffer;
      let usedModel: string;
      if (isGpt) {
        if (!openaiKey) return { error: "OPENAI_API_KEY not set" };
        const gptM = vModel === "gpt" ? "gpt-image-2" : (vModel as string);
        buf = await callGptVisionGenerate(openaiKey, prompt, size, refUrls, gptM, vq);
        usedModel = gptM;
      } else {
        buf = await callVertexNB2(settings, prompt, refUrls, sizeToNB2Aspect(size), nb2ImageSize);
        usedModel = "nano-banana-2";
      }
      return { imageBase64: buf.toString("base64"), mime: "image/png", usedModel };
    } catch (e) {
      const detail = (e as Error)?.message ?? String(e);
      console.error("[variation] failed:", detail);
      return { error: `Variation failed: ${detail}` };
    }
  }

  // gptModel: caller-pinned gpt-image variant for any GPT-side call inside
  // this request (generations / vision-generate / edits). Defaults to
  // gpt-image-2 (current GA). Mood Ideation passes "gpt-image-1.5"
  // because image-2 takes 1–2 min per image and a 9-image batch in
  // image-2 is unworkable for the mood-board UX.
  const gptModel: string = body.gptModel ?? "gpt-image-2";

  if (body.mode === "style_transfer") {
    // `model` mirrors ContiTab's top-bar `contiModel` selector so Style
    // Transfer honours the same model knob as Generate / Regenerate / TR.
    // When omitted or "nano-banana-2" we keep the legacy behaviour
    // (NB2 first, GPT edits as silent fallback on NB2 outage). When
    // "gpt" we skip NB2 entirely and run GPT as the primary generator.
    const { sourceImageUrl, styleImageUrl, prompt, gptPrompt, imageSize, projectId, sceneNumber, model: stModel } = body;
    if (!sourceImageUrl || !prompt || !projectId || sceneNumber === undefined) return { error: "Missing required fields" };
    // 스타일 적용 GPT 품질 — 호출 body 값 우선, 없으면 전역 폴백, 최종 "high".
    const styleQuality: string = body.quality ?? settings.gpt_image_quality ?? "high";
    // 아래 로그는 "GPT 선택했는데 NB2 로 도는 것 같다" 류 체감 버그의 교차확인용.
    // 평소에도 매우 저렴하게 한 줄이라 유지한다. 아래 route 결정 로그 ([StyleTransfer] route)
    // 와 함께 보면, 어떤 모델 값이 body 에 실려왔고 실제로 어떤 경로로 처리됐는지
    // 1-스캔에 판별할 수 있다.
    console.log("[StyleTransfer] stModel=", stModel, "imageSize=", imageSize, "scene=", sceneNumber, "quality=", styleQuality);

    // Shared GPT path — used as primary when stModel === "gpt", and as
    // the fallback when NB2 (the default primary) fails.
    //
    // We route through `callGptVisionGenerate` (the proven `gpt-image-2`
    // multi-image vision compose path used by Mood Ideation / ChangeAngle /
    // regular Generate-with-GPT) instead of `callGptInpaint`. Reasons:
    //
    //   1. gpt-image-2 composes via `image[]` with NO mask. callGptInpaint
    //      was built for gpt-image-1.5 inpaint (mask + `input_fidelity:high`)
    //      and just happened to also work for image-1.5 reference edits.
    //      With gpt-image-2 + null mask the edits endpoint rejects or
    //      silently no-ops the request, which is the user-visible
    //      "GPT image 2 로 스타일 변형이 안된다" symptom.
    //   2. Mood Ideation already proves this exact shape works for
    //      gpt-image-2: `image[0]` = canvas, `image[1..]` = references,
    //      no mask, `input_fidelity` omitted. Reusing it keeps the two
    //      gpt-image-2 paths in lockstep so a fix in one helper benefits
    //      both.
    //
    // Source is placed at refUrls[0] so it acts as the canvas; the style
    // ref follows at index 1 — the prompt explicitly addresses image[0]
    // as "SOURCE SCENE" and image[1] as "STYLE REFERENCE" so order matters.
    const runGpt = async (isFallback: boolean) => {
      if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
      const refUrls = [sourceImageUrl, ...(styleImageUrl ? [styleImageUrl] : [])];
      const imgBytes = await callGptVisionGenerate(
        openaiKey,
        gptPrompt ?? prompt,
        imageSize ?? "1024x1536",
        refUrls,
        gptModel,
        styleQuality,
      );
      const suffix = isFallback ? "style-gpt-fallback" : "style-gpt";
      const usedModel = isFallback ? `style-gpt-fallback:${gptModel}` : gptModel;
      const filePath = await saveToStorage(
        storagePath,
        "contis",
        projectId,
        `scene_${sceneNumber}_${suffix}_${Date.now()}.png`,
        imgBytes,
      );
      return { publicUrl: storageFileUrl(filePath), usedModel };
    };

    // GPT primary — user picked GPT explicitly. No NB2 attempt.
    if (stModel === "gpt") {
      console.log("[StyleTransfer] route=gpt-primary (NB2 skipped)", { gptModel });
      try {
        return await runGpt(false);
      } catch (e) {
        // Surface the underlying OpenAI error string (size mismatch,
        // invalid_input_fidelity_model, key tier, etc.) so the renderer
        // toast actually tells the user what to fix instead of just
        // "Style transfer failed".
        const detail = (e as Error)?.message ?? String(e);
        console.error("[StyleTransfer] GPT primary failed:", detail);
        return { error: `GPT style transfer failed: ${detail}` };
      }
    }

    // NB2 primary (default / "nano-banana-2") — try Vertex first,
    // fall back to GPT vision-generate on Vertex outage.
    console.log("[StyleTransfer] route=nb2-primary", stModel === null || stModel === undefined ? "(stModel unset)" : `(stModel=${stModel})`);
    try {
      const imageUrls = [sourceImageUrl, ...(styleImageUrl ? [styleImageUrl] : [])];
      const aspect = sizeToNB2Aspect(imageSize ?? "1024x1536");
      const imgBuf = await callVertexNB2(settings, prompt, imageUrls, aspect);
      const filePath = await saveToStorage(storagePath, "contis", projectId, `scene_${sceneNumber}_style-nb2_${Date.now()}.png`, imgBuf);
      return { publicUrl: storageFileUrl(filePath), usedModel: "nano-banana-2" };
    } catch (e) { console.error("[StyleTransfer] NB2 failed:", (e as Error).message); }
    console.log("[StyleTransfer] route=gpt-fallback (NB2 failed, trying GPT vision-generate)");
    try {
      return await runGpt(true);
    } catch (e) {
      const detail = (e as Error)?.message ?? String(e);
      console.error("[StyleTransfer] NB2+GPT both failed:", detail);
      return { error: `Style transfer failed (NB2 and GPT both errored): ${detail}` };
    }
  }

  const { mode, prompt, imageBase64, maskBase64, sourceImageUrl, referenceImageUrls = [], projectId, sceneNumber, imageSize, size: sizeAlias, assetImageUrls = [], forceGpt = false, model, useNanoBanana = false, folder, nb2ImageSize, preferredAngleModel, quality: bodyQuality, inputFidelity = true } = body as {
    mode?: string;
    prompt?: string;
    imageBase64?: string;
    maskBase64?: string;
    sourceImageUrl?: string;
    referenceImageUrls?: string[];
    projectId?: string;
    sceneNumber?: number;
    imageSize?: string;
    size?: string;
    assetImageUrls?: string[];
    forceGpt?: boolean;
    model?: string;
    useNanoBanana?: boolean;
    folder?: string;
    nb2ImageSize?: string;
    /** gpt-image quality (low|medium|high|auto). Defaults to "high" to preserve
     *  legacy behaviour for all callers that don't pass it. */
    quality?: string;
    /** input_fidelity gate for the edits endpoint (gpt-image-1.5 only). */
    inputFidelity?: boolean;
    /** ChangeAngle experiment toggle. When set to "gpt-image-2" or
     *  "gpt-image-1.5" the inpaint route skips NB2 and asks OpenAI's
     *  vision-aware image model to render a new angle while keeping the
     *  source as a reference. Default ("nb2" or undefined) keeps the
     *  current NB2-primary behaviour. Kept off the generic `model` param
     *  so it's opt-in and does not affect Inpaint / Style Transfer / other
     *  flows that happen to hit the same handler.
     *
     *  Why two GPT options:
     *    · "gpt-image-2"   → newer model, slower (~2-3 min/img), better at
     *      reconstructing full 3D camera moves from a single reference.
     *    · "gpt-image-1.5" → faster (~30-60 s/img), accepts `input_fidelity`
     *      and is exposed as a UI test toggle in ChangeAngleModal so the
     *      user can compare camera-change recognition quality side-by-side. */
    preferredAngleModel?: "nb2" | "gpt-image-2" | "gpt-image-1.5";
  };
  // Effective GPT quality: an explicit body value (e.g. Sketches tab preset)
  // wins; otherwise fall back to the global Settings default, then "high".
  const quality: string = bodyQuality ?? settings.gpt_image_quality ?? "high";
  // nb2ImageSize is the Vertex-side rendering resolution override ("1K" | "2K").
  // Defaults to "1K" inside callVertexNB2; the Contact Sheet path bumps it to
  // "2K" so each of the 9 post-split tiles has enough pixels to survive
  // application to a scene thumbnail.
  const nb2Size: "1K" | "2K" = nb2ImageSize === "2K" ? "2K" : "1K";
  if (!prompt || !projectId || sceneNumber === undefined) return { error: "Missing required fields: prompt, projectId, sceneNumber" };
  const size = imageSize ?? sizeAlias ?? "1024x1536";
  // Bucket routing:
  //   folder === "mood"   → mood reference images (briefs / mood-board)
  //   folder === "assets" → asset library images (background framings, etc.)
  //                          live alongside the original asset photo uploads
  //                          so cleanup/backup/listing all see them as
  //                          first-class asset blobs.
  //   default              → conti scene outputs.
  const bucket = folder === "mood" ? "mood" : folder === "assets" ? "assets" : "contis";
  let imageBytes: Buffer | undefined;
  let suffix: string = "";
  console.log("[openai-image] Request:", {
    mode,
    model,
    size,
    bucket,
    sceneNumber,
    promptLen: prompt?.length,
    useNanoBanana,
    hasSourceImageUrl: !!sourceImageUrl,
    hasImageBase64: !!imageBase64,
    hasMaskBase64: !!maskBase64,
    refCount: referenceImageUrls.length,
  });
  if (referenceImageUrls.length > 0) {
    console.log(
      "[openai-image] referenceImageUrls:",
      referenceImageUrls.map((u: string) => (u?.length > 120 ? u.slice(0, 117) + "..." : u)),
    );
  }

  // ── Inpaint 라우팅 ──
  //   · NB2 primary (마스크 유무 무관). 브러시 영역은 클라이언트에서 만든 "마스크 오버레이" 레퍼런스로 NB2 에 지시.
  //   · NB2 실패 or sourceImageUrl 없음 → GPT edits 폴백 (이때만 maskBase64 를 실제 인페인팅 마스크로 사용).
  //   · preferredAngleModel === "gpt-image-2" / "gpt-image-1.5" (ChangeAngle
  //     A/B + UI test toggle) → NB2 bypass, 직접 OpenAI vision-edits 로 라우트.
  //     실패 시 폴백 없이 에러를 surface — A/B 데이터가 NB2 에 자동으로
  //     reserve 되지 않도록.
  if (mode === "inpaint") {
    const hasMask = !!maskBase64;
    console.log("[inpaint] routing:", { hasMask, useNanoBanana, forceGpt, preferredAngleModel, refCount: referenceImageUrls.length });

    const isAngleGptModel =
      preferredAngleModel === "gpt-image-2" || preferredAngleModel === "gpt-image-1.5";
    if (isAngleGptModel && sourceImageUrl) {
      // ChangeAngle dedicated path: source image stays the primary reference,
      // tagged assets and mask overlay come after. The selected gpt-image
      // variant sees all of them via /v1/images/edits; the prompt (built
      // client-side from yaw/pitch/zoom + NL hint) is what drives the actual
      // angle change. Model is whichever the modal toggle picked.
      const angleModel = preferredAngleModel as "gpt-image-2" | "gpt-image-1.5";
      if (!openaiKey) {
        return { error: `OPENAI_API_KEY is required for ${angleModel} ChangeAngle`, usedModel: "inpaint-failed" };
      }
      const refs = [sourceImageUrl, ...referenceImageUrls].filter(Boolean);
      const shortTag = angleModel === "gpt-image-1.5" ? "gpt15" : "gpt2";
      try {
        imageBytes = await callGptVisionGenerate(openaiKey, prompt, size, refs, angleModel, quality);
        suffix = hasMask ? `angle-${shortTag}-masked` : `angle-${shortTag}`;
      } catch (e) {
        // Intentionally no NB2 fallback here — we want the error to be
        // loud so the A/B sample isn't silently backfilled by NB2.
        console.error(`[inpaint] ${angleModel} ChangeAngle failed:`, (e as Error).message);
        return { error: `${angleModel} ChangeAngle failed: ${(e as Error).message}`, usedModel: `angle-${shortTag}-failed` };
      }
    } else if (useNanoBanana && sourceImageUrl) {
      // NB2 primary — 원본 + (브러시 있으면) 마스크 오버레이 + 태그 에셋 refs
      try {
        const nbUrls = [sourceImageUrl, ...referenceImageUrls].filter(Boolean);
        console.log(
          "[inpaint] NB2 image layout:",
          nbUrls.map((u, i) => {
            const role =
              i === 0
                ? "[1]SOURCE"
                : hasMask && i === 1
                  ? "[2]MASK_HINT"
                  : `[${i + 1}]${hasMask ? "TAG_ASSET" : "REF"}`;
            return `${role} ${u.length > 80 ? u.slice(0, 77) + "..." : u}`;
          }),
        );
        imageBytes = await callVertexNB2(settings, prompt, nbUrls, sizeToNB2Aspect(size), nb2Size);
        suffix = hasMask ? "inpaint-nb2-masked" : "inpaint-nb2";
      } catch (e) {
        console.error("[inpaint] NB2 failed, falling back to GPT edits:", (e as Error).message);
      }
    }

    if (!imageBytes) {
      // GPT edits 폴백. 브러시 있을 때는 native mask 로 인페인팅, 없을 때는 mask=null 로 reference edit.
      // (마스크 없는 태그-only 인페인팅은 정상 유즈케이스이므로 forceGpt 요구 X.)
      if (!imageBase64) {
        return { error: "GPT edits 폴백에 imageBase64 가 필요합니다", usedModel: "inpaint-failed" };
      }
      if (!openaiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
      imageBytes = await callGptInpaint(openaiKey, imageBase64, maskBase64 ?? null, prompt, size, referenceImageUrls, gptModel, quality);
      suffix = hasMask ? `inpaint-gpt-masked-fallback:${gptModel}` : `inpaint-gpt-fallback:${gptModel}`;
    }
  } else if (model === "gpt") {
    if (!openaiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다. Settings에서 OpenAI API Key를 입력하세요.");
    if (openaiKey.startsWith("sk-ant-")) throw new Error("OpenAI 필드에 Anthropic 키가 입력되어 있습니다. Settings에서 올바른 OpenAI API Key(sk-proj-...)를 입력하세요.");
    // Vision-aware: when the renderer attached `assetImageUrls`, route
    // through callGptVisionGenerate so gpt-image actually SEES the
    // tagged assets instead of relying on text descriptions only. With
    // no refs the helper transparently falls back to the text-only
    // generations endpoint, so this is safe to call unconditionally.
    imageBytes = await callGptVisionGenerate(openaiKey, prompt, size, assetImageUrls, gptModel, quality, inputFidelity);
    suffix = assetImageUrls?.length > 0 ? `gen-gpt-vision:${gptModel}` : `gen-gpt:${gptModel}`;
  } else if (model === "nano-banana-2") {
    try { imageBytes = await callVertexNB2(settings, prompt, assetImageUrls?.length > 0 ? assetImageUrls : undefined, sizeToNB2Aspect(size), nb2Size); suffix = "nano-banana-2"; }
    catch (e) { console.error("[nano-banana-2] failed:", (e as Error).message); if (!openaiKey) throw new Error("NB2 실패, GPT 폴백에 OPENAI_API_KEY 필요"); imageBytes = await callGptVisionGenerate(openaiKey, prompt, size, assetImageUrls, gptModel); suffix = assetImageUrls?.length > 0 ? `nb2-gpt-vision-fallback:${gptModel}` : `nb2-gpt-fallback:${gptModel}`; }
  } else {
    try { imageBytes = await callVertexNB2(settings, prompt, assetImageUrls?.length > 0 ? assetImageUrls : undefined, sizeToNB2Aspect(size), nb2Size); suffix = "nano-banana-2"; }
    catch { if (!openaiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다."); imageBytes = await callGptVisionGenerate(openaiKey, prompt, size, assetImageUrls, gptModel); suffix = assetImageUrls?.length > 0 ? `gen-gpt-vision:${gptModel}` : `gen-gpt:${gptModel}`; }
  }

  const filePath = await saveToStorage(storagePath, bucket, projectId, `scene-${sceneNumber}-${suffix}-${Date.now()}.png`, imageBytes!);
  console.log("[openai-image] Saved:", filePath, "model:", suffix);
  return { publicUrl: storageFileUrl(filePath), usedModel: suffix };
}

// ── Vertex AI: Text Gemini (shared credentials with NB2) ──
function ensureGoogleCredentials(settings: any) {
  if (!settings.google_service_account_key || !settings.google_cloud_project_id) {
    throw new Error("Google Cloud 설정이 필요합니다. 설정 페이지에서 Service Account Key와 Project ID를 입력해주세요.");
  }
}

async function callVertexGemini(settings: any, model: string, requestBody: any): Promise<any> {
  const saKeyJson = settings.google_service_account_key;
  const gcpProjectId = settings.google_cloud_project_id;
  const accessToken = await getVertexAccessToken(saKeyJson);
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/global/publishers/google/models/${model}:generateContent`;
  const res = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    { label: `vertex-gemini:${model}`, timeoutMs: 90_000, retries: 2 },
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Vertex Gemini ${model}] HTTP ${res.status}:`, errText);
    throw new Error(`Vertex AI (${model}) HTTP ${res.status}`);
  }
  return await res.json();
}

// ── Vertex AI NB2 ──
// `imageSize` can be "1K" (default, fast) or "2K" (higher-res, used by the
// Contact Sheet tab where we need enough pixels to crop a 3x3 grid into
// 9 usable tiles without ending up with postage-stamp-sized thumbnails).
async function callVertexNB2(
  settings: any,
  prompt: string,
  imageUrls?: string[],
  aspectRatio?: string,
  imageSize?: "1K" | "2K",
): Promise<Buffer> {
  const saKeyJson = settings.google_service_account_key;
  const gcpProjectId = settings.google_cloud_project_id;
  if (!saKeyJson || !gcpProjectId) throw new Error("Google Cloud credentials not configured");
  const model = "gemini-3.1-flash-image";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/global/publishers/google/models/${model}:generateContent`;
  const parts: any[] = [{ text: prompt }];
  // Image downloads + base64 encoding happen in parallel so a batch of Camera
  // Variations doesn't queue on I/O before each NB2 request even goes out.
  if (imageUrls && imageUrls.length > 0) {
    const downloaded = await Promise.all(
      imageUrls.slice(0, 14).map(async (url) => {
        try { return await downloadImage(url); } catch { return null; }
      }),
    );
    for (const buf of downloaded) {
      if (buf) parts.push({ inlineData: { mimeType: "image/png", data: buf.toString("base64") } });
    }
  }
  const body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: aspectRatio ?? "9:16", imageSize: imageSize ?? "1K" } } });

  /** Single attempt. Bubbles up a sentinel so the outer retry can decide to
   *  refresh the cached access token on 401 (revoked/expired/wall-clock-drift). */
  const attempt = async (): Promise<Buffer> => {
    const accessToken = await getVertexAccessToken(saKeyJson);
    const started = Date.now();
    const res = await fetchWithRetry(
      endpoint,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body },
      { label: "vertex-nb2", timeoutMs: 180_000, retries: 1 },
    );
    if (res.status === 401) {
      const msg = await res.text();
      const err: any = new Error(`Vertex AI HTTP 401: ${msg}`);
      err.__nb2Unauthorized = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Vertex AI HTTP ${res.status}: ${await res.text()}`);
    const result = (await res.json()) as any;
    const elapsed = Date.now() - started;
    console.log(`[vertex-nb2] ok in ${elapsed}ms (refs=${Math.max(0, parts.length - 1)})`);
    if (!result.candidates?.length) throw new Error("Vertex AI: no candidates");
    for (const part of result.candidates[0].content?.parts || []) {
      if (part.inlineData?.data) return Buffer.from(part.inlineData.data, "base64");
    }
    throw new Error("Vertex AI: no image in response");
  };

  try {
    return await attempt();
  } catch (e: any) {
    if (e?.__nb2Unauthorized) {
      console.warn("[vertex-nb2] access token rejected, invalidating cache and retrying once");
      vertexTokenCache = null;
      vertexTokenInflight = null;
      return await attempt();
    }
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────
 * Vertex access-token cache.
 *
 * Every NB2 call used to fetch a fresh token (JWT sign → OAuth endpoint
 * POST). At ~1–2s each that added up fast when firing off 8 Camera
 * Variations in parallel — the OAuth hop alone was a noticeable chunk
 * of per-call latency.
 *
 * Google-issued access tokens for service accounts are valid for 1h.
 * We cache by service-account-key hash (so rotating the SA key
 * invalidates the cache) and consider the token expired 5 minutes
 * before its real expiry to absorb clock skew.
 *
 * In-flight de-dupe: concurrent callers during a cache miss share the
 * SAME promise, so we never kick off more than one OAuth exchange at
 * a time even under a burst.
 * ───────────────────────────────────────────────────────────── */
type CachedToken = { token: string; expiresAt: number };
let vertexTokenCache: { keyHash: string; entry: CachedToken } | null = null;
let vertexTokenInflight: { keyHash: string; promise: Promise<CachedToken> } | null = null;
const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // Google default
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function getVertexAccessToken(saKeyJson: string): Promise<string> {
  const keyHash = crypto.createHash("sha256").update(saKeyJson).digest("hex");
  const now = Date.now();

  if (vertexTokenCache && vertexTokenCache.keyHash === keyHash && vertexTokenCache.entry.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
    return vertexTokenCache.entry.token;
  }
  if (vertexTokenInflight && vertexTokenInflight.keyHash === keyHash) {
    const entry = await vertexTokenInflight.promise;
    return entry.token;
  }

  const promise = (async (): Promise<CachedToken> => {
    const sa = JSON.parse(saKeyJson);
    const iat = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sign = crypto.createSign("RSA-SHA256"); sign.update(signingInput);
    const signature = sign.sign(sa.private_key, "base64url");
    const jwt = `${signingInput}.${signature}`;
    const tokenRes = await fetchWithRetry(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      },
      { label: "google-oauth", timeoutMs: 15_000, retries: 2 },
    );
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    const json = (await tokenRes.json()) as { access_token: string; expires_in?: number };
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    const entry: CachedToken = { token: json.access_token, expiresAt: Date.now() + Math.min(ttlMs, TOKEN_LIFETIME_MS) };
    vertexTokenCache = { keyHash, entry };
    return entry;
  })();

  vertexTokenInflight = { keyHash, promise };
  try {
    const entry = await promise;
    return entry.token;
  } finally {
    if (vertexTokenInflight && vertexTokenInflight.keyHash === keyHash) vertexTokenInflight = null;
  }
}

/* ── GPT image generations / edits ─────────────────────────────────────
 *
 * Three entry points:
 *   1. callGptGenerations       — text-only (no refs).      /v1/images/generations
 *   2. callGptVisionGenerate    — text + asset ref images.  /v1/images/edits (no mask)
 *   3. callGptInpaint           — text + source + (mask).   /v1/images/edits
 *
 * All three accept a `model` parameter so callers can pin a specific
 * gpt-image variant. Defaults to "gpt-image-2" (current GA, released
 * 2026-04-21). Mood Ideation passes "gpt-image-1.5" because image-2
 * generations take ~2-3 minutes per image and a 9-image mood batch in
 * image-2 would blow past the user's patience budget. ChangeAngleModal
 * also exposes a runtime toggle between image-2 (default) and image-1.5
 * for side-by-side camera-change-recognition testing.
 *
 * Timeout note (Phase 1.9): per-call timeoutMs is 300_000 ms. Earlier
 * 180_000 was too tight for image-2's typical ~200 s response time,
 * causing the first attempt to almost always abort and forcing a retry
 * (~6 min wall time + double billing). 300 s lets the first attempt
 * complete normally for the typical case. See the per-helper inline
 * comment near `fetchWithRetry` for the full rationale.
 *
 * input_fidelity caveat: only `gpt-image-1.5` accepts the
 * `input_fidelity` parameter — `gpt-image-2` returns HTTP 400
 * (`invalid_input_fidelity_model`) when the field is present. The
 * helpers below conditionally emit it based on the model name. */

const SUPPORTS_INPUT_FIDELITY = (model: string) => model === "gpt-image-1.5";
const DEFAULT_GPT_IMAGE_MODEL = "gpt-image-2";

async function callGptGenerations(
  apiKey: string,
  prompt: string,
  size: string,
  model: string = DEFAULT_GPT_IMAGE_MODEL,
  quality: string = "high",
): Promise<Buffer> {
  console.log("[callGptGenerations] Starting:", { model, size, quality, promptLen: prompt.length });
  const body = { model, prompt, n: 1, size, quality, output_format: "png" };
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    // gpt-image-2 generations are 1–2min per call and OpenAI returns
    // transient 500/503 (with a `req_*` id) often enough that 1 retry
    // wasn't enough — users were seeing the raw OpenAI 500 toast on
    // single-scene Generate. 3 attempts with a longer base backoff
    // covers the typical recovery window without ballooning total
    // wall-clock for terminal failures.
    // retryOnTimeout: false — a timeout here means the generation itself was
    // slow, not a transient blip; retrying would just double the wait + bill.
    // 5xx/network errors are still retried (retries: 3).
    { label: `openai-generations:${model}`, timeoutMs: 180_000, retries: 3, backoffMs: 2000, retryOnTimeout: false },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as any;
    const msg = errBody.error?.message ?? `GPT generation failed (HTTP ${res.status})`;
    console.error("[callGptGenerations] API error:", res.status, msg);
    throw new Error(msg);
  }
  const data = (await res.json()) as any;
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    console.error("[callGptGenerations] No b64_json in response. Keys:", JSON.stringify(Object.keys(data?.data?.[0] ?? {})));
    throw new Error("No b64_json in GPT response");
  }
  console.log("[callGptGenerations] Success, image bytes:", b64.length);
  return Buffer.from(b64, "base64");
}

/* Vision-aware generation: feeds ref images directly to gpt-image so it
 * can preserve asset identity (faces, costumes, specific props, location
 * geometry) instead of relying purely on the text description in the
 * prompt. Routes through /v1/images/edits because /v1/images/generations
 * does NOT accept any reference image parameter (verified live —
 * `image_input` / `reference_images` / etc. all return `unknown_parameter`).
 *
 * image[] layout (current — same shape as callGptInpaint, max 4 slots
 * accepted by gpt-image edits in practice):
 *   image[0]  = refUrls[0]   (acts as the compositional canvas the model
 *                             starts from + first identity reference)
 *   image[1..]= refUrls[1..3] (additional identity references)
 *
 * Caller is responsible for ordering refUrls so that the most spatially
 * informative asset (background → mood reference → primary character)
 * sits at index 0. `buildAssetImageUrls` in src/lib/conti.ts already
 * does this ordering.
 *
 * If refUrls is empty this delegates to plain callGptGenerations so the
 * vision routing can be applied unconditionally at the call site. */
async function callGptVisionGenerate(
  apiKey: string,
  prompt: string,
  size: string,
  refUrls: string[],
  model: string = DEFAULT_GPT_IMAGE_MODEL,
  quality: string = "high",
  inputFidelity: boolean = true,
): Promise<Buffer> {
  if (!refUrls || refUrls.length === 0) {
    return callGptGenerations(apiKey, prompt, size, model, quality);
  }
  console.log("[callGptVisionGenerate] Starting:", {
    model,
    size,
    quality,
    inputFidelity,
    refCount: refUrls.length,
    promptLen: prompt.length,
  });
  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", prompt);
  formData.append("n", "1");
  formData.append("size", size);
  formData.append("quality", quality);
  formData.append("output_format", "png");
  if (SUPPORTS_INPUT_FIDELITY(model) && inputFidelity) formData.append("input_fidelity", "high");
  // Cap at 8 image[] entries. `/v1/images/edits` accepts up to 16 but the
  // identity-lift curve flattens well before that. 4 was too tight for
  // Mood Ideation scenes that routinely have
  //   [background] + [2 characters] + [weapon/prop] + [mood ref]
  // → at 4 the weapon (ordered last by the caller) got starved and the
  // model invented a generic rifle. 8 covers those multi-asset scenes
  // comfortably while keeping per-call input cost bounded.
  const cap = Math.min(refUrls.length, 8);
  // Phase 2.1: download + downscale references in parallel. Previously this was
  // a sequential await-loop, so N refs meant N back-to-back downloads *before*
  // the OpenAI call could even start (a real, OpenAI-independent wall-time tax,
  // especially for remote URLs). Promise.all preserves array order, so the
  // caller's reference ordering (index 0 = primary canvas) is kept intact.
  const fetched = await Promise.all(
    refUrls.slice(0, cap).map(async (url, i) => {
      try {
        const raw = await downloadImage(url);
        return { i, buf: downscaleRefBuffer(raw) };
      } catch (e) {
        console.warn(`[callGptVisionGenerate] ref ${i} download failed, skipping:`, (e as Error).message);
        return null;
      }
    }),
  );
  let attached = 0;
  for (const r of fetched) {
    if (!r) continue;
    formData.append("image[]", new Blob([r.buf], { type: "image/png" }), `ref-${r.i}.png`);
    attached++;
  }
  if (attached === 0) {
    // All refs failed to download — fall back to text-only generations so
    // the user still gets an image instead of a hard error.
    console.warn("[callGptVisionGenerate] no refs attached, falling back to text-only generations");
    return callGptGenerations(apiKey, prompt, size, model);
  }
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/images/edits",
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: formData },
    // Phase 1.8: ChangeAngle 등 사용자-개시 edit 작업. retries: 3 → 1 로 축소.
    // Phase 1.9 (timeout 튜닝): timeoutMs 180s → 300s 로 상향. 실측 결과
    // gpt-image-2 의 멀티-image vision compose 는 평균 ~200s 가 걸려서 180s
    // 에서는 1 차 시도가 거의 항상 잘려나가고 (사용자 화면에서 빨간 에러 +
    // 2 차 시도로 재호출 → 실효 대기시간 ~6 분 + 빌링 2 배). 300s 로 올리면
    // 1 차 시도가 정상 응답을 받아 평균 대기시간이 절반으로 단축.
    // Phase 2.1: retryOnTimeout: false — timeout 은 "느렸다"는 뜻이지 "재시도하면
    // 빠르다"가 아니므로 즉시 실패시켜 ~10 분 더블-대기/더블-빌링을 차단한다.
    // 일시적 5xx/네트워크 오류는 여전히 retries: 1 로 1 회 회복 시도.
    { label: `openai-vision-generate:${model}`, timeoutMs: 300_000, retries: 1, backoffMs: 2000, retryOnTimeout: false },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    const msg = err.error?.message ?? `GPT vision generate failed (HTTP ${res.status})`;
    console.error("[callGptVisionGenerate] API error:", res.status, msg);
    throw new Error(msg);
  }
  const data = (await res.json()) as any;
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No b64_json in GPT vision response");
  console.log("[callGptVisionGenerate] Success, image bytes:", b64.length, "| refs attached:", attached);
  return Buffer.from(b64, "base64");
}

async function callGptInpaint(
  apiKey: string,
  imageB64: string,
  maskB64: string | null,
  prompt: string,
  size: string,
  refUrls: string[] = [],
  model: string = DEFAULT_GPT_IMAGE_MODEL,
  quality: string = "high",
): Promise<Buffer> {
  const formData = new FormData();
  formData.append("model", model); formData.append("prompt", prompt); formData.append("n", "1"); formData.append("size", size); formData.append("quality", quality); formData.append("output_format", "png");
  if (SUPPORTS_INPUT_FIDELITY(model)) formData.append("input_fidelity", "high");
  formData.append("image[]", new Blob([Buffer.from(imageB64, "base64")], { type: "image/png" }), "image.png");
  for (let i = 0; i < Math.min(refUrls.length, 3); i++) { try { const refBuf = await downloadImage(refUrls[i]); formData.append("image[]", new Blob([refBuf], { type: "image/png" }), `ref-${i}.png`); } catch {} }
  if (maskB64) formData.append("mask", new Blob([Buffer.from(maskB64, "base64")], { type: "image/png" }), "mask.png");
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/images/edits",
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: formData },
    // Phase 1.8: Inpaint 도 사용자-개시 edit 이라 ChangeAngle 와 동일하게
    // retries: 3 → 1 로 축소. Phase 1.9: timeoutMs 180s → 300s 동일 적용.
    // gpt-image-2 응답이 평균 ~200s 라 180s 는 1 차 시도가 거의 무조건 잘리는
    // 비효율 패턴이었음. Phase 2.1: retryOnTimeout: false 로 timeout 시 즉시 실패
    // (더블-대기/빌링 차단). 자세한 근거는 callGptVisionGenerate 주석 참조.
    { label: `openai-edits:${model}`, timeoutMs: 300_000, retries: 1, backoffMs: 2000, retryOnTimeout: false },
  );
  if (!res.ok) {
    const err = (await res.json()) as any;
    throw new Error(err.error?.message ?? "GPT inpaint failed");
  }
  const data = (await res.json()) as any;
  return Buffer.from(data.data[0].b64_json, "base64");
}

async function downloadImage(url: string): Promise<Buffer> {
  // data: URL — 렌더러가 모델 호환 포맷(webp/png 등)으로 미리 재인코딩해 보낸
  // 인라인 이미지. Node fetch 는 data: 를 지원하지 않으므로 직접 디코드한다.
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("Malformed data URL");
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    if (/;base64/i.test(meta)) return Buffer.from(payload, "base64");
    return Buffer.from(decodeURIComponent(payload), "utf8");
  }
  if (url.startsWith("local-file://")) {
    const stripped = url.replace(/^local-file:\/\//i, "").split(/[?#]/)[0];
    return (await fs.promises.readFile(resolveStorageFilePath(decodeURIComponent(stripped)))) as unknown as Buffer;
  }
  const localPrefix = `${getLocalServerBaseUrl()}/storage/file/`;
  if (url.startsWith(localPrefix)) {
    const relative = decodeURIComponent(url.slice(localPrefix.length));
    const fullPath = path.resolve(getStorageBasePath(), relative);
    const base = path.resolve(getStorageBasePath());
    const rel = path.relative(base, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Blocked file outside storage: ${relative}`);
    }
    return (await fs.promises.readFile(fullPath)) as unknown as Buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ── Reference image downscale (Phase 2.1) ────────────────────────────────
 *
 * gpt-image edits processes every attached `image[]` through vision encoding,
 * and that cost scales with the *resolution* of each reference, not just the
 * count. Asset photos are frequently 2K–4K, but the model works at ~1024-class
 * internally, so shipping full-res references just burns input-token time +
 * upload bandwidth with no identity benefit. We downscale the longest edge to
 * `maxEdge` before attaching.
 *
 * Safety:
 *   - Only PNG / JPEG / WebP are decoded. AVIF is explicitly skipped because
 *     Electron's main-process AVIF decoder can hard-crash (ACCESS_VIOLATION,
 *     see main.ts) — uncatchable, so we never feed it to nativeImage.
 *   - Any failure / empty decode / already-small image returns the original
 *     buffer untouched, so this can never make a reference worse than before. */
const REF_MAX_EDGE = 1024;

function sniffResizableImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // WebP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true;
  }
  // Everything else (AVIF/HEIC/GIF/unknown) → leave untouched.
  return false;
}

function downscaleRefBuffer(buf: Buffer, maxEdge = REF_MAX_EDGE): Buffer {
  try {
    if (!sniffResizableImage(buf)) return buf;
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return buf;
    const { width, height } = img.getSize();
    if (!width || !height) return buf;
    if (width <= maxEdge && height <= maxEdge) return buf;
    const scale = maxEdge / Math.max(width, height);
    const resized = img.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      quality: "good",
    });
    if (resized.isEmpty()) return buf;
    const out = resized.toPNG();
    if (!out || out.length === 0) return buf;
    return out as unknown as Buffer;
  } catch {
    return buf;
  }
}

function sizeToNB2Aspect(size: string): string {
  const map: Record<string, string> = { "1024x1536": "9:16", "1536x1024": "16:9", "1024x1024": "1:1" };
  if (map[size]) return map[size];
  const parts = size.split("x").map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) { const ratio = parts[0] / parts[1]; if (ratio >= 1.4) return "16:9"; if (ratio <= 0.75) return "9:16"; return "1:1"; }
  return "9:16";
}

/** Strip characters Windows forbids in filenames.
 *
 *  Why this exists:
 *    Our GPT-path suffix is built as `gen-gpt:${gptModel}` → colons end up
 *    in filenames like `scene-1-gen-gpt:gpt-image-1.5-1776828531162.png`.
 *    On Windows NTFS, `:` is the Alternate-Data-Stream delimiter, so
 *    `fs.writeFile` either silently writes the stream (no primary file on
 *    disk) or throws EINVAL depending on the node build. Either way the
 *    later GET `/storage/file/...png` 404s and the UI shows empty cards
 *    (Mood Ideation, Sketches, etc.).
 *
 *  Forbidden on Windows: < > : " / \ | ? *  plus the control range 0x00-0x1F.
 *  We normalize them all to `-` so existing suffix semantics stay readable
 *  (`gen-gpt-gpt-image-1.5` instead of `gen-gpt:gpt-image-1.5`). Callers
 *  that build filenames with purposely meaningful colons should migrate to
 *  a different separator if they want the info preserved. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
}

async function saveToStorage(basePath: string, bucket: string, projectId: string, fileName: string, data: Buffer): Promise<string> {
  const dir = path.join(basePath, bucket, projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(fileName);
  const fullPath = path.join(dir, safeName);
  await fs.promises.writeFile(fullPath, data);
  return fullPath;
}
