import { FileText, MessageSquare, Layers, Clapperboard, Check } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";

export type TabId = "brief" | "agent" | "assets" | "storyboard";

/** 각 탭의 완료 여부. DB 기반 판정.
 *  - brief   : briefs.analysis 에 값이 있으면 true
 *  - assets  : assets 행이 1개 이상이면 true
 *  - agent   : scenes 행이 1개 이상이면 true (Ideation 탭)
 *  - conti   : scenes.conti_image_url 이 하나라도 있으면 true (Conti 탭) */
export interface TabCompletion {
  brief: boolean;
  assets: boolean;
  agent: boolean;
  storyboard: boolean;
}

type NodeStatus = "completed" | "active" | "skipped" | "upcoming";
type SegmentKind = "done" | "broken" | "future";

/** 사이드바에 뜨는 순서. ProjectPage 의 탭 구성과 일치시킨다. */
const tabs: { id: TabId; icon: typeof FileText; labelKey: string }[] = [
  { id: "brief", icon: FileText, labelKey: "tabs.brief" },
  { id: "assets", icon: Layers, labelKey: "tabs.assets" },
  { id: "agent", icon: MessageSquare, labelKey: "tabs.agent" },
  { id: "storyboard", icon: Clapperboard, labelKey: "tabs.conti" },
];

/* ── 디자인 상수 (v2 "트랙 분리형" 스펙) ── */
const TAB_HEIGHT = 64;
const TRACK_WIDTH = 20;
const NODE_SIZE = 14;
// 한 탭당 64px 에서 노드는 14px, 노드 중심이 y=32. 노드 top = 25.
const NODE_TOP = (TAB_HEIGHT - NODE_SIZE) / 2; // 25
// 세그먼트는 노드 바깥부터 다음 노드 바깥 직전까지 채움.
// 한 gap = 64 - 14 = 50px
const SEG_TOP_BASE = NODE_TOP + NODE_SIZE; // 39
const SEG_HEIGHT = TAB_HEIGHT - NODE_SIZE; // 50

const COLOR = {
  kr: "hsl(var(--primary))",
  krBg: "hsl(var(--primary) / 0.10)",
  green: "hsl(var(--success))",
  grayLine: "hsl(var(--border-subtle))",
  grayLine2: "hsl(var(--foreground) / 0.18)",
  textDim: "hsl(var(--foreground) / 0.32)",
  textDim2: "hsl(var(--foreground) / 0.55)",
  sidebarBg: "hsl(var(--surface-sidebar))",
};

/** 노드/세그먼트 상태 계산.
 *  - activeTab 은 항상 'active'
 *  - completion 에서 true 인 탭은 'completed'
 *  - 나머지 중 active 보다 앞 인덱스면 'skipped', 뒤면 'upcoming' */
function computeStatuses(activeTab: TabId, completion: TabCompletion): NodeStatus[] {
  const activeIdx = tabs.findIndex((t) => t.id === activeTab);
  return tabs.map((t, idx) => {
    if (t.id === activeTab) return "active";
    if (completion[t.id]) return "completed";
    return idx < activeIdx ? "skipped" : "upcoming";
  });
}

/** 세그먼트 종류 결정. i-1 → i 구간의 종류는 i-1 탭의 상태에 따름.
 *  - completed                     → done   (초록 실선)
 *  - active 이지만 실제 DB 완료    → done   (이미 완료된 탭으로 되돌아가 있는 경우)
 *  - skipped                       → broken (회색 점선)
 *  - 그 외                         → future (희미한 실선) */
function segmentKindFrom(prevStatus: NodeStatus, prevCompleted: boolean): SegmentKind {
  if (prevStatus === "completed") return "done";
  if (prevStatus === "active" && prevCompleted) return "done";
  if (prevStatus === "skipped") return "broken";
  return "future";
}

function segmentStyle(kind: SegmentKind): React.CSSProperties {
  if (kind === "done") return { background: COLOR.green, opacity: 0.85 };
  if (kind === "broken")
    return {
      background: `repeating-linear-gradient(to bottom, ${COLOR.grayLine2} 0px, ${COLOR.grayLine2} 3px, transparent 3px, transparent 6px)`,
    };
  return { background: COLOR.grayLine };
}

function nodeStyle(status: NodeStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
  };
  if (status === "completed") {
    return { ...base, background: COLOR.green, border: `1.5px solid ${COLOR.green}` };
  }
  if (status === "active") {
    return {
      ...base,
      background: COLOR.kr,
      border: `1.5px solid ${COLOR.kr}`,
      animation: "preflow-stepper-pulse 2.4s ease-in-out infinite",
    };
  }
  if (status === "skipped") {
    return { ...base, background: "transparent", border: `1.5px dashed ${COLOR.grayLine2}` };
  }
  // upcoming
  return { ...base, background: COLOR.sidebarBg, border: `1.5px solid ${COLOR.grayLine2}` };
}

interface Props {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  /** 각 탭 완료 여부. 미지정 시 모두 false 로 간주 (upcoming 처리). */
  completion?: TabCompletion;
}

const DEFAULT_COMPLETION: TabCompletion = {
  brief: false,
  assets: false,
  agent: false,
  storyboard: false,
};

export const ProjectSidebar = ({ activeTab, onTabChange, completion = DEFAULT_COMPLETION }: Props) => {
  const isMobile = useIsMobile();
  const t = useT();

  if (isMobile) {
    return (
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 h-12 border-t border-border-subtle bg-surface-sidebar flex items-center justify-around"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex flex-col items-center justify-center w-14 h-12 transition-colors duration-100",
                isActive ? "text-primary" : "text-muted-foreground active:text-foreground",
              )}
            >
              <tab.icon className="w-4 h-4" />
              <span className="text-nano mt-0.5 font-bold tracking-wider">{t(tab.labelKey)}</span>
            </button>
          );
        })}
        {/* Workspace switcher (icon variant) so users can hop to the
            Library from the mobile project view without relying on
            the legacy floating button. Sits at the right edge of the
            existing justify-around row; a thin divider separates it
            visually from the project step nav so the two affordances
            don't read as the same kind of control. */}
        <span aria-hidden className="h-6 w-px bg-border-subtle/70 mx-1" />
        <WorkspaceSwitcher variant="icon" />
      </nav>
    );
  }

  const statuses = computeStatuses(activeTab, completion);
  const totalHeight = tabs.length * TAB_HEIGHT;

  return (
    <aside
      className="flex flex-col items-center shrink-0 border-r border-border-subtle bg-surface-sidebar"
      style={{
        width: 100,
      }}
    >
      {/* 펄스 keyframes — 전역 CSS 대신 컴포넌트 로컬 스타일로 선언. */}
      <style>{`
        @keyframes preflow-stepper-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 0 hsl(var(--primary) / 0.55),
              0 0 0 0 hsl(var(--primary) / 0.15);
          }
          50% {
            box-shadow:
              0 0 0 3px hsl(var(--primary) / 0.35),
              0 0 0 7px hsl(var(--primary) / 0.08);
          }
        }
      `}</style>

      <div className="flex-1 flex items-center min-h-0">
        {/* 트랙을 화면 끝에서 살짝 띄우기 위해 왼쪽 여백. */}
        <div className="flex" style={{ height: totalHeight, paddingLeft: 16 }}>
          {/* ── 좌측 스테퍼 트랙 ── */}
          <div className="relative" style={{ width: TRACK_WIDTH }}>
            {/* 세그먼트 (노드 사이 gap 에만) */}
            {statuses.slice(0, -1).map((prev, i) => {
              const prevTabId = tabs[i].id;
              const prevCompleted = !!completion[prevTabId];
              return (
                <div
                  key={`seg-${i}`}
                  className="absolute"
                  style={{
                    left: "50%",
                    transform: "translateX(-50%)",
                    top: SEG_TOP_BASE + i * TAB_HEIGHT,
                    height: SEG_HEIGHT,
                    width: 2,
                    zIndex: 1,
                    ...segmentStyle(segmentKindFrom(prev, prevCompleted)),
                  }}
                />
              );
            })}

            {/* 노드 */}
            {statuses.map((status, i) => (
              <div
                key={`node-${i}`}
                className="absolute"
                style={{
                  left: "50%",
                  transform: "translateX(-50%)",
                  top: NODE_TOP + i * TAB_HEIGHT,
                  zIndex: 2,
                  ...nodeStyle(status),
                }}
                aria-hidden
              >
                {status === "completed" && (
                  <Check className="w-2 h-2 text-white" strokeWidth={3.5} />
                )}
              </div>
            ))}
          </div>

          {/* ── 탭 컬럼 ──
               컴팩트 워크스페이스 스위처는 stepper 영역 바깥(아래) 에서 footer 슬롯으로
               렌더한다 — stepper 의 vertical-center 정렬을 그대로 유지하면서 하단에 고정. */}
          <div className="flex flex-col">
            {tabs.map((tab, i) => {
              const status = statuses[i];
              const isActive = status === "active";
              const isSkipped = status === "skipped";
              const isCompleted = status === "completed";

              // 상태별 색상 — HTML 시안과 맞춤.
              //   active    : kr (빨강)
              //   completed : textDim2 (조금 밝은 회색)
              //   skipped   : textDim + opacity 0.6
              //   upcoming  : textDim
              let color: string = COLOR.textDim;
              let opacity = 1;
              if (isActive) color = COLOR.kr;
              else if (isCompleted) color = COLOR.textDim2;
              else if (isSkipped) {
                color = COLOR.textDim;
                opacity = 0.6;
              }

              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  title={t(tab.labelKey)}
                  className={cn(
                    "group relative flex flex-col items-center justify-center transition-colors duration-150",
                    "hover:bg-surface-panel",
                  )}
                  style={{
                    width: 64,
                    height: TAB_HEIGHT,
                    borderRadius: 0,
                    background: isActive ? COLOR.krBg : "transparent",
                    color,
                    opacity,
                  }}
                >
                  <tab.icon
                    className="w-[22px] h-[22px]"
                    style={{ color: "currentColor" }}
                  />
                  <span
                    className="text-caption font-medium tracking-tight mt-[5px] leading-none"
                    style={{ color: "currentColor" }}
                  >
                    {t(tab.labelKey)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 워크스페이스 스위처 footer (컴팩트) ──
          stepper 컬럼이 vertical-center 정렬이라 그 바깥(`<aside>` 의 마지막
          flex-shrink-0 자식) 에 붙여야 항상 화면 하단에 고정된다. 100px 너비
          rail 에 맞춘 compact variant 라 box 가 안 잘린다. */}
      <div className="w-full flex-shrink-0">
        <WorkspaceSwitcher variant="compact" />
      </div>
    </aside>
  );
};
