import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles, Snowflake, Wand2 } from "lucide-react";
import { scoreABCD, gradeABCD } from "@/lib/abcdScorer";
import type { ABCDCompliance, ABCDScore, Analysis, Scene } from "./agentTypes";

type Lang = "ko" | "en";

const L: Record<string, { ko: string; en: string }> = {
  title: { ko: "ABCD 실시간 점수", en: "ABCD Live Score" },
  subtitle_empty: { ko: "컷을 추가하면 실시간 채점됩니다", en: "Add shots to start live scoring" },
  subtitle_scenes: { ko: "컷/드래프트 {n}개 반영 · Agent 스토리보드 기준", en: "{n} shots/drafts · Agent storyboard-based" },
  subtitle_frozen_scenes: {
    ko: "컷이 비어 채점 중단 — 마지막 점수 유지",
    en: "No shots — last score frozen",
  },
  attract: { ko: "Attract · 첫 3초 몰입도", en: "Attract · First 3s Hook" },
  brand: { ko: "Brand · 브랜드·제품 노출", en: "Brand · Brand/Product Exposure" },
  connect: { ko: "Connect · 감정 연결", en: "Connect · Emotional Link" },
  direct: { ko: "Direct · CTA 명확성", en: "Direct · CTA Clarity" },
  continuity: { ko: "Continuity · 컷 연속성", en: "Continuity · Shot Flow" },
  continuity_aux_label: { ko: "보조 지표 · 총점 미포함", en: "Auxiliary · not in total" },
  continuity_aux_hint: {
    ko: "연속성은 ABCD 총점에 포함되지 않는 독립 보조 신호입니다",
    en: "Continuity is an auxiliary signal — not part of the ABCD total",
  },
  grade_excellent: { ko: "탁월", en: "Excellent" },
  grade_good: { ko: "양호", en: "Good" },
  grade_needs_work: { ko: "보완 필요", en: "Needs Work" },
  grade_revise: { ko: "전면 재검토", en: "Revise" },
  frozen_pill: { ko: "Paused", en: "Paused" },
  fix_continuity: { ko: "연속성 보정", en: "Fix continuity" },
  fix_continuity_hint: {
    ko: "감지된 연속성 문제를 정리해 에이전트에게 전체 컷 재정렬을 요청합니다",
    en: "Sends the detected continuity issues to the agent to re-align all cuts",
  },
};
const t = (k: string, lang: Lang) => L[k]?.[lang] ?? k;

const GRADE_LABEL: Record<string, { ko: string; en: string }> = {
  탁월: L.grade_excellent,
  양호: L.grade_good,
  "보완 필요": L.grade_needs_work,
  "전면 재검토": L.grade_revise,
};
const gradeLabel = (g: string, lang: Lang) => GRADE_LABEL[g]?.[lang] ?? g;

/**
 * 프로젝트 톤에 맞춘 3단계 컬러 시스템
 *   green  — 양호 이상 (>=7 개별축 / >=28 총점)
 *   amber  — 보완 필요 (4~6 / 20~27)
 *   red    — 심각 (<4 / <20)
 */
const COLORS = {
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  muted: "hsl(var(--muted-foreground))",
  frozen: "#6b7280",
  frozenTrack: "#6b728033",
} as const;

const barColor = (score: number) =>
  score >= 7 ? COLORS.green : score >= 4 ? COLORS.amber : COLORS.red;

/** gradeABCD 의 "lime" 을 프로젝트 팔레트(green) 로 매핑 */
const totalColor = (gradeColor: "red" | "amber" | "lime" | "green") =>
  gradeColor === "red" ? COLORS.red : gradeColor === "amber" ? COLORS.amber : COLORS.green;

/**
 * 프로젝트별로 마지막 '씬 기반' ABCD 점수를 기억한다.
 * 씬이 모두 제거/콘티 전송되어 `scoreABCD` 가 null 을 반환하면
 * 캐시된 점수를 회색으로 표시한다. 씬이 다시 채워지면 덮어씌운다.
 */
const _lastSceneAbcdByProject = new Map<string, ABCDCompliance>();

/** continuity 점수가 이 값 미만일 때 "연속성 보정" 버튼을 노출 (green 임계 = 7) */
const CONTINUITY_FIX_THRESHOLD = 7;

interface Props {
  projectId: string;
  scenes: Scene[];
  briefAnalysis: Analysis | null;
  lang?: Lang;
  /** controlled open state (optional) */
  defaultOpen?: boolean;
  /** 연속성 보정 요청 — 약한 점수일 때 버튼으로 노출. notes 를 그대로 넘긴다. */
  onFixContinuity?: (continuity: ABCDScore) => void;
  /** 생성 중이면 버튼 비활성화 */
  busy?: boolean;
}

export default function AgentAbcdPanel({
  projectId,
  scenes,
  briefAnalysis,
  lang = "en",
  defaultOpen = false,
  onFixContinuity,
  busy = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  // 씬 모드 호출 — scenes === [] 이어도 호출 (null 반환받아 동결 처리)
  const sceneBased = useMemo(() => {
    if (!briefAnalysis) return null;
    const vd =
      typeof briefAnalysis.visual_direction === "object" ? briefAnalysis.visual_direction : undefined;
    return scoreABCD({
      hook_strategy: briefAnalysis.hook_strategy,
      hero_visual: briefAnalysis.hero_visual,
      product_info: briefAnalysis.product_info,
      pacing: briefAnalysis.pacing,
      constraints: briefAnalysis.constraints,
      audience_insight: briefAnalysis.audience_insight,
      visual_direction: vd,
      reference_mood: briefAnalysis.reference_mood,
      scenes: scenes.map((s) => ({
        scene_number: s.scene_number,
        sequence: s.sequence,
        title: s.title,
        description: s.description,
        camera_angle: s.camera_angle,
        location: s.location,
        tagged_assets: s.tagged_assets,
        duration_sec: s.duration_sec,
      })),
      total_scene_count: scenes.length,
    });
  }, [scenes, briefAnalysis]);

  // 씬 기반 점수가 나올 때마다 프로젝트별 캐시에 저장
  useEffect(() => {
    if (sceneBased && projectId) {
      _lastSceneAbcdByProject.set(projectId, sceneBased);
    }
  }, [sceneBased, projectId]);

  if (!briefAnalysis) return null;

  // 표시 모드 결정
  // - sceneBased != null              → 씬 채점 중 (live)
  // - sceneBased == null && 캐시 있음 → 동결 (frozen, 회색) — 한번은 씬이 있었던 상태
  // - sceneBased == null && 캐시 없음 → pristine (0점/회색) — 씬을 만들기 전 초기 상태
  //
  // 이전에는 pristine 상태에서 브리프 체크리스트로 폴백하며 점수를 띄웠지만,
  // "씬 0개 = 점수 0 / 회색" 이라는 UX 규칙에 맞춰 pristine 은 완전 0점으로 표시한다.
  const cached = _lastSceneAbcdByProject.get(projectId) ?? null;
  const isPristine = !sceneBased && !cached;
  const isFrozen = !sceneBased && !!cached;

  const zeroScore: ABCDCompliance = {
    attract: { score: 0, notes: "" },
    brand: { score: 0, notes: "" },
    connect: { score: 0, notes: "" },
    direct: { score: 0, notes: "" },
    total: 0,
  };

  const display: ABCDCompliance = sceneBased ?? cached ?? zeroScore;

  const total = display.total ?? 0;
  const gradeInfo = gradeABCD(total);
  const gradeCol = (isFrozen || isPristine) ? COLORS.frozen : totalColor(gradeInfo.color);

  const activeBarColor = (s: number) => ((isFrozen || isPristine) ? COLORS.frozen : barColor(s));

  const rows: Array<{ key: "attract" | "brand" | "connect" | "direct"; letter: string; label: string }> = [
    { key: "attract", letter: "A", label: t("attract", lang) },
    { key: "brand", letter: "B", label: t("brand", lang) },
    { key: "connect", letter: "C", label: t("connect", lang) },
    { key: "direct", letter: "D", label: t("direct", lang) },
  ];

  const subtitle = isFrozen
    ? t("subtitle_frozen_scenes", lang)
    : isPristine
      ? t("subtitle_empty", lang)
      : t("subtitle_scenes", lang).replace("{n}", String(scenes.length));

  return (
    <div
      style={{
        borderRadius: 0,
        border: "0.5px solid hsl(var(--border))",
        background: "hsl(var(--muted)/0.2)",
        overflow: "hidden",
        opacity: (isFrozen || isPristine) ? 0.85 : 1,
      }}
    >
      {/* ── compact header (always visible) ─────────────────── */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {(isFrozen || isPristine) ? (
          <Snowflake style={{ width: 13, height: 13, color: COLORS.frozen }} />
        ) : (
          <Sparkles style={{ width: 13, height: 13, color: COLORS.muted }} />
        )}
        <span
          className="font-mono"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: (isFrozen || isPristine) ? COLORS.frozen : "hsl(var(--muted-foreground))",
            textTransform: "uppercase",
          }}
        >
          {t("title", lang)}
        </span>
        {isFrozen && (
          <span
            className="font-mono"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              color: COLORS.frozen,
              padding: "1px 6px",
              borderRadius: 0,
              background: `${COLORS.frozen}1f`,
              border: `1px solid ${COLORS.frozen}55`,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              lineHeight: 1,
            }}
          >
            {t("frozen_pill", lang)}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 6 }}>
          {rows.map(({ key, letter }) => {
            const s = display[key].score;
            const col = activeBarColor(s);
            return (
              <span
                key={key}
                className="font-mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 7px",
                  borderRadius: 0,
                  background: `${col}1f`,
                  border: `1px solid ${col}55`,
                  lineHeight: 1,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    color: col,
                    letterSpacing: "0.04em",
                  }}
                >
                  {letter}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: col,
                    letterSpacing: "0",
                  }}
                >
                  {s}
                </span>
              </span>
            );
          })}
          {display.continuity && (() => {
            const s = display.continuity.score;
            const col = activeBarColor(s);
            return (
              <>
                {/* ABCD(채점 대상) 와 연속성(보조 신호) 을 시각적으로 분리하는 구분선 */}
                <span
                  aria-hidden
                  style={{
                    width: 1,
                    height: 16,
                    background: "hsl(var(--border))",
                    margin: "0 3px",
                  }}
                />
                <span
                  className="font-mono"
                  title={t("continuity_aux_hint", lang)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "2px 7px",
                    borderRadius: 0,
                    background: `${col}1f`,
                    border: `1px solid ${col}55`,
                    borderStyle: "dashed",
                    lineHeight: 1,
                  }}
                >
                  <span style={{ fontSize: 10, fontWeight: 800, color: col, letterSpacing: "0.04em" }}>
                    {lang === "ko" ? "연속" : "Co"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: col }}>{s}</span>
                </span>
              </>
            );
          })()}
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: gradeCol,
              letterSpacing: "-0.01em",
            }}
          >
            {(total / 4).toFixed(1)}
            <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.muted }}>/10</span>
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: gradeCol,
              padding: "2px 7px",
              borderRadius: 0,
              background: `${gradeCol}1f`,
              border: `1px solid ${gradeCol}55`,
              lineHeight: 1,
            }}
          >
            {gradeLabel(gradeInfo.grade, lang)}
          </span>
          {open ? (
            <ChevronUp style={{ width: 13, height: 13, color: COLORS.muted }} />
          ) : (
            <ChevronDown style={{ width: 13, height: 13, color: COLORS.muted }} />
          )}
        </div>
      </button>

      {/* ── expanded details ─────────────────────────────── */}
      {open && (
        <div
          style={{
            padding: "10px 12px 12px 12px",
            borderTop: "0.5px solid hsl(var(--border))",
            background: "hsl(var(--background))",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: (isFrozen || isPristine) ? COLORS.frozen : "hsl(var(--muted-foreground))",
              marginBottom: 12,
              letterSpacing: "0.02em",
            }}
          >
            {subtitle}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {rows.map(({ key, letter, label }) => {
              const row = display[key];
              const pct = Math.round((row.score / 10) * 100);
              const col = activeBarColor(row.score);
              return (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="font-mono" style={{ fontSize: 13, fontWeight: 800, color: col }}>
                      {letter}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "hsl(var(--muted-foreground))",
                        fontWeight: 600,
                      }}
                    >
                      {label}
                    </span>
                    <span
                      className="font-mono"
                      style={{
                        marginLeft: "auto",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "hsl(var(--muted-foreground))",
                      }}
                    >
                      {row.score}/10
                    </span>
                  </div>
                  <div
                    style={{
                      height: 5,
                      width: "100%",
                      background: (isFrozen || isPristine) ? COLORS.frozenTrack : "hsl(var(--muted)/0.5)",
                      borderRadius: 0,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: col,
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                  {row.notes && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "hsl(var(--muted-foreground))",
                        lineHeight: 1.55,
                      }}
                    >
                      {row.notes}
                    </div>
                  )}
                </div>
              );
            })}
            {display.continuity && (() => {
              const row = display.continuity;
              const pct = Math.round((row.score / 10) * 100);
              const col = activeBarColor(row.score);
              return (
                <>
                {/* ABCD(채점 대상) 와 연속성(보조 신호) 을 구분하는 섹션 캡션 */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                  <div style={{ flex: 1, height: 1, background: "hsl(var(--border))" }} />
                  <span
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "hsl(var(--muted-foreground))",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("continuity_aux_label", lang)}
                  </span>
                  <div style={{ flex: 1, height: 1, background: "hsl(var(--border))" }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="font-mono" style={{ fontSize: 13, fontWeight: 800, color: col }}>
                      {lang === "ko" ? "연속" : "Co"}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "hsl(var(--muted-foreground))",
                        fontWeight: 600,
                      }}
                    >
                      {t("continuity", lang)}
                    </span>
                    <span
                      className="font-mono"
                      style={{
                        marginLeft: "auto",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "hsl(var(--muted-foreground))",
                      }}
                    >
                      {row.score}/10
                    </span>
                  </div>
                  <div
                    style={{
                      height: 5,
                      width: "100%",
                      background: (isFrozen || isPristine) ? COLORS.frozenTrack : "hsl(var(--muted)/0.5)",
                      borderRadius: 0,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: col,
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                  {row.notes && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "hsl(var(--muted-foreground))",
                        lineHeight: 1.55,
                      }}
                    >
                      {row.notes}
                    </div>
                  )}
                  {onFixContinuity && !isFrozen && !isPristine && row.score < CONTINUITY_FIX_THRESHOLD && (
                    <button
                      onClick={() => onFixContinuity(row)}
                      disabled={busy}
                      title={t("fix_continuity_hint", lang)}
                      style={{
                        marginTop: 4,
                        alignSelf: "flex-start",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 10px",
                        borderRadius: 0,
                        background: busy ? `${col}14` : `${col}1f`,
                        border: `1px solid ${col}66`,
                        color: col,
                        cursor: busy ? "not-allowed" : "pointer",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.02em",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      <Wand2 style={{ width: 12, height: 12 }} />
                      {t("fix_continuity", lang)}
                    </button>
                  )}
                </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
