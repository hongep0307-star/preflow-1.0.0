import { supabase } from "@/lib/supabase";

// 같은 프로젝트로 짧은 시간 안에 들락날락(예: 탭 토글, 뒤로가기/앞으로가기)
// 할 때 매번 UPDATE 가 날아가지 않도록 클라이언트 사이드 throttle.
// 1 분 안에 다시 들어와도 DB 쓰기를 건너뛴다 — RECENT 정렬 정확도엔 영향
// 없을 정도의 해상도이고, 대신 sqlite write 와 캐시 invalidate 비용을 아낀다.
const THROTTLE_MS = 60_000;

const lastWriteAt = new Map<string, number>();

/** ProjectPage 마운트 직후에 한 번 호출해 `last_visited_at` 을 갱신.
 *
 *  - 1 분 throttle: 같은 projectId 에 대해 마지막 호출이 60s 이내면 no-op
 *  - fire-and-forget: 실패해도 토스트 띄우지 않음 (RECENT 가 한 칸 늦는 정도)
 *  - 대시보드 캐시는 건드리지 않음. RECENT 섹션은 다음 페이지 진입 때
 *    fetchData 가 새로 받아오는 row 로 갱신되므로 구태여 sessionStorage 를
 *    건드릴 필요가 없다 (오히려 stale 캐시와 race 위험만 늘어남).
 */
export function markProjectVisited(projectId: string | null | undefined): void {
  if (!projectId) return;
  const now = Date.now();
  const prev = lastWriteAt.get(projectId);
  if (prev !== undefined && now - prev < THROTTLE_MS) return;
  lastWriteAt.set(projectId, now);

  // supabase 클라이언트는 local-server 를 통한 RPC 래퍼. await 하지 않고
  // 던져두면 Promise rejection 이 unhandled 가 되어 console 에 빨간 줄이
  // 찍힐 수 있어 catch 만 비워둔다.
  void (async () => {
    try {
      await supabase
        .from("projects")
        .update({ last_visited_at: new Date().toISOString() } as Record<string, unknown>)
        .eq("id", projectId);
    } catch {
      // best-effort. RECENT 섹션이 한 박자 늦는 정도라 사용자에게 알리지 않음.
    }
  })();
}
