import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // 프로젝트 전반(react renderer, electron main 양쪽) 에서 try / catch 의 의도적
      // swallow 패턴을 흔히 쓴다 — localStorage.setItem, releasePointerCapture,
      // mkdir 같은 "best-effort" 호출을 실패 무시로 감싸는 자리가 24군데 있다.
      // 빈 if/while/for 블록은 여전히 진짜 버그라서 잡되, 빈 catch 만 허용해
      // catch 내부에 신호용 코멘트를 굳이 24개씩 뿌리지 않도록 한다. 진짜로
      // 처리해야 할 catch 는 보통 logger/toast 호출이 들어가므로 이 옵션이
      // 실수의 catch 를 가린다는 우려는 낮다.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
