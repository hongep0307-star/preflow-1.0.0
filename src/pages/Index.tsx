import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  ensureWorkspacesLoaded,
  getCachedActive,
} from "@/lib/workspaceClient";

/**
 * 루트("/") 진입 시점의 dispatcher.
 *
 * 활성 워크스페이스가 Library 면 /library, 아니면 /dashboard 로 보낸다.
 * `ensureWorkspacesLoaded` 가 끝날 때까지 한 tick 만 대기 — 그 사이엔
 * null 을 렌더해 dashboard / library 가 어긋난 채 깜빡이는 것을 막는다.
 *
 * 로딩이 실패해도 (cache 가 비어 있어도) 기본값 /dashboard 로 폴백 —
 * ProtectedRoute 가 그 시점부터 다시 정합 평가를 이어받는다.
 */
const Index = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureWorkspacesLoaded().finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  const active = getCachedActive();
  const target = active?.kind === "library" ? "/library" : "/dashboard";
  return <Navigate to={target} replace />;
};

export default Index;
