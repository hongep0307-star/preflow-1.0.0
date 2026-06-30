/**
 * briefMatch.ts — "브리프 매치(Brief Match)" 기능의 오케스트레이션.
 *
 *   1) briefToMoodSpec        — 브리프(텍스트+이미지) → MoodFilterSpec + AI 폴더명
 *   2) saveMatchesToLibraryFolder — 선택 레퍼런스를 라이브러리 폴더로 정적 저장
 *   3) exportBriefToNewProject    — 새 프로젝트 생성 + 브리프/레퍼런스 시드
 *
 * 매칭 자체는 기존 scoreReferences 파이프라인(LibraryPage 의 moodFilter)을 그대로
 * 재사용하므로 여기서는 신호(signals) 생성까지만 담당한다.
 */
import { supabase } from "./supabase";
import { callLLM, type LLMContentPart } from "./llm";
import { OPENAI_PRIMARY, getModelMeta } from "./modelCatalog";
import { tokenize, type BriefSignals } from "./referenceRecommender";
import { type MoodFilterSpec } from "./moodSearch";
import {
  addReferencesToFolder,
  normalizeFolderPath,
  referenceToRefItem,
  buildAnnotationFromLibrary,
  type ReferenceItem,
} from "./referenceLibrary";
import { listLibraryReferences, crossRefToReferenceItem } from "./crossWorkspaceLibrary";
import { addUserFolderPath, getUserFolderPaths } from "./folderCache";
import { setFolderMeta } from "./folderPreferences";
import { getBriefMatchEntry, setBriefMatchEntry, listBriefMatchPaths } from "./briefMatchStore";
import { setBriefMatchImages } from "./briefMatchImageStore";
import { addImageAttachment, addPdfAttachment, addVideoAttachment, addYoutubeAttachment } from "./briefAttachments";
import type { RefItem } from "./refItems";
import type { PendingBriefMatchProject } from "./pendingBriefMatchProject";

/** base64 → Blob (브리프 이미지/포스터를 DB storage 로 업로드할 때 사용). */
function base64ToBlob(base64: string, mediaType: string): Blob {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

/** 크로스-워크스페이스 레퍼런스(RefItem)를 새 프로젝트의 brief_attachments(role:
 *  "reference")로 영구 저장한다. base64 를 localStorage draft 에 쌓지 않아 quota
 *  안전 — 마운트 recovery 가 file_url preview 로 되살린다. */
async function carryRefItemToDb(projectId: string, refItem: RefItem, originReferenceId: string): Promise<void> {
  if (refItem.kind === "image") {
    if (!refItem.base64) throw new Error("image refItem missing base64");
    const blob = base64ToBlob(refItem.base64, refItem.mediaType);
    await addImageAttachment(projectId, blob, {
      role: "reference",
      originReferenceId,
      annotation: refItem.annotation ?? undefined,
    });
    return;
  }
  if (refItem.kind === "youtube") {
    await addYoutubeAttachment(projectId, {
      role: "reference",
      url: refItem.url,
      videoId: refItem.videoId,
      title: refItem.title,
      channel: refItem.channel,
      thumbnailUrl: refItem.thumbnailUrl,
      transcript: refItem.transcript,
      durationSec: refItem.durationSec,
      originReferenceId,
      annotation: refItem.annotation ?? undefined,
    });
    return;
  }
  // video — 포스터만 디스크에 저장, 원본은 remoteUrl(storage URL)로 참조.
  if (!refItem.posterBase64) throw new Error("video refItem missing poster");
  const posterBlob = base64ToBlob(refItem.posterBase64, "image/jpeg");
  await addVideoAttachment(projectId, {
    role: "reference",
    filename: refItem.fileName,
    posterBlob,
    durationSec: refItem.durationSec,
    fileSize: refItem.fileSize,
    remoteUrl: refItem.remoteUrl,
    originReferenceId,
    annotation: refItem.annotation ?? undefined,
  });
}

export const BRIEF_MATCH_ROOT = "브리프 매치";

/** 경로가 브리프 매치 루트/하위인지. (folder: 접두 유무 무관) */
export function isBriefMatchPath(path: string): boolean {
  const p = normalizeFolderPath(path);
  return p === BRIEF_MATCH_ROOT || p.startsWith(`${BRIEF_MATCH_ROOT}/`);
}

const SIGNAL_KEYS = ["mood", "genre", "product", "location", "lighting", "camera", "keywords"] as const;

/** 자료 측 토큰 공간과 100% 일치시키기 위해 referenceRecommender.tokenize 로
 *  쪼갠다(공백/콤마/슬래시 분해 + stopword 제거). expandMoodQuery 와 동일 정책. */
function coerceSignals(parsed: unknown): BriefSignals {
  const out: BriefSignals = {
    mood: [], genre: [], product: [], location: [], lighting: [], camera: [], keywords: [],
  };
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  for (const key of SIGNAL_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    for (const raw of value) {
      if (typeof raw !== "string") continue;
      for (const tok of tokenize(raw)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        out[key].push(tok);
      }
    }
  }
  return out;
}

export interface BriefMatchInput {
  text?: string;
  images?: { mediaType: string; dataBase64: string }[];
}

export interface BriefMatchAnalysis {
  spec: MoodFilterSpec;
  /** AI 가 제안한 폴더명(편집 가능). 비면 호출부가 날짜 기본값으로 대체. */
  folderName: string;
}

/** LLM 이 빈 응답(토큰 예산 소진 등)을 돌려줘 신호 추출에 실패했을 때 던진다.
 *  과거에는 빈 spec 을 조용히 반환해 "매칭 0건 + 날짜 폴더" 로 둔갑했다. 이제
 *  호출부(BriefMatchFlyout.handleAnalyze)가 잡아 사용자에게 실패를 알리고 빈
 *  폴더 생성을 막는다. */
export class BriefAnalysisEmptyError extends Error {
  constructor(message = "브리프 분석 결과가 비어 있습니다. 다시 시도해 주세요.") {
    super(message);
    this.name = "BriefAnalysisEmptyError";
  }
}

function signalsAreEmpty(signals: BriefSignals): boolean {
  return SIGNAL_KEYS.every((key) => signals[key].length === 0);
}

const ANALYSIS_SYSTEM = [
  "You analyze a creative brief (text and/or reference images) and return structured visual reference signals",
  "so a reference library can be matched by mood/feel. Think in short keywords (1-3 words).",
  "Emit BOTH natural English AND natural Korean tokens in every non-empty category (the library indexes both).",
  "Do not transliterate — use real Korean words.",
  "",
  "Return ONLY valid JSON of this shape:",
  "{",
  '  "signals": {',
  '    "mood": string[], "genre": string[], "product": string[],',
  '    "location": string[], "lighting": string[], "camera": string[], "keywords": string[]',
  "  },",
  '  "folderName": string',
  "}",
  "",
  "Rules:",
  "- mood: emotion/atmosphere (warm, tense / 따뜻한, 긴장감).",
  "- genre: content kind (ad, music-video, documentary / 광고, 뮤직비디오).",
  "- product: named products/subjects only (else empty). Keep brand names as-is.",
  "- location/lighting/camera: place, lighting, shot/lens/motion keywords (한/영 모두).",
  "- keywords: any other useful tokens.",
  "- Lowercase English tokens; Korean tokens as-is. Use spaces, not hyphens. (signals only)",
  "- Never invent product/brand names not present in the brief.",
  "",
  "folderName — name the folder smartly:",
  "1) If the brief contains an EXPLICIT title / project name / campaign name, use it VERBATIM.",
  "   Look for fields/headers like 'Project name', '프로젝트명', a document title/heading,",
  "   or a leading title line. Examples:",
  "   - '07. 41.1 WSUS Promotion Shorts' → '41.1 WSUS Promotion Shorts'",
  "     (strip a leading list/ordinal number like '07.' but KEEP meaningful version numbers like '41.1').",
  "   - 'PUBGM x 잔망루피 Collaboration Teaser Trailer' → use the whole title as-is.",
  "2) Keep the title's ORIGINAL language and casing — if it's English, keep English (do NOT translate to Korean).",
  "   The folderName is exempt from the lowercase/Korean rules above.",
  "3) Only if there is NO explicit title, generate a concise 2-5 word name capturing the brief concept/mood,",
  "   in the brief's dominant language. Examples: 따뜻한 가족 광고, Neon Cyberpunk Action.",
  "- No slashes, quotes, or special characters. Keep it under ~60 characters.",
].join("\n");

/** 브리프(텍스트/이미지) → MoodFilterSpec + AI 폴더명. LLM 1회. */
export async function briefToMoodSpec(input: BriefMatchInput): Promise<BriefMatchAnalysis> {
  const text = (input.text ?? "").trim();
  const images = input.images ?? [];

  const parts: LLMContentPart[] = [];
  for (const img of images.slice(0, 4)) {
    parts.push({ type: "image", mediaType: img.mediaType, dataBase64: img.dataBase64 });
  }
  parts.push({
    type: "text",
    text: text
      ? `Brief:\n${text}\n\nReturn ONLY the JSON.`
      : "Analyze the attached reference image(s) and return ONLY the JSON.",
  });

  // gpt-5.5 는 reasoning 토큰이 출력 예산을 먼저 소진한다. 700 같은 작은 값이면
  // 본문 JSON 이 나오기 전에 잘려 "빈 응답 → 신호 0개" 가 된다. 모델의 최대
  // 출력 예산(16K)을 그대로 부여해 reasoning + 본문이 모두 들어가게 한다.
  const maxTokens = getModelMeta(OPENAI_PRIMARY)?.maxOutputTokens ?? 4000;
  const result = await callLLM({
    model: OPENAI_PRIMARY,
    system: ANALYSIS_SYSTEM,
    messages: [{ role: "user", content: parts }],
    response_format: "json_object",
    max_tokens: maxTokens,
  });

  const cleaned = result.text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const signals = coerceSignals(parsed.signals ?? parsed);
  const folderName =
    typeof parsed.folderName === "string" ? parsed.folderName.trim().replace(/[\\/]/g, " ").trim() : "";

  // 신호가 전부 비고 폴더명도 없으면 LLM 응답이 사실상 비었다는 뜻 — 조용히
  // 빈 spec 을 반환하면 매칭 0건 + 날짜 폴더로 둔갑하므로 명시적으로 실패시킨다.
  if (signalsAreEmpty(signals) && !folderName) {
    throw new BriefAnalysisEmptyError();
  }

  const spec: MoodFilterSpec = {
    rawQuery: text.slice(0, 200),
    signals,
    // 후보를 넉넉히 보여주려고 관대하게(strict off) 시작 — 사용자가 그리드에서 추림.
    minScore: 0.5,
    strict: false,
  };
  return { spec, folderName };
}

function dateStamp(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** briefText 앞부분에서 2-5 단어를 뽑아 폴더명 fallback 을 만든다.
 *  AI 폴더명이 비었을 때(토큰 수정 후에는 드묾) 날짜보다 의미 있는 이름을 준다. */
function fallbackNameFromBrief(briefText?: string): string {
  const text = (briefText ?? "").trim();
  if (!text) return "";
  const words = text
    .replace(/[\\/\n\r\t]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const name = words.join(" ").slice(0, 40).trim();
  return normalizeFolderPath(name);
}

/** 현재 워크스페이스에 이미 존재하는 폴더 경로 집합(브리프 매치 store + folderCache). */
function existingFolderPaths(): Set<string> {
  const set = new Set<string>();
  for (const p of listBriefMatchPaths()) set.add(normalizeFolderPath(p));
  for (const p of getUserFolderPaths()) set.add(normalizeFolderPath(p));
  return set;
}

/** baseName 이 이미 있으면 " (1)", " (2)" … 를 붙여 항상 새 경로를 만든다.
 *  (프로젝트/라이브러리 팩 import 의 dedup 패턴과 동일.) */
function uniqueBriefMatchPath(baseName: string): string {
  const existing = existingFolderPaths();
  const root = BRIEF_MATCH_ROOT;
  const build = (n: number) => `${root}/${n === 0 ? baseName : `${baseName} (${n})`}`;
  let n = 0;
  while (existing.has(normalizeFolderPath(build(n)))) n += 1;
  return build(n);
}

/** 폴더명 → `브리프 매치/{name}` 정규 경로. 이름이 비면 날짜 기본값. */
export function resolveBriefMatchFolderPath(folderName: string): string {
  const cleaned = normalizeFolderPath(folderName || "");
  const name = cleaned || dateStamp();
  // 이미 "브리프 매치/..." 로 시작하면 그대로, 아니면 루트 아래로 넣는다.
  return name.startsWith(`${BRIEF_MATCH_ROOT}/`) || name === BRIEF_MATCH_ROOT
    ? name
    : `${BRIEF_MATCH_ROOT}/${name}`;
}

/** 선택 레퍼런스를 브리프 매치 폴더로 정적 저장 + 브리프 내용 보관. 반환: 폴더 경로. */
export async function saveMatchesToLibraryFolder(
  referenceIds: string[],
  folderName: string,
  brief?: {
    briefText?: string;
    ideaNote?: string;
    images?: { base64: string; mediaType: string }[];
    pdfText?: string;
  },
): Promise<string> {
  // 1) 이름 결정: AI 폴더명 → briefText fallback → 날짜.
  const baseName =
    normalizeFolderPath(folderName || "") ||
    fallbackNameFromBrief(brief?.briefText) ||
    dateStamp();
  // 2) 같은 이름이 이미 있으면 " (n)" 을 붙여 항상 새 폴더를 만든다(병합 방지).
  const path = uniqueBriefMatchPath(baseName);
  addUserFolderPath(path); // 빈 폴더라도 사이드바에 보이도록
  // 일반 폴더와 구분되도록 브리프 매치 루트/하위 폴더를 빨간색으로.
  setFolderMeta(BRIEF_MATCH_ROOT, { color: "red" });
  setFolderMeta(path, { color: "red" });
  // 브리프 내용 보관 — 이후 폴더에서 언제든 프로젝트로 재생성 가능하게.
  // 텍스트/아이디어/PDF 텍스트는 localStorage(작아서 안전), 이미지(base64)는
  // IndexedDB 로 분리 저장해 localStorage quota 로 자동 폐기되지 않게 한다.
  const imageCount = brief?.images?.length ?? 0;
  setBriefMatchEntry(path, {
    briefText: brief?.briefText ?? "",
    ideaNote: brief?.ideaNote,
    createdAt: new Date().toISOString(),
    pdfText: brief?.pdfText || undefined,
    imageCount: imageCount > 0 ? imageCount : undefined,
  });
  if (imageCount > 0) {
    await setBriefMatchImages(path, brief!.images!);
  }
  if (referenceIds.length > 0) {
    await addReferencesToFolder(referenceIds, path);
  }
  return path;
}

/** 대상(프로젝트) 워크스페이스로 전환(reload)된 뒤 DashboardPage 가 호출.
 *  활성 DB(=대상 프로젝트 WS)에 프로젝트 + 브리프(사전 분석 포함)를 생성하고,
 *  라이브러리 레퍼런스를 크로스-워크스페이스로 해석해 브리프 draft(refItems)로 시드한다.
 *  반환: 새 projectId.
 *
 *  레퍼런스를 project_reference_links 가 아니라 draft(localStorage)로만 넣는 이유는
 *  exportBriefToNewProject 와 동일하다(라이브러리/프로젝트 WS 가 달라 링크 project_id
 *  가 "알 수 없는 프로젝트" 로 누적되는 문제 회피). */
export async function createProjectFromPending(payload: PendingBriefMatchProject): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: project, error } = await supabase
    .from("projects")
    .insert([
      {
        title: payload.title?.trim() || "Untitled",
        status: "active",
        video_format: payload.videoFormat ?? "horizontal",
        folder_id: payload.folderId ?? null,
        deadline: payload.deadline ?? null,
        // 요청 부서는 전용 컬럼이 없어 client 컬럼을 재사용한다.
        client: payload.client ?? null,
        user_id: user?.id,
      } as any,
    ])
    .select()
    .single();
  if (error || !project?.id) {
    throw new Error(error?.message ?? "프로젝트 생성에 실패했습니다.");
  }
  const projectId = project.id as string;

  // 1) briefs 시드 — raw_text 보관(분석은 BriefTab 진입 시 자동 실행되어 채워진다).
  const rawText = [payload.briefText?.trim(), payload.pdfText?.trim(), payload.ideaNote?.trim()]
    .filter(Boolean)
    .join("\n\n");
  const briefImages = payload.briefImages ?? [];
  const sourceType = payload.pdfText ? "pdf" : briefImages.length > 0 ? "image" : "text";
  try {
    await supabase.from("briefs").insert({
      project_id: projectId,
      raw_text: rawText,
      source_type: sourceType,
      lang: payload.lang,
    } as any);
  } catch (e) {
    console.warn("[briefMatch] briefs seed failed:", (e as Error).message);
  }

  const { appendLibraryRefItemToProject, seedBriefContentToProjectDraft } = await import("@/components/BriefTab");

  // 2) 라이브러리 레퍼런스를 크로스-워크스페이스로 해석 → refIds 로 필터 →
  //    브리프 DB 첨부(role:"reference")로 carry. base64 를 localStorage draft 에
  //    쌓지 않아 quota 안전 — 마운트 recovery 가 file_url preview 로 되살린다.
  //    DB 첨부 실패 시 per-item 으로 draft 시드로 폴백(데이터 유실 방지).
  if (payload.refIds.length > 0) {
    try {
      const { references } = await listLibraryReferences(payload.libraryWsId, { limit: 1000 });
      const wanted = new Set(payload.refIds);
      const selected = references.filter((r) => wanted.has(r.id));
      for (const cross of selected) {
        try {
          const item = crossRefToReferenceItem(cross);
          const refItem = await referenceToRefItem(item, buildAnnotationFromLibrary(item));
          try {
            await carryRefItemToDb(projectId, refItem, item.id);
          } catch (dbErr) {
            console.warn("[briefMatch] ref DB carry failed, falling back to draft:", (dbErr as Error).message);
            appendLibraryRefItemToProject(projectId, refItem);
          }
        } catch (e) {
          console.warn("[briefMatch] ref seed skipped:", (e as Error).message);
        }
      }
    } catch (e) {
      console.warn("[briefMatch] cross-workspace ref resolve failed:", (e as Error).message);
    }
  }

  // 3) 브리프 캡쳐 이미지를 DB 첨부(role:"brief")로 carry — 풀스크린 캡쳐 base64 를
  //    draft 에 넣으면 quota 를 터뜨리므로 DB 로 직접 저장하고, 텍스트/아이디어만
  //    draft 에 시드한다(작아서 안전). 이미지는 마운트 recovery 가 표시.
  for (const img of briefImages) {
    try {
      const blob = base64ToBlob(img.base64, img.mediaType);
      await addImageAttachment(projectId, blob, { role: "brief" });
    } catch (e) {
      console.warn("[briefMatch] brief image DB carry failed:", (e as Error).message);
    }
  }
  seedBriefContentToProjectDraft(projectId, {
    briefText: payload.briefText,
    ideaNote: payload.ideaNote,
    images: [],
  });

  // 4) 자동 분석 플래그 — BriefTab 이 마운트되어 콘텐츠가 준비되면 1회 분석 실행.
  if (payload.autoAnalyze) {
    try {
      localStorage.setItem(`ff_brief_autoanalyze_${projectId}`, "1");
    } catch {
      /* ignore */
    }
  }

  return projectId;
}

export interface ExportBriefInput {
  title: string;
  briefText?: string;
  ideaNote?: string;
  videoFormat?: "horizontal" | "vertical" | "square";
  /** 브리프 본문 첨부 이미지(로컬 드롭). */
  images?: { blob: Blob; filename?: string }[];
  /** 브리프 PDF(로컬 드롭). */
  pdf?: { blob: Blob; filename?: string; extractedText?: string; pages?: number };
  /** 매칭 후 선택된 라이브러리 레퍼런스. */
  selectedRefs: ReferenceItem[];
}

/** 새 프로젝트를 만들고 브리프 텍스트/첨부 + 선택 레퍼런스를 시드한다.
 *  반환: 새 projectId (호출부가 /project/:id?tab=brief 로 이동). */
export async function exportBriefToNewProject(input: ExportBriefInput): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: project, error } = await supabase
    .from("projects")
    .insert([
      {
        title: input.title?.trim() || "Untitled",
        status: "active",
        video_format: input.videoFormat ?? "horizontal",
        user_id: user?.id,
      } as any,
    ])
    .select()
    .single();
  if (error || !project?.id) {
    throw new Error(error?.message ?? "프로젝트 생성에 실패했습니다.");
  }
  const projectId = project.id as string;

  // 1) briefs.raw_text 시드 — BriefTab 가 마운트 시 LS draft 가 비어 있으면 이 값을 로드.
  const rawText = [input.briefText?.trim(), input.pdf?.extractedText, input.ideaNote?.trim()]
    .filter(Boolean)
    .join("\n\n");
  const sourceType = input.pdf ? "pdf" : (input.images && input.images.length > 0 ? "image" : "text");
  try {
    await supabase.from("briefs").insert({ project_id: projectId, raw_text: rawText, source_type: sourceType });
  } catch (e) {
    console.warn("[briefMatch] briefs seed failed:", (e as Error).message);
  }

  // 2) 브리프 본문 첨부(이미지/PDF) — role: "brief"
  for (const img of input.images ?? []) {
    try {
      await addImageAttachment(projectId, img.blob, { role: "brief", filename: img.filename });
    } catch (e) {
      console.warn("[briefMatch] addImageAttachment failed:", (e as Error).message);
    }
  }
  if (input.pdf) {
    try {
      await addPdfAttachment(projectId, input.pdf.blob, {
        role: "brief",
        filename: input.pdf.filename,
        extractedText: input.pdf.extractedText,
        pageCount: input.pdf.pages,
      });
    } catch (e) {
      console.warn("[briefMatch] addPdfAttachment failed:", (e as Error).message);
    }
  }

  // 3) 선택 레퍼런스를 브리프 draft(refItems)로만 전달한다.
  //    project_reference_links 는 만들지 않는다 — 라이브러리/프로젝트가 다른
  //    워크스페이스면 링크의 project_id 가 해석되지 않아 인스펙터에 "알 수 없는
  //    프로젝트" 로 무한 누적된다. 브리프 패널은 RefItem(base64 draft) 로 표시/
  //    분석하므로 draft 만으로 충분하다(localStorage 라 워크스페이스 무관).
  const { appendLibraryRefItemToProject } = await import("@/components/BriefTab");
  for (const item of input.selectedRefs) {
    try {
      const refItem = await referenceToRefItem(item, buildAnnotationFromLibrary(item));
      appendLibraryRefItemToProject(projectId, refItem);
    } catch (e) {
      console.warn("[briefMatch] appendLibraryRefItemToProject failed:", (e as Error).message);
    }
  }

  return projectId;
}
