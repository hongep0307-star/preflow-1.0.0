/* 뷰어 전용 경량 i18n.
 *
 * 메인 앱은 UiLanguageProvider + uiCopy 로 t() 를 제공하지만, 그 컨텍스트는
 * viewer 번들에 마운트되지 않는다(외부 공유용 단일 HTML). 그래서 player
 * 툴팁/단축키 라벨처럼 *뷰어가 직접 쓰는 소수의 문자열* 만 여기 모아
 * App 의 language 상태(ko/en)로 선택한다. 본문 AI 분석은 ReferenceItem 의
 * _ko/_en 필드를 ViewerInspector 가 직접 고른다(여기 대상 아님). */

export type ViewerLang = "ko" | "en";

type ViewerStringKey =
  | "play"
  | "pause"
  | "mute"
  | "unmute"
  | "volume"
  | "muted"
  | "loopLabel"
  | "loopActivateHint"
  | "loopClearHint"
  | "loopOn"
  | "loopOff"
  | "fullLoop"
  | "fullscreen"
  | "speed"
  | "skipBack5"
  | "skipFwd5"
  | "shortcuts"
  | "shortcutsTitle"
  | "scPlayPause"
  | "scMute"
  | "scFrameStep"
  | "scFrameNav"
  | "scItemNav"
  | "scSeek5"
  | "scLoop"
  | "scLoopRegion"
  | "scClose"
  | "decoding"
  | "gifFallbackNote"
  /* 툴바 */
  | "searchPlaceholder"
  | "clear"
  | "sortNewest"
  | "sortOldest"
  | "sortTitle"
  | "sortDuration"
  | "sortLabel"
  | "thumbnailSize"
  | "kindImage"
  | "kindWebp"
  | "kindGif"
  | "kindVideo"
  | "kindYoutube"
  | "kindUrl"
  | "kindDoc"
  | "colorFilterClear"
  | "toggleInspector"
  /* 폴더 트리 */
  | "allFolders"
  /* 인스펙터 */
  | "inspector"
  | "closeInspector"
  | "copyLink"
  | "openLarge"
  | "openInBrowser"
  | "download"
  | "openOriginal"
  | "copyColor"
  | "colorCopied"
  | "tags"
  | "aiAnalysis"
  | "suggestedTags"
  | "moodSection"
  | "sceneLabel"
  | "styleLabel"
  | "motionLabel"
  | "briefLabel"
  | "contiLabel"
  | "properties"
  | "propDimensions"
  | "propDuration"
  | "propType"
  | "propSize"
  | "propImported"
  | "propCreated"
  | "propModified"
  | "regionNotes"
  | "slideNotesTitle"
  | "notesSection"
  | "frameNotesTitle"
  | "timestampNotesTitle"
  | "noNotes"
  | "docNotViewable"
  /* PDF 뷰어 컨트롤 */
  | "pdfPrev"
  | "pdfNext"
  | "pdfZoomIn"
  | "pdfZoomOut"
  | "pdfFit"
  | "pdfLoading"
  | "pdfLoadFailed"
  | "pdfOpenNewTab"
  /* 모달 */
  | "modalPrev"
  | "modalNext"
  | "modalClose";

const DICT: Record<ViewerStringKey, { en: string; ko: string }> = {
  play: { en: "Play (Space)", ko: "재생 (Space)" },
  pause: { en: "Pause (Space)", ko: "일시정지 (Space)" },
  mute: { en: "Mute (M)", ko: "음소거 (M)" },
  unmute: { en: "Unmute (M)", ko: "음소거 해제 (M)" },
  volume: { en: "Volume", ko: "볼륨" },
  muted: { en: "Muted", ko: "음소거됨" },
  loopLabel: { en: "Loop", ko: "루프" },
  loopActivateHint: {
    en: "activate range (drag handles to set in/out)",
    ko: "구간 활성화 (핸들을 드래그해 in/out 설정)",
  },
  loopClearHint: { en: "click to clear", ko: "클릭하면 해제" },
  loopOn: { en: "Loop ON", ko: "루프 켜짐" },
  loopOff: { en: "Loop OFF", ko: "루프 꺼짐" },
  fullLoop: { en: "Repeat whole clip", ko: "전체 반복" },
  fullscreen: { en: "Fullscreen", ko: "전체화면" },
  speed: { en: "Playback speed", ko: "재생 속도" },
  skipBack5: { en: "Back 5s", ko: "5초 뒤로" },
  skipFwd5: { en: "Forward 5s", ko: "5초 앞으로" },
  shortcuts: { en: "Keyboard shortcuts", ko: "키보드 단축키" },
  shortcutsTitle: { en: "Keyboard Shortcuts", ko: "키보드 단축키" },
  scPlayPause: { en: "Play / Pause", ko: "재생 / 정지" },
  scMute: { en: "Mute", ko: "음소거" },
  scFrameStep: { en: "Frame step", ko: "프레임 이동" },
  scFrameNav: { en: "Prev / Next frame", ko: "이전 / 다음 프레임" },
  scItemNav: { en: "Prev / Next item", ko: "이전 / 다음 자료" },
  scSeek5: { en: "Seek ±5s (Shift = ±10s)", ko: "±5초 이동 (Shift = ±10초)" },
  scLoop: { en: "Toggle loop", ko: "루프 토글" },
  scLoopRegion: { en: "Set loop in / out", ko: "루프 in / out 설정" },
  scClose: { en: "Close", ko: "닫기" },
  decoding: { en: "Decoding…", ko: "디코딩 중…" },
  gifFallbackNote: {
    en: "Frame-precise playback is not supported in this browser; showing autoplay GIF.",
    ko: "이 브라우저는 프레임 단위 재생을 지원하지 않아 자동재생 GIF 로 표시합니다.",
  },
  /* 툴바 */
  searchPlaceholder: { en: "Search title, tags, notes...", ko: "제목, 태그, 메모 검색..." },
  clear: { en: "Clear", ko: "초기화" },
  sortNewest: { en: "Newest", ko: "최신순" },
  sortOldest: { en: "Oldest", ko: "오래된순" },
  sortTitle: { en: "Title", ko: "제목순" },
  sortDuration: { en: "Duration", ko: "길이순" },
  sortLabel: { en: "Sort", ko: "정렬" },
  thumbnailSize: { en: "Thumbnail size", ko: "썸네일 크기" },
  kindImage: { en: "Image", ko: "이미지" },
  kindWebp: { en: "WebP", ko: "WebP" },
  kindGif: { en: "GIF", ko: "GIF" },
  kindVideo: { en: "Video", ko: "비디오" },
  kindYoutube: { en: "YouTube", ko: "YouTube" },
  kindUrl: { en: "URL", ko: "URL" },
  kindDoc: { en: "File", ko: "파일" },
  colorFilterClear: { en: "Color filter — click to clear", ko: "색 필터 — 클릭하면 해제" },
  toggleInspector: { en: "Toggle inspector", ko: "인스펙터 열기/닫기" },
  /* 폴더 트리 */
  allFolders: { en: "All", ko: "전체" },
  /* 인스펙터 */
  inspector: { en: "Inspector", ko: "인스펙터" },
  closeInspector: { en: "Close inspector", ko: "인스펙터 닫기" },
  copyLink: { en: "Copy link to this item", ko: "이 항목 링크 복사" },
  openLarge: { en: "Open large view", ko: "크게 보기" },
  openInBrowser: { en: "Open in browser", ko: "브라우저에서 열기" },
  download: { en: "Download", ko: "다운로드" },
  openOriginal: { en: "Open original file", ko: "원본 파일 열기" },
  copyColor: { en: "Click to copy color code", ko: "클릭하면 색상 코드 복사" },
  colorCopied: { en: "Copied", ko: "복사됨" },
  tags: { en: "Tags", ko: "태그" },
  aiAnalysis: { en: "AI Analysis", ko: "AI 분석" },
  suggestedTags: { en: "Suggested Tags", ko: "추천 태그" },
  moodSection: { en: "Mood", ko: "무드" },
  sceneLabel: { en: "Scene", ko: "장면" },
  styleLabel: { en: "Style", ko: "스타일" },
  motionLabel: { en: "Motion", ko: "모션" },
  briefLabel: { en: "Brief", ko: "브리프" },
  contiLabel: { en: "Conti", ko: "콘티" },
  properties: { en: "Properties", ko: "속성" },
  propDimensions: { en: "Dimensions", ko: "크기" },
  propDuration: { en: "Duration", ko: "길이" },
  propType: { en: "Type", ko: "종류" },
  propSize: { en: "Size", ko: "용량" },
  propImported: { en: "Imported", ko: "가져온 날짜" },
  propCreated: { en: "Created", ko: "생성일" },
  propModified: { en: "Modified", ko: "수정일" },
  regionNotes: { en: "Region Notes", ko: "영역 메모" },
  slideNotesTitle: { en: "Slide Notes", ko: "슬라이드 노트" },
  notesSection: { en: "Notes", ko: "메모" },
  frameNotesTitle: { en: "Frame Notes", ko: "프레임 메모" },
  timestampNotesTitle: { en: "Timestamp Notes", ko: "타임스탬프 메모" },
  noNotes: { en: "No notes.", ko: "메모 없음." },
  docNotViewable: {
    en: "This file type can't be previewed. Use the open/download button in the inspector.",
    ko: "이 파일 형식은 미리보기를 지원하지 않습니다. 인스펙터의 열기/다운로드 버튼을 사용하세요.",
  },
  /* PDF 뷰어 컨트롤 */
  pdfPrev: { en: "Previous page", ko: "이전 페이지" },
  pdfNext: { en: "Next page", ko: "다음 페이지" },
  pdfZoomIn: { en: "Zoom in", ko: "확대" },
  pdfZoomOut: { en: "Zoom out", ko: "축소" },
  pdfFit: { en: "Fit to window", ko: "창에 맞춤" },
  pdfLoading: { en: "Loading PDF…", ko: "PDF 불러오는 중…" },
  pdfLoadFailed: { en: "Couldn't load this PDF.", ko: "PDF를 불러오지 못했습니다." },
  pdfOpenNewTab: { en: "Open in new tab", ko: "새 탭에서 열기" },
  /* 모달 */
  modalPrev: { en: "Previous (←)", ko: "이전 (←)" },
  modalNext: { en: "Next (→)", ko: "다음 (→)" },
  modalClose: { en: "Close (ESC)", ko: "닫기 (ESC)" },
};

export function vt(lang: ViewerLang, key: ViewerStringKey): string {
  return DICT[key][lang];
}
