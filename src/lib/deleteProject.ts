import { supabase } from "./supabase";
import { removeRecentProject } from "./recentProjectsCache";
import { refreshWorkspaces } from "./workspaceClient";

const LS_HISTORY_PREFIX = "ff_history_";
const PINNED_PROJECTS_KEY = "preflow.library.pinnedProjects";

/** 프로젝트를 휴지통으로 이동(soft delete). 실제 데이터는 그대로 두고
 *  `deleted_at` 만 채운다. 대시보드 목록/카운트/최근항목/워크스페이스 카운트는
 *  모두 deleted_at IS NULL 만 집계하므로 즉시 화면에서 사라지고, 휴지통 뷰
 *  에서만 보인다. 되돌리려면 `restoreProject`. */
export const trashProject = async (projectId: string): Promise<void> => {
  const { error } = await supabase
    .from("projects")
    .update({ deleted_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", projectId);
  if (error) throw new Error(error.message);
  // 라이브러리 picker / 사이드바 즐겨찾기에서 즉시 숨긴다 — 휴지통에 있는
  // 프로젝트로 자료를 attach 하거나 이동하지 않도록. 복원하면 다음 대시보드
  // fetch 의 recordProjects 가 다시 캐시에 넣어 준다.
  removeRecentProject(projectId);
  prunePinnedProject(projectId);
  // 워크스페이스 스위처의 프로젝트 카운트도 즉시 반영 (휴지통은 제외 집계).
  void refreshWorkspaces().catch(() => {});
};

/** 휴지통에서 복원 — deleted_at 을 비운다. */
export const restoreProject = async (projectId: string): Promise<void> => {
  const { error } = await supabase
    .from("projects")
    .update({ deleted_at: null } as Record<string, unknown>)
    .eq("id", projectId);
  if (error) throw new Error(error.message);
  void refreshWorkspaces().catch(() => {});
};

/** 라이브러리 사이드바 즐겨찾기(pinned)에서 해당 프로젝트 제거 — 영구 삭제
 *  시 dangling 참조가 남지 않도록. localStorage best-effort. */
const prunePinnedProject = (projectId: string): void => {
  try {
    const raw = window.localStorage.getItem(PINNED_PROJECTS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const next = arr.filter((p: any) => p?.projectId !== projectId);
    if (next.length !== arr.length) {
      window.localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
    }
  } catch {
    /* best-effort */
  }
};

/* Storage 버킷 폴더 완전 삭제 */
const purgeStorageFolder = async (bucket: string, folder: string) => {
  let offset = 0;
  while (true) {
    const { data: files, error } = await supabase.storage.from(bucket).list(folder, { limit: 100, offset });

    if (error || !files || files.length === 0) break;

    const paths = files.map((f) => `${folder}/${f.name}`);
    await supabase.storage.from(bucket).remove(paths);

    if (files.length < 100) break;
    offset += 100;
  }
};

export const deleteProjectCompletely = async (projectId: string): Promise<void> => {
  // ── 1. Storage 파일 삭제 ─────────────────────────────────────────
  // 모든 project-scoped 버킷을 purge. `mood` 누락으로 9장짜리 mood 배치가
  // 프로젝트 삭제 후에도 디스크에 남아 계속 쌓이던 누수를 차단.
  //
  // NOTE: `style-presets` 버킷은 user-scoped (style_presets 테이블에
  //       project_id 컬럼이 없음) 이라 여기서 purge 하지 않는다 —
  //       여러 프로젝트가 같은 프리셋을 공유하기 때문.
  await Promise.all([
    purgeStorageFolder("contis", projectId),
    purgeStorageFolder("assets", projectId),
    purgeStorageFolder("briefs", projectId),
    purgeStorageFolder("mood", projectId),
  ]);

  // ── 2. DB 레코드 삭제 (참조 순서 준수) ──────────────────────────
  await supabase.from("chat_logs").delete().eq("project_id", projectId);
  await supabase.from("scene_versions").delete().eq("project_id", projectId);
  await supabase.from("scenes").delete().eq("project_id", projectId);
  await supabase.from("assets").delete().eq("project_id", projectId);
  // brief_attachments — FK CASCADE 로 projects.id 삭제 시 자동 정리되지만,
  // 다른 자식 테이블과의 일관성을 위해 명시적으로 먼저 삭제 (storage purge 가
  // 이미 끝나 있어 안전). 옛 DB 에 없을 수 있어 에러는 무시.
  try {
    await supabase.from("brief_attachments").delete().eq("project_id", projectId);
  } catch {
    /* table missing in pre-migration DBs */
  }
  await supabase.from("briefs").delete().eq("project_id", projectId);
  await supabase.from("projects").delete().eq("id", projectId);

  // ── 3. localStorage 완전 정리 ────────────────────────────────────
  const keys = [
    `${LS_HISTORY_PREFIX}${projectId}`, // ContiTab  씬 이미지 히스토리
    `ff_brief_draft_${projectId}`, // BriefTab  브리프 입력 내용
    `ff_focal_${projectId}`, // AssetsTab 얼굴 위치/줌
    `ff_pending_scenes_${projectId}`, // AgentTab  초안 씬
    `preflow_onboarding_${projectId}`, // ProjectPage 온보딩 닫음 여부
  ];
  keys.forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  });

  // ── 4. workspace-independent 캐시 정리 ──────────────────────────
  // 이전 구현은 여기를 비워 두어, 삭제한 프로젝트가 라이브러리 picker 의 "최근
  // 프로젝트" 와 사이드바 즐겨찾기에 계속 남아 다시 열리는 zombie 참조가 쌓였다.
  removeRecentProject(projectId);
  prunePinnedProject(projectId);

  // ── 5. 워크스페이스 카운트 새로고침 ──────────────────────────────
  // delete 가 refreshWorkspaces 를 호출하지 않아 스위처의 "N projects" 가 옛
  // 값으로 멈춰 있던 문제를 해결.
  void refreshWorkspaces().catch(() => {});
};
