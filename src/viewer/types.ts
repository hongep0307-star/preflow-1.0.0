/* Viewer 전용 타입.
 *
 * 메인 앱의 src/lib/referenceLibrary.ts 에서 같은 이름의 타입들이
 * 정의돼 있지만, 그쪽은 supabase / electron 글로벌 / 로컬 서버 URL
 * 같은 무거운 모듈을 끌고 들어와 viewer 번들에 섞이면 안 된다.
 * 여기에 *직렬화 형태만* 다시 선언해 viewer 가 메인 앱 코드와
 * 완전히 분리되도록 한다 — 같은 필드 이름/모양을 유지해 export 측이
 * JSON 그대로 넣고, viewer 가 JSON 그대로 받아 쓰면 된다. */

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimestampNote {
  id: string;
  /** 영상 자료의 시각(초). */
  atSec?: number;
  /** GIF 프레임 인덱스. */
  frameIndex?: number;
  rangeText?: string;
  text: string;
  /** 자료 위에 그려진 정규화 영역 박스. */
  region?: RegionRect;
}

export type ReferenceKind = "image" | "webp" | "gif" | "video" | "youtube" | "link" | "doc";

/* 메인 앱 ColorSwatch 의 viewer 용 단순화 형태.
 *  - `ratio`: 해당 색이 차지하는 픽셀 비중(0..1). viewer 가 인스펙터의
 *    swatch 행을 표시할 때 *내림차순으로 정렬*해 dominant 색이 앞에 오도록
 *    한다. 메인 앱 ColorSwatch 와 동일 시맨틱.
 *  - `count`: 레거시 호환 필드(현 export 에선 채워지지 않음). 향후 제거
 *    가능. */
export interface ColorSwatch {
  color: string;
  ratio?: number;
  count?: number;
}

/* AI 분석 결과 — 메인 앱의 ai_suggestions 중 *읽기 전용으로 사용자에게
 *  보여줄 만한 필드* 만 좁혀 viewer 에 노출한다. transcript / raw 같은
 *  무거운 필드는 export 단계에서 명시적으로 제외해 viewer 번들이
 *  부풀어 오르지 않게 한다.
 *  영/한 두 언어가 함께 들어 있어 viewer 가 자체 언어 토글 없이
 *  사용자 환경에 맞춰 둘 중 한 쪽을 선택 표시할 수 있게 한다. */
export interface ReferenceAiSuggestions {
  suggested_tags?: string[];
  suggested_tags_ko?: string[];
  mood_labels?: string[];
  mood_labels_ko?: string[];
  /** 객관적 장면 묘사 — 메인 앱의 ai_suggestions 컨트랙트 (referenceAi.ts)
   *  와 평행. visual_style 의 *해석* 과 분리된 *관찰* 차원이라 viewer 도
   *  분석 본문 맨 위에 별도 블록으로 노출한다. */
  scene_description?: string;
  scene_description_ko?: string;
  visual_style?: string;
  visual_style_ko?: string;
  motion_notes?: string;
  motion_notes_ko?: string;
  brief_fit?: string;
  brief_fit_ko?: string;
  conti_use?: string;
  conti_use_ko?: string;
}

export interface ReferenceItem {
  id: string;
  kind: ReferenceKind;
  title: string;
  /** ZIP 모드에서는 "assets/files/<id>.<ext>" 같은 상대 경로,
   *  단일 HTML 모드에서는 "data:<mime>;base64,..." URI. */
  file_url?: string | null;
  thumbnail_url?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  tags?: string[];
  notes?: string | null;
  source_url?: string | null;
  /** Phase 4 region 노트가 포함된 코멘트 배열. */
  timestamp_notes: TimestampNote[];
  created_at?: string | null;
  updated_at?: string | null;
  imported_at?: string | null;
  /** 영상 자료에서 표시할 cover 시각 — 있으면 viewer 가 그리드 hover
   *  thumb 으로 활용. */
  cover_at_sec?: number | null;
  /** 메인 앱의 Inspector 상단 작은 컬러 칩(8개) — viewer 사이드바도 동일하게 표시. */
  color_palette?: ColorSwatch[];
  /** Inspector 의 AI 분석 섹션을 채울 부분 데이터. */
  ai_suggestions?: ReferenceAiSuggestions | null;
}

/* export 시점의 폴더 구조 스냅샷 노드.
 *  - `path`: 폴더 태그 전체 경로 ("folder:" prefix 제거). 예 "캐릭터/메인".
 *  - `name`: 표시명 (경로 마지막 세그먼트). 예 "메인".
 *  - `count`: 해당 폴더에 *직접* 소속된 아이템 수 (하위 폴더 미포함).
 *  구버전 export 엔 없으므로(부재) 뷰어는 tags 의 "folder:" prefix 에서
 *  트리를 재구성하는 폴백(foldersFromTags)을 유지한다. */
export interface ViewerFolderNode {
  path: string;
  name: string;
  count: number;
}

export interface ViewerData {
  title: string;
  /** ISO timestamp. 빈 문자열이면 헤더에 표시 X. */
  generated_at: string;
  item_count: number;
  items: ReferenceItem[];
  /** 신규 — export 시점의 폴더 구조 스냅샷. 부재 시 foldersFromTags 폴백. */
  folders?: ViewerFolderNode[];
  /** 신규 — export 한 앱의 UI 언어 (뷰어 초기 언어 기본값). */
  source_language?: "ko" | "en";
}

declare global {
  interface Window {
    __PREFLOW_VIEWER_DATA__?: ViewerData;
  }
}
