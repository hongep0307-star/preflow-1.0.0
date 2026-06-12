import type { SVGProps } from "react";

/**
 * DotGrid3x3 — 3×3 점 그리드 아이콘. '앵글 프리셋'(카메라 앵글 9분할 그리드) 기능을
 * 나타낸다. lucide 에는 9점 그리드 아이콘이 없어 직접 구성했다.
 *
 * 점은 채움(fill=currentColor)이라 작은 크기에서도 또렷하게 보인다. viewBox·
 * currentColor 규칙을 lucide 와 맞춰 `className`(w-/h-/text-color) 만으로 제어된다.
 */
export function DotGrid3x3({ className, ...props }: SVGProps<SVGSVGElement>) {
  const coords = [6, 12, 18];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {coords.flatMap((cy) =>
        coords.map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />),
      )}
    </svg>
  );
}
