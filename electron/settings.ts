import { getDb } from "./db";

export interface AppSettings {
  anthropic_api_key?: string;
  openai_api_key?: string;
  google_service_account_key?: string;
  google_cloud_project_id?: string;
  /**
   * "true" / "false" — GPT-5.5 API 가 출시된 직후 사용자가 즉시 활성화할 수
   * 있도록 한 플래그. 시드 카탈로그의 `released: false` 모델을 강제 활성화한다.
   * 5.5 가 GA 되면 카탈로그 시드 자체에서 released 를 true 로 올려 이 플래그를
   * 사실상 deprecate.
   */
  gpt_5_5_api_enabled?: string;
  /**
   * GPT 이미지 생성의 기본 품질 — "low" | "medium" | "high". 미설정 시 "high".
   * 호출 body 에 quality 가 명시되면(예: Sketches 탭 프리셋) 그 값이 우선하고,
   * 명시가 없으면 이 글로벌 디폴트가 적용된다.
   */
  gpt_image_quality?: string;
  /**
   * "이미지로 검색"(역검색) 시 이미지를 잠깐 올릴 Imgur 의 Client-ID.
   * 미설정 시 공개 기본값을 사용하지만, 공유 ID 는 rate-limit 이 빡빡하므로
   * 본인 Imgur 앱의 Client-ID 를 넣으면 더 안정적이다.
   */
  imgur_client_id?: string;
}

// Phase 2.3: 모든 /api/* 핸들러가 호출마다 settings 테이블을 풀스캔하던 것을
// 인메모리 캐시로 단축한다. Conti generate 사이클 1 회당 수십 회 호출되어
// prepared statement 캐싱이 있더라도 누적 ms 가 발생했다. setSettings 가
// 들어오면 즉시 무효화 — 이 모듈 외부에서 settings 테이블을 직접 쓰지 않는
// 한 stale 가능성은 0.
let settingsCache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (settingsCache) return settingsCache;
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const settings: any = {};
  for (const row of rows) settings[row.key] = row.value;
  settingsCache = settings;
  return settings;
}

export function setSettings(settings: Partial<AppSettings>) {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    stmt.run(key, value);
  }
  // 캐시 무효화 — 다음 getSettings() 호출에서 새 값을 다시 읽어 채운다.
  settingsCache = null;
}
