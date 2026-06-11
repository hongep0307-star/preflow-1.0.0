import type {
  ABCDCompliance,
  ABCDScore,
  HookStrategy,
  HeroVisual,
  ProductInfo,
  Pacing,
  Constraints,
  AudienceInsight,
} from "@/components/agent/agentTypes";

/**
 * ABCD Framework Scorer (Google)
 *   Attract — 첫 3초 몰입도
 *   Brand   — 브랜드/제품 노출 타이밍·빈도·지속시간
 *   Connect — 감정·내러티브 연결
 *   Direct  — CTA 명확성 및 노출 지속시간
 *
 * 채점 모드:
 *   1) scenes === undefined               → 브리프 설계 체크리스트 (pre-composition)
 *   2) scenes !== undefined, filled === 0 → 반환 null (호출측에서 마지막 점수 동결/회색 표시)
 *   3) scenes !== undefined, filled > 0   → 씬 기반 실시간 채점
 */

interface Rule {
  check: () => boolean;
  weight: number;
  fail_message: string;
  pass_message?: string;
}

export interface ABCDInput {
  hook_strategy?: HookStrategy;
  hero_visual?: HeroVisual;
  product_info?: ProductInfo;
  pacing?: Pacing;
  constraints?: Constraints;
  audience_insight?: AudienceInsight;
  visual_direction?: { lighting?: string };
  reference_mood?: string;
  scenes?: Array<{
    scene_number: number;
    sequence?: number | null;
    title?: string | null;
    description?: string | null;
    camera_angle?: string | null;
    location?: string | null;
    tagged_assets?: string[];
    duration_sec?: number | null;
  }>;
  total_scene_count?: number;
}

type SceneLike = NonNullable<ABCDInput["scenes"]>[number];

/* ─────────── 시간/키워드 유틸 ──────────────────────────── */

const DEFAULT_SCENE_SEC = 3;

function sceneDuration(s: SceneLike): number {
  return typeof s.duration_sec === "number" && s.duration_sec > 0
    ? s.duration_sec
    : DEFAULT_SCENE_SEC;
}

function totalDuration(scenes: SceneLike[]): number {
  return scenes.reduce((a, s) => a + sceneDuration(s), 0);
}

function sceneText(s: SceneLike): string {
  return `${s.title ?? ""} ${s.description ?? ""} ${(s.tagged_assets ?? []).join(" ")}`.toLowerCase();
}

function sceneHasAnyKeyword(s: SceneLike, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const txt = sceneText(s);
  return keywords.some((k) => txt.includes(k));
}

/** 키워드가 처음 등장한 씬의 누적 시작 시각(초). 없으면 null */
function firstKeywordRevealSec(scenes: SceneLike[], keywords: string[]): number | null {
  if (!keywords.length) return null;
  let cum = 0;
  for (const s of scenes) {
    if (sceneHasAnyKeyword(s, keywords)) return cum;
    cum += sceneDuration(s);
  }
  return null;
}

/** 키워드가 등장하는 씬들의 duration 총합(초) */
function keywordExposureSec(scenes: SceneLike[], keywords: string[]): number {
  if (!keywords.length) return 0;
  return scenes.reduce(
    (a, s) => a + (sceneHasAnyKeyword(s, keywords) ? sceneDuration(s) : 0),
    0,
  );
}

/** 키워드가 등장하는 씬의 개수 */
function sceneHitCount(scenes: SceneLike[], keywords: string[]): number {
  if (!keywords.length) return 0;
  return scenes.filter((s) => sceneHasAnyKeyword(s, keywords)).length;
}

/** 타임라인 마지막 pct (0~1) 구간과 교차하는 씬들 반환 */
function lastPortionScenes(scenes: SceneLike[], pct: number): SceneLike[] {
  const total = totalDuration(scenes);
  if (total <= 0) return [];
  const cutoff = total * (1 - pct);
  let acc = 0;
  const out: SceneLike[] = [];
  for (const s of scenes) {
    const end = acc + sceneDuration(s);
    if (end > cutoff) out.push(s);
    acc = end;
  }
  return out.length ? out : [scenes[scenes.length - 1]];
}

function extractProductKeywords(productWhat?: string, mustShow?: string[]): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw) return;
    raw
      .split(/[\s,/\\·\-·|]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2)
      .forEach((t) => out.push(t));
  };
  push(productWhat);
  (mustShow ?? []).forEach(push);
  return [...new Set(out)];
}

const CTA_KEYWORDS = [
  "cta",
  "구매",
  "다운로드",
  "참여",
  "클릭",
  "지금",
  "방문",
  "시작",
  "pre-register",
  "buy",
  "download",
  "tap",
  "click",
  "join",
  "play",
  "get",
  "start",
  "now",
  "subscribe",
  "sign up",
];

const PATTERN_INTERRUPT_MOTION = [
  "줌",
  "컷",
  "회전",
  "폭발",
  "충격",
  "번쩍",
  "스플래시",
  "변신",
  "플래시",
  "슬로우",
  "whip",
  "zoom",
  "cut",
  "slam",
  "flash",
  "explode",
  "burst",
  "dash",
  "rush",
  "quick",
  "match cut",
];

/* ─────────── runRules ──────────────────────────────────── */

function runRules(rules: Rule[]): ABCDScore {
  let earned = 0;
  const max = rules.reduce((a, r) => a + r.weight, 0);
  const notes: string[] = [];
  for (const r of rules) {
    let passed = false;
    try {
      passed = r.check();
    } catch {
      passed = false;
    }
    if (passed) {
      earned += r.weight;
      if (r.pass_message) notes.push(`✓ ${r.pass_message}`);
    } else {
      notes.push(`⚠ ${r.fail_message}`);
    }
  }
  const normalized = max === 0 ? 0 : Math.round((earned / max) * 10);
  return { score: normalized, notes: notes.join(" · ") };
}

/* ─────────── Continuity (컷 간 연속성) ──────────────────── */

/** camera_angle 문자열에서 주 숏사이즈 토큰 1개를 추출.
 *  한국어 출력도 "미디엄 숏(MS)" 처럼 괄호 안 약어를 동반하므로 약어 기준.
 *  alternation 은 longest-first 로 두어 BCU/ECU/MCU 가 CU 보다 먼저 매칭됨. */
const SHOT_SIZE_RE = /\b(ECU|BCU|MCU|MLS|VLS|ELS|MS|LS|CU)\b/;

function normLoc(s: SceneLike): string {
  return (s.location ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function shotSize(s: SceneLike): string | null {
  const m = (s.camera_angle ?? "").toUpperCase().match(SHOT_SIZE_RE);
  return m ? m[1] : null;
}

function assetSet(s: SceneLike): Set<string> {
  return new Set(
    (s.tagged_assets ?? [])
      .map((t) => (t.startsWith("@") ? t.slice(1) : t).trim().toLowerCase())
      .filter(Boolean),
  );
}

const seqOf = (s: SceneLike): number | null =>
  typeof s.sequence === "number" ? s.sequence : null;

/**
 * 컷 간 연속성을 결정론적으로 채점한다.
 *   1) 장소 흐름 안정성 — 같은 씬(sequence) 안에서 location 이 유지될 것
 *   2) 장소 종류 집약 — 씬 수(없으면 컷 수) 대비 distinct location 과다 금지
 *   3) 에셋 캐리오버 — 같은 씬 안 인접 컷이 공통 에셋을 이어받는 비율
 *   4) 같은 장소 내 카메라 변주 — 동일 location 연속 컷의 숏사이즈 반복 금지(30% 규칙)
 * sequence(씬) 정보가 있으면 **씬 경계의 장소/인물 전환은 의도된 것**으로 보고
 * 감점하지 않는다. 즉 "씬 내부"의 연결성만 평가한다.
 * 데이터가 비면(예: location 미기입) 해당 룰은 통과 처리해 거짓 음성을 피한다.
 * 컷 2개 미만이면 채점 불가 → null.
 */
function scoreContinuity(scenes: SceneLike[]): ABCDScore | null {
  const n = scenes.length;
  if (n < 2) return null;

  let locPairs = 0;
  let locChanges = 0;
  let carryPairs = 0;
  let carryShared = 0;
  let sameLocPairs = 0;
  let sameSizeViolations = 0;

  for (let i = 1; i < n; i++) {
    const seqA = seqOf(scenes[i - 1]);
    const seqB = seqOf(scenes[i]);
    // 둘 다 sequence 가 있고 서로 다르면 씬 경계 → 전환이 정상이므로 평가 제외.
    const isBoundary = seqA !== null && seqB !== null && seqA !== seqB;
    if (isBoundary) continue;

    const a = normLoc(scenes[i - 1]);
    const b = normLoc(scenes[i]);
    if (a && b) {
      locPairs++;
      if (a !== b) locChanges++;
      else {
        const sa = shotSize(scenes[i - 1]);
        const sb = shotSize(scenes[i]);
        if (sa && sb) {
          sameLocPairs++;
          if (sa === sb) sameSizeViolations++;
        }
      }
    }
    const A = assetSet(scenes[i - 1]);
    const B = assetSet(scenes[i]);
    if (A.size > 0 && B.size > 0) {
      carryPairs++;
      if ([...A].some((x) => B.has(x))) carryShared++;
    }
  }

  const locChangeRate = locPairs > 0 ? locChanges / locPairs : 0;
  const distinctLocs = new Set(scenes.map(normLoc).filter(Boolean)).size;
  const anyAssets = scenes.some((s) => assetSet(s).size > 0);
  const carryRate = carryPairs > 0 ? carryShared / carryPairs : 0;
  const hasLocData = locPairs > 0;

  // 장소 종류 상한: 씬 정보가 있으면 (씬 수 + 1), 없으면 컷 수의 절반을 기준.
  const distinctSeq = new Set(scenes.map(seqOf).filter((v): v is number => v !== null)).size;
  const maxLocs = distinctSeq > 0 ? Math.max(2, distinctSeq + 1) : Math.max(2, Math.ceil(n / 2));

  return runRules([
    {
      check: () => !hasLocData || locChangeRate <= 0.6,
      weight: 4,
      fail_message: `같은 씬 안에서 장소가 자주 바뀜 (변경률 ${Math.round(locChangeRate * 100)}%) — 공간 흐름 단절`,
      pass_message: hasLocData ? `씬 내부 장소 흐름 안정적 (변경률 ${Math.round(locChangeRate * 100)}%)` : undefined,
    },
    {
      check: () => distinctLocs <= maxLocs,
      weight: 2,
      fail_message: `서로 다른 장소 ${distinctLocs}개 / ${n}컷 — 장소 종류 과다`,
      pass_message: distinctLocs > 0 ? `장소 ${distinctLocs}종으로 집약` : undefined,
    },
    {
      check: () => !anyAssets || carryPairs === 0 || carryRate >= 0.4,
      weight: 3,
      fail_message: `씬 내부 인접 컷 에셋 연결률 ${Math.round(carryRate * 100)}% — 주인공/에셋 캐리오버 약함`,
      pass_message: anyAssets && carryPairs > 0 ? `에셋 캐리오버 ${Math.round(carryRate * 100)}%` : undefined,
    },
    {
      check: () => sameLocPairs === 0 || sameSizeViolations / sameLocPairs <= 0.5,
      weight: 1,
      fail_message: `같은 장소 연속 컷에서 숏사이즈 반복 ${sameSizeViolations}회 — 30% 변주 부족`,
      pass_message: sameLocPairs > 0 ? "같은 장소 내 카메라 변주 양호" : undefined,
    },
  ]);
}

/* ─────────── scoreABCD ─────────────────────────────────── */

export function scoreABCD(input: ABCDInput): ABCDCompliance | null {
  const {
    hook_strategy,
    hero_visual,
    product_info,
    pacing,
    visual_direction,
    reference_mood,
    audience_insight,
    scenes,
  } = input;

  const hasSceneInput = scenes !== undefined;
  const sceneArrAll = scenes ?? [];
  const filledScenes = sceneArrAll.filter(
    (s) => !!s.description && s.description.trim().length > 0,
  );

  // 씬 모드로 호출되었지만 실제로 채점할 씬이 없는 경우
  // → 호출측이 마지막 점수를 동결(회색)로 처리하도록 null 반환
  if (hasSceneInput && filledScenes.length === 0) {
    return null;
  }

  const hasScenes = filledScenes.length > 0;

  // ── 씬 기반 신호 사전 계산 ───────────────────────────────
  const productKeywords = extractProductKeywords(product_info?.what, hero_visual?.must_show);
  const totalSec = hasScenes ? totalDuration(filledScenes) : 0;
  const firstRevealSec = hasScenes ? firstKeywordRevealSec(filledScenes, productKeywords) : null;
  const brandExposureSec = hasScenes ? keywordExposureSec(filledScenes, productKeywords) : 0;
  const brandSceneHits = hasScenes ? sceneHitCount(filledScenes, productKeywords) : 0;
  const ctaPortion = hasScenes ? lastPortionScenes(filledScenes, 0.3) : [];
  const ctaHitInLastPortion = ctaPortion.some((s) => sceneHasAnyKeyword(s, CTA_KEYWORDS));
  const ctaExposureInLastPortion = keywordExposureSec(ctaPortion, CTA_KEYWORDS);
  const firstSceneFilled = filledScenes[0];
  const firstSceneTextLen = firstSceneFilled?.description?.trim().length ?? 0;
  const firstSceneDur = firstSceneFilled ? sceneDuration(firstSceneFilled) : 0;
  const firstSceneHasMotion = firstSceneFilled
    ? sceneHasAnyKeyword(firstSceneFilled, PATTERN_INTERRUPT_MOTION)
    : false;

  const emotionalHookTypes = new Set([
    "power_fantasy",
    "fail_solve",
    "testimonial",
    "before_after",
  ]);

  /* ───────── A: Attract ───────── */
  const attract = runRules(
    hasScenes
      ? [
          {
            check: () => firstSceneTextLen >= 20,
            weight: 2,
            fail_message: "첫 씬 description 이 비었거나 너무 짧음 — 훅 샷 구체화 필요",
            pass_message: "첫 씬 description 구체적",
          },
          {
            check: () =>
              !!firstSceneFilled?.camera_angle && firstSceneFilled.camera_angle.trim().length > 0,
            weight: 1,
            fail_message: "첫 씬 camera_angle 미지정",
          },
          {
            check: () => firstSceneDur >= 1 && firstSceneDur <= 5,
            weight: 1,
            fail_message:
              firstSceneDur < 1
                ? "첫 씬 duration 이 너무 짧음 — 훅 인지 불가"
                : firstSceneDur > 5
                  ? `첫 씬 duration ${firstSceneDur}s — 초반 스크롤 이탈 위험 (1-5s 권장)`
                  : "첫 씬 duration 미지정",
            pass_message: "첫 씬 duration 훅 구간에 적합",
          },
          {
            check: () => firstRevealSec !== null && firstRevealSec < 3,
            weight: 3,
            fail_message:
              firstRevealSec === null
                ? `씬에 제품/브랜드 키워드 노출 없음${productKeywords.length ? ` (검색어: ${productKeywords.slice(0, 4).join(", ")})` : ""}`
                : `첫 제품/브랜드 노출이 ${firstRevealSec.toFixed(1)}s — 3초 초과`,
            pass_message:
              firstRevealSec !== null ? `첫 ${firstRevealSec.toFixed(1)}s 내 브랜드·제품 노출` : undefined,
          },
          {
            check: () => hook_strategy?.pattern_interrupt === true || firstSceneHasMotion,
            weight: 2,
            fail_message:
              hook_strategy?.pattern_interrupt === true
                ? "첫 씬에 모션/컷 키워드가 없어 pattern_interrupt 체감 약함"
                : "스크롤 멈춤(pattern_interrupt) 장치 없음",
            pass_message: "pattern_interrupt 신호 확인됨",
          },
          {
            check: () => !!hero_visual?.first_frame && hero_visual.first_frame.trim().length > 0,
            weight: 1,
            fail_message: "hero_visual.first_frame 미정의",
          },
        ]
      : [
          {
            check: () => !!hero_visual?.first_frame && hero_visual.first_frame.trim().length > 0,
            weight: 3,
            fail_message: "hero_visual.first_frame 미정의 — 첫 프레임 시각을 구체화할 것",
            pass_message: "첫 프레임 시각 정의됨",
          },
          {
            check: () => hook_strategy?.pattern_interrupt === true,
            weight: 2,
            fail_message: "스크롤 멈춤(pattern_interrupt) 장치 없음",
            pass_message: "pattern_interrupt 활성",
          },
          {
            check: () =>
              !!hero_visual &&
              (hero_visual.brand_reveal_timing === "0-3s" ||
                hero_visual.product_reveal_timing === "0-3s"),
            weight: 3,
            fail_message: "첫 3초 내 제품/브랜드 노출이 설계되지 않음",
            pass_message: "첫 3초 내 브랜드·제품 노출 설계됨",
          },
          {
            check: () =>
              !!hook_strategy?.first_3s_description &&
              hook_strategy.first_3s_description.length > 20,
            weight: 2,
            fail_message: "훅 첫 3초 묘사가 비었거나 너무 짧음",
          },
        ],
  );

  /* ───────── B: Brand ───────── */
  const brand = runRules(
    hasScenes
      ? [
          {
            check: () => firstRevealSec !== null && firstRevealSec < 3,
            weight: 3,
            fail_message:
              firstRevealSec === null
                ? "어떤 씬에도 제품/브랜드 키워드가 없음"
                : `브랜드·제품 노출이 ${firstRevealSec.toFixed(1)}s — 3초 초과`,
            pass_message:
              firstRevealSec !== null ? `3초 이내 (${firstRevealSec.toFixed(1)}s) 브랜드 노출` : undefined,
          },
          {
            check: () => firstRevealSec !== null && firstRevealSec < 5,
            weight: 1,
            fail_message: "브랜드 노출이 5초 초과 — Hook 구간 내 진입 필요",
          },
          {
            check: () => brandSceneHits >= 2,
            weight: 2,
            fail_message:
              brandSceneHits === 1
                ? "브랜드·제품이 1개 씬에만 등장 — 분산 노출 부족"
                : "브랜드·제품 분산 노출 없음",
            pass_message: `${brandSceneHits}개 씬에 걸쳐 브랜드·제품 반복 노출`,
          },
          {
            check: () => totalSec > 0 && brandExposureSec / totalSec >= 0.2,
            weight: 2,
            fail_message:
              totalSec > 0
                ? `브랜드·제품 총 노출 ${brandExposureSec.toFixed(1)}s / ${totalSec.toFixed(1)}s (${Math.round((brandExposureSec / totalSec) * 100)}%) — 20% 미만`
                : "총 러닝타임 산출 불가",
            pass_message:
              totalSec > 0
                ? `브랜드 노출 비중 ${Math.round((brandExposureSec / totalSec) * 100)}%`
                : undefined,
          },
          {
            check: () => !!product_info?.what && product_info.what.length > 2,
            weight: 2,
            fail_message: "product_info.what 누락 — 판매·홍보 대상 불명확",
          },
        ]
      : [
          {
            check: () =>
              hero_visual?.brand_reveal_timing === "0-3s" ||
              hero_visual?.brand_reveal_timing === "3-5s",
            weight: 4,
            fail_message: "브랜드 노출 타이밍이 5초 이내에 설계되지 않음",
            pass_message: "5초 이내 브랜드 노출 (설계)",
          },
          {
            check: () => !!hero_visual?.logo_placement,
            weight: 2,
            fail_message: "logo_placement 미정의",
          },
          {
            check: () =>
              Array.isArray(hero_visual?.must_show) && (hero_visual?.must_show.length ?? 0) >= 2,
            weight: 2,
            fail_message: "hero_visual.must_show 자산 2개 미만",
          },
          {
            check: () => !!product_info?.what && product_info.what.length > 2,
            weight: 2,
            fail_message: "product_info.what 누락",
          },
        ],
  );

  /* ───────── C: Connect ───────── */
  const connect = runRules(
    hasScenes
      ? [
          {
            check: () =>
              !!audience_insight?.pain_point && audience_insight.pain_point.length > 5,
            weight: 2,
            fail_message: "audience_insight.pain_point 미정의 — 타겟 페인 포인트 구체화 필요",
          },
          {
            check: () =>
              !!hook_strategy?.primary && emotionalHookTypes.has(hook_strategy.primary),
            weight: 2,
            fail_message: "훅이 감정 비트를 강조하는 유형이 아님",
            pass_message: "감정 연결형 훅 유형",
          },
          {
            check: () =>
              (!!visual_direction?.lighting && visual_direction.lighting.length > 10) ||
              (!!reference_mood && reference_mood.length > 30),
            weight: 2,
            fail_message: "감정 톤을 구체화할 lighting·reference_mood 서술 부족",
          },
          {
            check: () => filledScenes.length >= 3,
            weight: 2,
            fail_message:
              filledScenes.length < 2
                ? `필드 씬 ${filledScenes.length}개 — 스토리 비트 구성 불가 (3+ 권장)`
                : `필드 씬 ${filledScenes.length}개 — 감정 빌드업 공간 부족`,
            pass_message: `${filledScenes.length}개 씬으로 내러티브 구성 가능`,
          },
          {
            check: () => {
              if (filledScenes.length < 2) return false;
              // CTA 구간에 들어가기 전에 최소 1개 빌드업 씬 존재
              const buildupCandidates = filledScenes.slice(0, Math.max(1, filledScenes.length - 1));
              return buildupCandidates.some(
                (s) => !sceneHasAnyKeyword(s, CTA_KEYWORDS) && (s.description?.trim().length ?? 0) >= 15,
              );
            },
            weight: 2,
            fail_message: "CTA 이전 빌드업 씬이 없음 — 감정 곡선 부재",
            pass_message: "CTA 이전 빌드업 씬 존재",
          },
        ]
      : [
          {
            check: () =>
              !!audience_insight?.pain_point && audience_insight.pain_point.length > 5,
            weight: 3,
            fail_message: "audience_insight.pain_point 미정의",
          },
          {
            check: () =>
              !!hook_strategy?.primary && emotionalHookTypes.has(hook_strategy.primary),
            weight: 3,
            fail_message: "훅이 감정 비트를 강조하는 유형이 아님",
            pass_message: "감정 연결형 훅 선택됨",
          },
          {
            check: () => !!visual_direction?.lighting && visual_direction.lighting.length > 10,
            weight: 2,
            fail_message: "visual_direction.lighting 이 감정 톤을 구체화하지 못함",
          },
          {
            check: () => !!reference_mood && reference_mood.length > 30,
            weight: 2,
            fail_message: "reference_mood 가 센서리 디테일로 묘사되지 않음",
          },
        ],
  );

  /* ───────── D: Direct ───────── */
  const direct = runRules(
    hasScenes
      ? [
          {
            check: () =>
              !!product_info?.cta_action &&
              /^(지금|참여|구매|다운|클릭|방문|[A-Za-z])/u.test(product_info.cta_action) &&
              product_info.cta_action.length <= 10,
            weight: 2,
            fail_message: "cta_action 이 동사형 10자 이내가 아님",
            pass_message: "cta_action 구체적 동사형",
          },
          {
            check: () => !!product_info?.cta_destination && product_info.cta_destination.length > 3,
            weight: 2,
            fail_message: "cta_destination (구체적 경로) 누락",
          },
          {
            check: () => !!product_info?.urgency?.type && product_info.urgency.type !== "none",
            weight: 1,
            fail_message: "urgency 'none' — 긴박감 장치 없음",
            pass_message: "긴박감(urgency) 설계됨",
          },
          {
            check: () => ctaHitInLastPortion,
            weight: 2,
            fail_message: "마지막 30% 구간 씬에 CTA 키워드 없음",
            pass_message: "마지막 구간 씬에 CTA 반영",
          },
          {
            check: () => ctaExposureInLastPortion >= 2,
            weight: 3,
            fail_message: ctaHitInLastPortion
              ? `CTA 노출 ${ctaExposureInLastPortion.toFixed(1)}s — 2초 미만, 인지 어려움`
              : "CTA 노출 없음",
            pass_message: `CTA 마지막 구간 ${ctaExposureInLastPortion.toFixed(1)}s 노출`,
          },
        ]
      : [
          {
            check: () =>
              !!product_info?.cta_action &&
              /^(지금|참여|구매|다운|클릭|방문|[A-Za-z])/u.test(product_info.cta_action) &&
              product_info.cta_action.length <= 10,
            weight: 3,
            fail_message: "cta_action 이 동사형 3-6자 짧은 문구가 아님",
            pass_message: "cta_action 구체적 동사형",
          },
          {
            check: () => !!product_info?.cta_destination && product_info.cta_destination.length > 3,
            weight: 3,
            fail_message: "cta_destination 누락",
          },
          {
            check: () => !!product_info?.urgency?.type && product_info.urgency.type !== "none",
            weight: 2,
            fail_message: "urgency 'none'",
            pass_message: "긴박감 설계됨",
          },
          {
            check: () => !!pacing && (pacing.shot_count ?? pacing.scene_count).recommended >= 3,
            weight: 2,
            fail_message: "권장 컷 수 3 미만 — 마지막 CTA 구간 확보 어려움",
          },
        ],
  );

  const total = attract.score + brand.score + connect.score + direct.score;
  // 연속성은 ABCD total 에 합산하지 않는 독립 보조 신호. 씬 2개 미만이면 undefined.
  const continuity = hasScenes ? (scoreContinuity(filledScenes) ?? undefined) : undefined;
  return { attract, brand, connect, direct, total, continuity };
}

/** 4개 영역 합산 0-40 을 5-grade 텍스트로 변환 */
export function gradeABCD(total: number): { grade: string; color: "red" | "amber" | "lime" | "green" } {
  if (total >= 34) return { grade: "탁월", color: "green" };
  if (total >= 28) return { grade: "양호", color: "lime" };
  if (total >= 20) return { grade: "보완 필요", color: "amber" };
  return { grade: "전면 재검토", color: "red" };
}
