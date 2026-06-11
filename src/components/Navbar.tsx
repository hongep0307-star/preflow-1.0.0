import { Settings, HardDrive } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/common/BrandLogo";
import { MetaPill } from "@/components/common/ui-primitives";
import { TopbarToastCarveOut } from "@/components/common/TopbarToastCarveOut";
import { WindowControls } from "@/components/common/WindowControls";
import { useT } from "@/lib/uiLanguage";
import { formatBytes, getStorageUsageByProject } from "@/lib/storageMaintenance";
import { useActiveWorkspaceName } from "@/lib/workspaceLabel";

// ── 타입 ────────────────────────────────────────────────
interface NavbarProps {
  /** 프로젝트 내부 탭에서만 전달. 없으면 Dashboard 모드 */
  folderName?: string;
  projectTitle?: string;
  tabName?: string;
  videoFormat?: string;
  sceneCount?: string; // e.g. "4/39"
}

const Divider = () => <div className="w-px h-4 bg-border-subtle flex-shrink-0" />;

// ── 메인 ───────────────────────────────────────────────
export const Navbar = ({ folderName, projectTitle, tabName, videoFormat, sceneCount }: NavbarProps) => {
  const navigate = useNavigate();
  const t = useT();
  const isDashboard = !projectTitle;
  const projectWorkspaceName = useActiveWorkspaceName("project");
  // 대시보드 헤더에만 노출되는 총 디스크 사용량. 백엔드는 30s TTL 캐시가
  // 걸려 있어 마운트마다 호출해도 디스크 walk 가 일어나지 않는다. idle
  // 콜백으로 미뤄 첫 페인트(브랜드 로고/타이틀)는 차단하지 않음.
  //
  // "프로젝트만" 합산: getStorageUsageByProject 가 첫 path segment 가 v4 UUID
  // 인 것만 by_project 로 모으고, references/mood/기타 unscoped 는 별도로
  // 분리한다. 라이브러리 레퍼런스가 늘어도 이 칩은 안 늘어야 한다는 의도에
  // 맞춰, by_project 합계만 표기.
  const [totalStorageBytes, setTotalStorageBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!isDashboard) return;
    let cancelled = false;
    const run = async () => {
      try {
        const usage = await getStorageUsageByProject();
        const projectsBytes = Object.values(usage.by_project ?? {}).reduce(
          (sum, entry) => sum + (entry?.bytes ?? 0),
          0,
        );
        if (!cancelled) setTotalStorageBytes(projectsBytes);
      } catch {
        /* best-effort — 칩이 안 보이는 정도의 영향 */
      }
    };
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    const handle = idle.requestIdleCallback
      ? idle.requestIdleCallback(() => void run(), { timeout: 1500 })
      : window.setTimeout(() => void run(), 200);
    return () => {
      cancelled = true;
      if (idle.requestIdleCallback && idle.cancelIdleCallback) idle.cancelIdleCallback(handle as number);
      else window.clearTimeout(handle as number);
    };
  }, [isDashboard]);

  const handleSettings = () => {
    navigate("/settings");
  };

  return (
    <nav className="app-topbar items-stretch relative">
      {/* Top-center 토스트가 네비바 위에 떠 있을 때 Electron drag region 흡수를
          막는 carve-out. 자세한 설명은 컴포넌트 파일 헤더 주석 참고. */}
      <TopbarToastCarveOut />

      {/* ── 브랜드 존 (항상 고정) ──
          로고는 더 이상 클릭 핸들러를 갖지 않는다. 워크스페이스 이동은
          하단 사이드바의 WorkspaceSwitcher 가 단일 진입점. 시각적인 호버
          dim 도 제거 — 정적 표시 영역. */}
      <div className="flex items-center pl-[27px] pr-8 min-w-[260px] flex-shrink-0">
        <BrandLogo variant="project" />
      </div>

      {/* ── 컨텍스트 존 (페이지별 가변) ── */}
      <div className="flex items-center flex-1 px-8 min-w-0">
        {isDashboard ? (
          /* Dashboard — 활성 Project 워크스페이스의 사용자 지정 이름.
             클릭 시 대시보드 루트로 복귀(라이브러리의 'All Items' 복귀와
             대칭). 라이브러리 브레드크럼 leaf 와 동일한 12/font-semibold/
             foreground 톤 유지. */
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            className="text-body font-semibold text-foreground hover:opacity-70 transition-opacity"
          >
            {projectWorkspaceName}
          </button>
        ) : (
          /* 프로젝트 탭 — breadcrumb. 모든 세그먼트/구분자를 대시보드 상단과
             동일한 13px 로 통일. 위계는 폰트 크기가 아니라 색/굵기로만 구분한다
             (활성=흰색 font-semibold, 그 외=회색). */
          <div className="flex items-center min-w-0 overflow-hidden">
            {folderName && (
              <>
                <span className="text-body text-muted-foreground flex-shrink-0">{folderName}</span>
                <span className="text-primary/50 text-body mx-2 flex-shrink-0">/</span>
              </>
            )}
            <span className="text-body font-semibold text-foreground flex-shrink-0 truncate max-w-[200px]">
              {projectTitle}
            </span>
            {tabName && (
              <>
                <span className="text-primary/50 text-body mx-2 flex-shrink-0">/</span>
                <span className="text-body text-text-secondary flex-shrink-0">{tabName}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── 우측 존 (항상 고정) ── */}
      <div className="flex items-center gap-6 pl-7 pr-4 flex-shrink-0">
        {isDashboard ? (
          /* Dashboard: 총용량 + 설정. 단일 사용자 로컬 앱이라 "사용자명" 슬롯은
             의미가 없어 제거. 향후 멀티유저/협업 기능이 들어오면 다시 살린다. */
          <>
            {totalStorageBytes !== null && totalStorageBytes > 0 && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-body tabular-nums text-muted-foreground"
                title={t("dashboard.totalStorageTooltip", { size: formatBytes(totalStorageBytes) })}
              >
                <HardDrive size={13} className="opacity-70" />
                {t("dashboard.totalStorage", { size: formatBytes(totalStorageBytes) })}
              </span>
            )}
            <Divider />
            <button
              onClick={handleSettings}
              className="flex items-center gap-1.5 text-body text-muted-foreground hover:text-foreground transition-colors"
            >
              <Settings size={13} />
              <span className="hidden sm:block">{t("common.settings")}</span>
            </button>
          </>
        ) : (
          /* 프로젝트 탭: 포맷 · 씬수 + 설정 (사용자명 슬롯 제거 — 동일 사유) */
          <>
            {videoFormat && (
              <MetaPill className="hidden sm:inline-flex">
                {videoFormat}
              </MetaPill>
            )}
            {videoFormat && sceneCount && <Divider />}
            {sceneCount && (
              <MetaPill>
                {sceneCount}
              </MetaPill>
            )}
            {(videoFormat || sceneCount) && <Divider />}
            <button
              onClick={handleSettings}
              className="flex items-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <Settings size={13} />
            </button>
          </>
        )}
      </div>

      {/* ── OS 윈도우 컨트롤(─ □ ×) ──
          네비바 맨 우측에 붙는다. Windows/Linux 에서만 렌더되고
          macOS 는 native traffic light 가 좌상단에 별도로 그려진다. */}
      <WindowControls />
    </nav>
  );
};
