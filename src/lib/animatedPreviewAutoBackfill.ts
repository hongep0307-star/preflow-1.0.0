/**
 * Library GIF animated-preview 자동 백필 스케줄러.
 *
 * `thumbnailAutoBackfill.ts` 의 자매 모듈. 정적 thumbnail 백필이 image/webp
 * 를 다루는 것과 달리, 이쪽은 `gif`(animated WebP/APNG 포함) 자료의 경량
 * animated 프리뷰(`preview.webp`, ≤360px·~12fps)를 채운다.
 *
 * 왜 필요한가:
 *   - 신규 업로드는 `uploadReferenceFile` 에서 프리뷰를 즉시 굽는다.
 *   - 하지만 (a) 기능 도입 이전 레거시 GIF, (b) main 프로세스가 프리뷰를
 *     생성하지 않는 Eagle import GIF 는 preview_url 이 비어 있다. 이들을
 *     진입 후 idle 시점에 *조용히* 백그라운드로 채운다.
 *
 * 정책(thumbnail 백필과 동일):
 *   - 동시성 1 — 디코드+WebP 인코드가 무거워 사용자 인터랙션과 메인스레드를
 *     다투지 않게 한 항목씩.
 *   - 진입 후 4초 지연 + requestIdleCallback — 첫 useMemo cascade / 스크롤
 *     jitter 가 가라앉은 뒤 시작.
 *   - workspace-scoped processed-ID set — 한 번 시도한 항목(성공/스킵/실패)
 *     은 다시 시도하지 않아 비용 누적을 막는다.
 *   - AbortSignal — LibraryPage unmount 또는 workspace 전환 시 즉시 정지.
 */

import {
  backfillAnimatedPreviews,
  selectAnimatedPreviewBackfillCandidates,
  type AnimatedPreviewBackfillItemEvent,
  type ReferenceItem,
} from "./referenceLibrary";
import { workspaceScopedKey } from "./workspaceScopedStorage";

/** thumbnail 백필과 분리된 별도 processed set — 두 백필은 대상/비용이 다르다. */
const PROCESSED_IDS_GLOBAL_KEY = "preflow.library.animatedPreviewAutoBackfill.processedIds";
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
    let arr = Array.from(ids);
    if (arr.length > PROCESSED_IDS_MAX) {
      arr = arr.slice(arr.length - PROCESSED_IDS_MAX);
    }
    window.localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* quota / private mode — best-effort */
  }
}

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

export interface ScheduleAnimatedPreviewAutoBackfillOptions {
  /** 각 항목 완료 시 호출. LibraryPage 는 이 hook 으로 카드의 preview_url 을
   *  in-place 교체해 사용자가 같은 세션 안에서 결과를 즉시 본다. */
  onItem?: (event: AnimatedPreviewBackfillItemEvent) => void;
  /** 모든 항목 처리 완료 시 호출. */
  onComplete?: () => void;
  /** 진입 후 시작 전 명시적 지연(ms). 기본 4000. */
  delayMs?: number;
}

/**
 * Library 진입 직후 호출해 idle 시점에 백그라운드 animated-preview 백필을 시작.
 * 반환값은 cancel 함수 — unmount/workspace 전환 cleanup 에서 호출.
 * 후보 0건이면 idle 잡도 스케줄하지 않고 즉시 no-op cancel 반환.
 */
export function scheduleAnimatedPreviewAutoBackfill(
  rows: ReferenceItem[],
  opts: ScheduleAnimatedPreviewAutoBackfillOptions = {},
): () => void {
  const candidates = selectAnimatedPreviewBackfillCandidates(rows);
  if (candidates.length === 0) return () => {};

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

      const sessionProcessed = new Set(processed);

      void backfillAnimatedPreviews({
        items: targets,
        concurrency: 1,
        signal: controller.signal,
        onItem: (event) => {
          sessionProcessed.add(event.item.id);
          writeProcessedIds(sessionProcessed);
          try {
            opts.onItem?.(event);
          } catch (err) {
            console.warn("[animatedPreviewAutoBackfill] onItem hook threw:", err);
          }
        },
      }).then(
        () => {
          try {
            opts.onComplete?.();
          } catch (err) {
            console.warn("[animatedPreviewAutoBackfill] onComplete hook threw:", err);
          }
        },
        (err) => {
          console.warn("[animatedPreviewAutoBackfill] failed:", err);
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
    void started;
  };
}
