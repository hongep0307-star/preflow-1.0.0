/**
 * Folder AI settings (Phase D1)
 *
 * 라이브러리 폴더마다 "AI 자동 분류 / 자동 태그 적용" 토글을 따로 둘 수
 * 있게 하는 영속 저장소.
 *
 * 저장 모델:
 *   - localStorage 의 단일 JSON 객체 (`preflow.folder.aiSettings`)
 *     `{ [folderPath]: { autoClassify, autoApplyTags } }`
 *   - 폴더 path 는 항상 `referenceLibrary` 의 표시 path 그대로 (예
 *     `"Reference/Motion"`). 접두어 `folder:` 는 호출부 책임 — 이 모듈은
 *     순수 path string 만 다룬다.
 *   - 변경 시 `window.dispatchEvent(new StorageEvent('storage', ...))`
 *     로 같은 윈도우 내 다른 컴포넌트도 즉시 구독할 수 있다 (브라우저
 *     기본 storage 이벤트는 *다른* 탭에서만 발화하므로 직접 디스패치).
 *
 * 의도된 제약:
 *   - autoApplyTags 는 autoClassify 에 의존(true 일 때만 의미). 검증은
 *     호출부 / UI 책임 — 저장 단에서는 임의 조합도 허용한다 (이전 토글을
 *     보존해 사용자가 다시 켤 때 자기 마지막 상태가 복원되게).
 *   - 폴더 이름이 변경되어도 자동 따라가지 않는다. renameFolder 시
 *     `renameFolderAiSettings(oldPath, newPath)` 를 호출하면 같은 트랜잭션
 *     안에서 키 이름만 옮긴다.
 */

/* localStorage key — preflow.folder.* 네임스페이스 안에 자리 잡는다. */
const STORAGE_KEY = "preflow.folder.aiSettings";

/* 같은 윈도우 내 구독자에게 변경을 알리는 커스텀 이벤트 이름. brave-new
   `dispatchEvent(new StorageEvent("storage", ...))` 도 함께 발화하지만,
   브라우저별로 같은 윈도우의 storage 이벤트를 silently drop 하는 경우가
   있어 별도 이벤트도 같이 쏜다. */
export const FOLDER_AI_SETTINGS_CHANGED_EVENT = "preflow.folder.aiSettings.changed";

export interface FolderAiSettings {
  /** 새 항목이 이 폴더로 import 될 때 자동으로 `classifyReference()` 를
   *  호출할지. classifyQueue 가 동시 실행 상한을 책임지므로 켜져 있는 동안
   *  burst 가 와도 폭주하지 않는다. */
  autoClassify: boolean;
  /** classify 가 끝나면 그 자료에 대해 `acceptReferenceAiSuggestions()` 까지
   *  자동으로 호출해 suggested_tags 를 적용할지. mood_labels 는 A1 변경에
   *  따라 자동 적용되지 않는다. autoClassify 가 false 면 무의미하지만 사용자
   *  토글 상태를 보존하기 위해 값 자체는 자유롭게 저장된다. */
  autoApplyTags: boolean;
}

const DEFAULTS: FolderAiSettings = {
  autoClassify: false,
  autoApplyTags: false,
};

/** in-memory cache — localStorage parse 비용을 줄이기 위해 한 번 읽고 들고
 *  있다가, write/외부 storage 이벤트 시점에 invalidate. */
let cache: Record<string, FolderAiSettings> | null = null;

function readAll(): Record<string, FolderAiSettings> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      cache = {};
      return cache;
    }
    const out: Record<string, FolderAiSettings> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || typeof key !== "string") continue;
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      out[key] = {
        autoClassify: v.autoClassify === true,
        autoApplyTags: v.autoApplyTags === true,
      };
    }
    cache = out;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function writeAll(next: Record<string, FolderAiSettings>): void {
  cache = next;
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    /* private 모드 등 — 저장 실패해도 in-memory cache 로 한 세션 동안은
       토글이 동작한다. */
  }
  /* 같은 윈도우 + 다른 윈도우 양쪽에 변경 신호. CustomEvent 가 같은 윈도우
     의 다른 컴포넌트들이 자기 상태를 다시 읽도록 트리거. */
  try {
    window.dispatchEvent(new CustomEvent(FOLDER_AI_SETTINGS_CHANGED_EVENT));
  } catch {
    /* SSR / 비-DOM 환경 — 무시. 운영 코드에서는 항상 브라우저 컨텍스트. */
  }
}

/** 한 폴더의 AI 설정을 가져온다. 미설정이면 모든 토글이 false 인 default. */
export function getFolderAiSettings(folderPath: string): FolderAiSettings {
  if (!folderPath) return { ...DEFAULTS };
  const all = readAll();
  const found = all[folderPath];
  if (!found) return { ...DEFAULTS };
  return { ...found };
}

/** 한 폴더의 AI 설정을 쓴다. 모두 false 인 경우는 항목 자체를 제거해
 *  저장소가 자연스럽게 마이그레이션 / 비워지도록. */
export function setFolderAiSettings(folderPath: string, value: FolderAiSettings): void {
  if (!folderPath) return;
  const all = { ...readAll() };
  const next: FolderAiSettings = {
    autoClassify: !!value.autoClassify,
    autoApplyTags: !!value.autoApplyTags,
  };
  const isDefault = !next.autoClassify && !next.autoApplyTags;
  if (isDefault) {
    if (!(folderPath in all)) return; // no-op — write skip
    delete all[folderPath];
  } else {
    all[folderPath] = next;
  }
  writeAll(all);
}

/** 모든 폴더의 AI 설정 dict 를 그대로 돌려준다. 호출부에서 React 상태로
 *  들고 있을 때 변경 이벤트와 같이 쓰면 즉시 sync. shallow-clone 반환 —
 *  내부 캐시는 절대 외부에 노출하지 않는다. */
export function listFolderAiSettings(): Record<string, FolderAiSettings> {
  const all = readAll();
  const out: Record<string, FolderAiSettings> = {};
  for (const [k, v] of Object.entries(all)) out[k] = { ...v };
  return out;
}

/** 한 폴더의 설정 자체를 제거 — 폴더 삭제 / 휴지통 시 호출. */
export function removeFolderAiSettings(folderPath: string): void {
  if (!folderPath) return;
  const all = { ...readAll() };
  if (!(folderPath in all)) return;
  delete all[folderPath];
  writeAll(all);
}

/** renameFolder() 시 설정을 새 경로로 옮겨 준다. 자식 폴더의 설정까지
 *  cascade 하려면 호출부가 prefix 매칭으로 한 번에 옮겨야 한다 — 라이브러리
 *  의 다른 prefs (FolderPreferences) 와 일관된 패턴. */
export function renameFolderAiSettings(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const all = { ...readAll() };
  const found = all[oldPath];
  if (!found) return;
  delete all[oldPath];
  all[newPath] = found;
  writeAll(all);
}

/** 한 윈도우 내에서 변경을 구독한다. unsubscribe 함수를 돌려줘 React
 *  useEffect 의 cleanup 으로 그대로 사용할 수 있게. */
export function subscribeFolderAiSettings(callback: () => void): () => void {
  const handler = () => {
    /* 외부 storage 이벤트가 도착하면 cache invalidate 후 콜백. CustomEvent
       경로에서도 같은 invalidation 을 통과하도록 동일 handler 를 공유. */
    cache = null;
    callback();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== STORAGE_KEY) return;
    handler();
  };
  window.addEventListener(FOLDER_AI_SETTINGS_CHANGED_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FOLDER_AI_SETTINGS_CHANGED_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

/** 테스트용 — cache reset (운영 코드에서 호출하지 않음). */
export function _resetFolderAiSettingsCache(): void {
  cache = null;
}
