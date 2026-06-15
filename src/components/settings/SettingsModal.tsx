import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";
import ModelPicker from "@/components/common/ModelPicker";
import { invalidateSettingsCache } from "@/lib/settingsCache";
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
  IMAGE_GEN_MODEL_LABELS,
  GPT_QUALITIES,
  modelIsGpt,
  getImageModelDefault,
  getGptQualityDefault,
  setImageModelDefault,
  setGptQualityDefault,
  orderImageGenFeatures,
  IMAGE_GEN_FEATURES,
  type ImageGenFeature,
  type ImageGenFeatureSpec,
  type GptQuality,
} from "@/lib/imageGenPreference";
import { IMAGE_GEN_FEATURE_ICONS } from "@/components/settings/imageGenIcons";
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
import {
  useSettingsModal,
  type SettingsCategoryId,
} from "@/lib/settingsModal";

const settingsApi = {
  get: async () => {
    const res = await fetch(`${LOCAL_SERVER_BASE_URL}/settings/get`, {
      method: "POST",
      headers: LOCAL_SERVER_AUTH_HEADERS,
    });
    return res.json();
  },
  set: async (s: SettingsState) => {
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

/* ── 좌측 카테고리 정의 ──
 *   1) "API Keys"        — 4 fields (제공사 인증)
 *   2) "Models"          — 모델 picker 2 + 기능별 이미지 생성 디폴트
 *   3) "Language"        — 전체 언어(UI) + AI 언어(출력/태그)
 *   4) "Display & UI"    — dashboard 컬럼 + 토글 2 + Maintenance sub-section
 */
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

/**
 * 설정 모달 — 전역 마운트.
 *
 * Radix Dialog 는 닫힐 때 Content 서브트리를 언마운트하므로, 실제 본문은
 * <SettingsModalBody> 로 분리해 매 오픈마다 새로 마운트되게 한다. 이 덕에
 * settingsApi.get() 의 마운트 이펙트가 오픈마다 다시 돌아 API 키가 최신값으로
 * 로드된다(영구 마운트였다면 stale 됐을 부분).
 */
const SettingsModal = () => {
  const { open, closeSettings } = useSettingsModal();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSettings();
      }}
    >
      <DialogContent
        size="wide"
        aria-describedby={undefined}
        className="flex h-[80vh] max-h-[760px] flex-col gap-0 overflow-hidden p-0"
      >
        <SettingsModalBody />
      </DialogContent>
    </Dialog>
  );
};

const SettingsModalBody = () => {
  const { surface, category, setCategory } = useSettingsModal();
  const { language, setLanguage, t } = useUiLanguage();

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
  /* AI 언어 정책 — 두 축(Display, Tag) 모두 같은 이벤트로 구독한다. */
  const [aiOutputLang, setAiOutputLang] = useState<AiOutputLanguageMode>(getAiOutputLanguageMode);
  const [aiTagLang, setAiTagLang] = useState<AiTagLanguageMode>(getAiTagLanguageMode);

  /* 자동 저장 → 인라인 "Saved" 칩 피드백. API Keys 외의 모든 컨트롤은 변경 즉시
     영구화되며, 그 변경을 패널 헤더 우측에 1.6초 페이드하는 "Saved" 칩으로 명시한다. */
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
    settingsApi.get().then((s: Partial<SettingsState>) => {
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

  /* 기능별 이미지 생성 디폴트 — 변경 즉시 localStorage 에 영속. */
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

  /* API 키 형식 휴리스틱 — keyWarning 과 같은 룰. */
  type ApiKeyStatus = "empty" | "configured" | "mismatch";
  const apiKeyStatusOf = (key: keyof SettingsState, value: string): ApiKeyStatus => {
    const trimmed = value.trim();
    if (!trimmed) return "empty";
    if (trimmed.length < 5) return "configured";
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
  const panelTitleCls = "text-label font-semibold text-foreground";
  const panelDescCls = "text-caption text-muted-foreground leading-relaxed";
  const cardCls = "surface-panel w-full rounded-none p-7";
  const rowCls = "space-y-2 py-5 first:pt-0 last:pb-0";
  const fieldLabelCls = "text-meta font-semibold text-text-secondary";
  const fieldDescCls = "text-caption text-muted-foreground leading-relaxed";

  // 좌측 네비 행 — 라이브러리 사이드바와 같은 시각 톤.
  const navItemCls = (isActive: boolean) =>
    cn(
      "w-full flex items-center gap-2.5 px-3 py-2 text-left text-body border-l-2 transition-colors",
      isActive
        ? "border-l-primary bg-primary/10 text-foreground"
        : "border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
    );

  const mainColCls = "w-full max-w-[640px] space-y-5";

  // API 키 상태 칩.
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

  // Maintenance action 카드.
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

  // ── 기능별 이미지 생성 행 — 라벨 앞에 실제 기능 아이콘을 붙인다. ──
  const renderImgGenRow = (spec: ImageGenFeatureSpec) => {
    const cur = imgGenPrefs[spec.feature];
    const qualityApplies = modelIsGpt(spec.feature, cur.model);
    const Icon = IMAGE_GEN_FEATURE_ICONS[spec.feature];
    return (
      <div key={spec.feature} className={rowCls}>
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <Label className={fieldLabelCls}>{t(spec.labelKey)}</Label>
        </div>
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
            onValueChange={(v) => handleImgGenQualityChange(spec.feature, v as GptQuality)}
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
  };

  // 공간(surface)별 정렬 — related 를 워크플로우 순서로 위에, 나머지는 '기타' 그룹.
  const { related, other } = orderImageGenFeatures(surface);

  return (
    <>
      {/* ── 헤더(타이틀) — Radix a11y 용 DialogTitle 포함 ── */}
      <header className="flex shrink-0 items-center border-b border-border-subtle px-6 py-3.5">
        <DialogTitle className="text-body font-semibold tracking-wide text-foreground">
          {t("settings.title")}
        </DialogTitle>
      </header>

      {/* ── 본문: 좌측 카테고리 레일 + 우측 패널 ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 좌측 레일 */}
        <aside className="w-[220px] flex-shrink-0 overflow-y-auto border-r border-border-subtle bg-surface-sidebar py-4 px-2">
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

        {/* 우측 패널 — 카테고리 한 개를 표시. */}
        <main className="flex flex-1 justify-center overflow-y-auto py-8 px-8">
          <div className={mainColCls}>
            {/* ── API Keys 패널 ── */}
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

            {/* ── Models 패널 ── */}
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

                {/* ── 기능별 이미지 생성 기본값 (공간별 정렬) ── */}
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
                    {related.map(renderImgGenRow)}
                  </div>
                </div>

                {/* 그 공간과 직접 관련 없는 기능은 '기타' 그룹으로 분리. */}
                {other.length > 0 && (
                  <>
                    <div className="flex items-center gap-3 pt-2">
                      <span className="text-caption font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                        {t("settings.imgGen.otherGroup")}
                      </span>
                      <div className="flex-1 h-px bg-border-subtle" />
                    </div>
                    <div className={cardCls}>
                      <div className="divide-y divide-border-subtle">
                        {other.map(renderImgGenRow)}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── 언어 패널 ── */}
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

            {/* ── Display & UI 패널 ── */}
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

                {/* ── Maintenance sub-section ── */}
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

      {/* ── 푸터 — "Save API Keys" 는 API Keys 카테고리에서만. 다른 카테고리의
          설정은 변경 즉시 자동 저장되므로 별도 저장 버튼이 필요 없다. ── */}
      {category === "keys" && (
        <DialogFooter className="shrink-0 border-t border-border-subtle px-6 py-3">
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
        </DialogFooter>
      )}

      <LibraryAiCleanupDialog open={aiCleanupOpen} onOpenChange={setAiCleanupOpen} />
      <OptimizeThumbnailsDialog open={thumbBackfillOpen} onOpenChange={setThumbBackfillOpen} />
      <KoreanAliasExpandDialog open={koreanAliasOpen} onOpenChange={setKoreanAliasOpen} />
    </>
  );
};

export default SettingsModal;
