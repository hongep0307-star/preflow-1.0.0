/**
 * Library → Project 연결의 *유일한* chokepoint orchestrator.
 *
 * Library 컨텍스트 메뉴, picker 모달, drag-drop, 추천 카드 — 어떤 진입점이든
 * 이 함수 하나로 수렴. 데이터 layer 위험 (tags / promoted_asset_ids /
 * classification_status / last_used_at 직접 mutation) 을 절대 일으키지 않도록
 * 가드를 일원화하고, 타겟별 후속 동작을 분기한다.
 *
 * ⚠️ 절대 손대지 말 것 (과거 라이브러리 ↔ 프로젝트 연결 실패의 원인):
 *   - reference.tags 직접 write → 폴더 트리 파괴.
 *     필요하면 `addReferencesToFolder` / `moveReferencesToFolder` 만 사용.
 *   - reference.promoted_asset_ids — `promoteReferenceToAsset` 가 자동 누적.
 *   - reference.classification_status / classified_at — ML 파이프 내부 상태.
 *   - reference.last_used_at — `linkReferenceToProject` 가 자동 갱신.
 *
 * 워크스페이스: 각 워크스페이스는 별개 SQLite DB 라 cross-workspace 링크는
 * 구조적으로 불가능. 별도 검증 불필요 (실수로 워크스페이스가 어긋날 case 가
 * 없음). 만약 미래에 multi-tenant SQLite 로 바뀐다면 여기 한 군데에서만
 * workspace_id match 체크 추가하면 됨.
 */

import {
  linkReferenceToProject,
  referenceToRefItem,
  type ReferenceItem,
} from "./referenceLibrary";

/** 어디로 보낼지. Conti 는 의미가 셋이라 sub-target 으로 분리.
 *  - brief: 브리프 참고자료에 RefItem 으로 추가 (base64 변환)
 *  - agent: 아이데이션 채팅 첨부로 추가 (caller 가 file_url 을 base64 로 변환해 큐에 append)
 *  - conti-inpaint: 프로젝트의 Conti Studio > Compare > 라이브러리 풀에
 *    레퍼런스 id 를 append (additive — LS chokepoint 는
 *    `compareLibraryStore.appendCompareLibraryIds`). 이름은 *과거* placeholder
 *    의미(씬 inpaint 큐)에서 유래했지만, 실제 다운스트림 효과는 Compare
 *    라이브러리 풀이다. AttachTarget enum 값 자체는 외부 caller 호환을 위해
 *    그대로 둔다.
 *  - conti-scene: 씬의 conti_image_url 교체 (destructive, Phase 4)
 *  - conti-sketch: 씬의 sketches 배열에 append (additive, Phase 4) */
export type AttachTarget =
  | "brief"
  | "agent"
  | "conti-inpaint"
  | "conti-scene"
  | "conti-sketch";

/** DB 의 `project_reference_links.target` enum 으로 매핑.
 *  Conti 의 3 sub-target 은 모두 "conti" 로 묶임 — DB 레벨에선 동일 카운트. */
function dbTargetFor(target: AttachTarget): "brief" | "agent" | "conti" {
  if (target === "brief") return "brief";
  if (target === "agent") return "agent";
  return "conti";
}

/** 각 target 별 허용 ReferenceItem.kind. */
const ALLOWED_KINDS: Record<AttachTarget, ReadonlySet<ReferenceItem["kind"]>> = {
  brief: new Set(["image", "webp", "gif", "video", "youtube"]),
  // agent(아이데이션 채팅): 영상/GIF 도 허용 — 정지 썸네일(poster)을 첨부하고
  // sampled_frames/AI 분석을 화면 밖에서 LLM 에 함께 보낸다(프레임 추출 구조).
  agent: new Set(["image", "webp", "gif", "video"]),
  // conti-inpaint 는 Compare > 라이브러리 풀로 매핑 — 사용자가 영상/유튜브
  // 자료도 비교용 레퍼런스로 모을 수 있도록 video/youtube 까지 허용한다.
  // (Compare 그리드는 항상 정적 poster 만 렌더해 애니메이션 위험 없음.)
  "conti-inpaint": new Set(["image", "webp", "gif", "video", "youtube"]),
  "conti-scene": new Set(["image", "webp", "gif"]),
  "conti-sketch": new Set(["image", "webp", "gif"]),
};

/** 결과 객체. caller 가 toast 등을 띄울 때 참고. */
export interface AttachResult {
  ok: boolean;
  target: AttachTarget;
  /** DB 에 새로 만들어졌으면 true. 기존 idempotent dedupe 면 false. */
  linkCreated: boolean;
  /** target 별 후속 처리 결과 (caller 에서 추가 액션 분기에 사용). */
  detail?: {
    /** agent: PromoteToAssetDialog 를 caller 가 직접 열어야 함. */
    requiresPromoteDialog?: boolean;
    /** conti-inpaint/scene/sketch: caller 가 콜백으로 받은 file_url. */
    fileUrl?: string;
    /** conti-scene 의 oldUrl (history push 에 사용). */
    oldUrl?: string | null;
  };
  /** ok=false 일 때 사람이 읽을 수 있는 사유. caller 가 toast 메시지로 사용. */
  errorCode?:
    | "no-active-project"
    | "reference-deleted"
    | "kind-not-allowed"
    | "missing-file-url"
    | "link-failed";
  /** link-failed 케이스의 underlying error message — caller 가 toast description
   *  에 그대로 노출하면 디버깅에 도움. */
  errorMessage?: string;
}

export interface AttachOptions {
  /** DB 의 link 행에 같이 저장될 annotation 텍스트 (선택). */
  annotation?: string;
  /** Brief 의 base64 변환을 위해 thumbnail 우선 시도하고 싶을 때.
   *  v1 에선 referenceToRefItem 의 default (file_url) 를 따른다. */
  preferThumbnail?: boolean;
}

/** 모든 entry point 가 이 함수를 통해 attach 한다.
 *
 *  Phase 1: brief / agent / conti-inpaint 만 *실제* 동작.
 *           conti-scene, conti-sketch 는 link 행만 만들고 caller 가 콜백으로
 *           실제 mutation 을 받음 (Phase 4 에서 활성).
 *
 *  순서:
 *   1) validate (kind / file_url / not deleted)
 *   2) target == conti-scene 처럼 *destructive* 인 경우 link 먼저 만들지 않음.
 *      Caller 가 mutation 성공 시 직접 link 작성. orchestrator 는 fileUrl
 *      만 돌려준다.
 *   3) additive 인 경우 link 먼저 → 성공 시 target 별 후속.
 *      *실패 가능성 매우 낮은* 후속 op (브리프 메모리 append 같은 local) 만
 *      link-first 전략 적용.
 */
export async function attachLibraryItemToProject(
  item: ReferenceItem,
  projectId: string,
  target: AttachTarget,
  options: AttachOptions = {},
): Promise<AttachResult> {
  // 1) 활성 프로젝트 검사
  if (!projectId) {
    return { ok: false, target, linkCreated: false, errorCode: "no-active-project" };
  }
  // 2) Soft-delete 검사 — 휴지통 자료는 attach 불가
  if (item.deleted_at) {
    return { ok: false, target, linkCreated: false, errorCode: "reference-deleted" };
  }
  // 3) kind 허용성 검사 — link 는 일반적이지만 doc 처럼 의미 없는 kind 차단
  if (!ALLOWED_KINDS[target].has(item.kind)) {
    return { ok: false, target, linkCreated: false, errorCode: "kind-not-allowed" };
  }
  // 4) file_url 필수 (asset/conti 는 URL 자체를 photo_url/inpaint ref 로 재사용)
  if (target !== "brief" && !item.file_url) {
    return { ok: false, target, linkCreated: false, errorCode: "missing-file-url" };
  }

  // Conti scene 은 destructive (conti_image_url 교체) — orchestrator 는 link 를
  // 만들지 않고 fileUrl 만 돌려준다. Caller (ContiTab) 가 콜백으로 실제 교체에
  // 성공한 직후 별도로 linkReferenceToProject 호출해야 한다 (Phase 4).
  if (target === "conti-scene") {
    return {
      ok: true,
      target,
      linkCreated: false,
      detail: { fileUrl: item.file_url ?? undefined },
    };
  }

  // Agent: 라이브러리 이미지를 아이데이션 채팅 첨부로 보낸다. link 행은 사용량
  // 배지용 best-effort 로 아래 additive 경로에서 생성되고, caller(LibraryPage)
  // 가 detail.fileUrl 을 base64 로 변환해 채팅 첨부 큐에 넣는다.

  // 여기서부터 *additive* 케이스 (brief / agent / conti-inpaint / conti-sketch) —
  // link 행 시도 + 후속 처리. 단, cross-workspace 시나리오 (라이브러리는 library
  // 워크스페이스 DB, 프로젝트는 project 워크스페이스 DB) 에서는 link 테이블의 FK
  // constraint 가 실패 (현재 활성 DB 에 다른 워크스페이스의 projects/refs 가 없음).
  // 사용자의 실제 자료 흐름 (Brief refItems / conti edit refs) 은 localStorage /
  // scenes 컬럼에 저장돼 workspace 와 무관하게 동작하므로, link row 는 *tracking-
  // only* 로 분류하고 실패해도 attach 자체는 계속한다. 단, 실패 사실은 result 에
  // 담아 caller 가 "추적은 안 되지만 attach 됨" 같은 soft 경고 표시 가능.
  let linkCreated = false;
  let linkError: string | null = null;
  try {
    await linkReferenceToProject({
      projectId,
      referenceId: item.id,
      target: dbTargetFor(target),
      annotation: options.annotation,
    });
    linkCreated = true;
  } catch (err) {
    linkError = err instanceof Error ? err.message : String(err);
    // FK violation 은 cross-workspace 의 *기대된* 동작 — 경고만, 실패로 처리 X.
    // 그 외 (네트워크 단절 등) 도 같은 정책 (link row 없어도 사용자 액션 자체는
    // 작동). 향후 Phase 2/5 에서 cross-workspace 추적 (양방향 dual-write 또는
    // 중앙 link store) 으로 보강 예정.
  }

  return {
    ok: true,
    target,
    linkCreated,
    errorMessage: linkError ?? undefined,
    detail: { fileUrl: item.file_url ?? undefined },
  };
}

/** Brief 용 RefItem 변환 — referenceToRefItem 의 thin wrapper.
 *  호출자 (LibraryPage) 가 attach 성공 후 이걸 호출해 BriefTab 의
 *  appendLibraryRefItemToProject 에 넘긴다. 분리 이유: orchestrator 는 DB
 *  mutation 만 책임지고, base64 변환 (fetch + 변환 비용) 은 호출자가 progress
 *  spinner 등 UI 처리할 수 있도록 별도. */
export { referenceToRefItem } from "./referenceLibrary";
