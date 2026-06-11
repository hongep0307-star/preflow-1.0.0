/**
 * Conti Studio > Compare > Library 풀의 localStorage chokepoint.
 *
 * Compare 의 library 서브탭은 사용자가 라이브러리에서 끌어와 누적한 자료의
 * *스냅샷* 을 프로젝트 단위로 영구화한다. 키는 프로젝트 단위
 * (`ff_compare_lib_refs_<projectId>`) 이라 *현재 활성이 아닌 다른 프로젝트*
 * 의 풀에도 안전하게 cross-workspace write 가 가능하다.
 *
 * ━━━ 왜 *스냅샷* (base64 썸네일 인라인) 인가 ━━━
 *
 * 각 워크스페이스는 별개 SQLite DB + 별개 storage 경로를 가진다. 라이브러리
 * 워크스페이스의 reference 본체와 파일은 프로젝트 워크스페이스에서 *어떤
 * 방법으로도* 조회/스트림할 수 없다(local server 가 활성 워크스페이스의 storage
 * base 만 서빙). id 만 저장하고 ContiStudio 에서 `listReferencesByIds` /
 * `<img src=file_url>` 로 해석하려 하면 cross-workspace 경로에서 모두 fail —
 * 사용자에겐 "추가했다 하더니 빈 그리드" 로 보인다(Brief 가 base64 inline 로
 * 풀어 둔 것과 동일한 함정).
 *
 * 그래서 attach 시점에 (=사용자가 라이브러리 워크스페이스에 머무는 그 순간)
 * 정적 poster(thumbnail) 을 fetch 해 data: URL 로 변환하여 entry 에 인라인
 * 한다. data URL 은 워크스페이스/DB/원격 서버에 일체 의존하지 않으므로 어떤
 * 워크스페이스에서 열어도 똑같이 렌더된다.
 *
 * footprint: 썸네일은 보통 10–50KB(jpg/webp) 라 50 개 풀 기준 LS 사용량은
 * 약 2~3MB. 5–10MB LS quota 안쪽으로 안전.
 *
 * ━━━ 데이터 포맷 ━━━
 *
 * 현행:  `CompareLibraryEntry[]` JSON
 * 레거시: `string[]` (id-only) — 본 모듈 도입 *이전* 코드가 남긴 데이터.
 *         read 시 자동 감지해 빈 풀로 fall back (사용자가 다시 추가하도록 유도).
 */

import type { ReferenceItem } from "./referenceLibrary";

export const compareLibraryLsKey = (projectId: string) => `ff_compare_lib_refs_${projectId}`;

/** Compare > Library 풀의 단일 항목 — 표시에 필요한 최소 필드만 보관한다.
 *  ContiStudio 의 그리드는 이 entry 만으로 100% 렌더 가능하며, DB / 원본
 *  파일 서버에 일체 접근하지 않는다. */
export interface CompareLibraryEntry {
  /** 원본 ReferenceItem.id — dedup key + 사용자가 "라이브러리에서 보기"
   *  같은 역링크에 사용. */
  id: string;
  /** image/webp/gif/video/youtube 등. UI 가 배지(YT/VID/GIF)/링크 등을
   *  분기하는 데 사용. */
  kind: ReferenceItem["kind"];
  /** 사용자에게 보이는 짧은 이름 (tooltip / 접근성). */
  title: string;
  /** 정적 썸네일(poster) 의 data: URL. 항상 *필수* — 풀에 들어오기 위한
   *  최소 조건이며 cross-workspace 안전성의 핵심. video/gif 도 이 필드 하나로
   *  그리드에 보여진다(애니메이션 없음). */
  thumbnailDataUrl: string;
  /** 원본 파일의 storage URL. 같은 워크스페이스 안에선 "원본 보기" 점프에
   *  쓸 수 있지만 cross-workspace 에서는 404 가 나는 것이 정상. 표시용으로
   *  의존해서는 안 된다. */
  originalUrl?: string | null;
  /** 라이브러리에 처음 push 된 ISO timestamp — 향후 정렬/만료 정책에 사용. */
  addedAt: string;
}

function isEntry(value: unknown): value is CompareLibraryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.kind === "string" &&
    typeof v.thumbnailDataUrl === "string" &&
    v.thumbnailDataUrl.startsWith("data:")
  );
}

/** LS 에서 entries 를 읽는다. 레거시 string[] / 손상 JSON 은 빈 배열로
 *  fall back. */
export function readCompareLibraryEntries(projectId: string): CompareLibraryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(compareLibraryLsKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 레거시 string[] 감지 — 이전 버전(코드 도입 직후) 이 남긴 데이터.
    // 본체/파일이 cross-workspace 에서 복원 불가능하므로 silent 하게 비운다.
    // (사용자가 같은 자료를 다시 추가하면 새 포맷으로 정상 진입.)
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

/** 전체 entries 를 통째로 쓴다. */
export function writeCompareLibraryEntries(projectId: string, entries: CompareLibraryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(compareLibraryLsKey(projectId), JSON.stringify(entries));
  } catch {
    /* private mode / quota — 무시. caller 가 toast 등 분기는 별도 책임. */
  }
}

export interface AppendResult {
  added: CompareLibraryEntry[];
  duplicate: CompareLibraryEntry[];
}

/** entries 를 풀 뒤에 append. 같은 id 의 항목은 중복으로 분류해 caller 에
 *  보고 — 토스트 분기에 사용. */
export function appendCompareLibraryEntries(
  projectId: string,
  entries: CompareLibraryEntry[],
): AppendResult {
  if (entries.length === 0) return { added: [], duplicate: [] };
  const current = readCompareLibraryEntries(projectId);
  const seen = new Set(current.map((e) => e.id));
  const added: CompareLibraryEntry[] = [];
  const duplicate: CompareLibraryEntry[] = [];
  for (const e of entries) {
    if (!e?.id) continue;
    if (seen.has(e.id)) {
      duplicate.push(e);
      continue;
    }
    seen.add(e.id);
    added.push(e);
  }
  if (added.length > 0) {
    writeCompareLibraryEntries(projectId, [...current, ...added]);
  }
  return { added, duplicate };
}

/** 단일 id 제거 (사용자가 그리드에서 X 버튼). 존재하지 않으면 noop. */
export function removeCompareLibraryEntry(projectId: string, id: string): void {
  const current = readCompareLibraryEntries(projectId);
  const next = current.filter((e) => e.id !== id);
  if (next.length !== current.length) {
    writeCompareLibraryEntries(projectId, next);
  }
}

/** ReferenceItem 한 건을 CompareLibraryEntry 로 변환.
 *
 *  - thumbnail_url(poster) 을 fetch → data: URL 로 인라인.
 *  - thumbnail 이 없는 자료는 file_url(이미지) 로 폴백 — gif/video 처럼
 *    *애니메이션이 되는* 원본을 인라인하는 건 의도 위반이라 명시적으로
 *    금지(no-poster gif/video 는 throw).
 *  - 호출자는 라이브러리 워크스페이스 활성 상태에서 부르는 것이 정상.
 *    그 외 환경에서는 fetch 가 404 가 날 수 있다(자연 throw).
 */
export async function makeCompareLibraryEntry(item: ReferenceItem): Promise<CompareLibraryEntry> {
  let sourceUrl: string | null = null;
  if (item.kind === "image" || item.kind === "webp") {
    sourceUrl = item.thumbnail_url || item.file_url || null;
  } else if (item.kind === "gif" || item.kind === "video" || item.kind === "youtube") {
    // 정적 poster *만* 인라인 — 풀에 들어가면 절대 애니메이션 안 됨.
    sourceUrl = item.thumbnail_url || null;
  } else {
    // doc/link 등 시각 카드로 부적합한 kind 는 진입 자체를 막는다.
    throw new Error(`Reference kind "${item.kind}" cannot be added to Compare Library.`);
  }
  if (!sourceUrl) {
    throw new Error(`Reference "${item.title}" has no static thumbnail to snapshot.`);
  }

  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to fetch thumbnail (HTTP ${res.status}).`);
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);

  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    thumbnailDataUrl: dataUrl,
    originalUrl: item.file_url ?? null,
    addedAt: new Date().toISOString(),
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result."));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.readAsDataURL(blob);
  });
}
