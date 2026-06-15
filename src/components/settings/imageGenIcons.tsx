/**
 * 설정 모달의 이미지 생성 기능 행 앞에 붙는 아이콘 매핑.
 *
 * 각 기능을 "실제 그 기능을 실행하는 UI 버튼/메뉴/모달이 쓰는 아이콘" 과 똑같이
 * 맞춰, 설정에서 본 아이콘과 실제 기능 트리거가 한눈에 연결되도록 한다.
 * (아래 file:line 은 그 아이콘이 실제로 렌더되는 1차 트리거 위치)
 *
 *   · conti           → Sparkles          (ContiTab "전체 생성")
 *   · style           → PhotoStar(커스텀)  (콘티 카드 "스타일로 사용" 퀵 버튼)
 *   · storyboardSheet → LayoutGrid        (ContiTab 시트 모드 토글)
 *   · angle           → Move3d            (ChangeAngle 모달 / SidePanel)
 *   · inpaint         → Paintbrush        (콘티 SidePanel 인페인트)
 *   · cameraVariation → DotGrid3x3(커스텀) (콘티 SidePanel 앵글 프리셋)
 *   · sketch          → SwitchCamera      (콘티 카드 구도 다양화 퀵 버튼, 카운트 배지)
 *   · mood            → Sparkles          (MoodIdeationPanel 생성)
 *   · sheet           → Sparkles          (AssetDetailModal 시트 생성)
 *   · variation       → Network           (라이브러리 컨텍스트 메뉴 베리에이션)
 *   · canvas          → Network           (캔버스 AI 생성 노드 헤더)
 *
 * NOTE — conti/sketch/mood/sheet 는 모두 동일한 "Sparkles + 생성" 버튼이 1차
 * 트리거라 같은 아이콘이 된다(실제 앱에서도 이들은 아이콘이 아니라 탭/패널
 * 컨텍스트로 구분된다). variation/canvas 도 둘 다 Network 노드 아이콘을 쓴다.
 * 즉 일부 중복은 실제 UI 와 정확히 일치시킨 결과다.
 *
 * imageGenPreference.ts 는 React 비의존 순수 lib 라 아이콘은 이 별도 모듈에 둔다.
 */
import type { ComponentType } from "react";
import {
  LayoutGrid,
  Move3d,
  Paintbrush,
  Sparkles,
  SwitchCamera,
  Network,
} from "lucide-react";
import { DotGrid3x3 } from "@/components/icons/DotGrid3x3";
import { PhotoStar } from "@/components/icons/PhotoStar";
import type { ImageGenFeature } from "@/lib/imageGenPreference";

/** lucide 아이콘과 커스텀 DotGrid3x3 를 함께 담기 위한 공통 타입. */
type FeatureIcon = ComponentType<{ className?: string }>;

export const IMAGE_GEN_FEATURE_ICONS: Record<ImageGenFeature, FeatureIcon> = {
  conti: Sparkles,
  style: PhotoStar,
  storyboardSheet: LayoutGrid,
  angle: Move3d,
  inpaint: Paintbrush,
  cameraVariation: DotGrid3x3,
  sketch: SwitchCamera,
  mood: Sparkles,
  sheet: Sparkles,
  variation: Network,
  canvas: Network,
};
