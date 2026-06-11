/**
 * 단계별(브리프/에이전트) 사용자 모델 선호도 — localStorage 영속.
 *
 * 이중 스코프 구조 (Global default + Per-project override):
 *   · **Global default** — Settings 페이지의 ModelPicker 가 쓰는 값.
 *     `ff_model_<stage>` 키에 저장되며, 어떤 프로젝트에서도 override 가
 *     없을 때의 폴백 + 신규 프로젝트의 출발점.
 *   · **Per-project override** — BriefTab 헤더처럼 "이 프로젝트만" 모델을
 *     바꾸고 싶을 때 쓰는 값. `ff_model_<stage>_proj_<projectId>` 키에
 *     저장되며, 해당 프로젝트에 한해 global 값을 가린다.
 *
 * 이전에는 인라인 picker 와 Settings 가 동일 global 키를 공유했기 때문에
 * 한 프로젝트에서 모델을 바꾸면 전역 디폴트까지 같이 바뀌었다. 사용자가
 * 기대하는 동작(= 프로젝트별 변경은 프로젝트에만, 신규 프로젝트는 디폴트로
 * 시작)을 만들려면 두 스토리지 레이어를 분리해야 한다.
 *
 * API 규약:
 *   · `projectId` 를 넘기면 → override 레이어 read/write.
 *     read 시 override 가 없거나 unknown 이면 global → 그 다음 stage 디폴트.
 *   · `projectId` 를 생략(undefined)하면 → global 레이어 read/write.
 *     Settings 페이지는 이 경로만 쓰므로 저장소 가시성이 분리된다.
 *
 * cross-window 동기화: storage 이벤트로 다른 BrowserWindow 도 동일 scope 의
 * 변경만 반영되도록 projectId 를 비교.
 */
import {
  DEFAULT_MODEL_BY_STAGE,
  KNOWN_MODEL_IDS,
  type ModelId,
} from "./modelCatalog";

export type ModelStage = "brief" | "agent";

const STAGE_KEY: Record<ModelStage, string> = {
  brief: "ff_model_brief",
  agent: "ff_model_agent",
};

const projectKey = (stage: ModelStage, projectId: string): string =>
  `${STAGE_KEY[stage]}_proj_${projectId}`;

type Listener = (modelId: ModelId) => void;
// scope = "__global__" | projectId
type ScopeMap = Map<string, Set<Listener>>;
const listeners: Record<ModelStage, ScopeMap> = {
  brief: new Map(),
  agent: new Map(),
};

const GLOBAL_SCOPE = "__global__";
const scopeOf = (projectId?: string) => projectId ?? GLOBAL_SCOPE;

function isKnown(id: string | null): id is ModelId {
  return !!id && KNOWN_MODEL_IDS.has(id);
}

function readLS(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore quota / sandboxed write failure */
  }
}

/**
 * 현재 적용 중인 모델 id 를 반환.
 *   - projectId 있음: override → global → stage 디폴트 순으로 폴백.
 *   - projectId 없음: global → stage 디폴트.
 */
export function getModel(stage: ModelStage, projectId?: string): ModelId {
  if (projectId) {
    const override = readLS(projectKey(stage, projectId));
    if (isKnown(override)) return override;
  }
  const global = readLS(STAGE_KEY[stage]);
  if (isKnown(global)) return global;
  return DEFAULT_MODEL_BY_STAGE[stage];
}

/**
 * 모델 변경을 영속.
 *   - projectId 있음: override 키에만 기록. global 은 건드리지 않는다.
 *   - projectId 없음: global 키에 기록. (Settings 경로)
 * 동일 scope 구독자에게만 통지한다. (프로젝트 A 변경이 B 의 picker 를
 * 흔들면 안 됨.)
 */
export function setModel(stage: ModelStage, modelId: ModelId, projectId?: string): void {
  const key = projectId ? projectKey(stage, projectId) : STAGE_KEY[stage];
  writeLS(key, modelId);
  const scope = scopeOf(projectId);
  const bucket = listeners[stage].get(scope);
  if (bucket) for (const l of bucket) l(modelId);
  // Global 변경 시에는 override 가 없는 모든 프로젝트 구독자도 갱신해야
  // Settings 에서 디폴트를 바꾸면 열어둔 신규 프로젝트 picker 가 즉시
  // 반영된다. 그러나 override 가 있는 프로젝트는 건드리지 않는다 —
  // getModel 로 재해결해 override 가 유지되는지 확인 후 콜백.
  if (!projectId) {
    for (const [sc, bucket2] of listeners[stage].entries()) {
      if (sc === GLOBAL_SCOPE) continue;
      const resolved = getModel(stage, sc);
      for (const l of bucket2) l(resolved);
    }
  }
}

/**
 * 변경 구독. 호출 즉시 콜백을 한 번 호출하지 않고 future 변경부터 알린다
 * (호출자가 초기값을 명시적으로 읽도록 강제).
 *
 * 다른 BrowserWindow 에서의 변경도 storage 이벤트로 처리하되, 현재 scope 의
 * 키일 때만 반응한다. projectId 를 넘긴 구독자라면 global 변경도 파생
 * 해결값(override 존재 여부 반영) 으로 받는다.
 */
export function subscribeModel(
  stage: ModelStage,
  cb: Listener,
  projectId?: string,
): () => void {
  const scope = scopeOf(projectId);
  let bucket = listeners[stage].get(scope);
  if (!bucket) {
    bucket = new Set();
    listeners[stage].set(scope, bucket);
  }
  bucket.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (!e.key) return;
    const ownKey = projectId ? projectKey(stage, projectId) : STAGE_KEY[stage];
    const globalKey = STAGE_KEY[stage];
    if (e.key === ownKey) {
      const resolved = getModel(stage, projectId);
      cb(resolved);
    } else if (projectId && e.key === globalKey) {
      // global 가 바뀌었을 때: override 가 없는 프로젝트만 영향.
      const resolved = getModel(stage, projectId);
      cb(resolved);
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    bucket?.delete(cb);
    if (bucket && bucket.size === 0) listeners[stage].delete(scope);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/**
 * 프로젝트 오버라이드를 해제하여 다시 global 디폴트를 따르게 한다.
 * 지금은 호출부가 없지만, 향후 "Reset to default" 버튼을 노출할 때 사용.
 */
export function clearProjectOverride(stage: ModelStage, projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(projectKey(stage, projectId));
  } catch {
    /* ignore */
  }
  const bucket = listeners[stage].get(projectId);
  if (bucket) {
    const resolved = getModel(stage, projectId);
    for (const l of bucket) l(resolved);
  }
}
