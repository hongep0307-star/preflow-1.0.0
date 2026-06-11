import {
  Bookmark,
  Box,
  Briefcase,
  Brush,
  Camera,
  Compass,
  Film,
  Flag,
  Folder,
  FolderOpen,
  Globe,
  Hash,
  Heart,
  Image as ImageIcon,
  Layers,
  Layout,
  Lightbulb,
  MapPin,
  Mic,
  Music,
  Palette,
  Sparkles,
  Star,
  Tag,
  Target,
  Type as TypeIcon,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * 라이브러리 폴더 커스터마이즈에 쓰는 아이콘 / 컬러 카탈로그.
 *
 * 디자인 의도:
 *  - lucide 의 의미 강한 글리프만 추려, 사용자가 폴더를 보고 "이게
 *    무슨 폴더지" 즉시 떠올릴 수 있게 한다 (Eagle 의 Change Icon
 *    팔레트와 같은 역할).
 *  - 색상은 Tailwind 의 기본 팔레트 토큰을 그대로 사용 — 다크/라이트
 *    테마 어디서든 동일하게 비치고 별도 CSS 변수가 필요 없다. id 는
 *    저장소(folderPreferences) 의 안정 키로 쓰이므로 의미 변경 없이
 *    기존 id 는 절대 빼지 말 것 (사용자가 이미 선택해 둔 색이 사라짐).
 *
 * 추가 시 가이드:
 *  - 새 글리프는 의미가 명확하고 Folder 와 시각적으로 충돌하지 않는
 *    것만 (즉, FolderPlus / FolderMinus 같은 *Folder* 변형은 피하기).
 *  - 새 색은 swatch 가 한 줄에 깔끔하게 들어가는 10개 정도 유지.
 */

export interface FolderColorOption {
  /** 영구화 키. 절대 변경 금지. */
  id: string;
  /** 사람이 읽을 수 있는 이름. 툴팁용. */
  label: string;
  /** swatch 자체의 dot 색. */
  swatchClass: string;
  /** 폴더 아이콘 badge 의 배경(연한). */
  bgClass: string;
  /** 폴더 아이콘 자체 색. */
  fgClass: string;
}

export interface FolderIconOption {
  /** 영구화 키. 절대 변경 금지. */
  id: string;
  /** 툴팁용 라벨. */
  label: string;
  /** 렌더링용 lucide 컴포넌트. */
  Icon: LucideIcon;
}

/** "기본값" 컬러. 메타가 비어있을 때 사용. */
export const DEFAULT_FOLDER_COLOR_ID = "gray";
export const DEFAULT_FOLDER_ICON_ID = "folder";

/** swatch / badge 색 팔레트. Tailwind 기본 컬러 토큰 사용 — 별도
 *  CSS 변수 정의 불필요. fg 는 -400 (다크 배경 위에서 가독성),
 *  bg 는 -500/15 (subtle tint). gray 만 muted-foreground 토큰을
 *  그대로 써 "색 없음/기본" 느낌을 살린다. */
export const FOLDER_COLORS: FolderColorOption[] = [
  {
    id: "gray",
    label: "Default",
    swatchClass: "bg-muted-foreground/40",
    bgClass: "bg-muted/50",
    fgClass: "text-muted-foreground",
  },
  { id: "red",     label: "Red",     swatchClass: "bg-red-500",     bgClass: "bg-red-500/15",     fgClass: "text-red-400" },
  { id: "orange",  label: "Orange",  swatchClass: "bg-orange-500",  bgClass: "bg-orange-500/15",  fgClass: "text-orange-400" },
  { id: "amber",   label: "Amber",   swatchClass: "bg-amber-500",   bgClass: "bg-amber-500/15",   fgClass: "text-amber-400" },
  { id: "lime",    label: "Lime",    swatchClass: "bg-lime-500",    bgClass: "bg-lime-500/15",    fgClass: "text-lime-400" },
  { id: "emerald", label: "Emerald", swatchClass: "bg-emerald-500", bgClass: "bg-emerald-500/15", fgClass: "text-emerald-400" },
  { id: "sky",     label: "Sky",     swatchClass: "bg-sky-500",     bgClass: "bg-sky-500/15",     fgClass: "text-sky-400" },
  { id: "indigo",  label: "Indigo",  swatchClass: "bg-indigo-500",  bgClass: "bg-indigo-500/15",  fgClass: "text-indigo-400" },
  { id: "violet",  label: "Violet",  swatchClass: "bg-violet-500",  bgClass: "bg-violet-500/15",  fgClass: "text-violet-400" },
  { id: "pink",    label: "Pink",    swatchClass: "bg-pink-500",    bgClass: "bg-pink-500/15",    fgClass: "text-pink-400" },
];

/** 글리프 카탈로그. id 는 영구화 키 — 새 아이콘 추가 시 새 id 만
 *  쓰고 기존은 이름/Icon 을 바꿔도 되지만 id 는 보존. */
export const FOLDER_ICONS: FolderIconOption[] = [
  { id: "folder",      label: "Folder",       Icon: Folder },
  { id: "folder-open", label: "Folder open",  Icon: FolderOpen },
  { id: "image",       label: "Image",        Icon: ImageIcon },
  { id: "film",        label: "Film",         Icon: Film },
  { id: "music",       label: "Music",        Icon: Music },
  { id: "mic",         label: "Mic",          Icon: Mic },
  { id: "camera",      label: "Camera",       Icon: Camera },
  { id: "palette",     label: "Palette",      Icon: Palette },
  { id: "brush",       label: "Brush",        Icon: Brush },
  { id: "star",        label: "Star",         Icon: Star },
  { id: "heart",       label: "Heart",        Icon: Heart },
  { id: "bookmark",    label: "Bookmark",     Icon: Bookmark },
  { id: "tag",         label: "Tag",          Icon: Tag },
  { id: "sparkles",    label: "Sparkles",     Icon: Sparkles },
  { id: "layers",      label: "Layers",       Icon: Layers },
  { id: "box",         label: "Box",          Icon: Box },
  { id: "layout",      label: "Layout",       Icon: Layout },
  { id: "type",        label: "Type",         Icon: TypeIcon },
  { id: "hash",        label: "Hash",         Icon: Hash },
  { id: "globe",       label: "Globe",        Icon: Globe },
  { id: "map-pin",     label: "Pin",          Icon: MapPin },
  { id: "lightbulb",   label: "Idea",         Icon: Lightbulb },
  { id: "target",      label: "Target",       Icon: Target },
  { id: "compass",     label: "Compass",      Icon: Compass },
  { id: "zap",         label: "Bolt",         Icon: Zap },
  { id: "flag",        label: "Flag",         Icon: Flag },
  { id: "briefcase",   label: "Briefcase",    Icon: Briefcase },
];

/** 안전한 lookup — 사용자가 이전에 선택한 id 가 카탈로그에서 사라진
 *  경우(예: 우리가 글리프를 빼버린 경우) 기본값으로 폴백한다.
 *  화면이 깨지지 않게 하는 안전장치. */
export function resolveFolderColor(id?: string): FolderColorOption {
  return (
    FOLDER_COLORS.find((c) => c.id === id) ??
    FOLDER_COLORS.find((c) => c.id === DEFAULT_FOLDER_COLOR_ID)!
  );
}

export function resolveFolderIcon(id?: string): FolderIconOption {
  return (
    FOLDER_ICONS.find((i) => i.id === id) ??
    FOLDER_ICONS.find((i) => i.id === DEFAULT_FOLDER_ICON_ID)!
  );
}
