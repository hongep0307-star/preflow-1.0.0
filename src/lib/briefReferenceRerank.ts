/**
 * briefReferenceRerank — 브리프 ↔ 라이브러리 레퍼런스 의미 기반 재정렬.
 *
 * 기존 매칭(scoreReferences)은 신호 토큰 ↔ 자료 AI메타 토큰의 *정확 교집합* 이라
 * "cozy" vs "따뜻한" 처럼 의미는 같지만 단어가 다른 자료를 놓친다. 여기서는
 *
 *   1) scoreReferences 로 후보를 넓게 recall(완화된 minScore) — 토큰이 하나도
 *      안 겹쳐도 분류된 자료 풀에서 상위 N개를 확보,
 *   2) 각 후보의 AI 메타를 압축한 다이제스트를 LLM(gpt-5.5)에 넘겨
 *      브리프 적합도(0-100)로 *의미 기반* 재정렬,
 *
 * 한다. 임베딩 인프라 없이 LLM 1회로 "잡힐 만한데 안 잡힌다" 회귀를 메운다.
 */
import { callLLM } from "./llm";
import { OPENAI_PRIMARY, getModelMeta } from "./modelCatalog";
import { scoreReferences, type BriefSignals } from "./referenceRecommender";
import type { ReferenceItem } from "./referenceLibrary";

export interface BriefRerankInput {
  briefText?: string;
  signals?: BriefSignals;
}

export interface RerankedReference {
  id: string;
  /** 0-100 적합도. 높을수록 브리프 무드/연출에 잘 맞음. */
  fit: number;
  reason?: string;
}

export interface RerankOptions {
  /** LLM 에 넘길 최대 후보 수(토큰 비용 상한). 기본 60. */
  maxCandidates?: number;
  /** 이 fit 미만은 결과에서 제외. 기본 40. */
  minFit?: number;
  signal?: AbortSignal;
}

const MAX_CANDIDATES_DEFAULT = 60;
const MIN_FIT_DEFAULT = 40;

interface CandidateDigest {
  id: string;
  kind: string;
  tags?: string[];
  mood?: string[];
  use_cases?: string[];
  scene?: string;
  style?: string;
  color?: string;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** 분류된(ai_suggestions 보유) 자료인지. 다이제스트가 채워지는 후보 판별. */
function isClassified(item: ReferenceItem): boolean {
  const ai = item.ai_suggestions;
  if (!ai || typeof ai !== "object") return false;
  return Object.keys(ai).length > 0;
}

/** ReferenceItem → 의미 다이제스트(한/영 메타 병합, 길이 상한). */
function toDigest(item: ReferenceItem): CandidateDigest {
  const ai = (item.ai_suggestions ?? {}) as Record<string, unknown>;
  const tags = Array.from(
    new Set([
      ...asStringArray(item.tags),
      ...asStringArray(ai.suggested_tags),
      ...asStringArray(ai.suggested_tags_ko),
    ]),
  ).slice(0, 12);
  const mood = Array.from(
    new Set([...asStringArray(ai.mood_labels), ...asStringArray(ai.mood_labels_ko)]),
  ).slice(0, 8);
  const use_cases = Array.from(
    new Set([...asStringArray(ai.use_cases), ...asStringArray(ai.use_cases_ko)]),
  ).slice(0, 8);
  const scene = (asString(ai.scene_description_ko) ?? asString(ai.scene_description))?.slice(0, 360);
  const style = (asString(ai.visual_style_ko) ?? asString(ai.visual_style))?.slice(0, 240);
  const color = (asString(ai.color_notes_ko) ?? asString(ai.color_notes))?.slice(0, 160);
  return {
    id: item.id,
    kind: item.kind,
    tags: tags.length ? tags : undefined,
    mood: mood.length ? mood : undefined,
    use_cases: use_cases.length ? use_cases : undefined,
    scene,
    style,
    color,
  };
}

/** 후보 recall — scoreReferences(완화) 우선, 토큰 교집합이 0이라 비면 분류된
 *  자료를 최근순으로 채운다. 분류 자료가 없으면 전체에서. */
function recallCandidates(
  signals: BriefSignals | undefined,
  candidates: ReferenceItem[],
  cap: number,
): ReferenceItem[] {
  const live = candidates.filter((c) => !c.deleted_at);
  const classified = live.filter(isClassified);
  const pool = classified.length > 0 ? classified : live;

  const ordered: ReferenceItem[] = [];
  const seen = new Set<string>();

  if (signals) {
    const scored = scoreReferences(signals, pool, {
      minScore: 0.1,
      limit: cap,
      strict: false,
    });
    for (const r of scored) {
      if (seen.has(r.item.id)) continue;
      seen.add(r.item.id);
      ordered.push(r.item);
    }
  }

  // 토큰 매칭이 부족하면 분류 풀의 최근 사용/추가순으로 채워 의미 재정렬에 맡긴다.
  if (ordered.length < cap) {
    const rest = [...pool]
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => {
        const ta = a.last_used_at ?? a.created_at ?? "";
        const tb = b.last_used_at ?? b.created_at ?? "";
        return tb.localeCompare(ta);
      });
    for (const c of rest) {
      if (ordered.length >= cap) break;
      seen.add(c.id);
      ordered.push(c);
    }
  }

  return ordered.slice(0, cap);
}

const RERANK_SYSTEM = [
  "You rank visual reference assets by how well they fit a creative brief's mood and direction.",
  "You receive the brief (text + extracted signals) and a list of candidate references with their AI metadata",
  "(tags, mood, use_cases, scene description, visual style, color notes).",
  "Judge SEMANTIC fit — synonyms and cross-language matches count (e.g. 'cozy' ≈ '따뜻한').",
  "Score each candidate 0-100 (100 = perfect mood/direction match). Only include references that are genuinely relevant.",
  "",
  "Return ONLY valid JSON: { \"ranked\": [{ \"id\": string, \"fit\": number, \"reason\": string }] }",
  "- id MUST be one of the provided candidate ids.",
  "- reason: a short (<=12 words) Korean note on why it fits.",
  "- Omit clearly irrelevant references rather than scoring them low.",
].join("\n");

function buildUserPrompt(input: BriefRerankInput, digests: CandidateDigest[]): string {
  const sig = input.signals;
  const sigText = sig
    ? (Object.keys(sig) as (keyof BriefSignals)[])
        .map((k) => {
          const v = sig[k];
          return Array.isArray(v) && v.length ? `${k}: ${v.join(", ")}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  return [
    "## Brief",
    input.briefText?.trim() || "(no text — rely on signals)",
    sigText ? `\n## Signals\n${sigText}` : "",
    "\n## Candidates (JSON)",
    JSON.stringify(digests),
    "\nReturn ONLY the JSON object.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 브리프에 맞는 레퍼런스를 의미 기반으로 재정렬한다. 분류된 후보가 없으면
 * 빈 배열을 반환(호출부가 안내). 실패해도 throw 하지 않고 [] 반환 — 토큰 기반
 * 1차 결과를 그대로 쓰면 되도록.
 */
export async function rerankReferencesForBrief(
  input: BriefRerankInput,
  candidates: ReferenceItem[],
  opts: RerankOptions = {},
): Promise<RerankedReference[]> {
  const cap = opts.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
  const minFit = opts.minFit ?? MIN_FIT_DEFAULT;

  const recall = recallCandidates(input.signals, candidates, cap);
  if (recall.length === 0) return [];

  const digests = recall.map(toDigest);
  const validIds = new Set(recall.map((r) => r.id));

  const maxTokens = getModelMeta(OPENAI_PRIMARY)?.maxOutputTokens ?? 4000;
  let result;
  try {
    result = await callLLM({
      model: OPENAI_PRIMARY,
      system: RERANK_SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(input, digests) }],
      response_format: "json_object",
      max_tokens: maxTokens,
    });
  } catch (e) {
    console.warn("[briefRerank] LLM call failed:", (e as Error).message);
    return [];
  }

  const cleaned = result.text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn("[briefRerank] JSON parse failed");
    return [];
  }

  const rankedRaw = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).ranked : null);
  if (!Array.isArray(rankedRaw)) return [];

  const out: RerankedReference[] = [];
  const seen = new Set<string>();
  for (const row of rankedRaw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    const fitRaw = typeof r.fit === "number" ? r.fit : Number(r.fit);
    const fit = Number.isFinite(fitRaw) ? Math.max(0, Math.min(100, fitRaw)) : 0;
    if (fit < minFit) continue;
    seen.add(id);
    out.push({ id, fit, reason: asString(r.reason) });
  }
  out.sort((a, b) => b.fit - a.fit);
  return out;
}
