import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    fontFamily: {
      // Pretendard Variable: 한/영 통합, 가변 폰트로 모든 weight 커버
      // Space Grotesk / Inter 제거 — Pretendard로 통일
      sans: ["Pretendard Variable", "Pretendard", "-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif"],
      // display도 Pretendard로 통일 (이전: Space Grotesk)
      // font-display 클래스 사용처에서 자동으로 Pretendard 적용됨
      display: ["Pretendard Variable", "Pretendard", "sans-serif"],
      // 버전 번호, 타임스탬프, 해상도(16:9 Horizontal) 등 기술적 수치 전용.
      // 폴백 체인 설계 의도:
      //  - macOS  : SF Mono 가 곧바로 매칭
      //  - Win 11 : Cascadia Mono → Cascadia Code (slab 마감이 살짝 약한 변형)
      //  - Win 10 : Consolas (모든 Windows 에 기본 탑재된 sans-style mono)
      //  - Linux  : Liberation Mono → generic monospace
      // 핵심은 generic `monospace` 앞에 Consolas 를 두는 것 — 이게 빠지면
      // Windows 의 generic monospace 가 Courier New 로 떨어져 카드 메타가
      // 갑자기 세리프로 보이는 사고가 난다.
      mono: [
        "SF Mono",
        "Cascadia Mono",
        "Cascadia Code",
        "Consolas",
        "Liberation Mono",
        "monospace",
      ],
    },
    extend: {
      // ── 시맨틱 타이포 스케일 ──────────────────────────────────────────────
      // 과거 컴포넌트 전역에 흩어져 있던 `text-[Npx]` 임의값(20종, 1,200+곳)을
      // 한 곳에서 관리하기 위한 토큰. 값은 *문자열* 로만 지정해 line-height 를
      // 강제하지 않으므로 기존 `text-[Npx]` 와 렌더링이 동일하다(시각 회귀 0).
      //
      // 매핑 원칙: 사용량이 압도적인 11/12/13px 는 각각 독립 토큰으로 보존한다.
      // 최소 크기는 한글 가독성을 위해 ~11px 로 floor 를 올렸다(8/9/10px 는 한글에서
      // 깨져 보임). 이 값들은 한 곳에서 조정 가능 — 더 키우려면 여기 px 만 바꾸면 된다.
      //   nano 10 · micro 11 · 2xs 11 · caption 11 · meta 12 · body 13 · label 14
      //   title 15 · subhead 16 · heading 17 · headline 20 · hero 22 · display 32
      // ⚠️ Tailwind 기본 키(xs/sm/base/lg/xl…) 는 건드리지 않는다 — 기존 text-sm
      //    등 사용처의 크기가 바뀌지 않도록 신규 키만 추가(extend 병합).
      fontSize: {
        nano: "10px",
        micro: "11px",
        "2xs": "11px",
        caption: "11px",
        meta: "12px",
        body: "13px",
        label: "14px",
        title: "15px",
        subhead: "16px",
        heading: "17px",
        headline: "20px",
        hero: "22px",
        display: "32px",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        brand: "hsl(var(--brand))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        "border-subtle": "hsl(var(--border-subtle))",
        "text-secondary": "hsl(var(--text-secondary))",
        "text-tertiary": "hsl(var(--text-tertiary))",
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        "surface-elevated": "hsl(var(--surface-elevated))",
        "surface-nav": "hsl(var(--surface-nav))",
        "surface-sidebar": "hsl(var(--surface-sidebar))",
        "surface-panel": "hsl(var(--surface-panel))",
        "surface-footer": "hsl(var(--surface-footer))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
