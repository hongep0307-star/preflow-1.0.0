/**
 * AI 분석 언어 정책 (두 축)
 *
 * 1) **Display Language** (`aiOutputLanguageMode`)
 *    - "auto" / "en" / "ko"
 *    - 인스펙터에서 칩/본문을 어떤 언어로 표시할지의 *기본값*. AI 탭의
 *      Display 토글이 이 값을 직접 바꾼다. 분석 결과는 항상 두 언어 모두
 *      DB 에 저장되므로 이 값은 LLM 호출을 다시 일으키지 않는다.
 *    - 분석 LLM 프롬프트에는 *primary attention* 힌트로 전달 — 두 언어 모두
 *      품질 있게 채우되, 이 언어에 약간 더 무게를 두라는 정도.
 *
 * 2) **Tag Language** (`aiTagLanguageMode`)
 *    - "follow" (= Display 따라가기, 기본) / "auto" / "en" / "ko"
 *    - Accept 시 `item.tags` 에 머지할 언어. "follow" 면 사용자가 Display
 *      를 KO 로 보고 있을 때 Accept 한 라이브러리 검색 키도 KO 로 저장된다.
 *      독립 설정으로 두려면 "en"/"ko" 로 고정 — Display 와 무관하게 항상
 *      그 언어로만 머지.
 *    - 어떤 선택이든 ai_suggestions 자체에는 두 언어 다 남아 있으므로
 *      양방향 검색(haystack)이 그대로 작동한다.
 *
 * 두 모드 모두 localStorage 단일 키에 저장되고, CustomEvent + storage 이벤트
 * 로 같은/다른 윈도우 동기화. */
import type { UiLanguage } from "./uiLanguage";

export type AiOutputLanguageMode = "auto" | "en" | "ko";
/** "follow" 는 현재 Display 모드를 그대로 따라간다는 의미.
 *  나머지("auto"/"en"/"ko") 는 Display 와 독립적으로 해석한다. */
export type AiTagLanguageMode = "follow" | AiOutputLanguageMode;
/** 최종 적용 언어(auto/follow 가 해석된 결과). LLM 힌트 / Accept 머지에서
 *  사용. */
export type AiOutputLanguage = UiLanguage;

const DISPLAY_KEY = "preflow.ai.outputLanguage";
const TAG_KEY = "preflow.ai.tagLanguage";
export const AI_OUTPUT_LANGUAGE_CHANGED_EVENT = "preflow.ai.outputLanguage.changed";

const DEFAULT_DISPLAY: AiOutputLanguageMode = "auto";
const DEFAULT_TAG: AiTagLanguageMode = "follow";

function normalizeDisplay(value: string | null | undefined): AiOutputLanguageMode {
  if (value === "en" || value === "ko" || value === "auto") return value;
  return DEFAULT_DISPLAY;
}

function normalizeTag(value: string | null | undefined): AiTagLanguageMode {
  if (value === "follow" || value === "en" || value === "ko" || value === "auto") return value;
  return DEFAULT_TAG;
}

/* ---- Display Language ---- */

export function getAiOutputLanguageMode(): AiOutputLanguageMode {
  if (typeof window === "undefined") return DEFAULT_DISPLAY;
  try {
    return normalizeDisplay(window.localStorage.getItem(DISPLAY_KEY));
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function setAiOutputLanguageMode(mode: AiOutputLanguageMode): void {
  if (typeof window === "undefined") return;
  try {
    if (mode === DEFAULT_DISPLAY) {
      window.localStorage.removeItem(DISPLAY_KEY);
    } else {
      window.localStorage.setItem(DISPLAY_KEY, mode);
    }
  } catch {
    /* private mode 등 — 무시. CustomEvent 는 그래도 디스패치해 같은 윈도우
       구독자에게는 즉시 알린다. */
  }
  try {
    window.dispatchEvent(new CustomEvent(AI_OUTPUT_LANGUAGE_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

/* ---- Tag Language ---- */

export function getAiTagLanguageMode(): AiTagLanguageMode {
  if (typeof window === "undefined") return DEFAULT_TAG;
  try {
    return normalizeTag(window.localStorage.getItem(TAG_KEY));
  } catch {
    return DEFAULT_TAG;
  }
}

export function setAiTagLanguageMode(mode: AiTagLanguageMode): void {
  if (typeof window === "undefined") return;
  try {
    if (mode === DEFAULT_TAG) {
      window.localStorage.removeItem(TAG_KEY);
    } else {
      window.localStorage.setItem(TAG_KEY, mode);
    }
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent(AI_OUTPUT_LANGUAGE_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

/* ---- Resolution ---- */

/** "auto" → UI 언어 따라가기. "en"/"ko" → 그대로 반환. */
export function resolveAiOutputLanguage(
  mode: AiOutputLanguageMode,
  uiLanguage: UiLanguage,
): AiOutputLanguage {
  if (mode === "auto") return uiLanguage;
  return mode;
}

/** Tag 모드 + Display 모드 + UI 언어 → 실제 적용 언어.
 *  "follow" 는 Display 결과를 그대로 차용하므로 Display 의 최종 값에 위임.
 *  "auto" 는 Display 와 무관하게 UI 언어를 따른다. */
export function resolveAiTagLanguage(
  tagMode: AiTagLanguageMode,
  displayMode: AiOutputLanguageMode,
  uiLanguage: UiLanguage,
): AiOutputLanguage {
  if (tagMode === "follow") return resolveAiOutputLanguage(displayMode, uiLanguage);
  if (tagMode === "auto") return uiLanguage;
  return tagMode;
}

/* ---- Subscription ---- */

export function subscribeAiOutputLanguage(callback: () => void): () => void {
  const handler = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== DISPLAY_KEY && event.key !== TAG_KEY) return;
    handler();
  };
  window.addEventListener(AI_OUTPUT_LANGUAGE_CHANGED_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AI_OUTPUT_LANGUAGE_CHANGED_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

/* ---- LLM Prompt Directive ----
   이제 분석은 항상 영어 canonical + 한국어 parallel 두 벌을 *동시에*
   요구한다. Display 모드는 LLM 에게 단지 어느 언어를 1순위 독자로
   가정해 글의 결을 다듬어 달라는 힌트만 전달. */
export function bilingualDirective(primary: AiOutputLanguage): string {
  const primaryLabel = primary === "ko" ? "Korean readers" : "English readers";
  return [
    "OUTPUT REQUIREMENTS — bilingual, ALWAYS:",
    "1. Fill BOTH English canonical fields AND their `*_ko` Korean parallels.",
    "2. English: lowercase, hyphenated tags (e.g. \"urban-night\").",
    "3. Korean parallels: same length & SAME ORDER as canonical. Use natural Korean — NOT phonetic transliteration of English. Idiomatic phrasing (e.g. canonical \"neon-noir\" → \"네온 누아르\" in tags_ko, never \"네온 노이르\").",
    "4. For free-text fields (visual_style, motion_notes, …), keep the meaning identical across English and `*_ko`; rewrite naturally, do not literal-translate sentence by sentence.",
    `5. Primary audience: ${primaryLabel}. Use this as a stylistic priority when wording overlaps allow, but both languages must be fully present and high quality.`,
  ].join("\n");
}
