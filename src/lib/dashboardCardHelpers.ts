// 그리드 ProjectCard 와 리스트 ProjectListRow 가 공통으로 쓰는 작은 표기
// 헬퍼들. 두 컴포넌트의 시각 일관성(D-day 빨간색 임계값, "방금 전" 임계 등)을
// 한 곳에서 정의해 한쪽만 바뀌어 어긋나는 것을 방지한다.

export interface DDayInfo {
  /** 표시할 텍스트. 마감 없음이면 null (호출부에서 칩 자체를 숨겨야 함). */
  label: string | null;
  /** 마감일까지 남은 일수. 음수면 overdue. null 이면 마감 없음. */
  daysLeft: number | null;
  /** 임박/초과 여부 — 빨간 강조용. 3 일 이내 또는 음수일 때 true. */
  isUrgent: boolean;
}

/** ISO 8601 또는 YYYY-MM-DD 형태의 마감일을 받아 D-day 표기 정보를 반환.
 *  하루 단위 비교라 시각 차이는 무시 (자정 기준). */
export function computeDDay(
  deadlineRaw: string | null | undefined,
  // 테스트 / SSR 안정성을 위해 외부에서 now 주입 가능. 기본은 호출 시점.
  now: number = Date.now(),
): DDayInfo {
  if (!deadlineRaw) return { label: null, daysLeft: null, isUrgent: false };
  const t = new Date(deadlineRaw).getTime();
  if (!Number.isFinite(t)) return { label: null, daysLeft: null, isUrgent: false };
  // 같은 날 내 시간 차이가 음수로 나와 D-1 이 D-DAY 로 보이는 일을 막기 위해
  // 두 시간점을 모두 자정으로 끌어내려 비교한다.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDeadline = new Date(t);
  startOfDeadline.setHours(0, 0, 0, 0);
  const days = Math.round((startOfDeadline.getTime() - startOfToday.getTime()) / 86_400_000);
  let label: string;
  if (days === 0) label = "D-DAY";
  else if (days > 0) label = `D-${days}`;
  else label = `D+${-days}`;
  return { label, daysLeft: days, isUrgent: days <= 3 };
}

/** 사이드바 RECENT 섹션과 카드 hover 의 "X분 전" 표시. 1 분 미만은 "Just now",
 *  60 분 미만은 "{n}분 전", 24 시간 미만은 "{n}시간 전", 그 외는 "{n}일 전".
 *  i18n 키가 필요하므로 키만 반환하고 호출부에서 t() 적용한다. */
export interface RelativeTimeInfo {
  /** uiCopy 의 키. justNow / minutesAgo / hoursAgo / daysAgo */
  key: "justNow" | "minutesAgo" | "hoursAgo" | "daysAgo";
  /** {n} 으로 치환할 숫자. justNow 면 0. */
  value: number;
}

export function computeRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): RelativeTimeInfo | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return { key: "justNow", value: 0 };
  if (diff < 3_600_000) return { key: "minutesAgo", value: Math.floor(diff / 60_000) };
  if (diff < 86_400_000) return { key: "hoursAgo", value: Math.floor(diff / 3_600_000) };
  return { key: "daysAgo", value: Math.floor(diff / 86_400_000) };
}

/* ── 프로젝트 진입 라우팅 ─────────────────────────────────────────────
 * 프로젝트 카드 / 리스트 행 / 사이드바 (Favorites · Recent) 어느 진입점이든
 * "진행도에 가장 적합한 탭" 으로 자동 이동하는 단일 룰. 사용자가 카드에서
 * 클릭한 경험과 사이드바에서 클릭한 경험이 어긋나지 않도록 한 곳에서만
 * 정의하고 모든 진입점이 호출한다.
 *
 *  우선순위:
 *    1) 콘티 탭에 씬 카드가 한 장이라도 있음 → ?tab=storyboard
 *       (scenes.source='conti' 또는 scene_versions row 존재)
 *    2) Agent 탭에 씬 카드가 있음 (채팅 시작했지만 아직 콘티탭으로 안 넘김)
 *       → ?tab=agent
 *    3) 그 외 (브리프/에셋까지만, 또는 최초 상태) → 기본 탭(brief). 쿼리
 *       파라미터 없이 /project/:id 만 반환. */
export interface ProjectSceneStatsLike {
  hasContiScenes?: boolean;
  hasAgentScenes?: boolean;
}

export function resolveProjectRoute(
  projectId: string,
  sceneStats?: ProjectSceneStatsLike,
): string {
  if (sceneStats?.hasContiScenes) return `/project/${projectId}?tab=storyboard`;
  if (sceneStats?.hasAgentScenes) return `/project/${projectId}?tab=agent`;
  return `/project/${projectId}`;
}
