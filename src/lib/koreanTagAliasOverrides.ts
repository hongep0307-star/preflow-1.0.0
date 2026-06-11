/**
 * 한국어 검색어 확장 오버라이드 — EN canonical 태그/무드에 대한 *추가* 한국어
 * 검색 별칭(음역 포함) 을 워크스페이스별 localStorage 에 보관한다.
 *
 * 배경: AI 분류는 `suggested_tags_ko` 를 *자연스러운 한국어 번역(직역)* 으로만
 * 채운다(referenceAi 프롬프트가 "no transliteration" 을 강제). 그래서
 * "halftone" → "망점" 만 검색되고 흔히 쓰는 음역 "하프톤" 으로는 안 잡힌다.
 * 이 스토어는 그 갭을 메우는 *추가* 별칭을 보관해 `buildKoreanTagAliasIndex`
 * 의 seedDictionary 로 합류시킨다 — 기존 별칭을 대체하지 않고 augment 한다.
 *
 * 동기화: animationPreferences 와 동일한 dual-channel 패턴
 *   1) CustomEvent — 같은 윈도우 안의 LibraryPage 가 인덱스를 즉시 재빌드
 *   2) 'storage' 이벤트 — 다른 BrowserWindow/탭
 */

import { workspaceScopedKey } from "./workspaceScopedStorage";
import type { TagSeedEntry } from "./koreanTagSeedDictionary";
import type { ReferenceItem } from "./referenceLibrary";
import type { ReferenceAiSuggestions } from "./referenceAi";

export const KOREAN_ALIAS_OVERRIDES_KEY = "preflow.library.koreanAliasOverrides";
export const KOREAN_ALIAS_AUTO_EXPAND_KEY = "preflow.library.koreanAliasAutoExpand";
export const KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT =
  "preflow:korean-alias-overrides-changed";

/** EN canonical(lowercase) → 한국어 검색 별칭 배열. 키가 *존재* 하면
 *  "확장 시도 완료" 로 간주한다(값이 빈 배열이어도) — auto 재호출 dedupe 기준. */
export type KoreanAliasOverrides = Record<string, string[]>;

const HANGUL_RE = /[\u3131-\u318E\uAC00-\uD7A3]/;

function scopedKey(globalKey: string): string | null {
  return workspaceScopedKey(globalKey);
}

export function readKoreanAliasOverrides(): KoreanAliasOverrides {
  if (typeof window === "undefined") return {};
  try {
    const key = scopedKey(KOREAN_ALIAS_OVERRIDES_KEY);
    if (!key) return {};
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: KoreanAliasOverrides = {};
    for (const [enRaw, ko] of Object.entries(parsed as Record<string, unknown>)) {
      const en = enRaw.trim().toLowerCase();
      if (!en) continue;
      const list = Array.isArray(ko)
        ? ko
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      out[en] = Array.from(new Set(list));
    }
    return out;
  } catch {
    return {};
  }
}

function writeKoreanAliasOverrides(map: KoreanAliasOverrides): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(KOREAN_ALIAS_OVERRIDES_KEY);
    if (!key) return;
    window.localStorage.setItem(key, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT));
  } catch {
    /* quota / private mode — in-memory 갱신은 호출부 state 가 담당 */
  }
}

/** 새 EN→ko[] 결과를 기존 오버라이드에 머지(기존 키는 ko 합집합으로 갱신).
 *  expandEnTagsToKorean 이 응답한 EN 키는 ko 가 비어도 그대로 등록되어
 *  "확장 시도함" 으로 마킹된다(auto dedupe). 반환: 머지 후 전체 맵. */
export function mergeKoreanAliasOverrides(
  additions: KoreanAliasOverrides,
): KoreanAliasOverrides {
  const next: KoreanAliasOverrides = { ...readKoreanAliasOverrides() };
  for (const [enRaw, ko] of Object.entries(additions)) {
    const en = enRaw.trim().toLowerCase();
    if (!en) continue;
    const merged = new Set([
      ...(next[en] ?? []),
      ...ko.map((s) => s.trim()).filter((s) => s.length > 0 && HANGUL_RE.test(s)),
    ]);
    next[en] = Array.from(merged);
  }
  writeKoreanAliasOverrides(next);
  return next;
}

/** 저장된 오버라이드 전체 삭제(설정에서 "초기화" 용). */
export function clearKoreanAliasOverrides(): void {
  writeKoreanAliasOverrides({});
}

/** 이미 확장 시도한 EN 키 집합 — auto 재확장에서 제외(중복 LLM 호출 방지). */
export function getExpandedEnSet(): ReadonlySet<string> {
  return new Set(Object.keys(readKoreanAliasOverrides()));
}

/** 오버라이드를 `buildKoreanTagAliasIndex` 의 seedDictionary 형태로 변환한다.
 *  각 항목을 tag 버킷과 mood 버킷 *양쪽* 에 등록해(family 미지정 + "mood"),
 *  lookup 단계의 inventoryFilter 가 알맞은 카테고리만 남기게 한다 — EN 이
 *  태그인지 무드인지 별도로 추적할 필요가 없다. */
export function koreanAliasOverridesToSeedEntries(
  map: KoreanAliasOverrides,
): TagSeedEntry[] {
  const out: TagSeedEntry[] = [];
  for (const [en, ko] of Object.entries(map)) {
    if (!en || ko.length === 0) continue;
    out.push({ en: [en], ko });
    out.push({ en: [en], ko, family: "mood" });
  }
  return out;
}

/** items 전체에서 EN canonical 태그/무드 인벤토리를 수집한다(소문자,
 *  한글/`folder:`/`source:` 접두사 제외). koreanInventory(LibraryPage) 와
 *  같은 규칙 — 확장 다이얼로그가 자체적으로 listReferences 한 결과에도
 *  동일 인벤토리를 적용하기 위한 공유 헬퍼. */
export function collectEnAliasInventory(
  items: ReadonlyArray<ReferenceItem>,
): string[] {
  const set = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (!tag || tag.startsWith("folder:") || tag.startsWith("source:")) continue;
      if (HANGUL_RE.test(tag)) continue;
      set.add(tag.toLowerCase());
    }
    const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null;
    for (const tag of ai?.suggested_tags ?? []) {
      if (!tag || HANGUL_RE.test(tag)) continue;
      set.add(tag.toLowerCase());
    }
    for (const mood of ai?.mood_labels ?? []) {
      if (!mood || HANGUL_RE.test(mood)) continue;
      set.add(mood.toLowerCase());
    }
  }
  return Array.from(set).sort();
}

/** "새 자료 자동 확장" 토글 — 워크스페이스별. 기본 false(예상치 못한 LLM
 *  비용 방지). 켜면 LibraryPage 가 새로 등장한 EN 태그만 백그라운드로 확장. */
export function readKoreanAliasAutoExpand(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = scopedKey(KOREAN_ALIAS_AUTO_EXPAND_KEY);
    if (!key) return false;
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function saveKoreanAliasAutoExpand(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(KOREAN_ALIAS_AUTO_EXPAND_KEY);
    if (!key) return;
    window.localStorage.setItem(key, value ? "true" : "false");
    window.dispatchEvent(new CustomEvent(KOREAN_ALIAS_OVERRIDES_CHANGED_EVENT));
  } catch {
    /* private mode */
  }
}
