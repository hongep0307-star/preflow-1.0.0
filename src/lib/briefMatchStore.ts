/**
 * briefMatchStore — "브리프 매치" 폴더가 들고 있는 브리프 내용 저장소.
 *
 * 브리프 매치 폴더는 일반 폴더(`folder:` 태그)와 동일하게 레퍼런스를 담지만,
 * "이 폴더는 이런 브리프로 모은 것" 이라는 브리프 텍스트/아이디어 노트를 함께
 * 보관해 언제든 프로젝트로 다시 내보낼 수 있어야 한다. 그 메타를 folderPrefs /
 * folderCache 와 동일한 패턴(localStorage + CustomEvent, workspace-scoped)으로
 * 폴더 경로별로 저장한다.
 */
import { migrateGlobalToScopedIfDefault, workspaceScopedKey } from "./workspaceScopedStorage";

const KEY = "preflow.library.briefMatchStore";
export const BRIEF_MATCH_STORE_CHANGED_EVENT = "preflow:library-brief-match-changed";

export interface BriefMatchEntry {
  briefText: string;
  ideaNote?: string;
  createdAt: string;
  /** 브리프 캡쳐 이미지(플라이아웃에 드롭/붙여넣은 것). 프로젝트 내보내기 시
   *  브리프 첨부로 carry + 분석 입력으로 사용. base64 라 quota 초과 가능 —
   *  write 가 실패하면 텍스트/레퍼런스만 보관된다(graceful). */
  images?: { base64: string; mediaType: string }[];
  /** 브리프 PDF 에서 추출한 텍스트(있으면 raw_text/분석에 합류). */
  pdfText?: string;
}

type BriefMatchMap = Record<string, BriefMatchEntry>;

function normalize(path: string): string {
  return path
    .replace(/^folder:/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function read(): BriefMatchMap {
  if (typeof window === "undefined") return {};
  migrateGlobalToScopedIfDefault(KEY);
  const key = workspaceScopedKey(KEY);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as BriefMatchMap;
  } catch {
    return {};
  }
}

function write(map: BriefMatchMap): void {
  if (typeof window === "undefined") return;
  const key = workspaceScopedKey(KEY);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(BRIEF_MATCH_STORE_CHANGED_EVENT));
  } catch {
    /* quota / private mode — in-memory 동작엔 지장 없음 */
  }
}

export function getBriefMatchEntry(path: string): BriefMatchEntry | null {
  const key = normalize(path);
  if (!key) return null;
  return read()[key] ?? null;
}

export function setBriefMatchEntry(path: string, entry: BriefMatchEntry): void {
  const key = normalize(path);
  if (!key) return;
  const map = read();
  map[key] = entry;
  write(map);
}

export function removeBriefMatchEntry(path: string): void {
  const key = normalize(path);
  if (!key) return;
  const map = read();
  if (!(key in map)) return;
  delete map[key];
  write(map);
}

export function listBriefMatchPaths(): string[] {
  return Object.keys(read());
}

/** 해당 폴더에 의미 있는 브리프 내용(텍스트/이미지/PDF 중 하나)이 있는지.
 *  일반 폴더 → 스마트 브리프 매치 이동 게이트 판정에 사용. */
export function hasBriefContent(path: string): boolean {
  const entry = getBriefMatchEntry(path);
  if (!entry) return false;
  return (
    !!(entry.briefText && entry.briefText.trim()) ||
    (Array.isArray(entry.images) && entry.images.length > 0) ||
    !!(entry.pdfText && entry.pdfText.trim())
  );
}

/** 폴더 경로가 바뀔 때(이동/이름변경/복제) 보관된 브리프 내용을 같은 경로 변화로
 *  따라가게 한다. 자기 경로 + `oldPath/` 접두 자손까지 키를 재작성한다.
 *  (folderPrefs/manualOrder 의 cascade 패턴과 동일.) */
export function cascadeRenameBriefMatchEntries(oldPath: string, newPath: string): void {
  const o = normalize(oldPath);
  const n = normalize(newPath);
  if (!o || !n || o === n) return;
  const map = read();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key === o) {
      map[n] = map[key];
      delete map[key];
      changed = true;
    } else if (key.startsWith(`${o}/`)) {
      const suffix = key.slice(o.length); // 선행 "/" 포함
      map[`${n}${suffix}`] = map[key];
      delete map[key];
      changed = true;
    }
  }
  if (changed) write(map);
}

/** 복제(duplicate)용 — 원본 트리의 브리프 내용을 새 경로 트리로 *복사*(원본 유지). */
export function cascadeDuplicateBriefMatchEntries(oldPath: string, newPath: string): void {
  const o = normalize(oldPath);
  const n = normalize(newPath);
  if (!o || !n || o === n) return;
  const map = read();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key === o) {
      map[n] = { ...map[key] };
      changed = true;
    } else if (key.startsWith(`${o}/`)) {
      const suffix = key.slice(o.length);
      map[`${n}${suffix}`] = { ...map[key] };
      changed = true;
    }
  }
  if (changed) write(map);
}

/** 특정 엔트리의 보관 이미지(base64)를 제거 — 프로젝트로 내보낸 뒤 소비 완료 처리.
 *  텍스트/PDF 메타는 유지하므로 폴더에서 재내보내기는 가능(이미지만 빠짐). */
export function clearBriefMatchImages(path: string): void {
  const key = normalize(path);
  if (!key) return;
  const map = read();
  const entry = map[key];
  if (!entry || !entry.images) return;
  delete entry.images;
  write(map);
}

/** localStorage quota 회복용 — 가장 최근 keepRecent 개 엔트리를 제외한 모든
 *  엔트리의 base64 이미지를 비운다(createdAt 내림차순). 텍스트는 유지.
 *  반환: 실제로 이미지를 비운 엔트리 수. */
export function pruneBriefMatchImages(keepRecent = 0): number {
  const map = read();
  const entries = Object.entries(map)
    .filter(([, v]) => Array.isArray(v.images) && v.images.length > 0)
    .sort((a, b) => (b[1].createdAt || "").localeCompare(a[1].createdAt || ""));
  let pruned = 0;
  for (let i = keepRecent; i < entries.length; i++) {
    delete entries[i][1].images;
    pruned++;
  }
  if (pruned > 0) write(map);
  return pruned;
}
