import type { SVGProps } from "react";

/**
 * PhotoStar — lucide `image-plus` 를 커스텀한 아이콘. 스타일 / 스타일로 사용 기능을
 * 나타낸다.
 *
 * image-plus 의 프레임(우상단이 열린 형태)·해(sun)·산 능선은 그대로 두고, 우상단의
 * "+"(plus) 자리에 별을 그린다. 이 자리는 프레임이 비어 있어(해는 좌상단, 산은 하단)
 * 별이 다른 요소와 겹치지 않고 또렷하게 보인다. 획·viewBox·currentColor 규칙을
 * lucide 와 동일하게 맞춰 `className`(w-/h-/text-color) 만으로 제어된다.
 */
export function PhotoStar({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* 프레임 — 우상단을 비워 별이 들어갈 자리를 만든다 (lucide image-plus 와 동일) */}
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
      {/* 산 능선 */}
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      {/* 해(sun) */}
      <circle cx="9" cy="9" r="2" />
      {/* 우상단 별 — image-plus 의 "+" 를 대체. 중심 (19,5), 외경 3 의 정5각 별. */}
      <path d="M19 2 19.71 4.03 21.85 4.07 20.14 5.37 20.76 7.43 19 6.2 17.24 7.43 17.86 5.37 16.15 4.07 18.3 4.03Z" />
    </svg>
  );
}
