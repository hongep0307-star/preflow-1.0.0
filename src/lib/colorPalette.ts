/**
 * 색팔레트 자동 추출.
 *
 * ReferenceItem.color_palette 의 데이터 자리는 이미 만들어져 있는데(스키마,
 * DB, 인스펙터 swatch UI) 정작 *채우는* 코드가 없어 영원히 빈 배열로
 * 들어가던 상태였다. 이 모듈이 그 빈자리를 채운다.
 *
 * 정책 (사용자 결정):
 *   - *현재 설정된 thumbnail 1장* 만 기준. 영상이라도 8 프레임 합산 같은 건
 *     안 하고 단순히 thumbnail_url 을 이미지 URL 로 취급. 비디오 poster /
 *     YouTube poster / 이미지 원본 모두 같은 경로.
 *   - thumbnail_url 가 *바뀌는 모든 경로* (createReference 의 신규 set,
 *     updateReference 의 patch — Save Frame as cover, Reset thumbnail,
 *     YouTube refresh, 자동 poster 생성 등) 에서 자동으로 다시 뽑힌다.
 *     hook 은 referenceLibrary 의 두 chokepoint 안에서 fire-and-forget
 *     으로 enqueue.
 *
 * 큐 모델:
 *   - 동시성 4. Eagle 1000개 일괄 import 같은 폭주 상황에서 메인 스레드
 *     점유를 막기 위한 가벼운 가드. 실제 추출은 extract-colors 가 내부
 *     <canvas> + getImageData 로 수행 (~10–30ms / 1장).
 *
 * 결과 전파:
 *   - 추출 완료 → DB(color_palette) 갱신 + 윈도우 커스텀 이벤트
 *     `preflow-library-palette-updated` 디스패치. LibraryPage 가 이를
 *     구독해 자기 items 상태를 패치한다(별도 refetch 불필요, 비용 0).
 */

import { extractColors } from "extract-colors";

import type { ColorSwatch } from "./referenceLibrary";

/** 추출할 swatch 최대 개수. 인스펙터 썸네일 직하 swatch 행이 일관되게
 *  5개 이상 노출되도록 8개로 잡음 — 추출기는 단색에 가까운 이미지면 그
 *  보다 적게 반환하므로 실제 노출은 콘텐츠에 따라 1~8 사이에서 결정된다. */
const PALETTE_SIZE = 8;
/** "솔리드한 소수의 컬러" 이미지가 아닌 한 이 개수 이상은 뽑히도록 보장
 *  하는 목표치. 첫 패스에서 이 값보다 적게 나오면 더 느슨한 파라미터로
 *  한 번 더 시도한다. 인스펙터 시각 풍부함과 색 필터 매칭 다양성을 위해
 *  사용자 정책상 7 로 결정. */
const MIN_TARGET_COLORS = 7;
/** extract-colors 의 픽셀 샘플링 한도. 32k 에서 48k 로 상향 — 명암
 *  그라데이션이 더 잘게 잡혀 1차 패스에서 명도가 다른 톤들이 머지되는
 *  비율이 줄어든다. 1장당 처리 시간은 30~45ms 수준. */
const SAMPLE_PIXELS = 48000;
/** 큐의 최대 동시 실행 개수. canvas / getImageData 가 메인 스레드를
 *  점유하므로 너무 크면 UI 가 떨림 — 4 정도가 import 폭주 / 부드러움
 *  의 균형점. */
const QUEUE_CONCURRENCY = 4;

/** 1차 추출 파라미터. extract-colors 기본값보다 머지 거리를 전반적으로
 *  좁힘 — 특히 lightnessDistance 를 0.2 → 0.08 로 크게 줄여 cinematic
 *  프레임의 명암부(그림자/하이라이트)가 한 swatch 로 뭉개지지 않게 한다.
 *  이 값은 "일반 사진/프레임" 에서 거의 항상 7+ 색을 뽑아내는 sweet spot.
 *  실제 솔리드 로고/단색 그래픽이면 이 단계에서도 자연스럽게 3~5 개만 나옴. */
const BASE_EXTRACT_PARAMS = {
  pixels: SAMPLE_PIXELS,
  distance: 0.12,
  lightnessDistance: 0.08,
  saturationDistance: 0.1,
  hueDistance: 0.05,
  crossOrigin: "anonymous" as const,
};

/** 2차(retry) 파라미터. 1차에서 MIN_TARGET_COLORS 미만이 나왔을 때만 사용.
 *  머지 거리를 한 번 더 좁혀, 1차에서도 뭉개졌던 미묘한 명암/채도 변형을
 *  분리. 단순 로고처럼 진짜 색 종류가 적은 이미지는 이 패스에서도 비슷한
 *  결과가 나와 추가 비용 외 부작용 없음. */
const LOOSER_EXTRACT_PARAMS = {
  pixels: SAMPLE_PIXELS,
  distance: 0.07,
  lightnessDistance: 0.05,
  saturationDistance: 0.06,
  hueDistance: 0.035,
  crossOrigin: "anonymous" as const,
};

export const PALETTE_UPDATED_EVENT = "preflow-library-palette-updated";

export interface PaletteUpdatedDetail {
  id: string;
  palette: ColorSwatch[];
}

let inFlight = 0;
const queue: Array<() => Promise<void>> = [];

function pump(): void {
  while (inFlight < QUEUE_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    inFlight += 1;
    job().finally(() => {
      inFlight -= 1;
      pump();
    });
  }
}

/** thumbnail URL 1장 → ColorSwatch[]. 실패(CORS/decode) 시 빈 배열 반환.
 *  silent fail 정책 — 카드 자체는 빈 색팔레트로 그대로 두고 다음 기회
 *  (Save Frame, Reset, 사용자 backfill 트리거 등) 에 다시 시도된다.
 *
 *  추출 전략: 2-pass adaptive.
 *    1) BASE_EXTRACT_PARAMS 로 1차 추출 — 명도/채도 분리가 충분히 세분된
 *       파라미터. 대다수의 사진/cinematic 프레임은 여기서 7+ 가 나옴.
 *    2) 결과가 MIN_TARGET_COLORS 미만이면 LOOSER_EXTRACT_PARAMS 로 한 번
 *       더 시도. 단순 솔리드 로고처럼 색 종류 자체가 적은 이미지는
 *       2차 패스도 비슷한 개수가 나와 자연스럽게 1차 결과로 수렴
 *       (둘 중 더 많이 나온 쪽을 선택). 1장당 비용은 1패스 대비 최대
 *       2배 정도이지만 fire-and-forget + 큐 동시성 4 라 UX 영향 미미.
 *
 *  반환 swatch 순서: extract-colors 가 매기는 "power"(intensity × 면적
 *  패널티) 순으로 들어온 것을 그대로 보존. ratio 내림차순 등 다른
 *  순서가 필요하면 *표시 시점에 정렬* (DB 데이터는 raw 보존). */
export async function extractFromThumbnail(url: string): Promise<ColorSwatch[]> {
  if (!url) return [];
  try {
    let colors = await extractColors(url, BASE_EXTRACT_PARAMS);
    if (Array.isArray(colors) && colors.length > 0 && colors.length < MIN_TARGET_COLORS) {
      const retry = await extractColors(url, LOOSER_EXTRACT_PARAMS);
      if (Array.isArray(retry) && retry.length > colors.length) {
        colors = retry;
      }
    }
    if (!Array.isArray(colors) || colors.length === 0) return [];
    return colors.slice(0, PALETTE_SIZE).map((c) => ({
      color: c.hex,
      // area 는 0..1 사이의 비율 (해당 색이 차지하는 픽셀 비중) —
      // ColorSwatch.ratio 와 의미 동일.
      ratio: typeof c.area === "number" ? c.area : 1 / Math.max(1, colors.length),
    }));
  } catch {
    return [];
  }
}

/** 큐에 추출 작업 등록. fire-and-forget 호출자용 — onResult 콜백으로
 *  결과를 받는다(빈 배열도 호출되며, 그 경우 보통 noop). */
export function enqueueExtractFromThumbnail(
  url: string | null | undefined,
  onResult: (swatches: ColorSwatch[]) => void,
): void {
  if (!url) {
    onResult([]);
    return;
  }
  queue.push(async () => {
    const result = await extractFromThumbnail(url);
    onResult(result);
  });
  pump();
}

/** 윈도우 커스텀 이벤트 발신 — LibraryPage 등이 items 상태를 패치하는 데 사용.
 *  서버 사이드 / SSR 환경(window 없음) 에선 noop. */
export function dispatchPaletteUpdated(id: string, palette: ColorSwatch[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PaletteUpdatedDetail>(PALETTE_UPDATED_EVENT, {
      detail: { id, palette },
    }),
  );
}

/** Eagle 일괄 import 후처리 등 — 이미 존재하는 items 중 thumbnail_url 이
 *  있는데 color_palette 가 비어 있는 것들에 대해 일괄 enqueue. 동시성
 *  가드는 이미 큐 안에 들어 있으므로 호출 측은 그냥 한 번 부르면 된다.
 *
 *  결과가 나오면 onPaletteReady(id, swatches) 가 호출돼 호출자가 DB
 *  반영 또는 로컬 state 패치를 한다. 빈 배열은 콜백을 부르지 않는다 —
 *  legacy 데이터가 영영 깜빡깜빡 갱신되는 것을 방지. */
export function backfillMissingPalettes(
  items: Array<{ id: string; thumbnail_url?: string | null; color_palette: ColorSwatch[] }>,
  onPaletteReady: (id: string, swatches: ColorSwatch[]) => void,
): void {
  for (const item of items) {
    if (!item.thumbnail_url) continue;
    if (item.color_palette.length > 0) continue;
    enqueueExtractFromThumbnail(item.thumbnail_url, (swatches) => {
      if (swatches.length === 0) return;
      onPaletteReady(item.id, swatches);
    });
  }
}
