/**
 * Brief 분석 진행 상태의 모듈 레벨 레지스트리.
 *
 * 왜 필요한가:
 *   - Brief 분석은 LLM 호출 한 번이 길게 (수십 초) 걸린다. 분석 도중 사용자가
 *     대시보드/라이브러리 등 다른 라우트로 다녀오면 ProjectPage 와 BriefTab 이
 *     언마운트되며 로컬 `analyzing` state 가 사라져, 돌아왔을 때 로딩 UI 가
 *     초기화된 것처럼 보이는 문제가 있었다.
 *   - 실제 fetch Promise 는 끝까지 살아남아 DB 에 결과를 기록하지만, 그 사이
 *     UI 는 "분석 안 한 상태" 로 보여 사용자 혼동 + 두 번 분석 누르는 사고
 *     가능성.
 *
 * 해결: 진행 중인 projectId 를 모듈 레벨 Map 에 두고, BriefTab 이 마운트될 때
 * 이 레지스트리에서 상태를 hydrate 한다. 분석 시작/종료 시점에 begin/end 를
 * 호출하면 현재 마운트된 모든 BriefTab 인스턴스가 subscriber 로 알림을 받아
 * 로딩 UI 와 결과 fetch 를 일관되게 갱신할 수 있다.
 *
 * 한 process 안에서만 유효하다 (페이지 전체 새로고침 시 잃음). 새로고침 시점에
 * 이미 DB write 가 끝났으면 다음 마운트의 fetchBrief 가 결과를 로드하므로
 * 사용성 회귀는 없음.
 */
type Listener = (state: { analyzing: boolean; startedAt: number | null }) => void;

interface InflightEntry {
  startedAt: number;
}

const inflight = new Map<string, InflightEntry>();
const listeners = new Map<string, Set<Listener>>();

const notify = (projectId: string) => {
  const ls = listeners.get(projectId);
  if (!ls || ls.size === 0) return;
  const entry = inflight.get(projectId);
  const payload = {
    analyzing: !!entry,
    startedAt: entry?.startedAt ?? null,
  };
  // 스냅샷으로 순회 — 콜백이 unsubscribe 를 호출해도 안전하도록.
  for (const listener of Array.from(ls)) {
    try {
      listener(payload);
    } catch (e) {
      console.warn("[briefAnalysisRegistry] listener threw:", (e as Error).message);
    }
  }
};

export const briefAnalysisRegistry = {
  isAnalyzing(projectId: string): boolean {
    return inflight.has(projectId);
  },
  startedAt(projectId: string): number | null {
    return inflight.get(projectId)?.startedAt ?? null;
  },
  /** 분석 시작 — 이미 진행 중이면 noop. */
  begin(projectId: string): void {
    if (inflight.has(projectId)) return;
    inflight.set(projectId, { startedAt: Date.now() });
    notify(projectId);
  },
  /** 분석 종료 — begin 없이 호출돼도 안전. */
  end(projectId: string): void {
    if (!inflight.has(projectId)) return;
    inflight.delete(projectId);
    notify(projectId);
  },
  subscribe(projectId: string, listener: Listener): () => void {
    let ls = listeners.get(projectId);
    if (!ls) {
      ls = new Set();
      listeners.set(projectId, ls);
    }
    ls.add(listener);
    return () => {
      const cur = listeners.get(projectId);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) listeners.delete(projectId);
    };
  },
};

export type BriefAnalysisRegistry = typeof briefAnalysisRegistry;
