/**
 * Settings 의 인메모리 스냅샷 + 구독 헬퍼.
 *
 * 왜 필요한가:
 *   - SettingsPage 가 키/플래그를 변경하면 ModelPicker, BriefTab 인라인 picker
 *     등이 즉시 가용성을 다시 계산해야 함.
 *   - settings 는 LOCAL_SERVER `/settings/get` 엔드포인트에서 가져오므로
 *     매 렌더마다 fetch 하면 비효율적 → 한 번 로드해서 캐시하고, 변경 시
 *     `invalidateSettingsCache()` 로 강제 리프레시.
 *
 * 형식: 카탈로그/디스패처가 settings 형태에 강하게 결합되지 않도록
 * `Record<string, string>` 으로만 다룬다 (settings DB 가 string-only 스키마).
 */
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

type SettingsSnapshot = Record<string, string>;

let cached: SettingsSnapshot | null = null;
let inflight: Promise<SettingsSnapshot> | null = null;
const listeners = new Set<(s: SettingsSnapshot) => void>();

async function fetchSettings(): Promise<SettingsSnapshot> {
  try {
    const res = await fetch(`${LOCAL_SERVER_BASE_URL}/settings/get`, {
      method: "POST",
      headers: LOCAL_SERVER_AUTH_HEADERS,
    });
    const json = (await res.json()) as Record<string, any>;
    const flat: SettingsSnapshot = {};
    for (const [k, v] of Object.entries(json)) {
      if (v === undefined || v === null) continue;
      flat[k] = String(v);
    }
    return flat;
  } catch (e) {
    console.warn("[settingsCache] fetch failed:", (e as Error).message);
    return {};
  }
}

export function getSettingsCached(): SettingsSnapshot | null {
  return cached;
}

/**
 * 비동기로 settings 를 한 번 로드해 캐시. 이미 로드돼 있으면 즉시 반환.
 * 동시 호출은 inflight 으로 디둪.
 */
export async function ensureSettingsLoaded(): Promise<SettingsSnapshot> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetchSettings()
    .then((s) => {
      cached = s;
      inflight = null;
      for (const l of listeners) l(s);
      return s;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });
  return inflight;
}

/** Settings 가 외부에서 변경됐을 때 호출 — 다음 ensure 호출 시 재fetch. */
export async function invalidateSettingsCache(): Promise<SettingsSnapshot> {
  cached = null;
  return ensureSettingsLoaded();
}

/** 변경 알림 구독. UI 가 가용 모델 목록을 즉시 갱신하기 위함. */
export function subscribeSettings(cb: (s: SettingsSnapshot) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
