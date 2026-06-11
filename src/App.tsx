import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import AuroraBackground from '@/components/AuroraBackground';
import { UiLanguageProvider, useT } from '@/lib/uiLanguage';
import { PageShell } from '@/components/PageShell';
import Index from './pages/Index';
import SettingsPage from './pages/SettingsPage';
import NotFound from './pages/NotFound';

/* 주요 페이지를 *eager* 가 아닌 *lazy* import 로 분할.
 *
 *  배경 — 이전엔 LibraryPage / ProjectPage / DashboardPage 가 main bundle 에
 *  통째로 들어가 main 이 ~890KB 였다. workspace switch 가 full page reload
 *  를 트리거하기 때문에 *매번* 전체 bundle 을 다시 parse → workspace
 *  스위치가 체감상 매우 느리던 주 원인.
 *
 *  lazy import 로 분할하면 각 페이지가 별도 chunk 가 되고 main bundle 은
 *  ~300-400KB 수준으로 줄어든다. 사용자가 첫 진입 시 해당 페이지 chunk 만
 *  추가 fetch (수십 ms) 하고, 같은 페이지 재진입 시 cache 에서 즉시. */
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));

const queryClient = new QueryClient();

/**
 * /library 의 실제 LibraryPage 인스턴스를 keep-mount 형태로 마운트한다.
 *
 * /library → /project → /library 왕복 시 LibraryPage(5249 라인) 가 매번
 * unmount/remount 되어 useMemo 9-stage cascade 재실행, 77 개 카드 DOM 재생성,
 * 70+ 장 paint-time 이미지 디코드를 매번 다시 했다(데이터 캐시는 살아있어도
 * UI 재구성 비용이 매번 그대로). 본 slot 이 LibraryPage 를 한 번 mount 한
 * 뒤로는 라우트가 떠나도 unmount 하지 않고 `display: none` 으로만 hide
 * 하므로 같은 라우트로 돌아오면 0ms 로 표시.
 *
 * LibraryPage 의 root 가 `h-screen overflow-hidden flex flex-col` 즉
 * *viewport-fill 자체* 패턴이라 wrapper 의 positioning context / flex-grid
 * container 의존이 없다. 이 계약 덕에 `PageShell` 의 일반 block div wrapper
 * 가 layout 을 깨뜨리지 않고 안전하다.
 *
 * Dashboard / Project 도 같은 패턴으로 확장 가능하지만, 각 페이지 root 가
 * `position: absolute; inset: 0` 같은 부모 layout 의존 패턴을 쓰는지 사전
 * 검증이 필요해 1차 도입에서는 LibraryPage 만 대상으로 한다.
 *
 * LibraryPage 를 prop 으로 받아 App.tsx 의 `lazy()` 정의와 동일 인스턴스를
 * 사용한다(중복 lazy 정의 시 별도 chunk 가 되는 사고 방지).
 */
function LibraryKeepMountSlot({
  LibraryPage,
}: {
  LibraryPage: React.ComponentType;
}) {
  const location = useLocation();
  const active = location.pathname === "/library";
  return (
    <PageShell active={active}>
      <LibraryPage />
    </PageShell>
  );
}

/* lazy chunk 가 fetch 되는 동안 보여줄 fallback. UiLanguageProvider 안쪽에서
   렌더되므로 useT 로 UI 언어(en/ko) 에 맞춰 "Loading..." / "불러오는 중..."
   을 표시한다. 한글 UI 에서도 영문이 섞이던 회귀를 방지. */
const RouteSuspenseFallback = () => {
  const t = useT();
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        color: "rgba(255,255,255,0.55)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        letterSpacing: "0.05em",
      }}
    >
      {t("common.loading")}
    </div>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <UiLanguageProvider>
      <TooltipProvider>
        <Toaster />
        <AuroraBackground />
        <HashRouter>
          <div style={{ position: "relative", zIndex: 1 }}>
            <ErrorBoundary label="App">
              {/* lazy 페이지 chunk 가 fetch 되는 동안의 fallback.
                  pending 상태에 사용자가 *완전 검정 화면* 으로 보이지 않도록
                  최소 가시 UI 를 표시 — 진단에도 도움이 된다 ("Loading..." 이
                  너무 오래 보이면 chunk fetch 자체가 stuck 인 것). */}
              <Suspense fallback={<RouteSuspenseFallback />}>
                <Routes>
                  <Route path="/" element={<Index />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route element={<ProtectedRoute />}>
                    <Route path="/dashboard" element={<DashboardPage />} />
                    {/* /library 는 아래 LibraryKeepMountSlot 이 처리한다.
                        Routes 에는 path 만 등록(element=null) 해 두어
                        (a) catch-all `*` 로 떨어져 NotFound 가 뜨는 것을
                        방지하고 (b) ProtectedRoute 의 워크스페이스 정합
                        가드는 path matching 만으로 동작하므로 deep-link
                        보호도 그대로 유지된다. 실제 LibraryPage 는 Routes
                        밖의 keep-mount slot 이 한 번 mount 한 뒤 라우트
                        전환 시 display:none 으로 hide 만 토글한다. */}
                    <Route path="/library" element={null} />
                    <Route path="/project/:id" element={<ProjectPage />} />
                  </Route>
                  <Route path="*" element={<NotFound />} />
                </Routes>
                {/* LibraryPage 만 keep-mount — 두번째 진입부터 0ms. Dashboard
                    / Project 는 root layout 계약 검증 전이라 기존 Routes
                    패턴 유지(회귀 위험 0). */}
                <LibraryKeepMountSlot LibraryPage={LibraryPage} />
              </Suspense>
              {/* The legacy <ModeSwitcher /> floating FAB was removed
                  here because it overlapped the bottom-right toast
                  viewport. Workspace switching now lives inside each
                  sidebar via <WorkspaceSwitcher /> — see DashboardPage,
                  LibrarySidebar, and ProjectSidebar. */}
            </ErrorBoundary>
          </div>
        </HashRouter>
      </TooltipProvider>
    </UiLanguageProvider>
  </QueryClientProvider>
);

export default App;
