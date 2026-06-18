/**
 * doc 카테고리(`kind: "doc"`) 자료의 시각 표현을 한 곳에 모은 helper.
 *
 * 라이브러리는 PDF/PPT/XLS/TTF/ZIP/HTML 같은 문서·바이너리 자료를 모두
 * `kind: "doc"` 으로 흡수하지만, 카드/인스펙터/필터 UI 에서는 구체 sub-type
 * 별로 구분되는 색·아이콘·라벨이 필요하다(스크린샷 mock 의 색띠 + 확장자
 * 배지 + 타입 라벨 모양). 컴포넌트마다 mime/확장자 분기를 다시 짜면 절대
 * 어긋나므로, 정렬된 메타 테이블을 한 모듈에서 export 한다.
 *
 * - i18n: 라벨 텍스트는 영문 default 만 두고, 사용 측에서 `t()` 와
 *   `library.docSubtype.<id>` 키를 갖다 쓰도록 한다(섞어 쓰기 방지).
 * - 아이콘: lucide-react. 비주얼 다양성보다 *식별 가능성* 우선
 *   (예: 압축=Archive, 폰트=Type, PDF=FileText 류).
 * - 색상: 카드 좌측 색띠 + 배경 그라데이션 토큰. 다크/라이트 양쪽 모두에서
 *   가독성 있는 채도로 골랐고, 모두 Tailwind 색상 팔레트 내에 머무른다.
 */
import {
  Archive,
  Code2,
  FileBarChart2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Film,
  Globe,
  Headphones,
  PresentationIcon,
  TerminalSquare,
} from "lucide-react";
import {
  detectDocSubtype,
  type DocSubtype,
  type ReferenceItem,
} from "./referenceLibrary";

export interface DocPresentation {
  subtype: DocSubtype;
  /** lucide icon component. */
  Icon: typeof FileText;
  /** 카드 우상단/리스트의 짧은 영문 라벨(EN 기본). i18n 적용 시 `t()` 로 덮음. */
  labelEn: string;
  /** Tailwind 색 토큰 — `text-<color>` 류로 쓰일 base. */
  hue: "rose" | "amber" | "orange" | "blue" | "violet" | "emerald" | "sky" | "slate" | "red";
}

const TABLE: Record<DocSubtype, DocPresentation> = {
  pdf:          { subtype: "pdf",          Icon: FileText,         labelEn: "PDF",          hue: "rose" },
  psd:          { subtype: "psd",          Icon: FileImage,        labelEn: "PSD",          hue: "blue" },
  spreadsheet:  { subtype: "spreadsheet",  Icon: FileSpreadsheet,  labelEn: "Spreadsheet",  hue: "emerald" },
  presentation: { subtype: "presentation", Icon: PresentationIcon, labelEn: "Presentation", hue: "orange" },
  document:     { subtype: "document",     Icon: FileBarChart2,    labelEn: "Document",     hue: "blue" },
  archive:      { subtype: "archive",      Icon: Archive,          labelEn: "Archive",      hue: "amber" },
  font:         { subtype: "font",         Icon: FileType2,        labelEn: "Font",         hue: "violet" },
  html:         { subtype: "html",         Icon: Globe,            labelEn: "Web Page",     hue: "sky" },
  code:         { subtype: "code",         Icon: Code2,            labelEn: "Code",         hue: "slate" },
  audio:        { subtype: "audio",        Icon: Headphones,       labelEn: "Audio",        hue: "violet" },
  /* 실행 파일 — *경고색* red 로 시각 구분. 사용자가 "이 파일은 그냥 더블클릭
     하면 동작한다" 는 점을 한 눈에 알아볼 수 있게. 라이브러리 자체는 자동
     실행하지 않으나, 외부 destination 에 끌어 떨어뜨릴 때의 의식 동작을 돕
     는 의미. */
  executable:   { subtype: "executable",   Icon: TerminalSquare,   labelEn: "Executable",   hue: "red" },
  other:        { subtype: "other",        Icon: FileText,         labelEn: "File",         hue: "slate" },
};

/* hue → Tailwind class 묶음. 카드 색띠/아이콘 색/배경 그라데이션이 한 세트
   로 움직이므로 string 보간 대신 정적 매핑으로 안전 (Tailwind purge 친화). */
const HUE_CLASSES: Record<DocPresentation["hue"], {
  /** 카드 좌측 색띠 / 우상단 배지 배경 */
  badgeBg: string;
  /** 큰 아이콘 색 */
  iconColor: string;
  /** 카드 배경 그라데이션 (top → bottom) */
  surface: string;
  /** 카드 텍스트(라벨) 위에서 부드럽게 빛나는 accent dot */
  dotBg: string;
}> = {
  rose:    { badgeBg: "bg-rose-500/15 text-rose-500",       iconColor: "text-rose-500",     surface: "bg-gradient-to-b from-rose-500/10 via-background to-background",       dotBg: "bg-rose-500" },
  amber:   { badgeBg: "bg-amber-500/15 text-amber-500",     iconColor: "text-amber-500",    surface: "bg-gradient-to-b from-amber-500/10 via-background to-background",      dotBg: "bg-amber-500" },
  orange:  { badgeBg: "bg-orange-500/15 text-orange-500",   iconColor: "text-orange-500",   surface: "bg-gradient-to-b from-orange-500/10 via-background to-background",     dotBg: "bg-orange-500" },
  blue:    { badgeBg: "bg-blue-500/15 text-blue-500",       iconColor: "text-blue-500",     surface: "bg-gradient-to-b from-blue-500/10 via-background to-background",       dotBg: "bg-blue-500" },
  violet:  { badgeBg: "bg-violet-500/15 text-violet-500",   iconColor: "text-violet-500",   surface: "bg-gradient-to-b from-violet-500/10 via-background to-background",     dotBg: "bg-violet-500" },
  emerald: { badgeBg: "bg-emerald-500/15 text-emerald-500", iconColor: "text-emerald-500",  surface: "bg-gradient-to-b from-emerald-500/10 via-background to-background",    dotBg: "bg-emerald-500" },
  sky:     { badgeBg: "bg-sky-500/15 text-sky-500",         iconColor: "text-sky-500",      surface: "bg-gradient-to-b from-sky-500/10 via-background to-background",        dotBg: "bg-sky-500" },
  slate:   { badgeBg: "bg-slate-500/20 text-slate-300",     iconColor: "text-slate-400",    surface: "bg-gradient-to-b from-slate-500/10 via-background to-background",      dotBg: "bg-slate-500" },
  red:     { badgeBg: "bg-red-500/15 text-red-500",         iconColor: "text-red-500",      surface: "bg-gradient-to-b from-red-500/10 via-background to-background",        dotBg: "bg-red-500" },
};

export function docSubtypeOf(item: ReferenceItem): DocSubtype {
  /* 저장된 PSD 는 mime 이 application/octet-stream 으로 떨어지고 title 에서
     확장자(.psd)가 제거돼 mime/ext 기반 판정이 "other" 로 빗나간다. 업로드 시
     생성한 풀해상도 프리뷰(ai_suggestions.psdPreview)가 있으면 확실한 PSD 이므로
     우선 확정한다. */
  if (item.ai_suggestions?.psdPreview) return "psd";
  return detectDocSubtype(item.mime_type ?? "", item.title ?? item.file_url ?? "");
}

export function docPresentationOf(item: ReferenceItem): DocPresentation {
  return TABLE[docSubtypeOf(item)];
}

export function docPresentationOfSubtype(subtype: DocSubtype): DocPresentation {
  return TABLE[subtype];
}

export function docHueClasses(p: DocPresentation) {
  return HUE_CLASSES[p.hue];
}

/** 카드 우상단 짧은 확장자 텍스트(예: "PDF", "TTF", "ZIP").
 *  파일명 확장자가 있으면 그것을 우선 — 사용자가 직접 알아보기 쉽기 때문.
 *  없을 때만 sub-type 의 영문 단어("Document") 로 폴백.
 *
 *  케이싱 — 약어형 확장자는 UPPER (`GIF`/`URL` 패턴), 단어형 폴백은 TitleCase
 *  (`Image`/`Video` 패턴). 폴백을 `.toUpperCase()` 로 강제하면 `SPREADSHEET`
 *  처럼 외침 식의 라벨이 나와 가독성이 떨어진다. */
export function docExtensionTag(item: ReferenceItem): string {
  const ext = (item.title || item.file_url || "")
    .match(/\.([a-z0-9]+)$/i)?.[1]
    ?.toUpperCase();
  if (ext && ext.length <= 5) return ext;
  return TABLE[docSubtypeOf(item)].labelEn;
}

/** sub-type 가 영구 정렬 / 필터 행 표시에 쓰이는 순서. UI 의 자연스러운
 *  스캔 순서(자주 쓰는 → 드물게 쓰는) 기준으로 손수 정렬. */
export const DOC_SUBTYPE_ORDER: DocSubtype[] = [
  "pdf",
  "psd",
  "presentation",
  "spreadsheet",
  "document",
  "font",
  "archive",
  "html",
  "code",
  "audio",
  "executable",
  "other",
];
