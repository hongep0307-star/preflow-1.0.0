import { useEffect, useState, useRef, useCallback, lazy, Suspense } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Clapperboard,
  Calendar,
  X,
  Check,
  Loader2,
  FileDown,
  FileText,
  Layers,
  MessageSquare,
  Settings,
} from "lucide-react";
import { ProjectSidebar, TabId, TabCompletion } from "@/components/ProjectSidebar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useIsMobile } from "@/hooks/use-mobile";
import type { VideoFormat } from "@/lib/conti";
import { BrandLogo } from "@/components/common/BrandLogo";
import { TopbarToastCarveOut } from "@/components/common/TopbarToastCarveOut";
import { WindowControls } from "@/components/common/WindowControls";
import { useT, useUiLanguage } from "@/lib/uiLanguage";
import { markProjectVisited } from "@/lib/projectVisitTracker";
import { getCachedActiveId } from "@/lib/workspaceClient";
import { prefetchLibraryPage } from "@/lib/pagePrefetch";

const BriefTab = lazy(() => import("@/components/BriefTab").then((m) => ({ default: m.BriefTab })));
const AgentTab = lazy(() => import("@/components/AgentTab").then((m) => ({ default: m.AgentTab })));
const AssetsTab = lazy(() => import("@/components/AssetsTab").then((m) => ({ default: m.AssetsTab })));
const ContiTab = lazy(() => import("@/components/ContiTab").then((m) => ({ default: m.ContiTab })));

const TabLoadingFallback = () => {
  const t = useT();
  return (
    <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span className="font-mono text-caption tracking-wide">{t("common.loading")}</span>
    </div>
  );
};

interface ProjectInfo {
  title: string;
  client: string | null;
  deadline: string | null;
  video_format: VideoFormat;
}

/* video_format → 화면 표시용 비율 prefix.
   라벨(가로형/세로형/정사각 등) 은 `t("projectModal.format.<value>")` 로
   런타임에 결합한다. 한글 UI 에서도 "16:9 Horizontal" 처럼 영문 단어가
   섞여 보이던 회귀를 방지. */
const FORMAT_RATIO: Record<VideoFormat, string> = {
  vertical: "9:16",
  horizontal: "16:9",
  square: "1:1",
};
const FORMAT_VALUES: VideoFormat[] = ["vertical", "horizontal", "square"];

// Dashboard 가 sessionStorage 에 적어두는 캐시 키. ProjectPage 가 마운트되는
// 거의 모든 케이스(대시보드 → 프로젝트 진입)에서 이 안에 video_format 까지 들어
// 있는 row 가 이미 존재하므로, 첫 페인트의 ProjectInfo 를 여기서 동기적으로
// 끌어와 fallback("vertical") 로 한 프레임 잘못 그려지는 비율 jolt 를 없앤다.
// 캐시가 비어 있어도(예: 새로고침/딥링크) 기존처럼 supabase fetch 가 채워준다.
const DASHBOARD_CACHE_KEY = "preflow.dashboard.cache.v1";

const readProjectFromDashboardCache = (
  projectId: string | undefined,
): { project: ProjectInfo; folderName: string } | null => {
  if (!projectId) return null;
  // 캐시가 다른 워크스페이스의 것이면 절대 사용 금지. workspaceId mismatch
  // 시 잘못된 project 정보를 첫 페인트에 노출해 사용자가 "내 워크스페이스에
  // 없는 프로젝트가 잠깐 보임" 현상을 겪는 것을 차단.
  const activeId = getCachedActiveId();
  if (!activeId) return null;
  try {
    const raw = sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      workspaceId?: string;
      projects?: Array<{
        id: string;
        title?: string;
        client?: string | null;
        deadline?: string | null;
        video_format?: string | null;
        folder_id?: string | null;
      }>;
      folders?: Array<{ id: string; name: string }>;
    };
    if (parsed.workspaceId !== activeId) return null;
    const hit = parsed.projects?.find((p) => p.id === projectId);
    if (!hit) return null;
    const fmt: VideoFormat =
      hit.video_format === "horizontal" || hit.video_format === "square"
        ? hit.video_format
        : "vertical";
    const folderName = hit.folder_id
      ? (parsed.folders?.find((f) => f.id === hit.folder_id)?.name ?? "")
      : "";
    return {
      project: {
        title: hit.title ?? "",
        client: hit.client ?? null,
        deadline: hit.deadline ?? null,
        video_format: fmt,
      },
      folderName,
    };
  } catch {
    return null;
  }
};

const ProjectPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const { language: uiLanguage } = useUiLanguage();
  const [searchParams] = useSearchParams();
  // URL 에 ?tab=... 이 있으면 그 탭으로 바로 진입. 없으면 null 로 두고
  // 중앙 4 버튼 선택 화면 (시작점 선택 picker) 을 보여준다.
  //
  // Fallback: 라이브러리 → 프로젝트 복귀 경로에서 HashRouter 의 query string 이
  // 어떤 환경에서 유실되는 케이스를 본 적이 있다. BriefTab.handleGoToLibrary 가
  // sessionStorage 의 `preflow.return.sourceTab` 에도 sourceTab 을 백업해 두므로,
  // URL 파싱 실패 시 그 값으로 진입. 한 번 소비하면 즉시 제거 — 다음 마운트
  // 때엔 URL 이 단일 진실 소스가 되도록.
  const initialTab = ((): TabId | null => {
    const fromUrl = (searchParams.get("tab") as TabId | null) ?? null;
    if (fromUrl) return fromUrl;
    if (typeof window === "undefined") return null;
    try {
      const fromSession = sessionStorage.getItem("preflow.return.sourceTab") as TabId | null;
      if (fromSession) {
        sessionStorage.removeItem("preflow.return.sourceTab");
        return fromSession;
      }
    } catch {
      /* private mode 등 — 무시 */
    }
    return null;
  })();
  // 대시보드 캐시에서 동기 lookup — fetch 가 도착하기 전 첫 프레임의 비율/제목/
  // 폴더명을 정확히 그리기 위함. 캐시 미스(새로고침·딥링크) 시 null 로 떨어져
  // 기존 fetch 경로가 그대로 채운다. lazy initializer 라 마운트 시 한 번만 실행.
  const [project, setProject] = useState<ProjectInfo | null>(
    () => readProjectFromDashboardCache(id)?.project ?? null,
  );
  const [folderName, setFolderName] = useState<string>(
    () => readProjectFromDashboardCache(id)?.folderName ?? "",
  );
  const [activeTab, setActiveTab] = useState<TabId | null>(initialTab);
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() =>
    initialTab ? new Set<TabId>([initialTab]) : new Set<TabId>(),
  );
  // ?tab/sourceTab 없이 진입(=시작점 picker 후보)했을 때, 대시보드 클릭과 동일하게
  // 콘텐츠가 있으면 해당 탭으로 자동 진입할지 결정. 마운트 시 1회만 캡처(매 렌더
  // 재계산되는 initialTab 의 sessionStorage 소비 부작용과 분리).
  const [shouldResolveInitialTab] = useState(() => initialTab === null);
  const [tabResolving, setTabResolving] = useState<boolean>(() => initialTab === null);
  const [completion, setCompletion] = useState<TabCompletion>({
    brief: false,
    assets: false,
    agent: false,
    storyboard: false,
  });
  const isMobile = useIsMobile();

  const [editingField, setEditingField] = useState<"format" | "client" | "deadline" | null>(null);
  const [editClient, setEditClient] = useState("");
  const [editDeadline, setEditDeadline] = useState("");
  const [briefLang, setBriefLang] = useState<"ko" | "en">(() => uiLanguage);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");

  const formatRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<HTMLDivElement>(null);
  const deadlineRef = useRef<HTMLDivElement>(null);

  // 대시보드 사이드바 RECENT 섹션의 정렬 키 갱신. id 가 바뀔 때마다 호출되며,
  // 같은 id 에 대해선 1 분 throttle 이 라이브러리 단계에서 걸려 있어 같은
  // 프로젝트로 빠르게 들락날락해도 DB 부하가 늘어나지 않는다.
  useEffect(() => {
    markProjectVisited(id);
  }, [id]);

  /* LibraryPage chunk idle prefetch — Project 작업 중 사용자가 좌측 사이드
     바의 Library 탭 / 우측 패널에서 reference 를 끌어오기 위해 라이브러리로
     점프하는 패턴이 흔하다. 이 흐름의 첫 진입 비용(lazy chunk fetch + parse)
     을 0 에 가깝게 만들기 위해 mount 후 idle 에 한 번 warm up.
     같은 specifier 의 dynamic import 는 vite 가 자동 dedupe → 실제 lazy
     resolve 시 캐시 hit. cleanup 은 idle 잡 자체를 취소해 짧게 mount 됐다
     unmount 되는 케이스(빠른 라우트 전환) 의 불필요 비용을 회피. */
  useEffect(() => {
    return prefetchLibraryPage();
  }, []);

  const activateTab = useCallback((tab: TabId) => {
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      return new Set([...prev, tab]);
    });
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      const { data } = await supabase
        .from("projects")
        .select("title, client, deadline, video_format, folder_id")
        .eq("id", id)
        .single();
      if (data) {
        setProject({ ...data, video_format: (data as any).video_format || "vertical" } as ProjectInfo);
        if ((data as any).folder_id) {
          const { data: folderData } = await supabase
            .from("folders")
            .select("name")
            .eq("id", (data as any).folder_id)
            .single();
          if (folderData) setFolderName(folderData.name);
        }
      }
      // Load persisted brief analysis language so ABCD/Agent render in the
      // analyzed language from the first paint (UI defaults to English).
      const { data: briefRow } = await supabase
        .from("briefs")
        .select("lang")
        .eq("project_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const storedLang = (briefRow as any)?.lang;
      if (storedLang === "ko" || storedLang === "en") setBriefLang(storedLang);
    };
    fetchData();
  }, [id]);

  useEffect(() => {
    if (!activeTab) return;
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      return new Set([...prev, activeTab]);
    });
  }, [activeTab]);

  // ── 모든 탭 background prefetch ──────────────────────────────────
  // 사용자가 첫 탭을 고른 직후, idle 시점에 나머지 탭들도 백그라운드로 마운트한다.
  // 이유: 탭은 lazy() + 첫 마운트 시에만 데이터 fetch. Generate All 도중에 처음
  // 들어가면 (a) lazy chunk 로드 + (b) Brief/Assets/Conti 의 SELECT 쿼리가
  // generate 워커가 점유한 local-server 큐 뒤에 밀려 응답이 늦음 ⇒ 빈 화면이
  // 잠깐 보이고 Generate 가 끝난 뒤에야 데이터가 채워진다. 모든 탭을 미리
  // 백그라운드로 마운트해 fetch 를 idle 시점에 끝내두면 언제 탭을 전환해도
  // 즉시 데이터가 보인다. activeTab 가 picker (null) 인 동안엔 스킵.
  useEffect(() => {
    if (!id || !activeTab) return;
    const allTabs: TabId[] = ["brief", "assets", "agent", "storyboard"];
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let handle: number;
    let isIdleHandle = false;
    if (typeof w.requestIdleCallback === "function") {
      isIdleHandle = true;
      handle = w.requestIdleCallback(() => {
        setMountedTabs((prev) => {
          if (allTabs.every((t) => prev.has(t))) return prev;
          return new Set(allTabs);
        });
      }, { timeout: 2000 });
    } else {
      handle = window.setTimeout(() => {
        setMountedTabs((prev) => {
          if (allTabs.every((t) => prev.has(t))) return prev;
          return new Set(allTabs);
        });
      }, 1500);
    }
    return () => {
      if (isIdleHandle && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [id, activeTab]);

  // ── Tab completion 판정 ──────────────────────────────────────────
  // 사이드바 스테퍼에 넘길 4 개 탭의 완료 여부. DB 에서 각각 최소 존재 여부만
  // 확인한다 (빈 문자열도 미완료로 취급). activeTab 이 바뀔 때마다 재조회해서
  // 직전 탭에서 한 작업이 즉시 반영되도록 한다.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const [briefRes, assetRes, sceneRes, versionRes] = await Promise.all([
        supabase.from("briefs").select("analysis").eq("project_id", id).limit(1),
        supabase.from("assets").select("id").eq("project_id", id).limit(1),
        supabase.from("scenes").select("id, conti_image_url, source").eq("project_id", id),
        // Send-to-Conti only persists into `scene_versions` as a JSON
        // snapshot — it does NOT create rows in `scenes` (and
        // clearScenesAfterSend wipes the agent-sourced drafts). So
        // presence of a version row is the real signal that Ideation
        // delivered its artifact.
        supabase.from("scene_versions").select("id").eq("project_id", id).limit(1),
      ]);
      if (cancelled) return;
      if (briefRes.error || assetRes.error || sceneRes.error || versionRes.error) {
        console.warn("[ProjectPage] completion refresh skipped after transient read error", {
          brief: briefRes.error?.message,
          assets: assetRes.error?.message,
          scenes: sceneRes.error?.message,
          versions: versionRes.error?.message,
        });
        return;
      }
      const briefRow = (briefRes.data as Array<{ analysis: string | null }> | null)?.[0];
      const briefDone = !!(briefRow?.analysis && String(briefRow.analysis).trim().length > 0);
      const assetsDone = ((assetRes.data as unknown[] | null)?.length ?? 0) > 0;
      const sceneRows =
        (sceneRes.data as Array<{ id: string; conti_image_url: string | null; source: string | null }> | null) ?? [];
      // Ideation completion: either a scene row exists (in-progress
      // Ideation drafts) OR at least one scene_version exists (drafts
      // were already shipped to Conti and `clearScenesAfterSend`
      // subsequently emptied the scenes table). Checking only the
      // scenes table made the step regress the moment the user advanced
      // to Conti — exactly opposite of what a "done" indicator should
      // do. Either signal is sufficient evidence that Ideation delivered
      // its artifact at least once.
      const hasVersion = ((versionRes.data as unknown[] | null)?.length ?? 0) > 0;
      const ideationDone = sceneRows.length > 0 || hasVersion;
      // Conti 완료 판정: 씬이 1개 이상이면서 모든 씬에 conti_image_url 이 채워져 있을 때.
      // 씬이 0개면 당연히 미완료.
      const contiDone =
        sceneRows.length > 0 &&
        sceneRows.every((s) => !!(s.conti_image_url && s.conti_image_url.length > 0));
      setCompletion({
        brief: briefDone,
        assets: assetsDone,
        agent: ideationDone,
        storyboard: contiDone,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, activeTab]);

  // ── 시작점 자동 해소 (대시보드 resolveProjectRoute 와 동일 규칙) ──
  // ?tab/sourceTab 없이 진입했고 콘텐츠가 있으면 picker 대신 그 탭으로 바로 진입.
  //   - 콘티 씬(source='conti') 또는 scene_versions 존재 → storyboard
  //   - 아이데이션 씬(source='agent') → agent
  //   - 둘 다 없으면 picker 유지(빈 프로젝트의 시작점 선택 의도 보존).
  useEffect(() => {
    if (!shouldResolveInitialTab || !id) {
      setTabResolving(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [scenesRes, versionsRes] = await Promise.all([
          supabase.from("scenes").select("source").eq("project_id", id),
          supabase.from("scene_versions").select("id").eq("project_id", id).limit(1),
        ]);
        const scenes = (scenesRes.data as Array<{ source?: string | null }> | null) ?? [];
        const versions = (versionsRes.data as unknown[] | null) ?? [];
        const hasConti = scenes.some((s) => s.source === "conti") || versions.length > 0;
        const hasAgent = scenes.some((s) => s.source === "agent");
        if (!cancelled) {
          // 사용자가 resolve 도중 picker 에서 직접 골랐으면 덮어쓰지 않는다.
          if (hasConti) setActiveTab((cur) => cur ?? "storyboard");
          else if (hasAgent) setActiveTab((cur) => cur ?? "agent");
        }
      } catch {
        /* 조회 실패 → picker 유지 */
      } finally {
        if (!cancelled) setTabResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, shouldResolveInitialTab]);

  useEffect(() => {
    if (!editingField) return;
    const refs = { format: formatRef, client: clientRef, deadline: deadlineRef };
    const handler = (e: MouseEvent) => {
      const ref = refs[editingField];
      if (ref?.current && !ref.current.contains(e.target as Node)) setEditingField(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editingField]);

  // ── Keyboard shortcuts ──────────────────────────────────────────
  // Cmd/Ctrl+1..4 to jump between the four project tabs. Order matches the
  // sidebar: 1 Brief · 2 Assets · 3 Agent · 4 Storyboard. We skip when an
  // input/textarea is focused so typed numbers still go where the user expects.
  useEffect(() => {
    const tabOrder: TabId[] = ["brief", "assets", "agent", "storyboard"];
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx === -1) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT"
      ) {
        return;
      }
      e.preventDefault();
      activateTab(tabOrder[idx]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activateTab]);

  const updateProjectField = useCallback(
    async (
      patch: Partial<{ video_format: VideoFormat; client: string | null; deadline: string | null }>,
      options: { closeEditor?: boolean } = {},
    ) => {
      if (!id) return;
      const shouldCloseEditor = options.closeEditor ?? true;
      setProject((prev) => (prev ? ({ ...prev, ...patch } as ProjectInfo) : prev));
      const { data } = await supabase
        .from("projects")
        .update(patch)
        .eq("id", id)
        .select("title, client, deadline, video_format")
        .single();
      if (data) setProject({ ...data, video_format: (data as any).video_format || "vertical" } as ProjectInfo);
      if (shouldCloseEditor) setEditingField(null);
    },
    [id],
  );

  const saveTitle = useCallback(
    async (val: string) => {
      const trimmed = val.trim();
      if (!trimmed || !id) {
        setEditingTitle(false);
        return;
      }
      const { data } = await supabase
        .from("projects")
        .update({ title: trimmed })
        .eq("id", id)
        .select("title, client, deadline, video_format")
        .single();
      if (data) setProject({ ...data, video_format: (data as any).video_format || "vertical" } as ProjectInfo);
      setEditingTitle(false);
    },
    [id],
  );

  const formatDeadlineDisplay = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00");
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
    const base = `${mm}/${dd}`;
    if (diff < 0) return { text: `${base} (D+${Math.abs(diff)})`, urgent: true };
    if (diff === 0) return { text: `${base} (TODAY)`, urgent: true };
    if (diff <= 3) return { text: `${base} (D-${diff})`, urgent: true };
    return { text: base, urgent: false };
  };

  const videoFormat = project?.video_format ?? "vertical";
  const formatRatio = FORMAT_RATIO[videoFormat];
  const formatLabel = `${formatRatio} ${t(`projectModal.format.${videoFormat}`)}`;
  const formatEditOptions = FORMAT_VALUES.map((value) => ({
    value,
    label: `${FORMAT_RATIO[value]} ${t(`projectModal.format.${value}`)}`,
  }));
  const deadlineDisplay = formatDeadlineDisplay(project?.deadline ?? null);
  // [JOLT-DEBUG] project 상태와 활성 탭이 어느 시점에 어떻게 잡히는지 트래킹.
  console.log("[JOLT][ProjectPage] render", {
    id,
    hasProject: !!project,
    videoFormat,
    activeTab,
    mounted: Array.from(mountedTabs),
    t: performance.now().toFixed(0),
  });

  const handleSwitchToContiTab = (sceneNumber?: number) => {
    activateTab("storyboard");
    if (sceneNumber) {
      setTimeout(() => {
        const el = document.getElementById(`conti-scene-${sceneNumber}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  };

  const renderTabPanels = () => {
    if (!id) return null;
    const panelClass = (tab: TabId) => (activeTab === tab ? "block h-full" : "hidden");

    return (
      <>
        {mountedTabs.has("brief") && (
          <div className={panelClass("brief")}>
            <ErrorBoundary label="brief tab" resetKey={`${id}:brief`}>
              <Suspense fallback={<TabLoadingFallback />}>
                <BriefTab
                  projectId={id}
                  onSwitchToAgent={(lang) => { setBriefLang(lang); activateTab("agent"); }}
                  onSwitchToAssets={() => activateTab("assets")}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
        {mountedTabs.has("agent") && (
          <div className={panelClass("agent")}>
            <ErrorBoundary label="agent tab" resetKey={`${id}:agent`}>
              <Suspense fallback={<TabLoadingFallback />}>
                {/* project 가 도착하기 전에 마운트되면 fallback "vertical" 비율로
                    한 프레임 그려져서 jolt 가 발생한다. 도착할 때까지 fallback 노출. */}
                {project ? (
                  <AgentTab
                    projectId={id}
                    videoFormat={videoFormat}
                    lang={briefLang}
                    onSwitchToContiTab={handleSwitchToContiTab}
                    isActive={activeTab === "agent"}
                  />
                ) : (
                  <TabLoadingFallback />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
        {mountedTabs.has("assets") && (
          <div className={panelClass("assets")}>
            <ErrorBoundary label="assets tab" resetKey={`${id}:assets`}>
              <Suspense fallback={<TabLoadingFallback />}>
                <AssetsTab projectId={id} initialAssetType={searchParams.get("assetType")} onSwitchToAgent={() => activateTab("agent")} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
        {mountedTabs.has("storyboard") && (
          <div className={panelClass("storyboard")}>
            <ErrorBoundary label="storyboard tab" resetKey={`${id}:storyboard`}>
              <Suspense fallback={<TabLoadingFallback />}>
                {/* project 도착 전 ContiTab 이 그리드/카드 비율을 fallback 으로
                    잡아 jolt 가 났다. project 도착 후에만 실제 그리드 마운트. */}
                {project ? (
                  <ContiTab projectId={id} videoFormat={videoFormat} isActive={activeTab === "storyboard"} />
                ) : (
                  <TabLoadingFallback />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </>
    );
  };

  /* ── Pill 스타일 ── */
  const pillBase = "meta-pill cursor-pointer";
  const pillDefault = "";
  const pillActive = "meta-pill-active";

  const TAB_LABEL: Record<TabId, string> = {
    brief: t("tabs.brief"),
    agent: t("tabs.agent"),
    assets: t("tabs.assets"),
    storyboard: t("tabs.conti"),
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* ── Top bar ──
          Library/Dashboard/Settings 네비바와 완전히 동일한 3-zone 구조
          (brand flex-shrink-0 / context flex-1 px-8 min-w-0 / right
          flex-shrink-0) 로 통일. brand 버튼은 `pl-[27px] pr-8 min-w-[260px]`
          로 자기 영역을 잡고, 우측 메타 pill 그룹은 `pr-2` 로 WindowControls
          (─ □ ×) 와 약간 분리. min-w-[260px] 가 variant 별 BrandLogo 너비
          차이(PROJECT WORKSPACE vs REFERENCE LIBRARY 서브타이틀 글자 차이)
          를 흡수해 네 화면의 컨텍스트 텍스트 시작점이 픽셀 단위로 일치한다. */}
      <nav className="app-topbar relative">
        {/* Top-center 토스트가 네비바 위에 떠 있을 때 Electron drag region 흡수를
            막는 carve-out. 자세한 설명은 컴포넌트 파일 헤더 주석 참고. */}
        <TopbarToastCarveOut />
        {/* 브랜드 버튼 (zone 1) */}
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center pl-[27px] pr-8 min-w-[260px] hover:opacity-80 transition-opacity flex-shrink-0"
        >
          <BrandLogo variant="project" />
        </button>

        {/* 브레드크럼 (zone 2) — 폴더 트리 위치 + 프로젝트 제목 + 활성 탭.
            Dashboard 의 "Project Workspace [pill]", Library 의 "Reference
            Library / All References" 와 완전히 동일한 `flex-1 px-8 min-w-0`
            컨테이너에 담겨 컨텍스트 텍스트 시작점이 세 화면에서 일치. */}
        {/* 브레드크럼 폰트는 대시보드/라이브러리 상단과 동일하게 13px 로 통일.
            위계는 색/굵기로만 구분(폴더=회색, 제목=흰색 semibold, 탭=회색),
            세그먼트 크기는 균등하게 둔다. */}
        <div className="flex items-center flex-1 px-8 min-w-0">
          {folderName && (
            <>
              <span className="text-body text-muted-foreground flex-shrink-0">{folderName}</span>
              <span className="text-primary/50 text-body mx-2 flex-shrink-0">/</span>
            </>
          )}
          {editingTitle ? (
            <input
              autoFocus
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle(editTitle);
                if (e.key === "Escape") setEditingTitle(false);
              }}
              onBlur={() => saveTitle(editTitle)}
              className="text-body font-semibold border-b border-primary bg-transparent text-foreground outline-none w-[200px]"
            />
          ) : (
            <button
              onClick={() => {
                setEditTitle(project?.title ?? "");
                setEditingTitle(true);
              }}
              className="text-body font-semibold text-foreground truncate max-w-[200px] hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
              title={t("project.editTitle")}
            >
              {project?.title || ""}
            </button>
          )}
          {activeTab && (
            <>
              <span className="text-primary/50 text-body mx-2 flex-shrink-0">/</span>
              <span className="text-body text-text-secondary flex-shrink-0">{TAB_LABEL[activeTab]}</span>
            </>
          )}
        </div>

        {/* 우측: 메타 pills (zone 3) */}
        <div className="flex items-center gap-2 pr-2 flex-shrink-0">
          {/* 비율 */}
          <div ref={formatRef} className="relative">
            <button
              onClick={() => setEditingField(editingField === "format" ? null : "format")}
              className={`${pillBase} ${editingField === "format" ? pillActive : pillDefault}`}
              style={{ borderRadius: 0 }}
            >
              {formatLabel}
            </button>
            {editingField === "format" && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] z-50 bg-card border border-border shadow-xl overflow-hidden min-w-[160px]"
                style={{ borderRadius: 0 }}
              >
                {formatEditOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => updateProjectField({ video_format: opt.value })}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-caption font-mono font-medium tracking-wide text-left transition-colors ${
                      project?.video_format === opt.value
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-secondary text-foreground/70"
                    }`}
                  >
                    <span className="flex-1">{opt.label}</span>
                    {project?.video_format === opt.value && <Check className="w-3 h-3 text-primary" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 요청부서 */}
          <div ref={clientRef} className="relative hidden md:block">
            {editingField === "client" ? (
              <input
                autoFocus
                value={editClient}
                onChange={(e) => setEditClient(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateProjectField({ client: editClient.trim() || null });
                  if (e.key === "Escape") setEditingField(null);
                }}
                onBlur={() => updateProjectField({ client: editClient.trim() || null })}
                placeholder={t("project.departmentPlaceholder")}
                className="meta-pill-active font-mono text-2xs font-medium tracking-wide border px-2.5 h-[26px] inline-flex items-center bg-background outline-none w-[110px] rounded-none"
              />
            ) : (
              <button
                onClick={() => {
                  setEditClient(project?.client ?? "");
                  setEditingField("client");
                }}
                className={`${pillBase} ${pillDefault}`}
                style={{ borderRadius: 0 }}
              >
                {project?.client || t("project.department")}
              </button>
            )}
          </div>

          {/* 마감일 */}
          <div ref={deadlineRef} className="relative hidden md:flex items-center">
            {editingField === "deadline" ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  type="date"
                  lang="en"
                  value={editDeadline}
                  onChange={(e) => {
                    const next = e.target.value;
                    setEditDeadline(next);
                    void updateProjectField({ deadline: next || null }, { closeEditor: false });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") updateProjectField({ deadline: editDeadline || null });
                    if (e.key === "Escape") setEditingField(null);
                  }}
                  onBlur={(e) => updateProjectField({ deadline: e.currentTarget.value || null })}
                  className="meta-pill-active font-mono text-2xs font-bold uppercase border px-2 py-0.5 bg-background outline-none rounded-none"
                  style={{ colorScheme: "dark" }}
                />
                {project?.deadline && (
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      updateProjectField({ deadline: null });
                    }}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    title={t("project.clearDeadline")}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={() => {
                  setEditDeadline(project?.deadline ?? "");
                  setEditingField("deadline");
                }}
                className={`${pillBase} ${deadlineDisplay?.urgent ? "border-primary/40 text-primary bg-primary/5" : pillDefault}`}
                style={{ borderRadius: 0 }}
              >
                <Calendar className="w-3 h-3 inline mr-1 -mt-px" />
                {deadlineDisplay ? deadlineDisplay.text : t("project.deadline")}
              </button>
            )}
          </div>

          {/* 설정 — 대시보드/라이브러리 네비바(Navbar)와 동일한 위치(윈도우 컨트롤
              좌측)에 고정. 프로젝트 상단 바는 Navbar 를 쓰지 않고 자체 구성이라
              이 버튼이 빠져 있었음. 구분선을 둬서 메타 pill 그룹과 분리하고,
              버튼이 추가되면서 좌측 pill 들은 자연히 왼쪽으로 밀려 설정 영역을 피함. */}
          <div className="w-px h-4 bg-border-subtle flex-shrink-0" />
          <button
            onClick={() => navigate("/settings")}
            className="flex items-center text-muted-foreground hover:text-foreground transition-colors"
            title={t("common.settings")}
          >
            <Settings size={13} />
          </button>
        </div>
        {/* OS 윈도우 컨트롤(─ □ ×). Win/Linux 에서만 렌더, macOS 는 자동 숨김. */}
        <WindowControls />
      </nav>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">
        {activeTab === null ? (
          // 시작점 자동 해소 중에는 picker 깜빡임을 막고 로딩만 보여준다.
          tabResolving ? (
            <div className="flex flex-1 items-center justify-center">
              <TabLoadingFallback />
            </div>
          ) : (
            // 첫 진입(빈 프로젝트) — 사이드바 없이 시작점 선택.
            <StartPointPicker
              completion={completion}
              onPick={activateTab}
            />
          )
        ) : (
          <>
            <ProjectSidebar activeTab={activeTab} onTabChange={activateTab} completion={completion} />
            <main
              className={`flex-1 overflow-hidden ${activeTab === "brief" ? "overflow-y-auto p-5 lg:p-6" : ""} ${isMobile ? "pb-14" : ""}`}
            >
              {renderTabPanels()}
            </main>
          </>
        )}
      </div>
    </div>
  );
};

/* ── 시작점 선택 Picker ────────────────────────────────────────────
 * 프로젝트에 처음 들어왔을 때 어느 단계부터 시작할지 고르는 4-카드 화면.
 * 사이드바 대신 전체 영역을 차지하며, 카드 클릭 시 해당 탭으로 진입. */
const PICKER_CARDS: {
  id: TabId;
  titleKey: string;
  icon: typeof FileText;
  descKey: string;
}[] = [
  { id: "brief", icon: FileText, titleKey: "tabs.brief", descKey: "project.briefDesc" },
  { id: "assets", icon: Layers, titleKey: "tabs.assets", descKey: "project.assetsDesc" },
  { id: "agent", icon: MessageSquare, titleKey: "tabs.agent", descKey: "project.agentDesc" },
  { id: "storyboard", icon: Clapperboard, titleKey: "tabs.conti", descKey: "project.contiDesc" },
];

const StartPointPicker = ({
  completion,
  onPick,
}: {
  completion: TabCompletion;
  onPick: (tab: TabId) => void;
}) => {
  const t = useT();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 bg-background">
      <div className="text-center mb-12">
        <h1 className="text-display font-extrabold tracking-tight leading-tight text-foreground">
          {t("project.startTitle")}
        </h1>
        <p className="mt-3 text-label text-text-secondary">
          {t("project.startDesc")}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 w-full max-w-[1500px]">
        {PICKER_CARDS.map((card) => {
          const done = completion[card.id];
          return (
            <button
              key={card.id}
              onClick={() => onPick(card.id)}
              className="group relative flex flex-col items-start gap-3 p-6 h-[180px] border border-border-subtle bg-surface-panel/50 hover:bg-surface-elevated hover:border-primary/40 transition-all duration-150 text-left rounded-none"
            >
              {done && (
                <span
                  className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-semibold tracking-wide bg-success/10 text-success rounded-none"
                >
                  <Check className="w-3 h-3" strokeWidth={3} />
                  {t("common.done")}
                </span>
              )}
              <div
                className="w-14 h-14 flex items-center justify-center bg-surface-elevated transition-colors duration-150 group-hover:bg-primary/15 rounded-none"
              >
                <card.icon className="w-7 h-7 text-text-secondary group-hover:text-primary transition-colors" />
              </div>
              <div className="flex-1 flex flex-col justify-end w-full">
                <div className="text-heading font-bold tracking-tight text-foreground">
                  {t(card.titleKey)}
                </div>
                {/* 한 줄 고정 — 카드 폭을 넉넉히 줘서 줄바꿈 없음. */}
                <div className="mt-1.5 h-[18px] overflow-hidden text-ellipsis whitespace-nowrap text-meta leading-[18px] text-muted-foreground">
                  {t(card.descKey)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ProjectPage;
