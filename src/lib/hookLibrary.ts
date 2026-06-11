import type { ContentType, HookType } from "@/components/agent/agentTypes";

/**
 * Hook Library — Performance Creative 훅 실행 템플릿
 *
 * 브리프 분석이 hook_strategy.primary 를 결정하면, AgentTab 의 시스템 프롬프트
 * 와 Conti 의 씬1 이미지 프롬프트가 런타임에 여기서 템플릿을 lookup 해서
 * "구체적 샷 시퀀스 + 오디오 큐" 를 주입한다.
 *
 * 참고: Meta Creative Best Practices · Google ABCD · Mobile UA Patterns.
 */

export interface HookShot {
  shot: string; // 샷 크기/앵글 (예: "ECU", "MS, low angle")
  subject: string; // 피사체·상황 묘사
  duration: string; // 타임코드 범위 (예: "0-1s")
}

export interface HookTemplate {
  /** 훅 전체 구조를 한 줄로 요약 */
  structure: string;
  /** 첫 3-5초의 샷 시퀀스 (보통 3샷) */
  shot_sequence: HookShot[];
  /** 오디오 연출 큐 (무성 시청 대비 자막 가이드 포함) */
  audio_cue: string;
  /** 이 훅이 빛을 보는 레퍼런스 광고/트레일러 */
  reference_ads: string[];
  /** 한 줄 한글 설명 (BriefTab/AgentTab UI용) */
  description_ko: string;
  /** 무드 키워드 (콘티 이미지 프롬프트 보강용) */
  mood_keywords: string[];
}

export const HOOK_LIBRARY: Record<HookType, HookTemplate> = {
  gameplay_first: {
    structure: "첫 3초 게임플레이 즉시 노출 → 상황 전개 → CTA 힌트",
    shot_sequence: [
      { shot: "LS/MS, kinetic", subject: "대표 게임플레이의 가장 임팩트 있는 순간 (킬/스킬/드라이브)", duration: "0-1s" },
      { shot: "CU quick cut", subject: "플레이어 캐릭터/UI 핵심 요소 클로즈업", duration: "1-2s" },
      { shot: "MS, action", subject: "상황 전개 — 스킬 체인 또는 결정적 순간", duration: "2-3s" },
    ],
    audio_cue: "인트로 없이 곧바로 메인 타격음/SFX 폭발로 시작, 음악은 1초에 드롭",
    reference_ads: ["PUBG Mobile 신규 맵 티저", "Call of Duty Mobile Season Drop"],
    description_ko: "가장 안전한 기본 훅 — 게임의 핵심 재미를 0초에 직접 노출",
    mood_keywords: ["kinetic", "high-energy", "quick-cut", "in-engine footage"],
  },

  fail_solve: {
    structure: "실패/답답한 순간 → 원인·도구 인지 → 극적 해결",
    shot_sequence: [
      { shot: "POV/MS", subject: "주인공이 반복적으로 실패하는 순간 (퍼즐 막힘/보스 패배)", duration: "0-2s" },
      { shot: "CU", subject: "신규 아이템/스킬/전략 등장 — 힌트 제시", duration: "2-3s" },
      { shot: "LS, triumphant", subject: "해결된 순간 — 승리/클리어 연출", duration: "3-5s" },
    ],
    audio_cue: "좌절음 → 정적(0.3s) → 발견 효과음 → 클리어 팡파르",
    reference_ads: ["Candy Crush 'stuck level' UA", "Clash Royale counter ads"],
    description_ko: "퍼즐/캐주얼 장르 최적 — 시청자의 'ㅋㅋ 나도 저래' 공감 훅",
    mood_keywords: ["relatable frustration", "tension", "release", "UI-heavy"],
  },

  power_fantasy: {
    structure: "평범/약함 → 각성·변신 → 압도적 퍼포먼스",
    shot_sequence: [
      { shot: "MS, low angle", subject: "평범한 상태의 캐릭터 — 머뭇거림/열세", duration: "0-2s" },
      { shot: "match cut to ECU", subject: "변화의 순간 — 눈 빛남, 무기 활성화, 스킬 발동", duration: "2-3s" },
      { shot: "LS, heroic low angle", subject: "완전 각성 상태 — 적 압도 또는 슬로우 모션 타격", duration: "3-5s" },
    ],
    audio_cue: "정적 → 저음 심박 → 메인 테마 폭발 (드럼 빌드업 후 드롭)",
    reference_ads: ["Genshin Impact character trailers", "Overwatch hero reveals"],
    description_ko: "RPG·배틀 장르에 강함 — 플레이어가 상상하는 '나의 강함' 판타지 자극",
    mood_keywords: ["dramatic low angle", "rim light", "slow-mo", "heroic"],
  },

  unboxing_reveal: {
    structure: "빈 화면/잠금 → 아이템 공개 순간 → 반응 또는 CTA 힌트",
    shot_sequence: [
      { shot: "ECU", subject: "잠긴 아이템 아이콘·박스·실루엣", duration: "0-1s" },
      { shot: "CU, VFX heavy", subject: "언락 이펙트 + 아이템 전체 공개", duration: "1-2s" },
      { shot: "MS", subject: "플레이어 리액션 또는 캐릭터 장착·각성 컷", duration: "2-3s" },
    ],
    audio_cue: "빈 공간 hush → 임팩트 사운드 (brass hit) → 메인 음악 드롭",
    reference_ads: ["Fortnite item shop reveals", "Valorant skin trailers", "Diablo legendary drops"],
    description_ko: "스킨·아이템 판매(product_launch) 기본값 — 언락 순간의 쾌감 자극",
    mood_keywords: ["reveal lighting", "macro detail", "particle VFX", "gold/purple glow"],
  },

  before_after: {
    structure: "변경 전 상태 → 명시적 전환 신호 → 변경 후 상태 대비",
    shot_sequence: [
      { shot: "same-framing shot A", subject: "이전 버전/기존 상태 — 관객이 '이거 알지' 싶은 화면", duration: "0-2s" },
      { shot: "wipe/match cut", subject: "전환 효과 — 날짜 오버레이 또는 버전 비교", duration: "2-3s" },
      { shot: "same-framing shot B", subject: "업데이트 후 상태 — 확연히 달라진 포인트 강조", duration: "3-5s" },
    ],
    audio_cue: "단조로운 앰비언트 → 스윕 효과음 → 새 BGM 폭발",
    reference_ads: ["PUBG map redesign announcements", "League of Legends champion rework reveals"],
    description_ko: "업데이트(update) 필수 훅 — 동일 구도 전후 비교가 시각적으로 가장 명확",
    mood_keywords: ["A/B comparison", "split-screen", "overlay text", "paired framing"],
  },

  mystery_tease: {
    structure: "불완전 이미지/소리 힌트 → 긴장 빌드업 → 마지막 순간 부분 공개",
    shot_sequence: [
      { shot: "ECU, fragmented", subject: "정체 불명의 오브젝트·실루엣·그림자", duration: "0-2s" },
      { shot: "LS, atmospheric", subject: "환경만 보이는 와이드 — 뭔가 온다는 긴장감", duration: "2-3s" },
      { shot: "CU, partial reveal", subject: "일부만 드러난 결정적 단서 — 전체 공개는 CTA 프레임에 이월", duration: "3-5s" },
    ],
    audio_cue: "서브 베이스 드론 + 심박 + 단절음, 음악 고조만 하고 드롭 없이 페이드",
    reference_ads: ["Cyberpunk 2077 first teasers", "Elden Ring announcement trailer"],
    description_ko: "티저 전용 — 이벤트 출시 전 호기심 증폭용. 완주율보다 재시청 유도",
    mood_keywords: ["high-contrast shadow", "atmospheric fog", "cryptic symbols", "saturated color accent"],
  },

  testimonial: {
    structure: "사용자/크리에이터 얼굴 등장 → 핵심 발언 → 실제 플레이 삽입",
    shot_sequence: [
      { shot: "MCU, direct to camera", subject: "실제 플레이어 또는 스트리머의 표정 — 놀람·환호·집중", duration: "0-2s" },
      { shot: "CU, reaction", subject: "핵심 한 줄 발언의 캡션 자막 동반", duration: "2-3s" },
      { shot: "cut to gameplay", subject: "발언을 뒷받침하는 실제 플레이 인서트", duration: "3-5s" },
    ],
    audio_cue: "자연스러운 방송 오디오 (채팅 알림, 마이크 호흡), 음악은 백그라운드 낮게",
    reference_ads: ["Mobile Legends creator campaigns", "Call of Duty streamer tournaments"],
    description_ko: "커뮤니티(community) 기반 훅 — UGC 느낌의 진정성이 핵심",
    mood_keywords: ["webcam overlay", "stream chat", "handheld", "authentic lighting"],
  },

  pattern_interrupt: {
    structure: "예상과 완전히 다른 첫 프레임 → 관객 뇌 정지 → 의도 공개",
    shot_sequence: [
      { shot: "ECU or abstract", subject: "게임 영상으로 보이지 않는 오프닝 (일상 오브젝트, 추상 패턴)", duration: "0-1s" },
      { shot: "zoom out/reveal", subject: "'아 게임이었구나' 깨닫는 전환 — 스케일 반전", duration: "1-3s" },
      { shot: "MS", subject: "정상 게임플레이로 복귀 — 훅이 맞았다는 인식 강화", duration: "3-5s" },
    ],
    audio_cue: "일상 앰비언트/대화 → 레코드 스크래치 효과음 → 게임 BGM 전환",
    reference_ads: ["Raid: Shadow Legends meme ads", "Archero fake gameplay UA"],
    description_ko: "바이럴·알고리즘 노출 극대화용 — 스크롤 멈춤 효과가 핵심",
    mood_keywords: ["unexpected framing", "tonal whiplash", "scale shift", "meta-aware"],
  },
};

/**
 * content_type × HookType 권장 매트릭스.
 * 1 = 적합, 2 = 매우 적합, 0 = 부적합.
 * hook_strategy.primary 가 비어 있거나 신뢰가 낮을 때의 폴백 추천용.
 */
export const HOOK_CONTENT_AFFINITY: Record<HookType, Partial<Record<ContentType, number>>> = {
  gameplay_first: { product_launch: 1, event: 1, update: 2, community: 1 },
  fail_solve: { product_launch: 1, event: 1, update: 1 },
  power_fantasy: { product_launch: 2, event: 1 },
  unboxing_reveal: { product_launch: 2, event: 1 },
  before_after: { product_launch: 1, update: 2 },
  mystery_tease: { product_launch: 1, event: 2 },
  testimonial: { event: 1, community: 2 },
  pattern_interrupt: { product_launch: 1, event: 1, community: 1 },
};

export function getHookTemplate(hook: HookType | undefined): HookTemplate | null {
  if (!hook) return null;
  return HOOK_LIBRARY[hook] ?? null;
}

/** 시스템 프롬프트에 넣을 수 있는 짧은 요약 (~300토큰) */
export function buildHookLibrarySummary(): string {
  const lines: string[] = ["[Hook 전략 라이브러리 — 8개 타입]"];
  for (const [key, tpl] of Object.entries(HOOK_LIBRARY)) {
    lines.push(`- ${key}: ${tpl.description_ko}`);
  }
  return lines.join("\n");
}

/** 특정 Hook 타입의 상세 실행 가이드 (AgentTab 에서 씬1 설계 시 주입) */
export function buildHookExecutionGuide(hook: HookType): string {
  const tpl = HOOK_LIBRARY[hook];
  if (!tpl) return "";
  const shots = tpl.shot_sequence
    .map((s, i) => `  ${i + 1}. [${s.duration}] ${s.shot} — ${s.subject}`)
    .join("\n");
  return [
    `[씬 1 훅 실행 템플릿: ${hook}]`,
    `구조: ${tpl.structure}`,
    `샷 시퀀스:`,
    shots,
    `오디오 큐: ${tpl.audio_cue}`,
    `참고: ${tpl.reference_ads.join(" / ")}`,
  ].join("\n");
}

/** Conti 이미지 프롬프트용 mood 키워드 (씬1 전용) */
export function buildHookMoodAddendum(hook: HookType): string {
  const tpl = HOOK_LIBRARY[hook];
  if (!tpl) return "";
  return tpl.mood_keywords.join(", ");
}
