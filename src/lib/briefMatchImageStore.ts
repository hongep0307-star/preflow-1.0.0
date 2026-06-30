/**
 * briefMatchImageStore — 브리프 매치 폴더의 첨부 이미지(base64)를 IndexedDB 에
 * 보관한다.
 *
 * 왜 IndexedDB 인가:
 *   - 텍스트/아이디어/PDF 텍스트는 작아서 briefMatchStore(localStorage)에 둬도
 *     안전하지만, 이미지(base64)는 localStorage 의 작은 quota(≈5MB)를 빠르게
 *     채워 `pruneBriefMatchImages` 로 자동 폐기되던 데이터 손실 핫스팟이었다.
 *   - IndexedDB 는 quota 가 훨씬 크고 quota 회복 로직의 대상도 아니므로, 폴더가
 *     살아 있는 한 이미지가 사라지지 않는다.
 *
 * 스코프:
 *   - localStorage 와 달리 IndexedDB 는 origin 단위라 워크스페이스 구분이
 *     자동이 아니다. 따라서 key 앞에 활성 워크스페이스 id 를 붙여 분리한다
 *     (`ws_<id>::<normalizedPath>`). id 미로딩 시엔 안전하게 no-op/빈 배열.
 *
 * 레거시 마이그레이션:
 *   - 과거 버전은 이미지를 briefMatchStore 엔트리의 `images`(base64) 로 들고
 *     있었다. 읽기 시 IndexedDB 가 비어 있고 localStorage 엔트리에 레거시
 *     이미지가 있으면 IndexedDB 로 옮기고 localStorage 에서는 비운다(quota 안전).
 */
import { getCachedActiveId } from "./workspaceClient";
import {
  BRIEF_MATCH_STORE_CHANGED_EVENT,
  clearBriefMatchImages,
  getBriefMatchEntry,
} from "./briefMatchStore";

export interface BriefImage {
  base64: string;
  mediaType: string;
}

const DB_NAME = "preflow.briefMatchImages";
const DB_VERSION = 1;
const STORE = "images";

/** 폴더 경로 정규화 — briefMatchStore.normalize 와 동일 규칙. */
function normalizePath(path: string): string {
  return path
    .replace(/^folder:/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

/** 워크스페이스 스코프 키. id 미로딩 시 null → 호출부가 no-op 처리. */
function scopedKey(path: string): string | null {
  const id = getCachedActiveId();
  const p = normalizePath(path);
  if (!id || !p) return null;
  return `ws_${id}::${p}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  // 열기 실패 시 다음 호출에서 재시도할 수 있게 캐시를 비운다.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function notifyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BRIEF_MATCH_STORE_CHANGED_EVENT));
}

/** 한 키에 대한 raw get (마이그레이션 없음). */
function idbGet(key: string): Promise<BriefImage[] | null> {
  return openDb().then(
    (db) =>
      new Promise<BriefImage[] | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as BriefImage[] | undefined) ?? null);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbPut(key: string, images: BriefImage[]): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(images, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/** 모든 키 나열 — cascade(rename/duplicate/delete) 의 subtree 매칭에 사용. */
function idbAllKeys(): Promise<string[]> {
  return openDb().then(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
        req.onerror = () => reject(req.error);
      }),
  );
}

/** 폴더의 첨부 이미지를 반환. IndexedDB 가 비어 있고 localStorage 엔트리에
 *  레거시 base64 이미지가 있으면 1회 마이그레이션한 뒤 반환한다. 실패 시 []. */
export async function getBriefMatchImages(path: string): Promise<BriefImage[]> {
  const key = scopedKey(path);
  if (!key) return [];
  try {
    const fromIdb = await idbGet(key);
    if (fromIdb && fromIdb.length > 0) return fromIdb;
    // 레거시 — localStorage 엔트리에 남아 있던 base64 이미지를 IndexedDB 로 이주.
    const legacy = getBriefMatchEntry(path)?.images;
    if (legacy && legacy.length > 0) {
      await idbPut(key, legacy);
      clearBriefMatchImages(path);
      return legacy;
    }
    return [];
  } catch {
    // IndexedDB 사용 불가/실패 시 레거시 localStorage 이미지로 폴백(있으면).
    return getBriefMatchEntry(path)?.images ?? [];
  }
}

/** 폴더의 첨부 이미지를 저장. 빈 배열이면 키를 삭제한다. */
export async function setBriefMatchImages(path: string, images: BriefImage[]): Promise<void> {
  const key = scopedKey(path);
  if (!key) return;
  try {
    if (images.length === 0) await idbDelete(key);
    else await idbPut(key, images);
    notifyChanged();
  } catch {
    /* best-effort */
  }
}

/** 폴더 경로 변경(이동/이름변경) — 자기 키 + `oldPath/` 자손 키를 새 경로로 이동. */
export async function cascadeRenameBriefMatchImages(oldPath: string, newPath: string): Promise<void> {
  const oKey = scopedKey(oldPath);
  const nKey = scopedKey(newPath);
  if (!oKey || !nKey || oKey === nKey) return;
  try {
    const keys = await idbAllKeys();
    const prefix = `${oKey}/`;
    let changed = false;
    for (const key of keys) {
      if (key === oKey || key.startsWith(prefix)) {
        const images = await idbGet(key);
        if (images) {
          const nextKey = key === oKey ? nKey : `${nKey}${key.slice(oKey.length)}`;
          await idbPut(nextKey, images);
          await idbDelete(key);
          changed = true;
        }
      }
    }
    if (changed) notifyChanged();
  } catch {
    /* best-effort */
  }
}

/** 폴더 복제 — 원본 트리의 이미지를 새 경로 트리로 *복사*(원본 유지). */
export async function cascadeDuplicateBriefMatchImages(oldPath: string, newPath: string): Promise<void> {
  const oKey = scopedKey(oldPath);
  const nKey = scopedKey(newPath);
  if (!oKey || !nKey || oKey === nKey) return;
  try {
    const keys = await idbAllKeys();
    const prefix = `${oKey}/`;
    let changed = false;
    for (const key of keys) {
      if (key === oKey || key.startsWith(prefix)) {
        const images = await idbGet(key);
        if (images) {
          const nextKey = key === oKey ? nKey : `${nKey}${key.slice(oKey.length)}`;
          await idbPut(nextKey, images);
          changed = true;
        }
      }
    }
    if (changed) notifyChanged();
  } catch {
    /* best-effort */
  }
}

/** 폴더 삭제 — 자기 키 + 자손 키의 이미지를 모두 제거. */
export async function cascadeDeleteBriefMatchImages(path: string): Promise<void> {
  const key = scopedKey(path);
  if (!key) return;
  try {
    const keys = await idbAllKeys();
    const prefix = `${key}/`;
    let changed = false;
    for (const k of keys) {
      if (k === key || k.startsWith(prefix)) {
        await idbDelete(k);
        changed = true;
      }
    }
    if (changed) notifyChanged();
  } catch {
    /* best-effort */
  }
}
