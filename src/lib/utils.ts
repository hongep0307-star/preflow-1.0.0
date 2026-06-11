import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind.config.ts 의 커스텀 시맨틱 폰트 스케일(text-nano … text-display)을
// tailwind-merge 가 "font-size" 그룹으로 인식하도록 등록한다.
//
// ⚠️ 이게 없으면 tailwind-merge 는 `text-caption` 같은 커스텀 토큰을 알지 못해
// `text-primary/85` 같은 text-color 클래스와 같은 그룹으로 오인하고, 충돌 해소
// 과정에서 폰트 크기 클래스를 통째로 제거한다. 그 결과 "크기 + 색상"을 함께 쓴
// 요소(대부분의 텍스트)에서 크기가 빠져 상속된 16px 로 커지는 버그가 난다.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "nano",
            "micro",
            "2xs",
            "caption",
            "meta",
            "body",
            "label",
            "title",
            "subhead",
            "heading",
            "headline",
            "hero",
            "display",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
