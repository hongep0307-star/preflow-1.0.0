# PRE-FLOW 디자인 시스템

> 출처: `tailwind.config.ts`, `src/index.css`, `src/components/ui/*`, 자산 색상 설정(`ACFG`)
> 테마: **다크 단일 / 직각(라운딩 0) / 무채색 베이스 + 단일 레드 강조**

---

## 0. 기반 (Foundation)

- **스택**: Electron + React + Tailwind CSS + shadcn/ui(Radix 기반) + CVA(`class-variance-authority`)
- **테마**: 다크 모드 단일(라이트 없음). 거의 순수 블랙 기반의 영상 제작 툴 톤
- **시그니처**: `--radius: 0px` — **전 컴포넌트 직각 모서리**(VSCode/Eagle 풍). 라운딩이 이 앱의 정체성
- **토큰 방식**: HSL CSS 변수(`src/index.css`) → Tailwind 시맨틱 컬러로 매핑(`tailwind.config.ts`)

---

## 1. 컬러 (Color)

### 브랜드

| 토큰 | 값 | 용도 |
|---|---|---|
| `--brand` / `--primary` | `hsl(2 95% 60%)` ≈ **#f9423a** (KR Red) | 핵심 강조, 활성 탭/바, CTA |
| `--primary-foreground` | `#ffffff` | primary 위 텍스트 |

### 배경 & 표면 (레이어드 그레이)

어두울수록 바깥/뒤, 밝을수록 떠 있는 면.

| 토큰 | 명도 | Hex |
|---|---|---|
| `--surface-footer` | 2% | #050505 |
| `--background` / `--surface-sidebar` | 4% | #0a0a0a |
| `--surface-nav` / `--sidebar-background` | 5% | #0d0d0d |
| `--surface-panel` | 7% | #121212 |
| `--card` / `--popover` | 8% | #141414 |
| `--surface-elevated` / `--secondary` / `--muted` / `--input` / `--accent` | 11% | #1c1c1c |

### 텍스트

| 토큰 | 값 | 용도 |
|---|---|---|
| `--foreground` | `#f0f0f0` (94%) | 본문 |
| `--text-secondary` / `--secondary-foreground` | `#999` (60%) | 보조 |
| `--muted-foreground` | `#777` (47%) | 비활성/메타 (WCAG AA 위해 상향됨) |
| `--text-tertiary` | 35% | 최약 텍스트 |

### 보더 / 포커스

- `--border`: `white / 0.07`, `--border-subtle`: `white / 0.08` (알파 기반 미세 라인)
- `--ring`: `hsl(0 0% 75%)` — 키보드 포커스는 **무채색**(브랜드 레드와 의도적으로 분리)
- 전역 `outline` 비활성. 선택 상태는 컴포넌트별 강조(좌측 primary 바 / `bg-accent` / selection ring)로 표현

### 시맨틱 상태

| 토큰 | 값 |
|---|---|
| `--success` | `hsl(160 84% 39%)` 틸/그린 |
| `--warning` | `hsl(38 92% 50%)` 앰버 |
| `--destructive` | `hsl(0 84% 45%)` 레드 |

### 자산 분류 색상 (Asset Taxonomy — `ACFG`)

멘션 칩·뱃지·호버 프리뷰에서 자산 유형 구분.

| 유형 | color | bg | border |
|---|---|---|---|
| character | `#6366f1` (인디고) | `rgba(99,102,241,0.10)` | `rgba(99,102,241,0.22)` |
| item | `#d97706` (앰버) | `rgba(245,158,11,0.10)` | `rgba(245,158,11,0.22)` |
| background | `#059669` (에메랄드) | `rgba(16,185,129,0.10)` | `rgba(16,185,129,0.22)` |

---

## 2. 타이포그래피 (Typography)

### 폰트 패밀리

- **sans / display**: `Pretendard Variable → Pretendard → -apple-system → system-ui → sans-serif`
  (한·영 통합, 가변 폰트로 전 weight 커버)
- **mono**: `SF Mono → Cascadia Mono → Cascadia Code → Consolas → Liberation Mono → monospace`
  - 버전·타임스탬프·해상도(16:9) 등 **기술 수치 전용**
  - generic `monospace` 앞에 Consolas 고정 → Windows에서 Courier New 세리프로 떨어지는 사고 방지
- 렌더링: `-webkit-font-smoothing: antialiased`, `text-wrap: pretty`

### 타입 스케일 (시맨틱 토큰)

한글 가독성을 위해 최소 ~11px floor. line-height 미강제(기존 시각 회귀 0).

| 토큰 | px | | 토큰 | px |
|---|---|---|---|---|
| `nano` | 10 | | `subhead` | 16 |
| `micro` / `2xs` / `caption` | 11 | | `heading` | 17 |
| `meta` | 12 | | `headline` | 20 |
| `body` | 13 | | `hero` | 22 |
| `label` | 14 | | `display` | 32 |
| `title` | 15 | | | |

> Tailwind 기본 키(xs/sm/base…)는 건드리지 않고 신규 키만 추가(extend 병합).

### 텍스트 유틸리티

- `.label-meta`: 11px / weight 500 / `letter-spacing 0.04em` / muted
- `.mono`: mono 체인 / 11px / `letter-spacing 0.02em`

---

## 3. 스페이싱 & 레이아웃 (Layout)

- 컨테이너: center, padding `2rem`, max breakpoint `2xl: 1400px`
- `borderRadius` 토큰: `lg = var(--radius) = 0`, `md = calc(-2px)`, `sm = calc(-4px)` → **실질 전부 0**
- 앱 셸 높이
  - `.app-topbar`: **81px** (윈도우 드래그 핸들, `-webkit-app-region: drag`)
  - `.app-footer`: **28px** (`h-7`)
- 스크롤바: 4px 폭, thumb `foreground / 0.12`(hover `0.2`), radius 2px

---

## 4. 컴포넌트 패턴 (Components)

### Button (CVA — `src/components/ui/button.tsx`)

- 공통: `rounded-none`, `text-sm font-medium`, `transition-colors`, `focus-visible:ring-2`
- **variant**: `default`(primary) · `destructive` · `outline` · `secondary` · `ghost` · `link`
- **size**: `default h-10 px-4` · `sm h-9 px-3` · `lg h-11 px-8` · `icon h-10 w-10`

### Surface

- `.surface-card`: `bg-card` + 1px `white/0.07` 보더 → hover 시 **브랜드 레드 보더(0.25)** + elevated 배경, 200ms 트랜지션
- `.surface-panel`: panel 배경 + subtle 보더
- `.surface-elevated`: 11% 표면

### Tab

- `.tab-item`: muted → hover foreground, 하단 2px 투명 보더
- `.tab-item.active`: foreground + `font-semibold` + **하단 보더 primary**

### Meta Pill (`.meta-pill`)

- 26px 높이, 직각, mono `2xs`, subtle 보더 + `panel/0.7` 배경
- hover: `primary/0.3` 보더
- `.meta-pill-active`: `primary` 보더·배경(0.1)·텍스트

### 윈도우 컨트롤 (Electron, Windows/Linux 전용)

- 커스텀 ─ □ ×, 버튼 36px / 호버박스 **32×38 직각**
- 일반 hover `foreground/0.08`, **닫기 hover `#E81123`**(Windows 관행)
- macOS는 native traffic light 사용(렌더 안 함)

---

## 5. 모션 (Motion)

| 이름 | 정의 | 용도 |
|---|---|---|
| `fadeIn` / `.animate-fade-in` | opacity + `translateY(4px)`, 0.3s ease-out | 메시지/요소 등장 |
| `tokenFade` / `.token-fade` | opacity, 0.25s ease-out | 스트리밍 텍스트 토큰 단위 |
| `shimmer` / `.skeleton-shimmer` | 1.8s 무한 | 로딩 스켈레톤 |
| `auroraTop/Mid/Bottom`, `shimmerSweep` | translate/scale | 배경 앰비언트 |
| `accordion-down/up` | 0.2s ease-out | Radix 아코디언 |

- 전반에 `@media (prefers-reduced-motion: reduce)` 가드 적용(접근성)
- `.img-lazy` → `.loaded`: 이미지 로딩 0.3s 페이드

---

## 6. 디자인 원칙 (Principles)

1. **다크·직각·무채색 베이스 + 레드 단일 강조** — 콘텐츠(영상/이미지)가 주인공, UI는 배경으로 후퇴
2. **알파 보더 + 표면 명도 단계**로 깊이 표현 (그림자 거의 안 씀)
3. **포커스는 무채색, 의미는 레드** — 키보드 인디케이터와 브랜드 강조를 분리
4. **한글 우선 가독성** — Pretendard 통일, 11px floor, mono는 수치 전용
5. **데스크톱 앱 셸** — 커스텀 타이틀바 / 드래그 영역 / 플랫폼별 윈도우 컨트롤
6. **접근성 내장** — WCAG AA 대비 보정, `prefers-reduced-motion` 일괄 가드
