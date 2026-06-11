// 렌더러(브라우저) 와 Electron main 양쪽이 공유하는 워크스페이스 모델 타입.
// 변경 시 한 곳만 고치면 양 빌드에 모두 반영됨.

export type WorkspaceKind = "project" | "library";

export interface WorkspaceMeta {
  id: string;
  kind: WorkspaceKind;
  name: string;
  /** 워크스페이스 폴더의 절대 경로. 기본 워크스페이스(Default Projects /
   *  Default Library) 는 Electron userData 루트를 가리키고, 사용자가 새로
   *  만든 워크스페이스는 사용자가 선택한 폴더를 가리킨다. */
  path: string;
  /** 자동 등록된 두 default 만 true. UI 의 삭제/이름변경 등 파괴적
   *  액션은 default 워크스페이스에서 비활성화한다. */
  isDefault?: boolean;
  /** 워크스페이스를 처음 등록한 ISO 8601 타임스탬프. */
  createdAt?: string;
  /** 워크스페이스 폴더 자체의 메타 스키마 버전. 디스크 포맷이 깨지는
   *  변경이 있을 때만 bump 한다. 기본 1. */
  schemaVersion?: number;
}

/** Quick-switch 가 "최근 사용한 반대 kind 워크스페이스" 로 점프하기 위한
 *  보조 인덱스. activate 가 일어날 때마다 그 워크스페이스의 kind 슬롯이
 *  갱신된다 — 즉 `lastActive.project` 는 *마지막으로 활성이었던 project
 *  워크스페이스*, `lastActive.library` 는 *마지막으로 활성이었던 library
 *  워크스페이스* 의 ID. `active` 와 달리 두 슬롯이 *동시에* 살아 있어서
 *  사용자가 둘 사이를 빠르게 핑퐁할 수 있다.
 *
 *  Bootstrap 직후엔 두 슬롯 모두 비어 있고, 폴백은 `isDefault` 기준 — 첫
 *  부팅에서 quick-switch 를 눌러도 옛 동작과 동일하게 default 짝으로 간다. */
export interface WorkspaceLastActive {
  project?: string | null;
  library?: string | null;
}

export interface WorkspaceRegistry {
  version: 1;
  /** 활성 워크스페이스 ID. 갓 설치 후 부트스트랩 직전에만 null. */
  active: string | null;
  /** kind 별로 마지막에 활성이었던 워크스페이스 ID. quick-switch 결정용. */
  lastActive?: WorkspaceLastActive;
  workspaces: WorkspaceMeta[];
}

/** UI 서브타이틀(`{n} projects` / `{n} items`) 용 카운트. 디스크에는 저장하지
 *  않고 list 응답 시점에 매번 SQL 카운트 쿼리로 채운다. */
export interface WorkspaceCounts {
  id: string;
  projectCount: number | null;
  itemCount: number | null;
}

export interface ListWorkspacesResponse {
  workspaces: WorkspaceMeta[];
  counts: WorkspaceCounts[];
  active: string | null;
  /** kind 별 마지막 활성 ID — quick-switch 가 반대 kind 의 "최근 워크스페이스"
   *  를 즉시 찾을 수 있도록 노출. 첫 부팅에선 두 슬롯 모두 비어 있어 클라이
   *  언트가 isDefault 폴백으로 떨어진다. */
  lastActive?: WorkspaceLastActive;
  /** 활성 워크스페이스 폴더에서 발견된 OneDrive/Dropbox 충돌 사본 파일명.
   *  비어 있으면 정상. 비어 있지 않으면 한쪽 PC 의 변경분이 갈라져 나갔을
   *  수 있어 UI 가 경고한다. */
  conflictCopies?: string[];
}

/** 다른 PC 가 같은 워크스페이스 폴더를 점유 중일 때 사용자에게 보여줄
 *  세부 정보. 락 파일을 그대로 deserialize 한 결과. */
export interface WorkspaceLockInfo {
  pid: number;
  hostname: string;
  username: string;
  acquiredAt: string;
  /** 락 보유 중 주기적으로 갱신되는 "마지막 활동" 타임스탬프(ISO 8601).
   *  하트비트가 이 값을 일정 간격으로 새로 찍는다. 다른 호스트의 락이
   *  stale 한지(=점유 PC 가 죽었거나 안 끄고 떠났는지) 판단하는 기준 —
   *  `now - renewedAt > TTL` 이면 자동 인계 가능. 구버전 락 파일에는 없을
   *  수 있어 옵셔널이며, 없으면 `acquiredAt` 으로 폴백한다. */
  renewedAt?: string;
  prettyLabel: string;
}

export const WORKSPACE_META_FILENAME = ".preflow-workspace.json";
export const WORKSPACE_LOCK_FILENAME = ".preflow-lock";
export const REGISTRY_FILENAME = "workspaces.json";
/** registry 의 즉시 백업 — 주 파일이 손상/삭제되었을 때 폴백.
 *  main 파일과 동일 폴더 (userData) 에 같이 둔다. */
export const REGISTRY_BACKUP_FILENAME = "workspaces.bak.json";
