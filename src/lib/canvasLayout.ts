/**
 * Library Canvas 뷰 — 폴더별 자유 배치 레이아웃 영구화.
 *
 * 폴더 콘텐츠는 grid/list/canvas 어느 뷰에서든 동일하다. 캔버스는 단지
 * "이 ref 가 무한 평면 위 어디에 놓이는가" 를 보조 메타데이터로 가진다.
 * 따라서 이 저장소가 단독으로 ref 를 소유하거나 삭제하지 않는다.
 *
 * 저장 위치 — 워크스페이스 DB(공유 레이아웃):
 *   원래는 렌더러 localStorage 에만 있어서 *PC 마다 따로* 였다. OneDrive 로
 *   워크스페이스 폴더를 공유해도 캔버스 배치/노트/연결선은 건너가지 않는
 *   누락이 있었다. 이제 워크스페이스 폴더 안의 preflow.db(canvas_layouts
 *   테이블) 로 승격해, 같은 폴더를 연결한 모든 PC 가 *동일한 공유 레이아웃* 을
 *   본다(맥 ↔ 윈도우 포함). 단, 갈래 A 의 "교대 사용" 전제는 그대로 — 두 PC
 *   가 동시에 편집하면 마지막 저장이 이긴다.
 *
 * 동기 API + 비동기 영속화:
 *   기존 호출부(LibraryCanvas/LibraryPage/Pack 다이얼로그) 는 모두 동기
 *   함수를 기대한다. 그래서 이 모듈은 메모리 캐시(`cache`) 를 authoritative
 *   진실원으로 들고, 부팅 시 1 회 DB 에서 hydrate 한다. 모든 read 는 캐시에서
 *   동기로 반환하고, write 는 캐시를 동기로 갱신한 뒤 변경분을 debounce 해
 *   DB 로 flush 한다(전용 /canvas/save 라우트). 페이지 reload(워크스페이스
 *   전환) 직전엔 pagehide 에서 keepalive flush 로 보존한다.
 *
 * 컨텍스트 키 정책:
 *   - manualOrder.ts 의 `deriveLibraryContextKey` 결과를 그대로 사용한다.
 *     실제로는 폴더 컨텍스트(`tag:folder:<path>`) 에서만 쓰지만, 키 형식을
 *     공유해야 향후 두 영구화의 의미가 어긋나지 않는다.
 *   - 폴더 rename/delete 시 cascade* 헬퍼로 prefix 일괄 갱신/정리.
 *     (folderPreferences.cascadeRenameFolderPrefs / folderManualOrder
 *      .cascadeRenameFolderManualOrder 와 동일 패턴.)
 */

import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

import { ensureWorkspacesLoaded } from "./workspaceClient";
import {
  migrateGlobalToScopedIfDefault,
  workspaceScopedKey,
} from "./workspaceScopedStorage";

// 레거시 localStorage 키 — DB 가 비어 있을 때 1 회 마이그레이션에만 사용.
const KEY = "preflow.library.canvasLayout";

/** 같은 윈도우 내 캔버스 레이아웃 변경 동기화용 커스텀 이벤트. detail.source 로
 *  발화자 식별 — 자기 자신의 변경을 무한 루프 없이 무시할 수 있다. */
export const CANVAS_LAYOUT_CHANGED_EVENT =
  "preflow:library-canvas-layout-changed";

/** 캔버스 위 단일 ref 의 비파괴 자르기 영역. 0..1 비율로 ref 박스 안쪽
 *  좌/상/우/하에서 잘라낼 양. 모두 0 이면 자르기 없음(=원본). 합 ≥ 1 이면
 *  결과가 0 px 이 되므로 호출자(crop UI) 가 0..0.9 사이로 clamp 한다.
 *  파일은 절대 건드리지 않고 표시 시 `clip-path` + `transform: scale` 로
 *  마치 잘린 것처럼 보이게 한다. */
export interface CanvasItemCrop {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** 캔버스 위 단일 ref 의 transform. 좌표는 캔버스(월드) 좌표계 픽셀.
 *  x/y 는 좌상단. w/h 는 *표시* 크기(원본 해상도 아님). rotation 은 라디안.
 *
 *  v2 추가 필드(전부 optional, 미지정 시 기존 동작과 동일):
 *    - groupId: 하드 그룹의 식별자. 같은 groupId 인 아이템들은 한 아이템을
 *      선택하면 자동으로 함께 선택돼 한 단위로 이동/스케일/회전된다.
 *    - hidden: true 면 캔버스에서 비표시 + hit-test 제외. ref 자체는 그대로.
 *    - opacity / grayscale / invert / borderRadius / borderWidth / shadow:
 *      per-item 시각 효과. CSS filter / border-radius / box-shadow 로 표시.
 *    - crop: 비파괴 자르기 영역(0..1 비율). 표시 시 clip-path 로 잘린 영역만
 *      보여준다. 원본 파일은 그대로. */
export interface CanvasItemTransform {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipH?: boolean;
  flipV?: boolean;
  zIndex: number;
  locked?: boolean;
  groupId?: string;
  hidden?: boolean;
  opacity?: number;
  grayscale?: boolean;
  invert?: boolean;
  borderRadius?: number;
  borderWidth?: number;
  shadow?: boolean;
  crop?: CanvasItemCrop;
  /** crop 좌표계 식별 — v2: w/h 가 *시각적으로 보이는 영역* 크기이고 crop 은
   *  "원본 이미지의 어느 부분을 wrapper 안에 보일지" 의미. v1(legacy, 필드 없음
   *  또는 false): w/h 가 원본 외곽이고 crop 은 wrapper 안 inset offset 의미.
   *  getCanvasLayout 시 v1 → v2 1회 자동 마이그레이션. */
  cropBaked?: boolean;
}

/** 캔버스 위 자유 텍스트 노트. ref 와 같은 transform 시스템을 공유.
 *
 *  서식 필드(bold/italic/underline/color/bgColor/align)는 *전체 노트 단위* 로
 *  적용된다 — per-character 리치 텍스트가 아니라 한 노트 안의 모든 글자가
 *  같은 스타일을 공유. contentEditable 의 IME 안정성과 영구화 단순함을 우선.
 *
 *  @deprecated linkedRefIds: 노트→ref 단방향 링크. 신규 코드는
 *  `CanvasLayout.connections` 를 사용한다. `getCanvasLayout` 이 로드 시
 *  1회 마이그레이션한 뒤 다음 저장 때 비워진다 (호환성 유지를 위해 필드는
 *  남김). */
export interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  rotation: number;
  zIndex: number;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  /** 하드 그룹 식별자 — CanvasItemTransform.groupId 와 *같은 네임스페이스* 를
   *  공유한다. 같은 groupId 를 가진 아이템(이미지/영상)과 노트는 한 단위로
   *  선택·이동되어, 노트도 이미지처럼 그룹에 섞여 묶일 수 있다. 미지정이면
   *  그룹에 속하지 않은 평범한 노트(기존 동작). */
  groupId?: string;
  /** 첨부 URL (http/https). 노트 우상단에 작은 link 인디케이터가 뜨고 클릭하면
   *  기본 브라우저로 열린다. NoteToolbar 의 Link 팝오버에서 입력/수정/삭제.
   *  비어 있으면 노트는 평범한 텍스트 노트. */
  url?: string;
  /** 노드 그래프에서 이 노트가 맡는 의미 역할(노드 에디터 v2).
   *   - "prompt": AI 생성 노드의 프롬프트 입력으로 쓰이는 카드. 시각적으로
   *     구분되며, `linkType:"input"` 연결로 생성 노드에 텍스트를 공급한다.
   *   - "param": 생성 파라미터(설정) 입력 카드 (향후).
   *   - "label": 그래프 주석/라벨 용도.
   *  미지정이면 평범한 텍스트 노트(기존 동작). */
  role?: "prompt" | "label" | "param";
  /** @deprecated 사용 안 함 — `CanvasLayout.connections` 로 마이그레이션됨. */
  linkedRefIds?: string[];
}

/** 객체(노트/미디어) 로컬 좌표 (0..1, 0..1) — 좌상=0,0 우하=1,1.
 *  객체 박스 비율 기준이라 회전/리사이즈에도 자연스럽게 따라간다.
 *
 *  값 도메인: 8 슬롯 중 하나의 (u,v).
 *    슬롯 = 0/0.5/1 의 모든 조합 8 점 (정중앙 (0.5,0.5) 은 제외).
 *  자유 위치 anchor 는 더 이상 생성되지 않으며, 기존 데이터는 첫 로드 시
 *  `migrateAnchorsToSlots` 가 가장 가까운 슬롯으로 스냅. */
export interface ConnectionAnchor {
  u: number;
  v: number;
}

/** 라인 외형 — 색/두께/실선·점선/화살표 ON/OFF. 모두 optional 이라 미지정
 *  시 ConnectionLayer 의 기본값(앱 primary 색, 두께 2, 실선, 끝점 화살표).
 *  시작점 화살표(endStart) 도 별도 토글 가능 — 양방향 라인 지원 여지. */
export type ConnectionLineStyle = "solid" | "dashed";
export type ConnectionEndStyle = "arrow" | "none";
export interface ConnectionStyle {
  color?: string;
  thickness?: number;
  lineStyle?: ConnectionLineStyle;
  endStart?: ConnectionEndStyle;
  endEnd?: ConnectionEndStyle;
}

/** 캔버스 객체끼리의 시각 연결 (PureRef 콜아웃 노트 패턴 일반화).
 *  노트→ref / ref→노트 / ref→ref / 노트→노트 모두 같은 모양으로 표현.
 *
 *  - id: 연결 자체의 식별자. 같은 from/to 쌍이 여러 link 를 가질 수 있어 별도.
 *  - from/to: 양 끝점. anchor 는 *항상* 8 슬롯 중 하나로 박힘.
 *  - style: 라인 외형 옵션 (optional, ConnectionToolbar 에서 사용자 변경).
 *
 *  대상 객체가 사라지면 ConnectionLayer 가 무시 (=안 그림). 다음 정리
 *  사이클에서 connection 자체도 sweep 가능 (로직은 별도).
 */
/** 끝점 anchor 정책:
 *  - anchorLocked === true: 사용자가 ConnectionAnchorEditor 로 *명시적으로 고정*
 *    한 슬롯 → 객체가 어디로 움직여도 그 변에 그대로 붙어 있음.
 *  - anchorLocked false/undefined: anchor 가 저장돼 있더라도 *항상 가장 가까운
 *    슬롯으로 자동 재계산*. 객체 이동 시 라인이 두 객체의 가까운 변 사이로
 *    자연스럽게 흐른다 (default 동작). 저장된 anchor 는 마지막 hint 용도.
 *
 *  legacy 데이터(필드 없음) 도 자동(anchorLocked === undefined) 으로 취급. */
/** 연결 끝점이 가리키는 캔버스 객체의 종류.
 *   - "note": 텍스트 노트 (프롬프트 카드 포함)
 *   - "item": 라이브러리 레퍼런스 카드
 *   - "gen": AI 생성 노드 (노드 에디터 v2) */
export type ConnectionNodeKind = "note" | "item" | "gen";

/** 연결의 의미 종류(노드 에디터 v2). 미지정이면 일반 시각 선.
 *
 *  ▶ UI 노출 안 함(v2 단순화): 사용자가 종류를 직접 고르지 않는다. 생성 노드의
 *    입력 판정은 "생성 노드에 연결되어 있는가"로 *암시적* 으로 처리(M4). 이
 *    필드는 향후 "생성에서 제외" 같은 opt-out 토글용으로만 예약해 둔다.
 *  ▶ "output": 생성 노드 → 결과 아이템을 잇는 *저장* 연결(M5). 입력선과 달리
 *    노드 우측에서 나가며, 앵커가 우측 중앙으로 고정된다. */
export type ConnectionLinkType = "reference" | "input" | "annotation" | "output";

/** 연결 라벨의 외형 — 글자 크기 / 채우기(글자색) / 아웃라인(헤일로) 색.
 *  모두 optional 이라 미지정 시 기본값(12px, 라인색, 배경색 헤일로). */
export interface ConnectionLabelStyle {
  fontSize?: number;
  /** 글자 채우기 색. 미지정 = 라인 색(currentColor). */
  fillColor?: string;
  /** 글자 외곽 헤일로 색. 미지정 = 앱 배경색(가독성용). "none" 이면 헤일로 없음. */
  outlineColor?: string;
}

export interface CanvasConnection {
  id: string;
  from: { kind: ConnectionNodeKind; id: string; anchor?: ConnectionAnchor; anchorLocked?: boolean };
  to: { kind: ConnectionNodeKind; id: string; anchor?: ConnectionAnchor; anchorLocked?: boolean };
  style?: ConnectionStyle;
  /** 연결선 중앙에 표시되는 라벨(선택). ConnectionToolbar 에서 입력. */
  label?: string;
  /** 라벨 외형 — 글자 크기 / 채우기 / 아웃라인 색. */
  labelStyle?: ConnectionLabelStyle;
  /** 연결의 의미 종류(예약, UI 비노출). 입력 판정은 암시적(M4). */
  linkType?: ConnectionLinkType;
}

/** AI 생성 노드(노드 에디터 v2). 캔버스 위 박스로, `linkType:"input"` 연결로
 *  들어온 이미지(item)/프롬프트(note role=prompt)를 모아 Vertex(Veo 영상 또는
 *  Gemini 이미지)로 생성을 실행한다. 결과물은 ReferenceItem 으로 적재되고
 *  provenance 가 결과 아이템에 기록된다(M4).
 *
 *  좌표/크기는 CanvasItemTransform 과 같은 캔버스(월드) 좌표계 픽셀.
 *  M1 에서는 타입/배치/연결만 도입하고 실행은 M4 에서 배선한다. */
export type CanvasGenOutputKind = "image" | "video";

export interface CanvasGenNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  /** 출력 종류 — 선택 모델이 결정. "image"=Gemini, "video"=Veo. */
  outputKind: CanvasGenOutputKind;
  /** 사용 모델 id (예: "veo-3.1-fast-generate-001" | "gemini-3.1-flash-image").
   *  미지정이면 imageGenPreference 기본값을 사용. */
  model?: string;
  /** 모델 파라미터(aspectRatio, duration, resolution 등). 자유 JSON. */
  params?: Record<string, unknown>;
  /** 마지막 실행 상태. M4 에서 사용. 미지정 = idle. */
  status?: "idle" | "running" | "done" | "error";
  locked?: boolean;
  hidden?: boolean;
  groupId?: string;
}

/** 카메라 상태 — translate + uniform scale. 캔버스 좌표 ↔ 스크린 좌표 변환에 쓰임. */
export interface CanvasCamera {
  tx: number;
  ty: number;
  scale: number;
}

export interface CanvasLayout {
  /** ReferenceItem.id → transform. Reconciliation 시 items 에 없는 키는 제거. */
  items: Record<string, CanvasItemTransform>;
  notes: CanvasNote[];
  view?: CanvasCamera;
  /** z-index 단조 증가 카운터. 새로 배치되거나 "맨 앞으로" 한 항목이 항상 위. */
  nextZ: number;
  /** 객체 간 시각 연결. 노트↔ref, ref↔ref, 노트↔노트, ↔gen 노드 모두 표현 가능. */
  connections?: CanvasConnection[];
  /** AI 생성 노드(노드 에디터 v2). 미지정/빈 배열이면 일반 캔버스(기존 동작). */
  genNodes?: CanvasGenNode[];
  /** 사용자가 우클릭으로 *숨긴* 파생(variation_of) 엣지 키 목록(`"{from}>{to}"`).
   *  파생 엣지는 저장 연결이 아니라 variation_of 계보로 자동 그려지는 점선이라,
   *  개별 숨김을 여기 영속화해 reconciliation/재렌더에도 유지한다. */
  hiddenDerivedEdges?: string[];
  /** 배경 그리드 표시 + Snap-to-Grid 활성화. 폴더별로 영구화. 미지정 = false. */
  showGrid?: boolean;
  /** 그리드 한 칸 크기(캔버스 좌표 px). 미지정 = 32. */
  gridSize?: number;
}

type LayoutMap = Record<string, CanvasLayout>;

export const EMPTY_LAYOUT: CanvasLayout = Object.freeze({
  items: {},
  notes: [],
  view: undefined,
  nextZ: 1,
  connections: [],
  genNodes: [],
  hiddenDerivedEdges: [],
  showGrid: false,
  gridSize: 32,
}) as CanvasLayout;

function emptyLayout(): CanvasLayout {
  return {
    items: {},
    notes: [],
    view: undefined,
    nextZ: 1,
    connections: [],
    genNodes: [],
    hiddenDerivedEdges: [],
    showGrid: false,
    gridSize: 32,
  };
}

/** anchor (u,v) 를 *8 슬롯* 에 정착시키는 1회 마이그레이션.
 *
 *  슬롯 = 0 / 0.5 / 1 의 모든 (u,v) 조합 8 점 (정중앙 (0.5,0.5) 제외).
 *  자유 위치 anchor 가 있던 기존 데이터를 가장 가까운 슬롯으로 스냅. 첫
 *  load 1회만 동작하고 이후엔 멱등(이미 슬롯 위면 no-op).
 *
 *  - 정중앙 (0.5,0.5) 은 8슬롯이 아니지만 *내부 anchor* 의도로 보고 이 함수에선
 *    건드리지 않음 — 사용자가 의도적으로 박은 점일 수 있음.
 *  - 이 함수는 canvasGeometry 의 `slotOfAnchor` 와 별도로 *모듈 의존성 없이*
 *    가까운 슬롯을 직접 계산 (canvasLayout → canvasGeometry 단방향 의존을
 *    유지하기 위함). */
function snapAnchorToSlot(a: ConnectionAnchor): ConnectionAnchor {
  const candidates: ConnectionAnchor[] = [
    { u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 1, v: 0 },
    { u: 0, v: 0.5 },                  { u: 1, v: 0.5 },
    { u: 0, v: 1 }, { u: 0.5, v: 1 }, { u: 1, v: 1 },
  ];
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c.u - a.u) ** 2 + (c.v - a.v) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** v1 → v2 crop 좌표계 마이그레이션.
 *  v1: tr.w/h 가 원본 외곽, crop 은 wrapper 안쪽 inset 비율 → 외곽이 visible 보다
 *      커서 transparent margin 발생 → 정렬·스냅·노트 위치가 어긋나는 회귀.
 *  v2: tr.w/h 가 시각적으로 보이는 영역, crop 은 "원본의 어느 부분을 보일지" →
 *      외곽 = visible, 모든 계산이 직관적.
 *  변환: new_w = old_w * (1-l-r), new_h = old_h * (1-t-b),
 *        new_x = old_x + l*old_w, new_y = old_y + t*old_h. crop 값 그대로 유지.
 *  cropBaked = true 로 마킹 — 이미 v2 인 항목은 멱등 skip. */
function migrateCropToBaked(layout: CanvasLayout): CanvasLayout {
  let changed = false;
  const items: Record<string, CanvasItemTransform> = {};
  for (const [id, tr] of Object.entries(layout.items)) {
    if (!tr.crop || tr.cropBaked) {
      items[id] = tr;
      continue;
    }
    const { l, t, r, b } = tr.crop;
    const spanX = 1 - l - r;
    const spanY = 1 - t - b;
    if (spanX <= 0 || spanY <= 0) {
      // 비정상 crop — skip
      items[id] = tr;
      continue;
    }
    items[id] = {
      ...tr,
      x: tr.x + l * tr.w,
      y: tr.y + t * tr.h,
      w: tr.w * spanX,
      h: tr.h * spanY,
      cropBaked: true,
    };
    changed = true;
  }
  if (!changed) return layout;
  return { ...layout, items };
}

/** "빈 노트" 판정 — 텍스트 없음 + 투명/무배경 + url/role/group 없음.
 *  이런 노트는 캔버스에서 *아무것도 그리지 않는* 유령이라, 선택(Ctrl+A) /
 *  선택 경계만 늘리고 보이지는 않는다(예: N 으로 만들고 안 적고 떠난 노트). */
export function isBlankCanvasNote(note: CanvasNote): boolean {
  const noText = !note.text || note.text.trim() === "";
  const noBg = !note.bgColor || note.bgColor === "transparent";
  return noText && noBg && !note.url && !note.role && !note.groupId;
}

/** 빈 노트 정리 — 단, *연결(connection)의 끝점* 인 노트는 보존(링크가 깨지므로).
 *  load 시 1회 호출해 누적된 유령 빈 노트를 청소한다. 멱등. */
function pruneBlankNotes(layout: CanvasLayout): CanvasLayout {
  const notes = layout.notes;
  if (!notes || notes.length === 0) return layout;
  const conns = layout.connections ?? [];
  const connNoteIds = new Set<string>();
  for (const c of conns) {
    if (c.from.kind === "note") connNoteIds.add(c.from.id);
    if (c.to.kind === "note") connNoteIds.add(c.to.id);
  }
  const kept = notes.filter((n) => !isBlankCanvasNote(n) || connNoteIds.has(n.id));
  if (kept.length === notes.length) return layout;
  return { ...layout, notes: kept };
}

function migrateAnchorsToSlots(layout: CanvasLayout): CanvasLayout {
  const conns = layout.connections;
  if (!Array.isArray(conns) || conns.length === 0) return layout;
  let layoutChanged = false;
  const next = conns.map((c) => {
    let nf = c.from;
    let nt = c.to;
    let cChanged = false;
    if (c.from.anchor) {
      const snapped = snapAnchorToSlot(c.from.anchor);
      if (snapped.u !== c.from.anchor.u || snapped.v !== c.from.anchor.v) {
        nf = { ...c.from, anchor: snapped };
        cChanged = true;
      }
    }
    if (c.to.anchor) {
      const snapped = snapAnchorToSlot(c.to.anchor);
      if (snapped.u !== c.to.anchor.u || snapped.v !== c.to.anchor.v) {
        nt = { ...c.to, anchor: snapped };
        cChanged = true;
      }
    }
    if (cChanged) {
      layoutChanged = true;
      return { ...c, from: nf, to: nt };
    }
    return c;
  });
  if (!layoutChanged) return layout;
  return { ...layout, connections: next };
}

/** legacy `linkedRefIds` 를 `connections` 으로 1회 마이그레이션. 변환된 노트의
 *  `linkedRefIds` 는 비워서 다음 저장 때 정착하게 한다. 멱등 — 이미 변환된
 *  노트는 no-op. id 충돌을 막기 위해 새 connection id 는 timestamp+random. */
function migrateLegacyLinks(layout: CanvasLayout): CanvasLayout {
  const existing = Array.isArray(layout.connections) ? layout.connections : [];
  const migrated: CanvasConnection[] = [...existing];
  let didMigrate = false;
  const nextNotes = layout.notes.map((n) => {
    const refs = n.linkedRefIds;
    if (!refs || refs.length === 0) return n;
    for (const refId of refs) {
      // 같은 from(note)→to(item) 가 이미 connections 에 있으면 중복 추가 안 함.
      const dup = migrated.some(
        (c) =>
          c.from.kind === "note" &&
          c.from.id === n.id &&
          c.to.kind === "item" &&
          c.to.id === refId,
      );
      if (!dup) {
        migrated.push({
          id: `mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${n.id}_${refId}`,
          from: { kind: "note", id: n.id },
          to: { kind: "item", id: refId },
        });
      }
    }
    didMigrate = true;
    return { ...n, linkedRefIds: [] };
  });
  if (!didMigrate) return layout;
  return { ...layout, notes: nextNotes, connections: migrated };
}

// ── 메모리 캐시 + DB 영속화 ──────────────────────────────────────────
// `cache` 가 현재 워크스페이스의 모든 캔버스 레이아웃을 담는 authoritative
// 진실원. hydrate 가 부팅 시 1 회 DB → cache 로 채운다. 모든 동기 read 는
// cache 에서, write 는 cache 갱신 + dirty/deleted 마킹 후 debounce flush.
let cache: LayoutMap = {};
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

// flush 대기 중인 변경 키. dirty = upsert 대상(cache 의 현재 값), deleted =
// 삭제 대상. 한 키가 양쪽에 동시에 있지 않도록 마킹 시 상호 배제한다.
const dirtyKeys = new Set<string>();
const deletedKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// drag commit / 카메라 idle 저장 등 잦은 write 를 묶는 debounce. 너무 길면
// 워크스페이스 전환 reload 시 유실 위험이 커지고, 너무 짧으면 DB 라운드트립이
// 잦아진다. 400ms 가 균형점(전환 직전엔 pagehide keepalive flush 가 보강).
const FLUSH_DEBOUNCE_MS = 400;

async function postCanvas(
  path: string,
  body: unknown,
  keepalive = false,
): Promise<unknown> {
  const res = await fetch(`${LOCAL_SERVER_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

function markDirty(key: string): void {
  dirtyKeys.add(key);
  deletedKeys.delete(key);
  scheduleFlush();
}

function markDeleted(key: string): void {
  deletedKeys.add(key);
  dirtyKeys.delete(key);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (typeof window === "undefined") return;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(keepalive = false): Promise<void> {
  // hydrate 완료 전엔 절대 영속화하지 않는다 — 빈 cache 로 DB 를 덮어쓰는
  // 사고 방지. 대기 마킹은 그대로 두고 hydrate 후 재시도.
  if (!hydrated) return;
  if (dirtyKeys.size === 0 && deletedKeys.size === 0) return;
  const upserts = [...dirtyKeys]
    .map((k) => ({ contextKey: k, layout: cache[k] }))
    .filter((u) => u.layout);
  const deletes = [...deletedKeys];
  dirtyKeys.clear();
  deletedKeys.clear();
  try {
    await postCanvas("/canvas/save", { upserts, deletes }, keepalive);
  } catch (err) {
    // 실패 시 재마킹 — 다음 flush 가 재시도.
    for (const u of upserts) dirtyKeys.add(u.contextKey);
    for (const d of deletes) deletedKeys.add(d);
    console.warn("[canvasLayout] flush failed, will retry:", err);
  }
}

/** 대기 중인 변경을 *지금 즉시* DB 로 flush 하고 끝날 때까지 기다린다.
 *  워크스페이스 전환(workspaceClient.activateWorkspace) 직전에 호출해야 한다 —
 *  서버가 활성 DB 를 바꾼 뒤(reload 시 pagehide) flush 가 일어나면 옛
 *  워크스페이스의 캔버스 변경이 *새* 워크스페이스 DB 로 잘못 기록되기 때문.
 *  전환 전에 비워두면 그 오염도, 전환 중 유실도 동시에 막는다. hydrate 전이거나
 *  대기 변경이 없으면 빠르게 no-op. */
export async function flushCanvasLayoutsNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/** 레거시 localStorage 레이아웃 1 회 읽기 — DB 가 비어 있을 때 마이그레이션
 *  소스로만 사용. 활성 워크스페이스 ID 가 필요하므로 호출 전 ensureWorkspaces
 *  Loaded() 가 끝나 있어야 한다. */
function readLegacyLocalStorage(): LayoutMap | null {
  if (typeof window === "undefined") return null;
  migrateGlobalToScopedIfDefault(KEY);
  const scoped = workspaceScopedKey(KEY);
  if (!scoped) return null;
  try {
    const raw = window.localStorage.getItem(scoped);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LayoutMap;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 부팅 시 1 회 — DB 에서 모든 캔버스 레이아웃을 cache 로 채운다. DB 가 비어
 *  있으면 레거시 localStorage 를 1 회 마이그레이션. 멱등(중복 호출은 같은
 *  promise 반환). 완료 후 CANVAS_LAYOUT_CHANGED_EVENT 를 발화해 이미 마운트된
 *  캔버스가 실제 데이터로 reload 되게 한다. */
export function hydrateCanvasLayouts(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const dbMap: LayoutMap = {};
    let listOk = false;
    try {
      const rows = (await postCanvas("/canvas/list", {})) as Array<{
        context_key: string;
        layout: string;
      }>;
      listOk = true;
      for (const r of rows) {
        if (!r || typeof r.context_key !== "string") continue;
        try {
          dbMap[r.context_key] =
            typeof r.layout === "string" ? (JSON.parse(r.layout) as CanvasLayout) : (r.layout as CanvasLayout);
        } catch {
          /* skip malformed row */
        }
      }
    } catch (err) {
      console.warn("[canvasLayout] hydrate (DB list) failed:", err);
    }

    // DB 가 *확실히* 비어 있을 때만(list 성공 + 0 행) 레거시 localStorage →
    // DB 마이그레이션. list 가 실패했을 땐 DB 가 실제로 비었는지 알 수 없어
    // 마이그레이션을 건너뛴다 — 일시적 실패로 stale localStorage 를 진짜 DB
    // 데이터 위에 덮어쓰는 사고를 막는다.
    if (listOk && Object.keys(dbMap).length === 0) {
      try {
        await ensureWorkspacesLoaded();
        const legacy = readLegacyLocalStorage();
        if (legacy) {
          for (const k of Object.keys(legacy)) {
            dbMap[k] = legacy[k];
            dirtyKeys.add(k); // flush 가 DB 로 옮긴다(localStorage 는 백업으로 유지)
          }
        }
      } catch (err) {
        console.warn("[canvasLayout] localStorage migration skipped:", err);
      }
    }

    // hydrate 도중 사용자가 만든 in-flight 편집 보존 — DB 값보다 우선.
    for (const k of dirtyKeys) {
      if (cache[k]) dbMap[k] = cache[k];
    }
    for (const k of deletedKeys) delete dbMap[k];

    cache = dbMap;
    hydrated = true;
    if (dirtyKeys.size > 0 || deletedKeys.size > 0) scheduleFlush();
    emitChanged();
  })();
  return hydratePromise;
}

/** CANVAS_LAYOUT_CHANGED_EVENT 의 detail. `source` 는 자기 자신이 발화한
 *  이벤트로 인한 사이클(저장 → 동일 컴포넌트 리스너 → load → 다시 저장…) 을
 *  끊기 위한 식별자. 호출자가 `Symbol()` 같은 인스턴스 고유 값을 넘기면,
 *  같은 컴포넌트 인스턴스의 리스너에서 비교해 무시할 수 있다. */
export interface CanvasLayoutChangedDetail {
  source?: unknown;
}

function emitChanged(source?: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CanvasLayoutChangedDetail>(CANVAS_LAYOUT_CHANGED_EVENT, {
      detail: { source },
    }),
  );
}

// 모듈 로드 즉시 hydrate 시작 — 캔버스 chunk 가 로드되는 순간 DB 를 당겨온다.
// 페이지 reload(워크스페이스 전환) 직전엔 대기 중 변경을 keepalive 로 flush.
if (typeof window !== "undefined") {
  void hydrateCanvasLayouts();
  window.addEventListener("pagehide", () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flush(true);
  });
}

/** 한 컨텍스트의 레이아웃 조회. 없으면 빈 레이아웃. 항상 새 객체.
 *
 *  legacy `note.linkedRefIds[]` 는 여기서 1회 마이그레이션되어 신규
 *  `connections` 로 옮겨진다. 호출자(LibraryCanvas)가 이 결과를 다음 변경에
 *  반영하면서 자연스레 저장 단계에서 정착. */
export function getCanvasLayout(contextKey: string): CanvasLayout {
  const stored = cache[contextKey];
  if (!stored) return emptyLayout();
  const base: CanvasLayout = {
    items: { ...stored.items },
    notes: stored.notes ? [...stored.notes] : [],
    view: stored.view ? { ...stored.view } : undefined,
    nextZ: typeof stored.nextZ === "number" && stored.nextZ > 0 ? stored.nextZ : 1,
    connections: Array.isArray(stored.connections) ? [...stored.connections] : [],
    genNodes: Array.isArray(stored.genNodes) ? [...stored.genNodes] : [],
    hiddenDerivedEdges: Array.isArray(stored.hiddenDerivedEdges) ? [...stored.hiddenDerivedEdges] : [],
    showGrid: typeof stored.showGrid === "boolean" ? stored.showGrid : false,
    gridSize: typeof stored.gridSize === "number" && stored.gridSize >= 8 ? stored.gridSize : 32,
  };
  // 마이그레이션 후(연결 정착 완료) 빈 노트 정리 — 연결 끝점은 보존.
  return pruneBlankNotes(migrateAnchorsToSlots(migrateLegacyLinks(migrateCropToBaked(base))));
}

/** 전체 레이아웃 덮어쓰기. 호출자가 reducer 로 만든 결과를 한 번에 저장할 때.
 *  `source` 는 자기 자신의 listener 가 자기 변경에 다시 반응하지 않도록 식별. */
export function setCanvasLayout(
  contextKey: string,
  layout: CanvasLayout,
  source?: unknown,
): void {
  cache[contextKey] = layout;
  markDirty(contextKey);
  emitChanged(source);
}

/** 한 ref 의 transform 부분 갱신 (drag 등 잦은 변경에 사용).
 *  contextKey 에 layout 이 없으면 자동으로 빈 layout 을 만들고 거기에 박는다. */
export function patchCanvasItem(
  contextKey: string,
  refId: string,
  partial: Partial<CanvasItemTransform>,
): void {
  const layout = cache[contextKey] ?? emptyLayout();
  const existing = layout.items[refId];
  if (!existing) return; // 신규 항목은 setCanvasItem 으로 명시 생성
  cache[contextKey] = {
    ...layout,
    items: { ...layout.items, [refId]: { ...existing, ...partial } },
  };
  markDirty(contextKey);
  emitChanged();
}

/** 한 ref 의 transform 을 전체 새로 set (자동 배치 시 신규 진입). */
export function setCanvasItem(
  contextKey: string,
  refId: string,
  transform: CanvasItemTransform,
): void {
  const layout = cache[contextKey] ?? emptyLayout();
  cache[contextKey] = {
    ...layout,
    items: { ...layout.items, [refId]: transform },
    nextZ: transform.zIndex >= layout.nextZ ? transform.zIndex + 1 : layout.nextZ,
  };
  markDirty(contextKey);
  emitChanged();
}

/** 사라진 ref 들을 layout 에서 정리. items 에 없는 entry 의 누적을 차단. */
export function pruneCanvasItems(contextKey: string, keepIds: ReadonlySet<string>): void {
  const layout = cache[contextKey];
  if (!layout) return;
  const nextItems: Record<string, CanvasItemTransform> = {};
  let changed = false;
  for (const [id, tr] of Object.entries(layout.items)) {
    if (keepIds.has(id)) nextItems[id] = tr;
    else changed = true;
  }
  if (changed) {
    cache[contextKey] = { ...layout, items: nextItems };
    markDirty(contextKey);
    emitChanged();
  }
}

/** 한 컨텍스트의 레이아웃 전체 삭제 (사용자가 "초기화" 메뉴 호출 등).
 *
 *  `source` 는 자기 자신의 리스너가 자기 변경에 다시 반응하지 않도록 식별.
 *  setCanvasLayout 과 동일한 규약. 호출 직후 reducer 가 새 layout 을 dispatch
 *  할 때, 같은 instance 의 onCanvasChange 가 storage 이벤트를 받아
 *  `dispatch({type:"load"})` 로 past/future 를 통째로 비우는 회귀를 막는다. */
export function clearCanvasLayout(contextKey: string, source?: unknown): void {
  if (!(contextKey in cache)) return;
  delete cache[contextKey];
  markDeleted(contextKey);
  emitChanged(source);
}

/** 폴더 path → contextKey 변환. manualOrder.deriveLibraryContextKey 와 동일한
 *  키 형식(`tag:folder:<path>`) 을 만든다. 캔버스는 폴더에서만 쓰이므로
 *  헬퍼를 분리해 호출처에서 의존성 줄임. */
export function folderContextKey(folderPath: string): string {
  return `tag:folder:${folderPath}`;
}

/** 현재 워크스페이스의 *모든* 캔버스 레이아웃 맵(스냅샷) 반환. preflow Pack
 *  export 가 이걸 그대로 직렬화해 zip 에 동봉 → import 측에서
 *  mergeCanvasLayouts 로 복원. cache 가 워크스페이스 DB 에서 hydrate 되므로
 *  현재 워크스페이스의 레이아웃만 담긴다. 빈 맵일 수 있다(hydrate 전/없음). */
export function getAllCanvasLayouts(): LayoutMap {
  return { ...cache };
}

/** Pack import 직후 외부에서 받은 layout 맵을 현재 워크스페이스에 *병합*.
 *   - `mode: "skip"` (기본): 이미 존재하는 contextKey 는 건드리지 않음 →
 *     사용자의 현재 작업 손실 없음
 *   - `mode: "overwrite"`: 기존 키 덮어쓰기 (위험 — 사용 신중)
 *   - 키 remap 이 필요한 경우 (folder 충돌로 이름 변경) 호출자가 사전에
 *     map 의 키를 변환해 넘겨야 한다 (cascadeRenameCanvasLayout 참고). */
export function mergeCanvasLayouts(
  incoming: LayoutMap,
  options: { mode?: "skip" | "overwrite" } = {},
): { added: number; skipped: number } {
  const mode = options.mode ?? "skip";
  let added = 0;
  let skipped = 0;
  for (const [key, layout] of Object.entries(incoming)) {
    if (cache[key] && mode === "skip") {
      skipped += 1;
      continue;
    }
    cache[key] = layout;
    markDirty(key);
    added += 1;
  }
  if (added > 0) emitChanged();
  return { added, skipped };
}

/** 폴더 rename / move 시 prefix 일괄 치환.
 *  - 컨텍스트 키가 `tag:folder:<oldPath>` 또는 `tag:folder:<oldPath>/...` 인 경우
 *    `<newPath>` 로 prefix 치환.
 *  호출자(LibraryPage)는 referenceLibrary.renameFolder 성공 직후 한 번만
 *  호출하면 된다 — folderPreferences.cascadeRenameFolderPrefs 와 같은 패턴. */
export function cascadeRenameCanvasLayout(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const oldPrefix = `tag:folder:${oldPath}`;
  const newPrefix = `tag:folder:${newPath}`;
  let changed = false;
  for (const key of Object.keys(cache)) {
    let destKey: string | null = null;
    if (key === oldPrefix) destKey = newPrefix;
    else if (key.startsWith(`${oldPrefix}/`)) destKey = `${newPrefix}/${key.slice(oldPrefix.length + 1)}`;
    if (!destKey) continue;
    cache[destKey] = cache[key];
    delete cache[key];
    markDirty(destKey);
    markDeleted(key);
    changed = true;
  }
  if (changed) emitChanged();
}

/** 폴더 삭제 시 정리 — `tag:folder:<path>` 또는 그 자손 컨텍스트 키 전부 제거. */
export function cascadeDeleteCanvasLayout(folderPath: string): void {
  if (!folderPath) return;
  const prefix = `tag:folder:${folderPath}`;
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      delete cache[key];
      markDeleted(key);
      changed = true;
    }
  }
  if (changed) emitChanged();
}

/** 폴더 duplicate 시 원본 트리의 layout 을 새 prefix 로 복제.
 *  duplicateFolder 가 디스크 파일을 복사하진 않지만 ref id 자체는 새로 생성되므로
 *  ref 별 transform 은 그대로 옮길 수 없다 — *카메라 상태와 노트만* 복사하고
 *  refId 기반 items 는 비워서 시작한다. 사용자는 새 폴더의 ref 들을 다시
 *  자동 배치 받음. (대안은 oldId → newId 매핑을 받아 items 도 따라가게 하는 것;
 *  현재는 duplicateFolder API 가 id 매핑을 노출하지 않으므로 v1 에선 생략.) */
export function cascadeDuplicateCanvasLayout(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const oldPrefix = `tag:folder:${oldPath}`;
  const newPrefix = `tag:folder:${newPath}`;
  // 원본 키를 먼저 스냅샷 — 루프 중 cache 에 새 키를 더하면서 순회하지 않도록.
  const sourceEntries = Object.entries(cache);
  let changed = false;
  for (const [key, layout] of sourceEntries) {
    let destKey: string | null = null;
    if (key === oldPrefix) destKey = newPrefix;
    else if (key.startsWith(`${oldPrefix}/`)) destKey = `${newPrefix}/${key.slice(oldPrefix.length + 1)}`;
    if (!destKey || destKey in cache) continue;
    cache[destKey] = {
      items: {},
      notes: layout.notes ? layout.notes.map((n) => ({ ...n, id: `${n.id}-dup` })) : [],
      view: layout.view ? { ...layout.view } : undefined,
      nextZ: 1,
    };
    markDirty(destKey);
    changed = true;
  }
  if (changed) emitChanged();
}
