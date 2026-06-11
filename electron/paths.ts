import { app } from "electron";
import path from "path";
import fs from "fs";

import { getActiveStoragePath } from "./workspace";

/** 활성 워크스페이스의 storage 베이스 경로.
 *
 *  - 부팅 후 `initWorkspace` 가 끝나면 활성 워크스페이스(default 또는
 *    custom) 의 `<path>/storage/` 를 돌려준다.
 *  - 부팅 직전 (workspace 초기화 전) 호출되는 경로(예: profile env 처리,
 *    main 의 일부 helper) 는 안전하게 userData 를 fallback 으로 사용.
 *  - 디렉터리 mkdir 은 호출 시점에 idempotent 하게 수행.
 *
 *  과거 내부 캐시(`storageBase`) 는 워크스페이스 전환을 막기 때문에 제거.
 *  대신 활성 워크스페이스 모듈이 자체 캐시를 들고 있다 (path 변경은 활성
 *  전환 시에만 발생 → 캐시 무효화 자동). */
export function getStorageBasePath(): string {
  let base: string;
  try {
    base = getActiveStoragePath();
  } catch {
    // 부팅 초기 — workspace 모듈이 아직 init 되지 않은 시점. userData 로 폴백.
    base = path.join(app.getPath("userData"), "storage");
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}
