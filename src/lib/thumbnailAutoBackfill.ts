/**
 * Library 이미지 thumbnail 자동 백필 스케줄러.
 *
 * 배경:
 *   `OptimizeThumbnailsDialog` (D-2) 가 Settings 에 노출돼 사용자가 *수동으로*
 *   레거시 자료의 thumbnail 을 백필하는 구조였다. 하지만:
 *     - 신규 ingest 경로는 이미 thumbnail 을 자동 생성 (D-1).
 *     - 다이얼로그를 한 번 누르면 끝나는 *일회성* 마이그레이션인데, 사용자는
 *       "주기적으로 눌러야 하나?" 로 오해하기 쉽다.
 *     - 베타 초기 사용자 외엔 후보가 0 인 경우가 대다수라 UI 자체가 노이즈.
 *
 * 본 모듈은 LibraryPage 진입 직후 idle 시점에 *조용히* 한 번 돌아 레거시
 * 자료를 백그라운드에서 정리한다. 다이얼로그는 보험으로 Settings 에 남겨두되
 * 일반 사용자는 마주칠 일이 없게 만드는 것이 목표.
 *
 * 정책:
 *   - 동시성 1 — 카드 디코드/스크롤 같은 사용자 인터랙션과 메인스레드를
 *     공유하지 않게. 한 자료는 fetch + canvas decode + webp 인코드 + upload
 *     로 1~3 초 걸리므로 자연스럽게 페이싱이 된다.
 *   - 진입 후 4 초 지연 + `requestIdleCallback` — Library 진입 직후의
 *     useMemo cascade(필터/그룹/정렬 9 개) 가 끝난 뒤에야 시작.
 *   - workspace-scoped processed-ID set — 한 번 시도한 항목(성공/스킵/실패
 *     무관) 은 다시 시도하지 않는다. 실패 항목이 매 세션 fetch 를 재시도
 *     해 비용을 누적하는 것을 막는다. 사용자가 실패 항목을 재시도하고
 *     싶을 땐 다이얼로그를 통해 강제 실행 (보험 경로).
 *   - AbortSignal — LibraryPage unmount 또는 workspace 전환 시 즉시 정지.
 *
 * 비-목적:
 *   - 사용자에게 진행률을 노출하지 않는다. UI 가 떠야 할 만큼 큰 작업이면
 *     보험 다이얼로그가 더 적합하다.
 *   - 새 ingest 경로의 빈 자리를 메우는 것이 아니다 (그건 `createUploadedReference`
 *     본체에서 처리). 본 모듈은 *과거에 등록된* 자료의 정리만 담당.
 */

import {
  backfillImageThumbnails,
  selectThumbnailBackfillCandidates,
  type ReferenceItem,
  type ThumbnailBackfillItemEvent,
} from "./referenceLibrary";
import { workspaceScopedKey } from "./workspaceScopedStorage";

/** Workspace 가 다르면 라이브러리가 완전히 별개이므로 processed set 도
 *  scoped 키로 분리. 키 미정(워크스페이스 ID 미로딩) 일 땐 read/write 모두
 *  no-op 처리해 안전하게 미시작. */
const PROCESSED_IDS_GLOBAL_KEY = "preflow.library.thumbnailAutoBackfill.processedIds";

/** localStorage 에 저장되는 set 의 최대 크기. 이 한계를 넘으면 가장 오래된
 *  ID 부터 잘라낸다 — 무한 증가 방지. 자료 1 만건 기준 ID 가 36자 UUID 면
 *  ~360KB 로 localStorage 안전 범위 안. 그래도 보수적으로 50_000 캡. */
const PROCESSED_IDS_MAX = 50_000;

function readProcessedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const key = workspaceScopedKey(PROCESSED_IDS_GLOBAL_KEY);
  if (!key) return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeProcessedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  const key = workspaceScopedKey(PROCESSED_IDS_GLOBAL_KEY);
  if (!key) return;
  try {
    // 한계 초과 시 가장 먼저 들어온 항목부터 잘라낸다(insertion 순서 = Set
    // iteration 순서). 데이터 손실의 의미는 "다음 세션에서 재시도될 수 있음"
    // 정도라 큰 문제 없다.
    let arr = Array.from(ids);
    if (arr.length > PROCESSED_IDS_MAX) {
      arr = arr.slice(arr.length - PROCESSED_IDS_MAX);
    }
    window.localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* quota / private mode — best-effort, in-memory state 가 살아 있으면 같은
       세션 안에선 정상 동작 */
  }
}

/** requestIdleCallback 폴백. pagePrefetch / LibraryPage 의 runIdle 과 같은
 *  패턴. 안전하게 setTimeout 폴백을 둔다. */
function scheduleIdle(cb: () => void, timeout = 5000): number {
  const idle = (globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  }).requestIdleCallback;
  if (idle) return idle(cb, { timeout });
  return (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout(cb, 0) as unknown as number;
}

function cancelIdle(handle: number): void {
  const cancel = (globalThis as unknown as {
    cancelIdleCallback?: (id: number) => void;
  }).cancelIdleCallback;
  if (cancel) cancel(handle);
  else (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout(handle);
}

export interface ScheduleThumbnailAutoBackfillOptions {
  /** 각 항목 완료 시 호출되는 hook. LibraryPage 는 이 hook 으로 카드의
   *  thumbnail_url 을 in-place 교체해 사용자가 같은 세션 안에서 결과를
   *  즉시 본다. */
  onItem?: (event: ThumbnailBackfillItemEvent) => void;
  /** 모든 항목 처리 완료 시 호출. LibraryPage 는 캐시 flush 등에 사용. */
  onComplete?: () => void;
  /** 진입 후 시작 전 명시적 지연(ms). 기본 4000 — useMemo cascade + 첫
   *  스크롤 jitter 가 가라앉을 시간. */
  delayMs?: number;
}

/**
 * Library 진입 직후 호출해 idle 시점에 백그라운드 thumbnail 백필을 시작한다.
 *
 * 반환값은 *cancel 함수* — LibraryPage unmount 또는 workspace 전환 cleanup
 * 에서 호출하면 (a) 아직 시작 안 한 idle 잡 취소 (b) 시작했으면 AbortSignal
 * 로 다음 자료부터 정지.
 *
 * 후보가 0 건이면 idle 잡도 스케줄하지 않고 즉시 no-op cancel 반환 — 첫
 * 진입 비용을 최소화.
 */
export function scheduleThumbnailAutoBackfill(
  rows: ReferenceItem[],
  opts: ScheduleThumbnailAutoBackfillOptions = {},
): () => void {
  const candidates = selectThumbnailBackfillCandidates(rows);
  if (candidates.length === 0) return () => {};

  // 이미 한 번 시도한 항목은 건너뛴다. 성공 항목은 thumbnail_url 이 file_url
  // 과 달라져 selectThumbnailBackfillCandidates 에서 자동 제외되므로 여기에
  // 다시 나올 일이 없지만, skipped/failed 항목은 후보로 계속 잡혀 매 세션
  // 비용을 누적할 위험이 있다. processed-ID set 으로 차단.
  const processed = readProcessedIds();
  const targets = candidates.filter((c) => !processed.has(c.id));
  if (targets.length === 0) return () => {};

  const controller = new AbortController();
  let timeoutHandle: number | null = null;
  let idleHandle: number | null = null;
  let started = false;

  const delayMs = Math.max(0, opts.delayMs ?? 4000);

  timeoutHandle = (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout(() => {
    timeoutHandle = null;
    if (controller.signal.aborted) return;
    idleHandle = scheduleIdle(() => {
      idleHandle = null;
      if (controller.signal.aborted) return;
      started = true;

      // 처리된 ID 를 in-memory 로 모아 두고 한 항목 끝날 때마다 localStorage
      // 에 flush. write 비용은 작지만 백필 자체가 1~3 초/항목 페이스라
      // overhead 무시 가능. 중간에 앱이 강제 종료돼도 마지막 항목까지의
      // 진행이 보존된다.
      const sessionProcessed = new Set(processed);

      void backfillImageThumbnails({
        items: targets,
        concurrency: 1,
        signal: controller.signal,
        onItem: (event) => {
          sessionProcessed.add(event.item.id);
          writeProcessedIds(sessionProcessed);
          try {
            opts.onItem?.(event);
          } catch (err) {
            // 사용자 hook 실패가 백필 자체를 멈추지 않도록 격리.
            console.warn("[thumbnailAutoBackfill] onItem hook threw:", err);
          }
        },
      }).then(
        () => {
          try {
            opts.onComplete?.();
          } catch (err) {
            console.warn("[thumbnailAutoBackfill] onComplete hook threw:", err);
          }
        },
        (err) => {
          // backfillImageThumbnails 자체가 throw 하는 케이스는 거의 없지만
          // 안전망. abort 는 throw 가 아니라 단순 조기 종료라서 여기 안 옴.
          console.warn("[thumbnailAutoBackfill] failed:", err);
        },
      );
    });
  }, delayMs) as unknown as number;

  return () => {
    controller.abort();
    if (timeoutHandle !== null) {
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (idleHandle !== null) {
      cancelIdle(idleHandle);
      idleHandle = null;
    }
    // 이미 시작된 경우엔 controller.abort 가 다음 자료부터 정지를 보장.
    void started;
  };
}
