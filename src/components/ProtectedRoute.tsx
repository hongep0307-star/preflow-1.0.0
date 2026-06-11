import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  ensureWorkspacesLoaded,
  getCachedActive,
  subscribeWorkspaces,
} from "@/lib/workspaceClient";

/**
 * 활성 워크스페이스 kind 와 현재 라우트의 정합을 보장하는 가드.
 *
 * 비대칭 규칙 — 단방향으로만 강제한다:
 *   • Library 활성 + Project 라우트(/dashboard, /project/*)
 *     → /library 로 강제 redirect. Library DB 에는 projects 테이블이 무
 *       의미하므로 그 페이지가 mount 되면 잘못된 쿼리/빈 화면이 난다.
 *   • Project 활성 + Library 라우트(/library)
 *     → 통과. project 작업 중 reference 를 찾으러 잠시 들르는 정상 워크
 *       플로우. LibraryPage 의 `returnTo` 메커니즘으로 돌아갈 수 있다.
 *
 * 이 가드가 필요한 시나리오:
 *   1) dev 빌드 재시작 / 앱 재부팅 시 직전 세션 URL 이 그대로 떴는데 활성
 *      워크스페이스가 사이에 Library 로 바뀌어 있는 경우 — Workspace
 *      Switcher 만 Library 로 보이고 본문은 Project Dashboard 로 남는
 *      모순을 자동 회복.
 *   2) deep link (#/project/foo) 로 진입했는데 활성이 Library 인 경우.
 *
 * cache 가 아직 비어 있는 첫 페인트에서는 가드를 건너뛴다 — 잘못된 추측
 * 으로 깜빡임을 만들지 않기 위해. cache 가 채워지면 subscribeWorkspaces
 * 콜백으로 re-render 가 발생해 그때 정합 평가가 다시 일어난다.
 */
export const ProtectedRoute = () => {
  const location = useLocation();
  const [, force] = useState(0);

  useEffect(() => {
    void ensureWorkspacesLoaded();
    return subscribeWorkspaces(() => force((n) => n + 1));
  }, []);

  const active = getCachedActive();

  if (active?.kind === "library") {
    const onProjectRoute =
      location.pathname === "/dashboard" ||
      location.pathname.startsWith("/project/");
    if (onProjectRoute) {
      return <Navigate to="/library" replace />;
    }
  }

  return <Outlet />;
};
