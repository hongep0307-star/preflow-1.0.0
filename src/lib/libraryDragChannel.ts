// 라이브러리 카드 드래그 동안 *같은 렌더러* 내부에서 의도(폴더 이동 /
// 카드 재정렬) 를 알리기 위한 사이드 채널 + 글로벌 dragover/dragend tracker.
//
// 왜 필요한가:
//   HTML5 native DnD 의 `DataTransfer.getData("application/x-preflow-...")`
//   는 *drop* 이벤트에서만 읽을 수 있고, *dragover* / *dragenter* 에서는
//   브라우저 보안 정책상 빈 문자열을 반환한다(외부 드래그가 페이지에
//   진입하기 전 컨텐츠를 미리 보지 못하게 차단). 폴더 행이 hover 중에
//   "이 드래그는 내부 카드 드래그라 활성 시각을 켜야 한다" 를 판단하려면
//   *그 시점에* 페이로드를 읽을 수 있어야 한다 → JS 모듈 전역 변수로
//   해결.
//
//   추가로, image kind 에 한해 외부 OLE export 를 살리려면 dragstart 의
//   dataTransfer 에 image MIME 을 가리키는 `text/uri-list` 를 박아 Chromium
//   "image-content 모드" 를 강제해야 한다. 그러면 외부 destination 은
//   파일을 수신하지만, 같은 윈도우 안에서 fire 되어야 할 native onDrop /
//   onDragOver 이벤트가 image-content 모드에 가려 fire 되지 않거나 막혀
//   내부 폴더/카드 드롭이 깨진다.
//
//   이 fallback 을 위해 글로벌 `installDragTracker` 가 document capture 단계
//   에서 dragover/dragend/drop 을 가로채 좌표 → elementFromPoint →
//   data-attribute 로 대상(폴더/카드)을 식별한다. dragend 시 마지막 hover
//   대상을 등록된 dispatch 핸들러(`setLibraryDropHandlers`) 로 라우팅하면
//   onDrop 의존 없이 폴더 이동/카드 재정렬을 처리할 수 있다.
//
// 라이프사이클:
//   - LibraryCard 가 `onDragStart` 시점에 setActiveLibraryDrag({ ids,
//     sourceItem }) + installDragTracker(ids).
//   - FolderRow / LibraryCard / LibraryGrid 의 onDragOver 가 hasActiveDrag()
//     로 내부 드래그인지 확인. 외부(OS) 드래그면 false.
//   - tracker 가 dragover 마다 hover target 을 publish — FolderRow /
//     LibraryCard 가 subscribeDragHover 로 시각 자동 동기화.
//   - dragend 시 tracker 가 등록된 핸들러로 dispatch (single source of truth).
//   - native onDrop 핸들러는 dispatch 하지 않고 시각만 정리한다 — image-mode
//     케이스에서 fire 되지 않을 수 있고, fire 되어도 tracker dispatch 와
//     중복되므로.
//   - `onDragEnd` 또는 tracker dispose 가 끝난 뒤 clearActiveLibraryDrag().
//
// 단일 렌더러 단일 활성 드래그 가정. multi-window/iframe 은 우리 앱 범위
// 밖이며, 한 드래그가 동시에 두 개 진행되는 케이스는 OS 자체가 만들 수
// 없다.

import type { ReferenceItem } from "@/lib/referenceLibrary";

export interface ActiveLibraryDrag {
  /** 함께 옮겨질 reference id 들. 단일 카드 드래그면 [id] 한 개. */
  ids: string[];
  /** 드래그 시작점의 원본 카드. 마지막에 hovering 시각이 활성 카드 자기
   *  자신에는 켜지지 않도록(자기로 떨어뜨릴 의미 없음) self-check 에 쓴다. */
  sourceItem: ReferenceItem;
  /** 같은 윈도우에서 시작된 드래그임을 표시. external OS drag(예: 탐색기
   *  → 라이브러리) 와 구분하기 위해 별도 마커는 필요 없지만, 명시적으로
   *  들고 있어 디버깅이 쉽다. */
  startedAt: number;
}

let _active: ActiveLibraryDrag | null = null;

export function setActiveLibraryDrag(drag: ActiveLibraryDrag): void {
  _active = drag;
}

export function getActiveLibraryDrag(): ActiveLibraryDrag | null {
  return _active;
}

export function clearActiveLibraryDrag(): void {
  _active = null;
}

/** dragover/dragenter 의 시각 표시 게이팅용 단축 함수. */
export function hasActiveLibraryDrag(): boolean {
  return _active !== null;
}

/** drop / dragover 에서 "이 드래그가 내부 reference 인가" 를 빠르게 본다.
 *  dataTransfer.types 는 dragover 에서도 읽을 수 있으므로(키 이름만 노출,
 *  값은 가려짐), MIME 이름만으로도 1차 판정 가능 — 사이드 채널과 함께
 *  중복 가드를 두면 외부 드래그 오인 사고가 거의 없다. */
export const INTERNAL_DRAG_MIME = "application/x-preflow-references";

// ────────────────────────────────────────────────────────────────────────
// 글로벌 dragover/dragend tracker
// ────────────────────────────────────────────────────────────────────────

/** 글로벌 hover target — 사용자가 현재 드래그 cursor 아래 둔 폴더/카드/브리프매치 앵커. */
export type DropTarget =
  | { kind: "folder"; path: string }
  | { kind: "card"; id: string }
  | { kind: "briefAnchor" }
  | { kind: "briefImage" }
  | { kind: "variationInject" };

export interface LibraryDropHandlers {
  /** 폴더 위에서 release — 카드들이 그 폴더로 이동.
   *  additive=true (Ctrl/⌘ 누른 채 드롭) 이면 기존 폴더 소속을 유지하고
   *  대상 폴더에도 *추가*(다중 소속). false 면 기존 동작인 이동(교체). */
  onFolderDrop: (ids: string[], path: string, additive: boolean) => void;
  /** 다른 카드 직전 위치로 release — manual reorder. */
  onCardDrop: (ids: string[], targetCardId: string) => void;
  /** Brief Match 플라이아웃의 앵커 드롭존 위에서 release — 카드들을 앵커로 추가.
   *  (image-mode 카드도 native onDrop 없이 이 경로로 안정적으로 받기 위함) */
  onBriefAnchorDrop?: (ids: string[]) => void;
  /** Brief Match 플라이아웃의 브리프 이미지 드롭존 위에서 release — 카드들을
   *  브리프 이미지(분석 입력)로 추가. */
  onBriefImageDrop?: (ids: string[]) => void;
  /** Variation 플라이아웃의 참조 주입 드롭존 위에서 release — 카드들을 변형
   *  참조 이미지로 추가. (image-mode 카드도 native onDrop 없이 이 경로로 수신) */
  onVariationInjectDrop?: (ids: string[]) => void;
}

let _dropHandlers: LibraryDropHandlers | null = null;

/** LibraryPage 가 mount 시 등록. tracker 의 dragend 가 이 핸들러를 호출. */
export function setLibraryDropHandlers(handlers: LibraryDropHandlers | null): void {
  console.warn("[Tracker] setLibraryDropHandlers " + (handlers ? "registered" : "cleared"));
  _dropHandlers = handlers;
}

let _hoverTarget: DropTarget | null = null;
const _hoverSubscribers: Set<(target: DropTarget | null) => void> = new Set();

function describeTarget(target: DropTarget | null): string {
  if (!target) return "null";
  if (target.kind === "folder") return `folder:${target.path}`;
  if (target.kind === "card") return `card:${target.id}`;
  if (target.kind === "briefImage") return "briefImage";
  if (target.kind === "variationInject") return "variationInject";
  return "briefAnchor";
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") return a.path === b.path;
  if (a.kind === "card" && b.kind === "card") return a.id === b.id;
  // 인자 없는 kind 들(briefAnchor/briefImage/variationInject)은 kind 일치만으로 동일.
  return true;
}

function publishHover(target: DropTarget | null): void {
  if (sameTarget(_hoverTarget, target)) return;
  console.warn("[Tracker] hover " + describeTarget(target));
  _hoverTarget = target;
  for (const sub of _hoverSubscribers) {
    try {
      sub(target);
    } catch {
      /* subscriber throw 가 다른 subscribers 에 영향 주지 않게 */
    }
  }
}

/** FolderRow / LibraryCard 가 hover 시각을 자동으로 따라가게 하기 위한
 *  구독. 반환된 함수를 호출하면 구독 해제. React 컴포넌트는 useEffect
 *  안에서 useState setter 를 호출해 자기 시각만 토글하면 된다. */
export function subscribeDragHover(cb: (target: DropTarget | null) => void): () => void {
  _hoverSubscribers.add(cb);
  return () => {
    _hoverSubscribers.delete(cb);
  };
}

export function getDragHoverTarget(): DropTarget | null {
  return _hoverTarget;
}

// ────────────────────────────────────────────────────────────────────────
// copy modifier (Ctrl / ⌘) — 폴더 드롭을 "이동" 대신 "추가"(다중 소속) 로.
// ────────────────────────────────────────────────────────────────────────
//
// 드래그 중 dragover/dragend/drop 의 keyState 를 추적해 publish. FolderRow 가
// 구독해 hover 시각을 "추가" 모드로 바꾸고, tracker dispatch 가 onFolderDrop
// 의 additive 인자로 넘긴다. Win 은 Ctrl, mac 은 ⌘(metaKey) 관습 둘 다 수용.

let _copyModifier = false;
const _copyModifierSubscribers: Set<(copy: boolean) => void> = new Set();

export function getCopyModifier(): boolean {
  return _copyModifier;
}

/** FolderRow 가 hover 시각(이동 vs 추가)을 동기화하기 위한 구독. */
export function subscribeCopyModifier(cb: (copy: boolean) => void): () => void {
  _copyModifierSubscribers.add(cb);
  return () => {
    _copyModifierSubscribers.delete(cb);
  };
}

function setCopyModifier(copy: boolean): void {
  if (_copyModifier === copy) return;
  _copyModifier = copy;
  for (const sub of _copyModifierSubscribers) {
    try {
      sub(copy);
    } catch {
      /* subscriber throw 격리 */
    }
  }
}

/** elementFromPoint(x, y) 결과의 ancestor 를 타고 올라가며 등록된 drop
 *  target attribute (data-drop-folder-path / data-drop-card-id) 를 찾는다.
 *  attribute 우선순위는 *카드 > 폴더* — 카드가 폴더 안에 nested 된 케이스가
 *  없지만, 사이드바 폴더 위에 다른 우연한 카드가 떠 있을 가능성을 보호. */
function detectTargetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  // Brief Match 앵커 드롭존은 그리드 위에 떠 있는(overlay) 패널이므로 가장 먼저
  // 검사한다 — 그 아래에 카드가 있어도 앵커 드롭이 우선되어야 한다.
  const briefAnchor = el.closest<HTMLElement>("[data-drop-brief-anchor]");
  if (briefAnchor) return { kind: "briefAnchor" };
  const briefImage = el.closest<HTMLElement>("[data-drop-brief-image]");
  if (briefImage) return { kind: "briefImage" };
  // Variation 플라이아웃의 참조 주입 드롭존도 그리드 위에 떠 있는 overlay 라
  // 카드보다 먼저 검사한다.
  const variationInject = el.closest<HTMLElement>("[data-drop-variation-inject]");
  if (variationInject) return { kind: "variationInject" };
  const card = el.closest<HTMLElement>("[data-drop-card-id]");
  if (card) {
    const id = card.getAttribute("data-drop-card-id");
    if (id) return { kind: "card", id };
  }
  const folder = el.closest<HTMLElement>("[data-drop-folder-path]");
  if (folder) {
    const path = folder.getAttribute("data-drop-folder-path");
    if (path !== null) return { kind: "folder", path };
  }
  return null;
}

export interface DragTrackerHandle {
  dispose: () => void;
}

/** 모듈 레벨 단일 tracker 보장 — 이전 dragstart 의 tracker 가 어떤 사유로
 *  dispose 안 된 채 listener 가 살아있는 leak 을 차단한다.
 *
 *  Windows OLE + Electron `webContents.startDrag` 환경에서는 HTML5 dragend
 *  가 fire 되지 않는 알려진 quirk 가 있다. 그러면 LibraryCard.handleDragEnd
 *  도 호출되지 않아 trackerRef 가 정리되지 않고, 그 다음 dragstart 의 새
 *  tracker 가 install 되면 두 개의 listener 가 한 이벤트를 동시에 받는다 —
 *  dispatch 가 두 번 trigger 되어 reorder/move 가 두 번 적용되거나, dispatched
 *  플래그가 instance 별이라 정렬 결과가 비결정적으로 깨진다.
 *
 *  새 install 직전에 이전 tracker 를 강제 dispose 해 항상 *하나의 tracker* 만
 *  document listener 를 갖게 보장한다. */
let _activeTracker: DragTrackerHandle | null = null;

/** dragstart 시점에 호출. document 의 dragover/dragend/drop 을 capture 단계
 *  로 listen 해 좌표 기반 hover target 을 publish 한다. dragend 시 등록된
 *  drop handler 를 호출하고 자기 자신을 정리한다.
 *
 *  ids 는 옮길 카드 id 들. self-drop (자기 카드에 자기를 떨어뜨리는 무의미
 *  케이스) 를 가드하기 위해 tracker 가 들고 있는다. */
export function installDragTracker(ids: string[]): DragTrackerHandle {
  // 이전 tracker leak 방어 — 새 install 전에 강제 정리.
  if (_activeTracker) {
    console.warn("[Tracker] previous tracker still active — force dispose");
    _activeTracker.dispose();
    _activeTracker = null;
  }

  let disposed = false;
  let dispatched = false;

  /* body cursor override 시도 — image-content 모드의 not-allowed cursor 를
   * webview 레벨에서 강제로 덮어쓸 수 있는지 실험. OS 레벨 cursor 라면
   * 무시되지만 webview 레벨이면 valid target hover 동안 "copy" 시각이
   * 유지된다. drag 종료 후 cleanup 에서 원복. */
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = "copy";

  // 마지막 dragover 에서 본 copy modifier 상태. drop/dragend 이벤트의 ctrlKey 는
  // Electron/Chromium 에서 종종 false 로 보고되는(터미널 이벤트가 modifier 를
  // 안 싣는) 알려진 quirk 가 있어, dispatch 시점엔 *이 값* 을 신뢰한다. dragover
  // 는 release 직전까지 고빈도로 발화하므로 가장 정확한 최신 상태다.
  let lastCopyModifier = false;

  const handleDragOver = (event: globalThis.DragEvent) => {
    if (disposed) return;
    // Ctrl(Win) / ⌘(mac) 누름 상태를 실시간 추적 — 폴더 hover 시각 "추가" 모드.
    lastCopyModifier = event.ctrlKey || event.metaKey;
    setCopyModifier(lastCopyModifier);
    const target = detectTargetAt(event.clientX, event.clientY);
    publishHover(target);
    /* hover target 별로 cursor 갱신 — valid target 이면 copy, 무효 영역이면
     * default 로 잠시 풀어 사용자가 valid 영역으로 다시 들어왔을 때 cursor
     * 변화가 시각 신호가 되도록. */
    document.body.style.cursor = target ? "copy" : "auto";
    /* cursor 시각 회복 — image-mode (Chromium 이 dataTransfer 에 image MIME
     * URL 을 보고 image-content 모드로 승격) 환경에서는 native onDragOver
     * 의 preventDefault 가 가려져 "이 요소는 drop target 이 아니다" 시각
     * (금지 아이콘) 이 떠 사용자가 release 를 안 하고 도중 취소한다.
     *
     * 글로벌 tracker 가 capture phase 에서 *우리 윈도우 안의* 모든 dragover
     * 를 받으니, valid drop target 위에 있을 때만 preventDefault + dropEffect
     * 를 직접 박아 cursor 를 "이동 가능" 으로 표시한다. 외부 destination
     * (Slack/Photoshop/탐색기) 위에서는 우리 document 의 dragover 가 애초
     * 발생하지 않아 OLE 흐름엔 영향이 없다. */
    if (target && event.dataTransfer) {
      event.preventDefault();
      try {
        /* dropEffect = "copy" — dragstart 의 effectAllowed="copy" 와 짝.
         * image-mode 는 "copy" 만 호환되므로 통일. 내부 의미는 "이동" 이지만
         * cursor 만 "+ 복사" 시각이 된다 (실제 dispatch 는 변하지 않음). */
        event.dataTransfer.dropEffect = "copy";
      } catch {
        /* 일부 환경은 dropEffect 쓰기를 막을 수 있어 silently 무시. */
      }
    }
  };

  const dispatch = (cause: "dragend" | "drop") => {
    if (dispatched) {
      console.warn("[Tracker] dispatch skip (already) cause=" + cause);
      return;
    }
    const target = _hoverTarget;
    const handlers = _dropHandlers;
    console.warn(
      "[Tracker] dispatch cause=" + cause +
        " target=" + describeTarget(target) +
        " hasHandlers=" + Boolean(handlers) +
        " ids=" + ids.length,
    );
    if (!target || !handlers) return;
    dispatched = true;
    if (target.kind === "folder") {
      handlers.onFolderDrop(ids, target.path, _copyModifier);
    } else if (target.kind === "card") {
      if (ids.includes(target.id)) return;
      handlers.onCardDrop(ids, target.id);
    } else if (target.kind === "briefAnchor") {
      handlers.onBriefAnchorDrop?.(ids);
    } else if (target.kind === "briefImage") {
      handlers.onBriefImageDrop?.(ids);
    } else if (target.kind === "variationInject") {
      handlers.onVariationInjectDrop?.(ids);
    }
  };

  const handleDragEnd = (event: globalThis.DragEvent) => {
    if (disposed) return;
    // 종료 이벤트의 ctrlKey 는 신뢰하지 않는다(Electron 에서 false 로 오는 quirk).
    // 마지막 dragover 가 잡은 값을 OR 로 보강만 — true 면 채택, false 면 그대로.
    if (event.ctrlKey || event.metaKey) lastCopyModifier = true;
    setCopyModifier(lastCopyModifier);
    dispatch("dragend");
    cleanup();
  };

  const handleDrop = (event: globalThis.DragEvent) => {
    /* drop 이 image-mode 환경에서 fire 되는 경우도 있어 같은 dispatch 를
     * 시도. dispatched 플래그로 중복 방지. dragend 가 곧 따라 fire 되어
     * cleanup 까지 보장된다. */
    if (disposed) return;
    if (event.ctrlKey || event.metaKey) lastCopyModifier = true;
    setCopyModifier(lastCopyModifier);
    dispatch("drop");
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("dragover", handleDragOver, true);
    document.removeEventListener("dragend", handleDragEnd, true);
    document.removeEventListener("drop", handleDrop, true);
    publishHover(null);
    setCopyModifier(false);
    document.body.style.cursor = prevCursor;
    if (_activeTracker === handle) {
      _activeTracker = null;
    }
    console.warn("[Tracker] disposed dispatched=" + dispatched);
  };

  document.addEventListener("dragover", handleDragOver, true);
  document.addEventListener("dragend", handleDragEnd, true);
  document.addEventListener("drop", handleDrop, true);
  console.warn("[Tracker] installed ids=" + ids.length);

  const handle: DragTrackerHandle = { dispose: cleanup };
  _activeTracker = handle;
  return handle;
}
