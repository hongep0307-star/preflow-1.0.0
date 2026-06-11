import { cn } from "@/lib/utils";

// ── 브랜드 마크 ─────────────────────────────────────────────────────────────
// Project / Library 두 마크는 사용자가 제공한 원본 SVG 좌표를 픽셀 단위 그대로
// 옮긴 것이다. viewBox 는 200×200, 안쪽 컨텐츠는 (10,10) 으로 translate 되어
// 실제 그래픽 영역은 180×180. 외곽 프레임은 우상단 + 좌하단 두 곳에 30 단위
// 대각선 컷이 들어간 사각형(`stroke-linejoin="miter"` 로 컷 모서리가 칼처럼
// 떨어짐). 두 마크의 유일한 차이는 내부 `<rect>` 의 위치/크기/채움 여부뿐.
//
//   ⚠ 박스 좌표는 임의로 손대지 말 것. 변경이 필요하면 디자이너 원본 SVG 를
//     다시 받아서 그 좌표를 그대로 교체하는 식으로만 진행한다.
//
// 색상은 `#E53935` 하드코딩 대신 `currentColor` 로 받아 `text-primary` 토큰
// (`#f9423a`) 이 자동 주입된다. 다크/라이트 토큰 전환 시에도 그대로 따라감.

type BrandVariant = "project" | "library";

type BrandMarkProps = {
  className?: string;
  /** true 면 외곽 컷-프레임을 제거하고 안쪽 4 박스만 렌더한다.
   *  좌상단 메인 로고는 항상 프레임 포함(=false)이어야 하므로 호출부에서
   *  명시적으로 true 를 넘겨야만 frameless 모드가 활성화된다.
   *  쓰임새 — 워크스페이스 스위처 등 작은 배지(28–32px)에서, 프레임
   *  스트로크가 시각적으로 너무 두껍게 잡혀 안쪽 4 박스가 작아 보이는
   *  케이스에 사용한다. 박스 좌표/크기는 그대로 유지되어 식별성을 잃지
   *  않는다. */
  withoutFrame?: boolean;
};

const FRAME_PATH = "M 0 0 L 150 0 L 180 30 L 180 180 L 30 180 L 0 150 Z";

export const ProjectMark = ({ className, withoutFrame = false }: BrandMarkProps) => (
  <svg
    viewBox="0 0 200 200"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("text-primary flex-shrink-0", className)}
    aria-hidden="true"
  >
    <g transform="translate(10, 10)">
      {!withoutFrame && (
        <path
          d={FRAME_PATH}
          stroke="currentColor"
          strokeWidth={10}
          strokeLinejoin="miter"
        />
      )}
      {/* 채움 박스 3 개. 원본 55×55 에서 × 0.9 축소 → 49.5×49.5.
         각 박스 중심점(원본 기준 (59.5, 59.5) / (120.5, 59.5) / (59.5, 120.5))
         은 그대로 유지한 채 사이즈만 줄여서 프레임 안 박스가 살짝 더 작아 보이게.
         결과적으로 박스 사이 십자 갭이 6 → 11.5 단위로 넓어진다.
         + LibraryMark 와 동일하게 4 박스 그룹 전체를 y 2.5 단위(= 40px 렌더
           기준 0.5 CSS px) 위로 평행 이동해 프레임 안 미세하게 위로 보정. */}
      <rect x="34.75" y="32.25" width="49.5" height="49.5" fill="currentColor" />
      <rect x="95.75" y="32.25" width="49.5" height="49.5" fill="currentColor" />
      <rect x="34.75" y="93.25" width="49.5" height="49.5" fill="currentColor" />
      {/* BR 외곽선 — 채움 박스와 같은 비율(× 0.9)로 축소 + 같은 2.5 단위 상향.
         · 시각 외곽 : 49.5×49.5 (95.75–145.25 × 93.25–142.75)
         · 시각 내곽 : 35.5×35.5 (102.75–138.25 × 100.25–135.75), stroke ring 7 유지
         even-odd-fill 도넛으로 stroke 보다 작은 렌더에서 더 또렷하게 잡힘. */}
      <path
        d="M 95.75 93.25 H 145.25 V 142.75 H 95.75 Z M 102.75 100.25 H 138.25 V 135.75 H 102.75 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </g>
  </svg>
);

export const LibraryMark = ({ className, withoutFrame = false }: BrandMarkProps) => (
  <svg
    viewBox="0 0 200 200"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("text-primary flex-shrink-0", className)}
    aria-hidden="true"
  >
    <g transform="translate(10, 10)">
      {!withoutFrame && (
        <path
          d={FRAME_PATH}
          stroke="currentColor"
          strokeWidth={10}
          strokeLinejoin="miter"
        />
      )}
      {/* 4 박스 모두 외곽선 — 각 박스를 시각 외곽 기준 × 0.9 로 축소하고
         중심점은 그대로 유지. stroke ring 의 시각 두께(7) 도 유지되어 박스가
         얇아지지 않고 자연스럽게 작아진다.
         · 시각 외곽 폭 : 57 → 51.3 (× 0.9)
         · 시각 외곽 높이 : 45/69/75/51 → 40.5/62.1/67.5/45.9 (× 0.9)
         · 시각 내곽 = 시각 외곽 − 7 / 변(좌우 각 3.5)
         even-odd-fill 도넛 구조라 작은 렌더에서도 또렷하게 유지된다.
         + 4 박스 그룹이 프레임 정중앙보다 아래로 쏠려 보여서, 4 박스 전체
           y 좌표를 2.5 단위씩 위로 평행 이동 (= 40px 렌더 기준 0.5 CSS px 상향). */}
      {/* TL : outer 31.35–82.65 × 28.25–68.75 (51.3×40.5), inner 38.35–75.65 × 35.25–61.75 */}
      <path
        d="M 31.35 28.25 H 82.65 V 68.75 H 31.35 Z M 38.35 35.25 H 75.65 V 61.75 H 38.35 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      {/* TR : outer 97.35–148.65 × 29.45–91.55 (51.3×62.1), inner 104.35–141.65 × 36.45–84.55 */}
      <path
        d="M 97.35 29.45 H 148.65 V 91.55 H 97.35 Z M 104.35 36.45 H 141.65 V 84.55 H 104.35 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      {/* BL : outer 31.35–82.65 × 81.75–149.25 (51.3×67.5), inner 38.35–75.65 × 88.75–142.25 */}
      <path
        d="M 31.35 81.75 H 82.65 V 149.25 H 31.35 Z M 38.35 88.75 H 75.65 V 142.25 H 38.35 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      {/* BR : outer 97.35–148.65 × 104.55–150.45 (51.3×45.9), inner 104.35–141.65 × 111.55–143.45 */}
      <path
        d="M 97.35 104.55 H 148.65 V 150.45 H 97.35 Z M 104.35 111.55 H 141.65 V 143.45 H 104.35 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </g>
  </svg>
);

// ── 브랜드 로고 (마크 + PRE-FLOW + 서브타이틀) ─────────────────────────────
// 네비바(81px) 안에 들어가는 기본 사이즈는 `md`. 좌측 마크 + 우측 2 줄
// (PRE-FLOW / 서브타이틀) 의 수직 중앙 정렬. 서브타이틀은 variant 로 결정되며,
// 디자인 토큰 통일을 위해 항상 대문자 + 트래킹 0.2em + muted-foreground 톤.
//
// 비율 기준 — 마크는 픽스(40px), 텍스트는 마크 대비 살짝 작게.
//   md  ⇒ mark 40px, title 20px, subtitle 9px, stackGap 4px
//         (text block ≈ 20+4+9 = 33px, mark 40px → 40/33 = 1.21)
//   ※ 외곽선 박스가 작은 렌더에서 흐려져 작아 보이던 문제는 BrandLogo 사이즈를
//     키우는 대신 마크 SVG 의 외곽선 박스를 stroke → even-odd-fill path 로 바꿔
//     해결했다 (위 ProjectMark/LibraryMark 의 path 주석 참고).

type BrandLogoProps = {
  variant: BrandVariant;
  size?: "sm" | "md" | "lg";
  showSubtitle?: boolean;
  className?: string;
};

const sizeMap = {
  sm: {
    wrap: "gap-2.5",
    mark: "w-6 h-6",
    title: "text-title",
    subtitle: "text-nano",
    stackGap: "gap-[3px]",
  },
  md: {
    wrap: "gap-[7px]",
    mark: "w-10 h-10",
    title: "text-headline",
    subtitle: "text-micro",
    stackGap: "gap-[4px]",
  },
  lg: {
    wrap: "gap-4",
    mark: "w-14 h-14",
    title: "text-display",
    subtitle: "text-body",
    stackGap: "gap-[6px]",
  },
} as const;

const variantSubtitle: Record<BrandVariant, string> = {
  project: "PROJECT WORKSPACE",
  library: "REFERENCE LIBRARY",
};

const MarkByVariant = ({ variant, className }: { variant: BrandVariant; className?: string }) => {
  if (variant === "library") return <LibraryMark className={className} />;
  return <ProjectMark className={className} />;
};

export const BrandLogo = ({
  variant,
  size = "md",
  showSubtitle = true,
  className,
}: BrandLogoProps) => {
  const cfg = sizeMap[size];

  return (
    <div className={cn("flex items-center leading-none select-none", cfg.wrap, className)}>
      <MarkByVariant variant={variant} className={cfg.mark} />
      <div className={cn("flex flex-col items-start leading-none", cfg.stackGap)}>
        <span className={cn("font-extrabold tracking-tight uppercase", cfg.title)}>
          <span className="text-foreground">PRE-</span>
          <span className="text-primary">FLOW</span>
        </span>
        {showSubtitle && (
          <span
            className={cn(
              "font-semibold uppercase text-muted-foreground tracking-[0.2em]",
              cfg.subtitle,
            )}
          >
            {variantSubtitle[variant]}
          </span>
        )}
      </div>
    </div>
  );
};
