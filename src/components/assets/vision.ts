import { callClaude } from "@/lib/claude";
import type { AssetType } from "./types";

const VISION_CONFIGS: Record<AssetType, { system: string; prompt: string }> = {
  character: {
    system: "You are a fashion analyst for commercial film production. Analyze clothing and return only JSON.",
    prompt: `이 이미지 속 인물의 착장만 분석하세요. 아래 JSON만 반환 (마크다운 없이):\n{"outfit":"의상 설명 (영어, 색상/스타일/의류 종류 포함)"}`,
  },
  item: {
    system: "You are a prop analyst for commercial film production. Analyze objects and return only JSON.",
    prompt: `이 이미지 속 오브젝트/소품을 분석하세요. 아래 JSON만 반환 (마크다운 없이):\n{"description":"상세 묘사 (영어, 형태/크기/소재/색상/질감/특이사항/브랜드 포함)"}`,
  },
  background: {
    system: "You are a location scout for commercial film production. Analyze locations and return only JSON.",
    prompt: `이 이미지 속 배경/장소를 분석하세요. 아래 JSON만 반환 (마크다운 없이):\n{"description":"장소 묘사 (영어, 공간 유형/조명/분위기/색감/주요 요소/시간대 포함)"}`,
  },
};

/** 통합 1콜: 라이브러리 레퍼런스를 에셋으로 승격할 때, 타입 추천 + 세 타입의
 *  설명을 한 번에 받는다. 다이얼로그가 추천 타입을 프리셀렉트하고, 사용자가
 *  타입을 바꿔도 추가 호출 없이 캐시된 설명을 쓸 수 있다. */
export interface PromoteAnalysis {
  asset_type: AssetType;
  outfit: string;
  item_description: string;
  space_description: string;
}

export const analyzeForPromote = async (
  base64: string,
  mediaType: string,
): Promise<PromoteAnalysis> => {
  const data = await callClaude({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system:
      "You classify a reference image into a production asset type and describe it for each type. Return only JSON, no markdown.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
          {
            type: "text",
            text:
              `이 이미지를 광고 프로덕션 에셋으로 분류하고 묘사하세요. 아래 JSON만 반환(마크다운 없이):\n` +
              `{\n` +
              `  "asset_type": "character | item | background 중 가장 적합한 하나",\n` +
              `  "outfit": "인물일 경우 착장 설명 (영어, 색상/스타일/의류 종류)",\n` +
              `  "item_description": "사물/소품일 경우 상세 묘사 (영어, 형태/크기/소재/색상/질감/특이사항)",\n` +
              `  "space_description": "장소/배경일 경우 묘사 (영어, 공간 유형/조명/분위기/색감/주요 요소/시간대)"\n` +
              `}\n` +
              `세 설명은 가능한 한 모두 채우되, 해당 없으면 빈 문자열.`,
          },
        ],
      },
    ],
  });
  const raw: string = data.content?.[0]?.text ?? "";
  if (!raw) throw new Error("응답이 비어 있습니다");
  const jsonMatch = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim()
    .match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`JSON 파싱 실패: ${raw.slice(0, 80)}`);
  const parsed = JSON.parse(jsonMatch[0]) as Partial<PromoteAnalysis>;
  const at: AssetType =
    parsed.asset_type === "item" || parsed.asset_type === "background" ? parsed.asset_type : "character";
  return {
    asset_type: at,
    outfit: typeof parsed.outfit === "string" ? parsed.outfit : "",
    item_description: typeof parsed.item_description === "string" ? parsed.item_description : "",
    space_description: typeof parsed.space_description === "string" ? parsed.space_description : "",
  };
};

export const callVisionAnalyze = async (base64: string, mediaType: string, type: AssetType) => {
  const { system, prompt } = VISION_CONFIGS[type];
  const data = await callClaude({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const raw: string = data.content?.[0]?.text ?? "";
  if (!raw) throw new Error("응답이 비어 있습니다");
  const jsonMatch = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim()
    .match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`JSON 파싱 실패: ${raw.slice(0, 80)}`);
  return JSON.parse(jsonMatch[0]);
};

export interface CharacterSheetVisionResult {
  /** Identity-level appearance description: face shape, skin tone, hair
   *  texture/color/style, build. Useful as `ai_description` when the
   *  field is empty. */
  appearance?: string;
  /** Outfit / styling description: garments, materials, colors,
   *  accessories. Useful as `outfit_description` when empty. */
  outfit?: string;
}

/**
 * Vision analysis tuned for character reference sheets (Phase 3 §3).
 *
 * Unlike `callVisionAnalyze("character", ...)` which only returns
 * `outfit`, the sheet has multiple panels giving the model a much
 * richer view of the person — we extract BOTH facial identity and
 * outfit so callers can populate empty fields after a successful
 * sheet generation. Single round-trip keeps the additional cost
 * bounded.
 *
 * Caller responsibilities:
 *   · Run only against a sheet image (not the original portrait —
 *     this prompt expects a multi-panel turnaround).
 *   · Treat returned strings as suggestions; never overwrite values
 *     the user already typed.
 */
export const callCharacterSheetVision = async (
  base64: string,
  mediaType: string,
): Promise<CharacterSheetVisionResult> => {
  const data = await callClaude({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system:
      "You are a character designer for commercial film production. Analyze a multi-panel character reference sheet and return only JSON.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              // Anthropic SDK requires a literal MIME union here. The
              // caller has already validated the media type via
              // `urlToBase64`, so a narrowing cast is safe and avoids
              // the `any` escape hatch the older callVisionAnalyze
              // helper still uses on line ~29.
              media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: base64,
            },
          },
          {
            type: "text",
            text: `이 이미지는 캐릭터 reference sheet (16:9, 좌측 전신 2컷, 우측 얼굴 2x2 그리드) 입니다. 패널 전체를 종합해 다음 JSON 만 반환 (마크다운 없이):
{
  "appearance": "Identity description (English, 1-2 sentences): face shape, skin tone, hair texture/color/style, build, age range. Avoid clothing here.",
  "outfit": "Outfit description (English, 1-2 sentences): garments, fabrics, colors, accessories, footwear. Avoid identity/face here."
}`,
          },
        ],
      },
    ],
  });
  const raw: string = data.content?.[0]?.text ?? "";
  if (!raw) throw new Error("응답이 비어 있습니다");
  const jsonMatch = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim()
    .match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`JSON 파싱 실패: ${raw.slice(0, 80)}`);
  const parsed = JSON.parse(jsonMatch[0]) as CharacterSheetVisionResult;
  return {
    appearance: typeof parsed.appearance === "string" ? parsed.appearance.trim() : undefined,
    outfit: typeof parsed.outfit === "string" ? parsed.outfit.trim() : undefined,
  };
};
