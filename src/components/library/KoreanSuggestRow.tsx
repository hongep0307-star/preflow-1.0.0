/**
 * KoreanSuggestRow (B2)
 *
 * 사이드바 검색창 바로 아래에 놓이는 인라인 추천 칩 블록.
 *
 * - LibraryPage 가 useEffect + 400 ms 디바운스로 `koreanSearchSuggest` 를
 *   호출해 spec / loading / dismissed 상태를 결정하고 이 컴포넌트로 props
 *   를 주입한다.
 * - tag 칩 클릭 → tagsFilter.include 에 영어 토큰 추가.
 *   mood 칩 클릭 → *moodsFilter.include* 에 영어 토큰 추가 (태그 필터가
 *   아니라 무드 필터 — chip 카테고리와 적용 대상 필터의 의미를 일치시킴).
 * - "× 닫기" 누르면 그 query 는 세션 동안 추천 안 함 (부모가 dismissed
 *   Set 으로 관리).
 *
 * 시각 디자인:
 *   - 좌측 브랜드 액센트 바 + 옅은 primary 틴트 배경으로 "추천(suggestion)
 *     영역" 임을 한눈에 표시 → toolbar 의 *실제 적용 필터* 칩과 시각적
 *     으로 명확히 분리.
 *   - 카테고리별로 *섹션 헤더* (✨ 추천 태그 / ✨ 추천 무드) 와 *전용 줄* 로
 *     나눠 그룹을 명확히 시각화. 각 헤더에 Sparkles 아이콘을 인라인으로
 *     붙여 "AI 추천" 의미를 카테고리 단위로 일관되게 전달.
 *   - 칩은 sharp corner(브랜드) + dashed 보더 + 투명 배경으로 "클릭하면
 *     추가됨" 어포던스를 부여. 실제 적용 칩(solid 보더, 채워진 배경) 과
 *     구분된다.
 *
 * 로딩/빈 상태:
 *   - 결과(tag 또는 mood)가 *하나라도 있으면* loading 인디케이터는 노출하지
 *     않는다 — 사용자에게 이미 클릭 가능한 칩이 보이고 있어 "추천 중…"
 *     라벨이 동시에 떠 있으면 시각적으로 중복이고, 새 결과는 LLM 응답
 *     완료 시 그냥 매끄럽게 추가된다.
 *   - 결과가 아직 없을 때만 "✨ 추천 중…" 한 줄을 보여 준다.
 *
 * Hallucination/dead-end 가드는 lib 단에서 끝났으므로 여기서는 빈 결과는
 * 자동으로 숨긴다 (loading 도 끝났는데 빈 결과 + error 없음 → null).
 */
import { Sparkles, X } from "lucide-react";
import { useT } from "@/lib/uiLanguage";
import { cn } from "@/lib/utils";

export interface KoreanSuggestRowProps {
  /** 디바운스 후 LLM 호출이 in-flight 인 동안 true. 빈 결과 vs "아직"
   *  을 구분하기 위해 필요. */
  loading: boolean;
  /** LibraryPage 가 들고 있는 KoreanSuggestSpec — null 이면 아직 LLM
   *  호출 전(쿼리 변경 직후 디바운스 대기) 이거나 한글이 없는 상태. */
  suggestedTags: ReadonlyArray<string>;
  suggestedMoods: ReadonlyArray<string>;
  /** LLM 호출은 끝났는데 칩이 한 개도 없을 때 (라이브러리 영어 inventory
   *  와 의미 교집합이 없는 경우) 부모가 "추천 없음" 안내를 띄울지 결정.
   *  현재는 silent 가 UX 적으로 더 깔끔해 false 권장. */
  showEmptyMessage?: boolean;
  /** 사용자가 tag 칩 하나를 클릭. 부모는 tagsFilter.include 에 추가 + 같은
   *  쿼리를 recent 로 영속(rememberKoreanQuery). */
  onApplyTag: (tag: string) => void;
  /** 사용자가 mood 후보 칩을 클릭. 부모는 *moodsFilter.include* 에 추가
   *  (태그 필터가 아니라 무드 필터). 미지정 시 onApplyTag 로 폴백 — 호출부
   *  가 별도 핸들러를 제공하지 않은 legacy 경로 보호. */
  onApplyMood?: (mood: string) => void;
  /** "× 닫기" — 부모는 dismissedQueries 에 현재 query 를 넣어 같은 세션
   *  에서 다시 안 뜨도록 한다. */
  onDismiss: () => void;
}

/* 칩은 "사용자가 클릭할 본문" — 본문급 readability(12px) + medium weight 로
   섹션 라벨(meta, 10px regular-ish) 과 명확한 위계 차를 만든다. uppercase
   제거 직후엔 라벨/칩이 같은 톤으로 평탄해 보여 "같은 레벨"로 읽혔던 문제를
   사이즈+웨이트 양쪽으로 분리해 해결. */
const CHIP_CLASS = cn(
  "inline-flex h-[24px] items-center border border-dashed px-2 text-meta font-medium transition-colors",
  "border-border bg-transparent text-text-secondary",
  "hover:border-primary hover:bg-primary/10 hover:text-foreground",
);

/* uiCopy 라벨("Suggested tags" / "추천 태그") 은 이미 사람이 읽기 좋은
   케이스로 정의돼 있는데 CSS `uppercase` 가 강제로 "SUGGESTED TAGS" 로
   변환하고 있었다 → 디자인 톤과 어긋나는 "고함치는" 느낌. uppercase 를
   제거하고, 대문자 전제로 벌려 놨던 자간도 정상화. 위계는 사이즈(10px vs
   12px) + 색(muted vs secondary) 로 만들고, 라벨의 weight 는 semibold 를
   유지해 헤더 시그널 자체는 잃지 않게 한다. */
const SECTION_LABEL_CLASS =
  "inline-flex items-center gap-1.5 text-2xs font-semibold tracking-normal text-muted-foreground/80";

/** 섹션 헤더 — 인라인 Sparkles 아이콘 + 라벨. 추천 태그/무드/로딩/빈 상태가
 *  모두 같은 헤더 형태를 공유해 "AI 추천" 시그널이 카테고리/상태 별로 일관
 *  되게 전달된다. */
function SectionHeader({ label }: { label: string }) {
  return (
    <span className={SECTION_LABEL_CLASS}>
      <Sparkles className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
      {label}
    </span>
  );
}

export function KoreanSuggestRow({
  loading,
  suggestedTags,
  suggestedMoods,
  showEmptyMessage = false,
  onApplyTag,
  onApplyMood,
  onDismiss,
}: KoreanSuggestRowProps) {
  const t = useT();

  const hasTags = suggestedTags.length > 0;
  const hasMoods = suggestedMoods.length > 0;
  const hasAny = hasTags || hasMoods;
  const empty = !loading && !hasAny;

  /* 빈 결과는 기본적으로 silent — UX 가 noisy 해지지 않게. 부모가 명시적
     으로 보여달라고 요청한 경우만 1줄짜리 안내를 렌더. */
  if (empty && !showEmptyMessage) return null;

  /* 결과가 이미 있을 때 in-flight 인디케이터를 별도 줄로 노출하면 헤더가
     중복되어 보이는 회귀가 있었다("추천 태그  추천 중…  /  추천 태그
     [chip]..."). 결과가 있으면 LLM 응답 완료 시 매끄럽게 추가되므로
     loading 라벨은 생략. 결과가 아예 없을 때만 단독 헤더로 보여 준다. */
  const showLoadingHeader = loading && !hasAny;
  const showEmptyHeader = empty && showEmptyMessage;

  return (
    <div
      // 사이드바 Quick filters 의 active row("All" 선택 시) 와 동일한 시각
      // 패턴 — `border-l-2 border-l-primary` + `bg-primary/10`. 이전엔
      // border 40% / bg 4% 로 한참 더 흐려서 같은 의미체계("브랜드 강조
      // 영역") 인데도 사용자 눈엔 별개의 위계로 읽혔다. opacity 를 맞춰
      // 라이브러리 안에서 "좌측 붉은 바 + 옅은 레드 틴트 = 강조 영역"
      // 단일 패턴으로 통일.
      className="flex items-start gap-2 border-l-2 border-l-primary bg-primary/10 px-3 py-2"
      style={{ borderRadius: 0 }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {showLoadingHeader ? (
          <div className="flex items-center gap-2">
            <SectionHeader label={t("library.koreanSuggest.loading")} />
          </div>
        ) : null}

        {showEmptyHeader ? (
          <div className="flex items-center gap-2">
            <SectionHeader label={t("library.koreanSuggest.empty")} />
          </div>
        ) : null}

        {/* 추천 태그 섹션 — Sparkles 헤더 + 칩들 wrap 줄. */}
        {hasTags ? (
          <div className="flex flex-col gap-1.5">
            <SectionHeader label={t("library.koreanSuggest.label")} />
            <div className="flex flex-wrap gap-1.5">
              {suggestedTags.map((tag) => (
                <button
                  key={`tag:${tag}`}
                  type="button"
                  onClick={() => onApplyTag(tag)}
                  title={t("library.koreanSuggest.applyTag", { tag })}
                  className={CHIP_CLASS}
                  style={{ borderRadius: 0 }}
                >
                  <span className="max-w-[160px] truncate">{tag}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 추천 무드 섹션 — 태그 섹션과 동일한 Sparkles 헤더 + 자체 줄.
            mood 는 클릭 시 *무드 필터* 로 적용되므로 라벨 자체("추천 무드")
            로 카테고리 차이를 명확화. */}
        {hasMoods ? (
          <div className="flex flex-col gap-1.5">
            <SectionHeader label={t("library.koreanSuggest.moodLabelSection")} />
            <div className="flex flex-wrap gap-1.5">
              {suggestedMoods.map((mood) => (
                <button
                  key={`mood:${mood}`}
                  type="button"
                  onClick={() => (onApplyMood ?? onApplyTag)(mood)}
                  title={t("library.koreanSuggest.applyMood", { tag: mood })}
                  className={CHIP_CLASS}
                  style={{ borderRadius: 0 }}
                >
                  <span className="max-w-[160px] truncate">{mood}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title={t("library.koreanSuggest.dismissTitle")}
        className="mt-[1px] inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        style={{ borderRadius: 0 }}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
