/**
 * Classify Queue (Phase D3)
 *
 * 폴더 단위 Auto-classify(D2) 가 켜진 폴더로 새 항목이 import 되면
 * `enqueueClassify()` 가 호출돼 백그라운드 큐에 잡이 쌓인다. 동시 실행
 * 상한은 2 — OpenAI rate-limit 친화적이면서, 인스펙터에서 사용자가 직접
 * "Classify" 를 눌렀을 때도 자리가 비어 있도록(=수동 분류와 자동 분류가
 * 같은 쿼터를 두고 경합하지 않도록) 의도된 수치다.
 *
 * 책임 분리:
 *   - 큐는 단순한 in-memory FIFO. 영속화는 없다 — 새로고침 시 진행 중인
 *     잡은 모두 사라지지만, classification_status="pending" 이 DB 에
 *     기록돼 있어 사용자가 인스펙터에서 다시 트리거할 수 있다.
 *   - 각 잡은 항상 `classifyReference()` 를 호출하고, autoApplyTags 가
 *     true 면 후속으로 `acceptReferenceAiSuggestions()` 까지 이어 받는다
 *     (A1 변경 반영 — suggested_tags 만 적용, mood_labels 는 보존).
 *   - 워커는 항상 silent — 잡 실패는 `classifyReference` 가 DB 에
 *     "failed" 를 기록하고 throw 한다. 큐는 그걸 잡아 다음 잡으로 넘어가
 *     UI 단의 toast/error 처리는 호출부(LibraryPage) 가 subscribe 결과
 *     로 결정한다.
 */
import {
  acceptReferenceAiSuggestions,
  classifyReference,
  type ClassifyProgress,
  type ClassifyStage,
} from "./referenceAi";
import type { ReferenceItem } from "./referenceLibrary";
import type { AiOutputLanguage } from "./aiOutputLanguage";

/* 동시 실행 상한 — 자동 분류(폴더 Auto-classify) + 사용자가 직접 누른
 * 수동 분류가 같은 큐를 공유한다(Phase E). OpenAI rate-limit 친화적인 동시
 * 수치를 유지하면서, bulk 트리거(여러 자료 선택 후 한 번에 enqueue)도
 * 안전한 백그라운드 페이스로 흐르도록 한다. 필요 시 사용자 설정으로 노출
 * 가능하지만 현재는 코드 상수. */
const CONCURRENCY = 2;

export interface ClassifyQueueSnapshot {
  /** 큐에 들어가 있지만 아직 시작 안 한 잡 수. */
  pending: number;
  /** 워커가 잡고 실행 중인 잡 수 (0 ≤ running ≤ CONCURRENCY). */
  running: number;
}

interface QueueJob {
  item: ReferenceItem;
  autoApplyTags: boolean;
  /** 분석 결과의 *primary* 출력 언어 힌트. 두 언어 모두 항상 저장되므로
   *  LLM 에게 "어느 쪽 독자를 1순위로 가정해 다듬을지" 만 알려주는 역할. */
  language?: AiOutputLanguage;
  /** Accept(자동 tag 적용) 시 어떤 언어 배열을 `item.tags` 에 머지할지.
   *  미지정 시 영어 canonical. enqueue 시점의 effective tag language 를
   *  그대로 들고 간다. */
  tagLanguage?: AiOutputLanguage;
  /** 같은 item.id 가 두 번 enqueue 되지 않게 dedupe 키로 사용. */
  id: string;
  /** classifyReference 가 throw 했을 때 후속 처리에 활용할 ref. 현재는
   *  silent fail 정책이라 큐 자체에서는 쓰이지 않지만, 향후 retry 가
   *  필요할 때를 대비해 구조만 유지. */
  enqueuedAt: number;
  /** 처리 완료 후 외부에서 결과를 받고 싶을 때 쓸 수 있는 옵션
   *  콜백. 현재 LibraryPage 가 subscribe 로 진행 상태만 보지만, 자료
   *  목록 갱신용 hook 이 필요해질 때 여기에 wire 한다. */
  onSettled?: (result: { item?: ReferenceItem; error?: unknown }) => void;
  /** Phase E — 사용자가 수동 트리거한 잡에 대해 인스펙터/카드가 자료별
   *  진행 상태(stage / progress) 를 실시간으로 그릴 수 있게 콜백을
   *  forward 한다. 자동 큐(폴더 import) 잡은 미지정 — 어차피 UI 가
   *  보지 않으므로 비용 없음. */
  onStage?: (stage: ClassifyStage) => void;
  onProgress?: (progress: ClassifyProgress) => void;
}

const queue: QueueJob[] = [];
const inProgress = new Set<string>();
const subscribers = new Set<(snapshot: ClassifyQueueSnapshot) => void>();

function snapshot(): ClassifyQueueSnapshot {
  return { pending: queue.length, running: inProgress.size };
}

function notify(): void {
  const snap = snapshot();
  for (const cb of subscribers) {
    try {
      cb(snap);
    } catch {
      /* subscriber 의 예외가 큐 동작을 막지 않도록 격리. */
    }
  }
}

async function runJob(job: QueueJob): Promise<void> {
  inProgress.add(job.id);
  notify();
  try {
    /* classifyReference 자체가 DB 의 classification_status 를 pending→ready/
       failed 로 업데이트한다. 큐는 별도 status 를 두지 않고 그 결과를 그대로
       사용. onStage/onProgress 는 호출부(인스펙터/카드) 가 자료별 진행 상태
       를 그리는 데 forward 한다. */
    const next = await classifyReference(job.item, {
      language: job.language,
      onStage: job.onStage,
      onProgress: job.onProgress,
    });
    let finalItem = next;
    if (job.autoApplyTags) {
      try {
        finalItem = await acceptReferenceAiSuggestions(next, { tagLanguage: job.tagLanguage });
      } catch {
        /* tag 적용 실패는 분류 자체에 영향이 없으므로 silent. 사용자가
           나중에 인스펙터에서 수동 Accept 로 복구 가능. */
      }
    }
    job.onSettled?.({ item: finalItem });
  } catch (err) {
    /* 분류 실패는 DB 에 이미 "failed" 가 기록돼 있다. 큐는 다음 잡으로
       넘어가는 데 집중. */
    job.onSettled?.({ error: err });
  } finally {
    inProgress.delete(job.id);
    notify();
    pump();
  }
}

function pump(): void {
  while (inProgress.size < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    void runJob(job);
  }
  /* pump 가 새 잡을 띄울 때마다 pending/running 동시에 변할 수 있으므로
     호출자가 안 보고 가도 한 번 더 notify. (runJob 가 곧 다시 notify
     하지만, idempotent 라 비용 무시 가능.) */
  notify();
}

/** 한 자료를 백그라운드 분류 큐에 넣는다. 같은 item.id 가 이미 큐 안에
 *  있으면 (또는 in-flight) no-op — 짧은 시간 내 중복 enqueue 를 안전하게
 *  허용해 호출부가 idempotent 하게 짤 수 있다. */
export function enqueueClassify(
  item: ReferenceItem,
  options: {
    autoApplyTags?: boolean;
    language?: AiOutputLanguage;
    tagLanguage?: AiOutputLanguage;
    onSettled?: QueueJob["onSettled"];
    onStage?: QueueJob["onStage"];
    onProgress?: QueueJob["onProgress"];
  } = {},
): boolean {
  if (!item || !item.id) return false;
  if (inProgress.has(item.id)) return false;
  if (queue.some((j) => j.id === item.id)) return false;
  queue.push({
    item,
    autoApplyTags: !!options.autoApplyTags,
    language: options.language,
    tagLanguage: options.tagLanguage,
    id: item.id,
    enqueuedAt: Date.now(),
    onSettled: options.onSettled,
    onStage: options.onStage,
    onProgress: options.onProgress,
  });
  pump();
  return true;
}

/** 호출부가 "지금 큐 안에 들어 있는가" 를 가볍게 확인할 때 — 인스펙터의
 *  Run AI 버튼이 진행 중일 때 다시 누르지 않도록 disable 표시할 때 유용. */
export function isItemEnqueued(itemId: string): boolean {
  if (inProgress.has(itemId)) return true;
  return queue.some((j) => j.id === itemId);
}

/** 진행 상황 구독. cb 는 즉시 한 번(current snapshot) 호출되고, 이후 큐
 *  상태가 변할 때마다 다시 호출된다. unsubscribe 함수를 돌려준다 — React
 *  useEffect 의 cleanup 으로 그대로 사용 가능. */
export function subscribeClassifyQueue(
  callback: (snapshot: ClassifyQueueSnapshot) => void,
): () => void {
  subscribers.add(callback);
  try {
    callback(snapshot());
  } catch {
    /* 첫 호출 예외는 무시 — 구독은 유지된다. */
  }
  return () => {
    subscribers.delete(callback);
  };
}

/** 현재 큐 스냅샷 — useSyncExternalStore 같은 패턴 없이 한 번만 보고 싶을 때. */
export function getClassifyQueueSnapshot(): ClassifyQueueSnapshot {
  return snapshot();
}

/** 테스트 / 디버그 — 큐를 비운다 (in-flight 잡 까진 멈추지 않는다 — 그건
 *  classifyReference 자체의 abort 책임). */
export function _resetClassifyQueue(): void {
  queue.length = 0;
  notify();
}
