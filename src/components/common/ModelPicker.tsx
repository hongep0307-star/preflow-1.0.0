/**
 * 단계별 모델 선택 picker — Settings(full) 와 BriefTab(compact) 양쪽에서 공유.
 *
 * 스코프:
 *   · `projectId` 미지정 → Settings 경로. localStorage 의 global 디폴트를
 *     read/write.
 *   · `projectId` 지정 → 해당 프로젝트 override 만 read/write. Settings 의
 *     global 디폴트는 건드리지 않으며, override 가 없으면 global 디폴트를
 *     표시한다. (BriefTab 헤더가 이 경로.)
 *
 * settingsCache 를 구독해 API 키/플래그가 변경되면 가용 모델 리스트도 갱신.
 *
 * variant:
 *   - "compact": 짧은 라벨만 (Brief 헤더용, ~140px)
 *   - "full":    Settings 페이지용. 모델 메타 (ctx · vision · video) 라인 동봉.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listModels, getModelMeta, type ModelMeta } from "@/lib/modelCatalog";
import { getModel, setModel, subscribeModel, type ModelStage } from "@/lib/modelPreference";
import {
  ensureSettingsLoaded,
  getSettingsCached,
  subscribeSettings,
} from "@/lib/settingsCache";
import { useT } from "@/lib/uiLanguage";

type Variant = "compact" | "full";

interface Props {
  stage: ModelStage;
  variant?: Variant;
  className?: string;
  /** 지정 시 해당 프로젝트 override 만 read/write. 미지정 시 global 디폴트. */
  projectId?: string;
}

const ModelPicker = ({ stage, variant = "compact", className = "", projectId }: Props) => {
  const t = useT();
  const [selected, setSelected] = useState<string>(() => getModel(stage, projectId));
  const [settingsTick, setSettingsTick] = useState(0);

  // settings 캐시가 비어있으면 한 번 로드. 로드 후 tick 증가시켜 가용성 재계산.
  useEffect(() => {
    let cancelled = false;
    if (!getSettingsCached()) {
      ensureSettingsLoaded().then(() => {
        if (!cancelled) setSettingsTick((t) => t + 1);
      });
    }
    const unsub = subscribeSettings(() => setSettingsTick((t) => t + 1));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // 다른 화면에서 모델이 변경되면 즉시 반영 — projectId 를 넘겨 scope 를
  // 좁힌다. (프로젝트 A 의 override 변경이 프로젝트 B picker 로 새지 않음.)
  // projectId 변경 시 selected 도 재해석해야 하므로 명시적으로 재동기화.
  useEffect(() => {
    setSelected(getModel(stage, projectId));
    return subscribeModel(stage, (id) => setSelected(id), projectId);
  }, [stage, projectId]);

  // settingsTick 은 settings 구독에서 받는 version counter — getSettingsCached()
  // 자체는 인자가 없어 ESLint 가 "unnecessary dependency" 로 본다. 의도적으로
  // tick 이 올라갈 때 캐시를 다시 읽어 settings 변경(다른 화면의 모델 토글 등)
  // 을 즉시 반영하는 패턴이므로 dep 을 *유지* 한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settings = useMemo(() => getSettingsCached(), [settingsTick]);
  const models = useMemo(() => listModels(settings), [settings]);
  const currentMeta: ModelMeta | null = useMemo(
    () => getModelMeta(selected, settings),
    [selected, settings],
  );

  const handlePick = useCallback(
    (id: string) => {
      setModel(stage, id as any, projectId);
      setSelected(id);
    },
    [stage, projectId],
  );

  const isCompact = variant === "compact";

  // 가용 모델이 0개이거나 currentMeta 가 없으면 폴백 라벨
  const buttonLabel = currentMeta?.label ?? t("settings.modelPickerFallback");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={
            isCompact
              ? `inline-flex items-center gap-1.5 h-7 px-2.5 rounded-none border border-white/10 bg-white/[0.04] text-caption text-white/70 hover:text-white hover:border-white/25 transition-colors min-w-0 max-w-full ${className}`
              : `inline-flex items-center justify-between gap-2 h-9 px-3 rounded-none border border-white/15 bg-white/[0.04] text-meta text-white/80 hover:border-white/30 transition-colors w-full ${className}`
          }
        >
          {/* min-w-0 없이는 flex child 가 컨텐츠 최소폭을 auto 로 잡아서
           *  truncate 가 발동하지 않는다. compact variant 는 부모(BriefTab
           *  헤더)가 좁아졌을 때 라벨을 줄여야 LangToggle 이 잘리지 않음. */}
          <span className="truncate min-w-0 flex-1 text-left">{buttonLabel}</span>
          <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-[#161616] border-white/10 text-white/80 min-w-[260px] rounded-none"
      >
        <DropdownMenuLabel className="text-caption font-semibold text-white/50">
          {stage === "brief" ? t("settings.briefModel") : t("settings.agentModel")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-white/10" />
        {models.map((m) => {
          const isSelected = m.id === selected;
          const isDisabled = !m.available;
          return (
            <DropdownMenuItem
              key={m.id}
              disabled={isDisabled}
              onSelect={(e) => {
                if (isDisabled) {
                  e.preventDefault();
                  return;
                }
                handlePick(m.id);
              }}
              className={`flex flex-col items-start gap-0.5 py-2 px-3 cursor-pointer rounded-none ${
                isSelected ? "bg-white/[0.06]" : ""
              } ${isDisabled ? "opacity-40 cursor-not-allowed" : "hover:bg-white/[0.08] focus:bg-white/[0.08]"}`}
              title={m.disabledReason}
            >
              <div className="flex items-center gap-2 w-full">
                <span className={`text-meta ${isSelected ? "text-white" : "text-white/85"}`}>
                  {m.label}
                </span>
                {m.isPreview && (
                  <span className="text-micro px-1 py-[1px] border border-amber-400/30 text-amber-300">
                    {t("settings.modelPreviewBadge")}
                  </span>
                )}
                {isDisabled && <Lock className="w-3 h-3 ml-auto opacity-60" />}
              </div>
              {m.description && (
                <span className="text-caption text-white/45">{m.description}</span>
              )}
              {isDisabled && m.disabledReason && (
                <span className="text-caption text-amber-400/70">{m.disabledReason}</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ModelPicker;
