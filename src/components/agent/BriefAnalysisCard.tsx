import { Sparkles } from "lucide-react";
import { KR } from "./agentTypes";
import { useUiLanguage } from "@/lib/uiLanguage";

const CONTENT_TYPE_META: Record<string, { label: { ko: string; en: string }; color: string }> = {
  product_launch: { label: { ko: "상품 런칭", en: "Product Launch" }, color: "#f59e0b" },
  event: { label: { ko: "이벤트", en: "Event" }, color: "#8b5cf6" },
  update: { label: { ko: "업데이트", en: "Update" }, color: "#06b6d4" },
  community: { label: { ko: "커뮤니티", en: "Community" }, color: "#10b981" },
  brand_film: { label: { ko: "브랜드 필름", en: "Brand Film" }, color: "#f9423a" },
};

const HOOK_LABEL: Record<string, { ko: string; en: string }> = {
  gameplay_first: { ko: "게임플레이 우선", en: "Gameplay First" },
  fail_solve: { ko: "실패 → 해결", en: "Fail → Solve" },
  power_fantasy: { ko: "파워 판타지", en: "Power Fantasy" },
  unboxing_reveal: { ko: "언박싱 공개", en: "Unboxing Reveal" },
  before_after: { ko: "비포 / 애프터", en: "Before / After" },
  mystery_tease: { ko: "미스터리 티징", en: "Mystery Tease" },
  testimonial: { ko: "사용자 증언", en: "Testimonial" },
  pattern_interrupt: { ko: "패턴 인터럽트", en: "Pattern Interrupt" },
};

type FieldKey = "goal" | "target" | "usp" | "tone";

const FIELD_LABEL: Record<FieldKey, { ko: string; en: string }> = {
  goal: { ko: "목표", en: "Goal" },
  target: { ko: "타겟", en: "Target" },
  usp: { ko: "USP", en: "USP" },
  tone: { ko: "톤앤매너", en: "Tone & Manner" },
};

// Aliases that may appear in the seed context (Korean first, then English).
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  goal: ["목표", "Goal"],
  target: ["타겟", "Target"],
  usp: ["USP"],
  tone: ["톤앤매너", "Tone & Manner", "Tone and Manner"],
};

export const BriefAnalysisCard = ({ content }: { content: string }) => {
  const { language } = useUiLanguage();
  const raw = content
    .replace(/^\[브리프 분석 결과\]\s*/i, "")
    .replace(/^\[Brief Analysis\]\s*/i, "");

  const extract = (aliases: string[]): string | null => {
    for (const label of aliases) {
      const esc = label.replace(/([.*+?^=!:${}()|[\]\\])/g, "\\$1");
      const re = new RegExp(`^${esc}:\\s+(.+)$`, "m");
      const m = raw.match(re);
      if (m) return m[1].trim();
    }
    return null;
  };

  const goal = extract(FIELD_ALIASES.goal);
  const target = extract(FIELD_ALIASES.target);
  const usp = extract(FIELD_ALIASES.usp);
  const tone = extract(FIELD_ALIASES.tone);
  const ideaNote = extract(["아이디어 메모", "Idea Memo", "Idea Note"]);
  const directorRec = extract(["디렉터 추천", "Director Recommendation", "Director Rec"]);

  const ctMatch =
    raw.match(/\[콘텐츠 타입\]\s*(\w+)(?:\s*\(신뢰도\s*(\d+)%\))?/) ||
    raw.match(/\[Content Type\]\s*(\w+)(?:\s*\(confidence\s*(\d+)%\))?/i);
  const contentType = ctMatch?.[1];
  const contentTypeConf = ctMatch?.[2];
  const contentTypeMeta = contentType ? CONTENT_TYPE_META[contentType] : null;
  const contentTypeLabel = contentTypeMeta?.label[language] ?? contentType ?? null;
  const contentTypeColor = contentTypeMeta?.color ?? KR;

  const formatMatch =
    raw.match(/-\s*포맷\s+(\S+)\s*·\s*길이\s+(\S+)/) ||
    raw.match(/-\s*Format\s+(\S+)\s*·\s*Duration\s+(\S+)/i);
  const format = formatMatch?.[1];
  const duration = formatMatch?.[2];

  const sceneMatch =
    raw.match(/-\s*브리프 기준 컷\/Shot 수:\s*(\d+)(?:\s*\(범위\s*(\d+)~(\d+)\))?/) ||
    raw.match(/-\s*브리프 기준 컷 수:\s*(\d+)(?:\s*\(범위\s*(\d+)~(\d+)\))?/) ||
    raw.match(/-\s*컷 수:\s*(\d+)(?:\s*\(범위\s*(\d+)~(\d+)\))?/) ||
    raw.match(/-\s*씬 수:\s*(\d+)(?:\s*\(범위\s*(\d+)~(\d+)\))?/) ||
    raw.match(/-\s*(?:Brief\s+)?(?:Shot|Cut)s?:\s*(\d+)(?:\s*\(range\s*(\d+)[~-](\d+)\))?/i) ||
    raw.match(/-\s*Scenes:\s*(\d+)(?:\s*\(range\s*(\d+)[~-](\d+)\))?/i);
  const scenesRec = sceneMatch?.[1];
  const scenesRange = sceneMatch?.[2] && sceneMatch?.[3] ? `${sceneMatch[2]}~${sceneMatch[3]}` : null;

  const hookMatch = raw.match(/-\s*primary:\s*(\w+)/);
  const hook = hookMatch?.[1];
  const hookLabel = hook ? (HOOK_LABEL[hook]?.[language] ?? hook) : null;

  // Extract trailing free-form request text (if any).
  const blocks = raw.split(/\n\n+/);
  const lastBlock = blocks[blocks.length - 1]?.trim() ?? "";
  const isStructured =
    lastBlock.startsWith("[") ||
    lastBlock.startsWith("- ") ||
    /^[A-Za-z가-힣 ]+:\s/.test(lastBlock);
  const requestText = !isStructured && lastBlock.length > 0 ? lastBlock : null;

  const coreFields = [
    { key: FIELD_LABEL.goal[language], value: goal, color: "#f9423a" },
    { key: FIELD_LABEL.target[language], value: target, color: "#6366f1" },
    { key: FIELD_LABEL.usp[language], value: usp, color: "#d97706" },
    { key: FIELD_LABEL.tone[language], value: tone, color: "#059669" },
  ].filter((f) => f.value);

  const metaPills: { label: string; value: string }[] = [];
  if (format) metaPills.push({ label: language === "ko" ? "포맷" : "Format", value: duration ? `${format} · ${duration}` : format });
  if (scenesRec) metaPills.push({ label: language === "ko" ? "컷 수" : "Shots", value: scenesRange ? `${scenesRec} (${scenesRange})` : `${scenesRec}` });
  if (hookLabel) metaPills.push({ label: language === "ko" ? "훅" : "Hook", value: hookLabel });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Sparkles size={13} style={{ color: KR }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: KR, letterSpacing: "0.01em" }}>
            {language === "ko" ? "브리프 분석" : "Brief Analysis"}
          </span>
        </div>
        {contentTypeLabel && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              background: `${contentTypeColor}22`,
              color: contentTypeColor,
              border: `1px solid ${contentTypeColor}55`,
              letterSpacing: "0.03em",
              whiteSpace: "nowrap",
            }}
          >
            {contentTypeLabel}
            {contentTypeConf && <span style={{ marginLeft: 4 }}>· {contentTypeConf}%</span>}
          </span>
        )}
      </div>

      {/* Core 4-field grid */}
      {coreFields.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {coreFields.map((f) => (
            <div
              key={f.key}
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
                padding: "7px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 3,
                minHeight: 56,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: f.color,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase" as const,
                }}
              >
                {f.key}
              </div>
              <div style={{ fontSize: 12.5, color: "hsl(var(--foreground))", lineHeight: 1.45, opacity: 0.9 }}>
                {f.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Meta line: format · scenes · hook */}
      {metaPills.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.05)",
            padding: "6px 10px",
          }}
        >
          {metaPills.map((p, i) => (
            <span key={p.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: "rgba(255,255,255,0.12)" }}>·</span>}
              <span style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", opacity: 0.7, letterSpacing: "0.04em", textTransform: "uppercase" as const }}>
                {p.label}
              </span>
              <span style={{ fontSize: 11.5, color: "hsl(var(--foreground))", fontWeight: 600 }}>{p.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Notes (idea + director rec combined) */}
      {(ideaNote || directorRec) && (
        <div
          style={{
            padding: "7px 10px",
            background: "rgba(255,255,255,0.02)",
            borderLeft: "2px solid rgba(249,66,58,0.4)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {ideaNote && (
            <div style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", lineHeight: 1.5 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", opacity: 0.55, marginRight: 6, textTransform: "uppercase" as const }}>
                {language === "ko" ? "아이디어" : "Idea"}
              </span>
              {ideaNote}
            </div>
          )}
          {directorRec && (
            <div style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", lineHeight: 1.5 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", opacity: 0.55, marginRight: 6, textTransform: "uppercase" as const }}>
                {language === "ko" ? "디렉터" : "Director"}
              </span>
              {directorRec}
            </div>
          )}
        </div>
      )}

      {/* Trailing request text */}
      {requestText && (
        <div
          style={{
            fontSize: 12.5,
            color: "hsl(var(--muted-foreground))",
            marginTop: 2,
            fontStyle: "italic",
            opacity: 0.65,
            lineHeight: 1.5,
          }}
        >
          {requestText}
        </div>
      )}
    </div>
  );
};
