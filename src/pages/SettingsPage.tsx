import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Eye,
  EyeOff,
  Loader2,
  ArrowLeft,
  Check,
  Key,
  Cpu,
  Languages,
  Monitor,
  Wrench,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";
import ModelPicker from "@/components/common/ModelPicker";
import { invalidateSettingsCache } from "@/lib/settingsCache";
import { BrandLogo } from "@/components/common/BrandLogo";
import { TopbarToastCarveOut } from "@/components/common/TopbarToastCarveOut";
import { WindowControls } from "@/components/common/WindowControls";
import { useUiLanguage, type UiLanguage } from "@/lib/uiLanguage";
import {
  DASHBOARD_CARDS_PER_ROW_OPTIONS,
  readDashboardCardsPerRow,
  saveDashboardCardsPerRow,
  type DashboardCardsPerRow,
} from "@/lib/dashboardPreferences";
import {
  readAnimatedThumbnailsAutoplay,
  saveAnimatedThumbnailsAutoplay,
} from "@/lib/animationPreferences";
import {
  readHideDefaultWorkspaces,
  saveHideDefaultWorkspaces,
} from "@/lib/workspacePreferences";
import { Checkbox } from "@/components/ui/checkbox";
import {
  IMAGE_GEN_FEATURES,
  IMAGE_GEN_MODEL_LABELS,
  GPT_QUALITIES,
  modelIsGpt,
  getImageModelDefault,
  getGptQualityDefault,
  setImageModelDefault,
  setGptQualityDefault,
  type ImageGenFeature,
  type GptQuality,
} from "@/lib/imageGenPreference";
import {
  getAiOutputLanguageMode,
  getAiTagLanguageMode,
  setAiOutputLanguageMode,
  setAiTagLanguageMode,
  subscribeAiOutputLanguage,
  type AiOutputLanguageMode,
  type AiTagLanguageMode,
} from "@/lib/aiOutputLanguage";
import { LibraryAiCleanupDialog } from "@/components/library/LibraryAiCleanupDialog";
import { KoreanAliasExpandDialog } from "@/components/library/KoreanAliasExpandDialog";
import { OptimizeThumbnailsDialog } from "@/components/library/OptimizeThumbnailsDialog";
import { cn } from "@/lib/utils";

const settingsApi = {
  get: async () => {
    const res = await fetch(`${LOCAL_SERVER_BASE_URL}/settings/get`, {
      method: "POST",
      headers: LOCAL_SERVER_AUTH_HEADERS,
    });
    return res.json();
  },
  set: async (s: any) => {
    const res = await fetch(`${LOCAL_SERVER_BASE_URL}/settings/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
      body: JSON.stringify(s),
    });
    return res.json();
  },
};

interface SettingsState {
  anthropic_api_key: string;
  openai_api_key: string;
  google_service_account_key: string;
  google_cloud_project_id: string;
}

/* ── 좌측 사이드 네비게이션 카테고리 정의 ──
 *
 * 옵션 A 의 핵심 — 기존 2-탭(API Keys / Models & Preferences) 구조가
 * "한 탭에 카드 3개 + 컨트롤 7개" 로 폭주하던 문제를 해결한다.
 *
 *   1) "API Keys"        — 4 fields (제공사 인증)
 *   2) "Models"          — 2 model pickers
 *   3) "Language"        — 전체 언어(UI) + AI 언어(출력/태그 머지) 두 하위 섹션
 *   4) "Display & UI"    — dashboard 컬럼 + 토글 2 + 하단 Maintenance sub-section
 *
 * Maintenance(라이브러리 AI 정리 / 썸네일 최적화) 는 별도 카테고리가
 * 아니라 Display & UI 패널 하단의 "1회성 작업" sub-section 으로 배치 —
 * "이 페이지는 정리 도구가 아니라 설정 페이지" 라는 사용자 모델을 유지하면서,
 * 인접한 카테고리(Display & UI) 안에서 발견될 수 있게 한다.
 */
type SettingsCategoryId = "keys" | "models" | "language" | "displayUi";

interface CategoryDef {
  id: SettingsCategoryId;
  labelKey: string;
  descKey: string;
  icon: LucideIcon;
}

const CATEGORIES: CategoryDef[] = [
  { id: "keys",       labelKey: "settings.nav.apiKeys",    descKey: "settings.apiKeysCardDesc",    icon: Key },
  { id: "models",     labelKey: "settings.nav.models",     descKey: "settings.modelsCardDesc",     icon: Cpu },
  { id: "language",   labelKey: "settings.nav.language",   descKey: "settings.languageCardDesc",   icon: Languages },
  { id: "displayUi",  labelKey: "settings.nav.displayUi",  descKey: "settings.displayUiCardDesc",  icon: Monitor },
];

const SettingsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { language, setLanguage, t } = useUiLanguage();

  /* 어디서 Settings 로 진입했는지 — 호출부가 navigate("/settings",
     { state: { from: "/library" } }) 식으로 실어 보내면 그 경로로 돌아간다.
     state 가 없거나 형태가 이상하면 기존 동작(/dashboard) 으로 fallback. */
  const { backPath, backLabel } = useMemo(() => {
    const rawFrom = (location.state as { from?: string } | null)?.from;
    if (typeof rawFrom === "string" && rawFrom.startsWith("/library")) {
      return { backPath: "/library", backLabel: t("common.library") };
    }
    return { backPath: "/dashboard", backLabel: t("common.dashboard") };
  }, [location.state, t]);

  /* 활성 카테고리 — 좌측 레일에서 선택. 라우트 state 에서 초기 카테고리를
     실어 보낼 수도 있게 했지만 (settings:{category:"models"} 같은 식의 향후
     호출부 확장 여지), 현재는 기본값 "keys" 로 진입한다. */
  const [category, setCategory] = useState<SettingsCategoryId>(() => {
    const fromState = (location.state as { category?: SettingsCategoryId } | null)?.category;
    return fromState ?? "keys";
  });

  const [settings, setSettings] = useState<SettingsState>({
    anthropic_api_key: "",
    openai_api_key: "",
    google_service_account_key: "",
    google_cloud_project_id: "",
  });
  // 기능별 이미지 생성 디폴트(모델 + GPT 품질). localStorage 기반이라 settings
  // (DB) 와 별개로 즉시 영속된다. 각 생성 화면이 마운트 시 이 값을 출발값으로 읽는다.
  const [imgGenPrefs, setImgGenPrefs] = useState<
    Record<ImageGenFeature, { model: string; quality: GptQuality }>
  >(() =>
    Object.fromEntries(
      IMAGE_GEN_FEATURES.map((s) => [
        s.feature,
        { model: getImageModelDefault(s.feature), quality: getGptQualityDefault(s.feature) },
      ]),
    ) as Record<ImageGenFeature, { model: string; quality: GptQuality }>,
  );
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dashboardCardsPerRow, setDashboardCardsPerRow] =
    useState<DashboardCardsPerRow>(readDashboardCardsPerRow);
  const [animatedThumbnailsAutoplay, setAnimatedThumbnailsAutoplay] =
    useState<boolean>(readAnimatedThumbnailsAutoplay);
  const [hideDefaultWorkspaces, setHideDefaultWorkspaces] = useState<boolean>(
    readHideDefaultWorkspaces,
  );
  const [aiCleanupOpen, setAiCleanupOpen] = useState(false);
  const [thumbBackfillOpen, setThumbBackfillOpen] = useState(false);
  const [koreanAliasOpen, setKoreanAliasOpen] = useState(false);
  /* AI 언어 정책 — 두 축(Display, Tag) 모두 같은 이벤트로 구독한다.
     Inspector 의 토글이 Display 를 바꾸면 여기 Select 도 즉시 따라온다. */
  const [aiOutputLang, setAiOutputLang] = useState<AiOutputLanguageMode>(getAiOutputLanguageMode);
  const [aiTagLang, setAiTagLang] = useState<AiTagLanguageMode>(getAiTagLanguageMode);

  /* 자동 저장 → 인라인 "Saved" 칩 피드백.
     API Keys 외의 모든 컨트롤(언어 select, dashboard 컬럼, 토글들)은
     변경 즉시 영구화된다. "Save Settings" 버튼이 사실상 키만 저장하던 점이
     기존의 혼란 원인이었으므로, 자동 저장된 변경은 패널 헤더 우측에 1.6초
     페이드하는 "Saved" 칩으로 명시한다. ref 로 setTimeout 핸들을 추적해
     빠른 연속 변경에도 깜빡임이 안 생기게 한다. */
  const [savedHint, setSavedHint] = useState(false);
  const savedHintTimerRef = useRef<number | null>(null);
  const flashSaved = () => {
    setSavedHint(true);
    if (savedHintTimerRef.current !== null) {
      window.clearTimeout(savedHintTimerRef.current);
    }
    savedHintTimerRef.current = window.setTimeout(() => {
      setSavedHint(false);
      savedHintTimerRef.current = null;
    }, 1600);
  };
  useEffect(() => {
    return () => {
      if (savedHintTimerRef.current !== null) {
        window.clearTimeout(savedHintTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAiOutputLanguage(() => {
      setAiOutputLang(getAiOutputLanguageMode());
      setAiTagLang(getAiTagLanguageMode());
    });
    return unsubscribe;
  }, []);

  const handleAiOutputLangChange = (value: string) => {
    const next = value as AiOutputLanguageMode;
    setAiOutputLang(next);
    setAiOutputLanguageMode(next);
    flashSaved();
  };
  const handleAiTagLangChange = (value: string) => {
    const next = value as AiTagLanguageMode;
    setAiTagLang(next);
    setAiTagLanguageMode(next);
    flashSaved();
  };
  const handleUiLanguageChange = (value: UiLanguage) => {
    setLanguage(value);
    flashSaved();
  };

  useEffect(() => {
    settingsApi.get().then((s: any) => {
      setSettings({
        anthropic_api_key: s.anthropic_api_key ?? "",
        openai_api_key: s.openai_api_key ?? "",
        google_service_account_key: s.google_service_account_key ?? "",
        google_cloud_project_id: s.google_cloud_project_id ?? "",
      });
    });
  }, []);

  const handleSave = async () => {
    setLoading(true);
    setSaved(false);
    await settingsApi.set(settings);
    await invalidateSettingsCache();
    setSaved(true);
    setLoading(false);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggle = (key: string) => setShowKeys((p) => ({ ...p, [key]: !p[key] }));

  /* 기능별 이미지 생성 디폴트 — ModelPicker 처럼 변경 즉시 localStorage 에
     영속한다(설정 저장 버튼과 무관). 각 생성 화면은 마운트 시 이 값을 출발값으로
     읽으므로 다음 생성부터 반영된다. */
  const handleImgGenModelChange = (feature: ImageGenFeature, modelId: string) => {
    setImageModelDefault(feature, modelId);
    setImgGenPrefs((p) => ({ ...p, [feature]: { ...p[feature], model: modelId } }));
    flashSaved();
  };
  const handleImgGenQualityChange = (feature: ImageGenFeature, quality: GptQuality) => {
    setGptQualityDefault(feature, quality);
    setImgGenPrefs((p) => ({ ...p, [feature]: { ...p[feature], quality } }));
    flashSaved();
  };

  const handleDashboardCardsPerRowChange = (value: string) => {
    const next = Number(value) as DashboardCardsPerRow;
    if (!DASHBOARD_CARDS_PER_ROW_OPTIONS.includes(next)) return;
    setDashboardCardsPerRow(next);
    saveDashboardCardsPerRow(next);
    flashSaved();
  };

  const handleAnimatedThumbnailsAutoplayChange = (checked: boolean) => {
    setAnimatedThumbnailsAutoplay(checked);
    saveAnimatedThumbnailsAutoplay(checked);
    flashSaved();
  };

  const handleHideDefaultWorkspacesChange = (checked: boolean) => {
    setHideDefaultWorkspaces(checked);
    saveHideDefaultWorkspaces(checked);
    flashSaved();
  };

  const inputCls =
    "h-9 bg-surface-panel border-border-subtle text-meta text-foreground/80 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:border-primary/30 rounded-none";

  /* API 키 형식 휴리스틱 — keyWarning 과 같은 룰. 상태 칩이 keyWarning 과
     동일 데이터 소스를 쓰게 해 두 곳이 어긋나지 않게 한다. */
  type ApiKeyStatus = "empty" | "configured" | "mismatch";
  const apiKeyStatusOf = (key: keyof SettingsState, value: string): ApiKeyStatus => {
    const trimmed = value.trim();
    if (!trimmed) return "empty";
    if (trimmed.length < 5) return "configured"; // 너무 짧으면 형식 판정 보류
    if (key === "openai_api_key" && trimmed.startsWith("sk-ant-")) return "mismatch";
    if (
      key === "anthropic_api_key"
      && (trimmed.startsWith("sk-proj-") || (trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-")))
    ) return "mismatch";
    if (key === "google_service_account_key" && !trimmed.startsWith("{")) return "mismatch";
    return "configured";
  };

  const keyWarning = (key: keyof SettingsState, value: string): string | null => {
    if (!value || value.length < 5) return null;
    if (key === "openai_api_key" && value.startsWith("sk-ant-"))
      return "⚠ This looks like an Anthropic key. Please enter an OpenAI key (sk-proj-... or sk-...).";
    if (
      key === "anthropic_api_key"
      && (value.startsWith("sk-proj-") || (value.startsWith("sk-") && !value.startsWith("sk-ant-")))
    )
      return "⚠ This looks like an OpenAI key. Please enter an Anthropic key (sk-ant-...).";
    if (key === "google_service_account_key" && !value.trim().startsWith("{"))
      return "⚠ Must be JSON. Paste the full {\"type\":\"service_account\",...} object.";
    return null;
  };

  const fields: {
    key: keyof SettingsState;
    label: string;
    desc: string;
    required?: boolean;
    multiline?: boolean;
    placeholder?: string;
  }[] = [
    { key: "anthropic_api_key", label: "Anthropic API Key", desc: "Used for Claude chat, scene translation, and visual interpretation", required: true, placeholder: "sk-ant-..." },
    { key: "openai_api_key", label: "OpenAI API Key", desc: "Used for GPT image generation and GPT-5.4 / GPT-5.5 text analysis / agent", required: true, placeholder: "sk-proj-..." },
    { key: "google_cloud_project_id", label: "Google Cloud Project ID", desc: "Vertex AI — shared for image generation + Gemini text analysis", required: true, placeholder: "my-project-123" },
    { key: "google_service_account_key", label: "Google Service Account Key (JSON)", desc: "Full service-account JSON used to authenticate with Vertex AI", required: true, multiline: true, placeholder: '{"type":"service_account",...}' },
  ];

  /* ── 스타일 토큰 ── */

  // 패널 헤더 — 카테고리 아이콘 + 14px 타이틀 + 11px 설명.
  // 카드 내부 라벨(text-meta font-semibold) 와 명확히 위계가 갈리도록
  // 13px → 14px 로 한 단계 키운다.
  const panelTitleCls = "text-label font-semibold text-foreground";
  const panelDescCls = "text-caption text-muted-foreground leading-relaxed";

  // 단일 surface-panel 카드 — 한 카테고리에 하나만 둔다. p-7 + 내부
  // divide-y 로 행 분리. 카드를 여러 개 쌓던 이전 구조 대비 시각 잡음 ↓.
  const cardCls = "surface-panel w-full rounded-none p-7";

  // 카드 내부 한 행. py-5 로 행 사이 호흡을 조금 늘려 라벨/설명/컨트롤이
  // 답답하지 않게.
  const rowCls = "space-y-2 py-5 first:pt-0 last:pb-0";
  const fieldLabelCls = "text-meta font-semibold text-text-secondary";
  const fieldDescCls = "text-caption text-muted-foreground leading-relaxed";

  // 좌측 네비 행 — 라이브러리 사이드바와 같은 시각 톤(13px / py-2 /
  // border-l-2 활성). 익숙한 패턴 재사용으로 학습 비용 0.
  const navItemCls = (isActive: boolean) =>
    cn(
      "w-full flex items-center gap-2.5 px-3 py-2 text-left text-body border-l-2 transition-colors",
      isActive
        ? "border-l-primary bg-primary/10 text-foreground"
        : "border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
    );

  // 우측 메인 컬럼 폭 — 단일 컬럼이지만 이전 560px 보다 더 여유 있게.
  // 좌측 220px 레일과 함께 1024px 화면에서도 답답하지 않다.
  const mainColCls = "w-full max-w-[640px] space-y-5";

  // API 키 상태 칩 — 라벨 우측에 작은 도트 + 라벨 형식으로 한눈에 식별.
  const StatusChip = ({ status }: { status: ApiKeyStatus }) => {
    const map: Record<ApiKeyStatus, { dot: string; text: string; bg: string; label: string }> = {
      empty: {
        dot: "bg-muted-foreground/50",
        text: "text-muted-foreground",
        bg: "bg-muted/40",
        label: t("settings.apiKeyStatus.empty"),
      },
      configured: {
        dot: "bg-success",
        text: "text-success",
        bg: "bg-success/10",
        label: t("settings.apiKeyStatus.configured"),
      },
      mismatch: {
        dot: "bg-warning",
        text: "text-warning",
        bg: "bg-warning/10",
        label: t("settings.apiKeyStatus.mismatch"),
      },
    };
    const s = map[status];
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-1.5 py-0.5 text-2xs font-medium",
          s.bg,
          s.text,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} aria-hidden />
        {s.label}
      </span>
    );
  };

  // 패널 헤더(아이콘 + 타이틀 + 설명 + Saved 칩) 공통 렌더러.
  // 모든 카테고리 패널 상단이 같은 시각 구조를 갖도록 묶었다.
  const renderPanelHeader = (
    Icon: LucideIcon,
    titleKey: string,
    descKey: string,
    extra?: ReactNode,
  ) => (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <h2 className={panelTitleCls}>{t(titleKey)}</h2>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-caption font-medium text-success transition-opacity duration-200",
              savedHint ? "opacity-100" : "opacity-0",
            )}
            aria-hidden={!savedHint}
          >
            <Check className="h-3 w-3" />
            {t("common.saved")}
          </span>
        </div>
        <p className={cn(panelDescCls, "mt-0.5")}>{t(descKey)}</p>
        {extra}
      </div>
    </div>
  );

  // Maintenance action 카드 — Display & UI 패널 하단의 1회성 작업 행.
  // 일반 settings 행과 시각적으로 구분되도록 darker bg-card + 좌측 컬러
  // 아이콘 박스 + 우측 outline 실행 버튼. "이건 설정이 아니라 작업" 임이
  // 한눈에 읽힌다.
  const ActionCard = ({
    icon: Icon,
    title,
    desc,
    onAction,
  }: {
    icon: LucideIcon;
    title: string;
    desc: string;
    onAction: () => void;
  }) => (
    <div className="flex items-center gap-4 border border-border-subtle bg-card p-4 hover:border-primary/30 transition-colors">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-body font-semibold text-foreground">{title}</p>
        <p className="text-caption text-muted-foreground leading-relaxed mt-0.5">{desc}</p>
      </div>
      <Button
        variant="outline"
        onClick={onAction}
        style={{ borderRadius: 0 }}
        className="shrink-0 text-meta h-8"
      >
        {t("settings.maintenance.run")}
      </Button>
    </div>
  );

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Library/Dashboard/Project 와 완전히 동일한 3-zone 구조 + 좌표계. */}
      <nav className="app-topbar relative">
        {/* Top-center 토스트가 네비바 위에 떠 있을 때 Electron drag region 흡수를
            막는 carve-out. 자세한 설명은 컴포넌트 파일 헤더 주석 참고. */}
        <TopbarToastCarveOut />
        <button
          onClick={() => navigate(backPath)}
          className="flex items-center pl-[27px] pr-8 min-w-[260px] hover:opacity-80 transition-opacity flex-shrink-0"
        >
          <BrandLogo variant={backPath === "/library" ? "library" : "project"} />
        </button>
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="text-body font-semibold tracking-wide text-foreground">
            {t("settings.title")}
          </span>
        </div>
        <div className="flex items-baseline gap-3 min-w-0 flex-1 px-8" />
        <div className="flex items-center gap-2 pr-2">
          <Button
            variant="outline"
            onClick={() => navigate(backPath)}
            className="h-9 text-meta font-bold tracking-wider bg-transparent border-border-subtle text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-transparent gap-1.5 rounded-none"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {backLabel}
          </Button>
          {/* "Save API Keys" 는 API Keys 카테고리에서만 노출. 다른 카테고리
              의 설정은 변경 즉시 자동 저장되므로 별도 저장 버튼이 필요 없고,
              항상 보이는 버튼은 "이 페이지의 모든 설정을 저장하는 것" 처럼
              읽히는 옛 혼동을 다시 만든다. 노출 카테고리를 좁혀 라벨 그대로
              동작이 진실한 1:1 매핑이 되게 한다. */}
          {category === "keys" && (
            <Button
              onClick={handleSave}
              disabled={loading}
              className="h-9 min-w-[148px] text-meta font-bold tracking-wider rounded-none border-0 gap-1.5 bg-primary hover:bg-primary/85"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : saved ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  {t("common.saved")}
                </>
              ) : (
                <>
                  <Key className="w-3.5 h-3.5" />
                  {t("settings.saveApiKeys")}
                </>
              )}
            </Button>
          )}
        </div>
        <WindowControls />
      </nav>

      {/* ── 본문: 좌측 카테고리 레일 + 우측 패널 ────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 좌측 레일 — 라이브러리/대시보드 사이드바와 동일한 220px 폭/시각 톤. */}
        <aside className="w-[220px] flex-shrink-0 border-r border-border-subtle bg-surface-sidebar overflow-y-auto py-4 px-2">
          <div className="space-y-0.5">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  className={navItemCls(isActive)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">{t(cat.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* 우측 패널 영역 — 카테고리 한 개를 한 화면에 표시. */}
        <main className="flex-1 overflow-y-auto py-8 px-8 flex justify-center">
          <div className={mainColCls}>
            {/* ── API Keys 패널 ─────────────────────────────────── */}
            {category === "keys" && (
              <>
                {renderPanelHeader(Key, "settings.nav.apiKeys", "settings.apiKeysCardDesc")}
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    {fields.map((f) => {
                      const value = settings[f.key];
                      const warning = keyWarning(f.key, value);
                      const status = apiKeyStatusOf(f.key, value);
                      return (
                        <div key={f.key} className={rowCls}>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Label className={fieldLabelCls}>{f.label}</Label>
                              {f.required && (
                                <span className="inline-flex items-center bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                                  {t("settings.required")}
                                </span>
                              )}
                            </div>
                            <StatusChip status={status} />
                          </div>
                          <p className={fieldDescCls}>{f.desc}</p>
                          {f.multiline ? (
                            <Textarea
                              className={`${inputCls} min-h-[80px] resize-y ${warning ? "border-warning" : ""}`}
                              value={value}
                              onChange={(e) =>
                                setSettings((p) => ({ ...p, [f.key]: e.target.value }))
                              }
                              placeholder={f.placeholder}
                            />
                          ) : (
                            <div className="relative">
                              <Input
                                type={showKeys[f.key] ? "text" : "password"}
                                className={`${inputCls} pr-9 ${warning ? "border-warning" : ""}`}
                                value={value}
                                onChange={(e) =>
                                  setSettings((p) => ({ ...p, [f.key]: e.target.value }))
                                }
                                placeholder={f.placeholder}
                              />
                              <button
                                type="button"
                                onClick={() => toggle(f.key)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                              >
                                {showKeys[f.key] ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          )}
                          {warning && (
                            <p className="text-caption text-warning">{warning}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* ── Models 패널 ───────────────────────────────────── */}
            {category === "models" && (
              <>
                {renderPanelHeader(Cpu, "settings.nav.models", "settings.modelsCardDesc")}
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.briefModel")}</Label>
                      <p className={fieldDescCls}>{t("settings.briefModelDesc")}</p>
                      <ModelPicker stage="brief" variant="full" />
                    </div>
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.agentModel")}</Label>
                      <p className={fieldDescCls}>{t("settings.agentModelDesc")}</p>
                      <ModelPicker stage="agent" variant="full" />
                    </div>
                  </div>
                </div>

                {/* ── 기능별 이미지 생성 기본값 ── */}
                <div className="flex items-center gap-3">
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-caption font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {t("settings.imgGen.section")}
                  </span>
                  <div className="flex-1 h-px bg-border-subtle" />
                </div>
                <p className={cn(fieldDescCls, "-mt-1")}>{t("settings.imgGen.sectionDesc")}</p>
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    {IMAGE_GEN_FEATURES.map((spec) => {
                      const cur = imgGenPrefs[spec.feature];
                      const qualityApplies = modelIsGpt(spec.feature, cur.model);
                      return (
                        <div key={spec.feature} className={rowCls}>
                          <Label className={fieldLabelCls}>{t(spec.labelKey)}</Label>
                          <p className={fieldDescCls}>{t(spec.descKey)}</p>
                          <div className="flex items-center gap-2">
                            <Select
                              value={cur.model}
                              onValueChange={(v) => handleImgGenModelChange(spec.feature, v)}
                            >
                              <SelectTrigger className={`${inputCls} flex-1`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                                {spec.models.map((m) => (
                                  <SelectItem key={m.id} value={m.id} className="text-meta">
                                    {IMAGE_GEN_MODEL_LABELS[m.id] ?? m.id}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select
                              value={cur.quality}
                              onValueChange={(v) =>
                                handleImgGenQualityChange(spec.feature, v as GptQuality)
                              }
                              disabled={!qualityApplies}
                            >
                              <SelectTrigger
                                className={`${inputCls} w-[150px] ${qualityApplies ? "" : "opacity-40"}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                                {GPT_QUALITIES.map((q) => (
                                  <SelectItem key={q} value={q} className="text-meta">
                                    {t(`settings.gptQuality.${q}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {!qualityApplies && (
                            <p className="text-2xs text-muted-foreground/70">
                              {t("settings.imgGen.qualityNa")}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* ── 언어 패널 — "전체 언어(UI)" + "AI 언어" 두 하위 섹션으로 통합 ── */}
            {category === "language" && (
              <>
                {renderPanelHeader(Languages, "settings.nav.language", "settings.languageCardDesc")}

                {/* 하위 섹션 1 — 전체 언어(앱 UI 표기 언어) */}
                <div className="flex items-center gap-3">
                  <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-caption font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {t("settings.langSection.ui")}
                  </span>
                  <div className="flex-1 h-px bg-border-subtle" />
                </div>
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.uiLanguage")}</Label>
                      <p className={fieldDescCls}>{t("settings.uiLanguageDesc")}</p>
                      <Select
                        value={language}
                        onValueChange={(value) => handleUiLanguageChange(value as UiLanguage)}
                      >
                        <SelectTrigger className={`${inputCls} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                          <SelectItem value="ko" className="text-meta">{t("settings.korean")}</SelectItem>
                          <SelectItem value="en" className="text-meta">{t("settings.english")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* 하위 섹션 2 — AI 언어(AI 결과 표시 / 태그 머지 언어) */}
                <div className="flex items-center gap-3 pt-2">
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-caption font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {t("settings.langSection.ai")}
                  </span>
                  <div className="flex-1 h-px bg-border-subtle" />
                </div>
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    {/* AI 결과 표시 언어 — 라이브러리 인스펙터의 AI 탭에서 칩/본문이
                        어떤 언어로 나오는지. 분석은 항상 두 언어를 함께 저장하므로
                        이 값은 LLM 재호출 없이 즉시 토글된다. Auto 는 UI 언어 따라가기. */}
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.aiOutputLanguage")}</Label>
                      <p className={fieldDescCls}>{t("settings.aiOutputLanguageDesc")}</p>
                      <Select value={aiOutputLang} onValueChange={handleAiOutputLangChange}>
                        <SelectTrigger className={`${inputCls} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                          <SelectItem value="auto" className="text-meta">{t("settings.aiLang.auto")}</SelectItem>
                          <SelectItem value="en" className="text-meta">{t("settings.aiLang.en")}</SelectItem>
                          <SelectItem value="ko" className="text-meta">{t("settings.aiLang.ko")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* AI 태그 머지 언어 — Accept 버튼이 item.tags 에 머지할 언어를
                        결정. "Follow display" 는 위의 Display 와 함께 움직이고,
                        Auto/EN/KO 는 Display 와 무관하게 독립으로 고정한다.
                        ai_suggestions 자체에는 양 언어 모두 보존되므로 검색
                        haystack 은 항상 양방향. */}
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.aiTagLanguage")}</Label>
                      <p className={fieldDescCls}>{t("settings.aiTagLanguageDesc")}</p>
                      <Select value={aiTagLang} onValueChange={handleAiTagLangChange}>
                        <SelectTrigger className={`${inputCls} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                          <SelectItem value="follow" className="text-meta">{t("settings.aiLang.follow")}</SelectItem>
                          <SelectItem value="auto" className="text-meta">{t("settings.aiLang.auto")}</SelectItem>
                          <SelectItem value="en" className="text-meta">{t("settings.aiLang.en")}</SelectItem>
                          <SelectItem value="ko" className="text-meta">{t("settings.aiLang.ko")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ── Display & UI 패널 ─────────────────────────────── */}
            {category === "displayUi" && (
              <>
                {renderPanelHeader(Monitor, "settings.nav.displayUi", "settings.displayUiCardDesc")}
                <div className={cardCls}>
                  <div className="divide-y divide-border-subtle">
                    <div className={rowCls}>
                      <Label className={fieldLabelCls}>{t("settings.dashboardCardsPerRow")}</Label>
                      <p className={fieldDescCls}>{t("settings.dashboardCardsPerRowDesc")}</p>
                      <Select
                        value={String(dashboardCardsPerRow)}
                        onValueChange={handleDashboardCardsPerRowChange}
                      >
                        <SelectTrigger className={`${inputCls} w-full`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border-subtle text-foreground/80 rounded-none">
                          {DASHBOARD_CARDS_PER_ROW_OPTIONS.map((value) => (
                            <SelectItem key={value} value={String(value)} className="text-meta">
                              {t("settings.dashboardCardsPerRowOption", { count: String(value) })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* GIF/WebP 썸네일 자동 재생 여부 토글. */}
                    <div className={rowCls}>
                      <Label
                        htmlFor="animatedThumbnailsAutoplay"
                        className={`${fieldLabelCls} cursor-pointer`}
                      >
                        {t("settings.animatedThumbnailsAutoplay")}
                      </Label>
                      <p className={fieldDescCls}>{t("settings.animatedThumbnailsAutoplayDesc")}</p>
                      <div className="flex items-center gap-2 pt-1">
                        <Checkbox
                          id="animatedThumbnailsAutoplay"
                          checked={animatedThumbnailsAutoplay}
                          onCheckedChange={(checked) =>
                            handleAnimatedThumbnailsAutoplayChange(checked === true)
                          }
                        />
                        <Label
                          htmlFor="animatedThumbnailsAutoplay"
                          className="text-meta text-foreground/80 cursor-pointer select-none"
                        >
                          {animatedThumbnailsAutoplay ? t("common.on") : t("common.off")}
                        </Label>
                      </div>
                    </div>

                    {/* Default 워크스페이스 숨김 토글. */}
                    <div className={rowCls}>
                      <Label
                        htmlFor="hideDefaultWorkspaces"
                        className={`${fieldLabelCls} cursor-pointer`}
                      >
                        {t("settings.hideDefaultWorkspaces")}
                      </Label>
                      <p className={fieldDescCls}>{t("settings.hideDefaultWorkspacesDesc")}</p>
                      <div className="flex items-center gap-2 pt-1">
                        <Checkbox
                          id="hideDefaultWorkspaces"
                          checked={hideDefaultWorkspaces}
                          onCheckedChange={(checked) =>
                            handleHideDefaultWorkspacesChange(checked === true)
                          }
                        />
                        <Label
                          htmlFor="hideDefaultWorkspaces"
                          className="text-meta text-foreground/80 cursor-pointer select-none"
                        >
                          {hideDefaultWorkspaces ? t("common.on") : t("common.off")}
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Maintenance sub-section ─────────────────────────
                    1회성 라이브러리 정리 작업. 일반 setting 행과 명확히
                    구분되도록:
                      - 별도 헤더 (작은 uppercase 라벨 + 아이콘 + 라인)
                      - 액션 카드는 darker bg-card + outline 실행 버튼
                      - 카드 hover 시 primary tint 로 "클릭 가능한 작업" 강조
                    "이건 설정이 아니라 실행" 임이 시각적으로 한눈에 읽힌다. */}
                <div className="flex items-center gap-3 pt-2">
                  <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-caption font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {t("settings.maintenance.title")}
                  </span>
                  <div className="flex-1 h-px bg-border-subtle" />
                </div>
                <p className={cn(fieldDescCls, "-mt-3")}>{t("settings.maintenance.desc")}</p>

                <div className="space-y-3">
                  <ActionCard
                    icon={Sparkles}
                    title={t("library.aiCleanup.entry")}
                    desc={t("library.aiCleanup.entryDescription")}
                    onAction={() => setAiCleanupOpen(true)}
                  />
                  <ActionCard
                    icon={Zap}
                    title={t("library.thumbBackfill.entry")}
                    desc={t("library.thumbBackfill.entryDescription")}
                    onAction={() => setThumbBackfillOpen(true)}
                  />
                  <ActionCard
                    icon={Languages}
                    title={t("library.koreanAlias.entry")}
                    desc={t("library.koreanAlias.entryDescription")}
                    onAction={() => setKoreanAliasOpen(true)}
                  />
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      <LibraryAiCleanupDialog open={aiCleanupOpen} onOpenChange={setAiCleanupOpen} />
      <OptimizeThumbnailsDialog open={thumbBackfillOpen} onOpenChange={setThumbBackfillOpen} />
      <KoreanAliasExpandDialog open={koreanAliasOpen} onOpenChange={setKoreanAliasOpen} />
    </div>
  );
};

export default SettingsPage;
