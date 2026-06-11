import { describe, expect, it } from "vitest";

import {
  COLOR_FILTER_THRESHOLD,
  colorDistance,
  hexToLab,
  hexToRgb,
  rgbToHex,
  scoreItemByColor,
} from "@/lib/colorMatch";

describe("colorMatch — hex/rgb roundtrip", () => {
  it("parses #RRGGBB and bare RRGGBB equivalently", () => {
    expect(hexToRgb("#ff8800")).toEqual({ r: 255, g: 136, b: 0 });
    expect(hexToRgb("ff8800")).toEqual({ r: 255, g: 136, b: 0 });
  });

  it("rejects malformed hex", () => {
    expect(hexToRgb("not-hex")).toBeNull();
    expect(hexToRgb("#abc")).toBeNull(); // 3자리 단축형은 의도적으로 미지원
    expect(hexToRgb("#1234567")).toBeNull();
  });

  it("rgbToHex round-trips with hexToRgb", () => {
    const samples = ["#000000", "#ffffff", "#1e88e5", "#fdd835", "#7e57c2"];
    for (const hex of samples) {
      const rgb = hexToRgb(hex);
      expect(rgb).not.toBeNull();
      expect(rgbToHex(rgb!)).toBe(hex);
    }
  });
});

describe("colorMatch — LAB distance", () => {
  it("distance from a color to itself is ~0", () => {
    expect(colorDistance("#1e88e5", "#1e88e5")).toBeLessThan(0.01);
  });

  it("similar blues have small distance, blue↔red have large distance", () => {
    const blueA = "#1e88e5";
    const blueB = "#1976d2"; // 살짝 다른 파랑
    const red = "#e53935";
    const dSimilar = colorDistance(blueA, blueB);
    const dDifferent = colorDistance(blueA, red);
    expect(dSimilar).toBeLessThan(COLOR_FILTER_THRESHOLD);
    expect(dDifferent).toBeGreaterThan(COLOR_FILTER_THRESHOLD);
    expect(dSimilar).toBeLessThan(dDifferent);
  });

  it("invalid hex yields Infinity (= never matches)", () => {
    expect(colorDistance("not-a-hex", "#000000")).toBe(Number.POSITIVE_INFINITY);
  });

  it("hexToLab caches; repeated calls return equal Lab", () => {
    const a = hexToLab("#1e88e5");
    const b = hexToLab("#1E88E5");
    expect(a).toEqual(b);
  });
});

describe("colorMatch — scoreItemByColor", () => {
  it("returns null for empty palette", () => {
    expect(scoreItemByColor([], "#000000")).toBeNull();
  });

  it("returns null when target hex is invalid", () => {
    expect(scoreItemByColor([{ color: "#000000" }], "garbage")).toBeNull();
  });

  it("distance uses the closest swatch regardless of ratio (filter-pass semantics)", () => {
    /* palette 에 빨간색과 파란색이 함께 있고, target=파랑이면 swatch 의
       ratio 가 어떻든 거리 ≈ 0 (파랑과 동일) 이 나와야 한다. ratio 가중치를
       쓰면 빨간색이 더 넓은 비중일 때 거리가 부풀려질 텐데, 정책상 그렇게
       동작하면 안 됨 (작게 들어간 핵심 색도 잡혀야). */
    const palette = [
      { color: "#e53935", ratio: 0.9 }, // 큰 빨강
      { color: "#1e88e5", ratio: 0.1 }, // 작은 파랑
    ];
    const score = scoreItemByColor(palette, "#1e88e5");
    expect(score).not.toBeNull();
    expect(score!.distance).toBeLessThan(0.01);
  });

  it("threshold ≈ 25 separates same-family vs cross-family", () => {
    const blue = "#1e88e5";
    /* 같은 family — 살짝 다른 파랑들 */
    const variants = ["#1976d2", "#2196f3", "#42a5f5"];
    for (const v of variants) {
      expect(colorDistance(blue, v)).toBeLessThan(COLOR_FILTER_THRESHOLD);
    }
    /* 다른 family */
    const others = ["#e53935", "#43a047", "#fdd835"];
    for (const o of others) {
      expect(colorDistance(blue, o)).toBeGreaterThan(COLOR_FILTER_THRESHOLD);
    }
  });

  /* ── rankScore: 면적 큰 swatch 에 보너스만, 작은 swatch 에 페널티 X ── */

  it("ratio=0 / undefined: rankScore === distance (no penalty)", () => {
    // 면적 보너스가 0 면 rankScore 가 distance 와 정확히 같아야 한다.
    // legacy 데이터(ratio 누락) 가 기존 정렬 동작과 동일하게 작동함을 보장.
    const paletteNoRatio = [{ color: "#1e88e5" }];
    const r1 = scoreItemByColor(paletteNoRatio, "#1e88e5");
    expect(r1).not.toBeNull();
    expect(r1!.rankScore).toBeCloseTo(r1!.distance, 6);

    const paletteZeroRatio = [{ color: "#1e88e5", ratio: 0 }];
    const r2 = scoreItemByColor(paletteZeroRatio, "#1e88e5");
    expect(r2).not.toBeNull();
    expect(r2!.rankScore).toBeCloseTo(r2!.distance, 6);
  });

  it("perfect match: large-ratio swatch gets a lower rankScore than small-ratio one", () => {
    // 두 자료 모두 target 과 완벽 매칭(distance==0)이지만, 한 쪽은 면적 0.5
    // 다른 쪽은 면적 0.05. rankScore 는 dominant 매칭에 더 낮은 값을 줘야 함.
    const dominantMatch = scoreItemByColor([{ color: "#1e88e5", ratio: 0.5 }], "#1e88e5");
    const minorMatch = scoreItemByColor([{ color: "#1e88e5", ratio: 0.05 }], "#1e88e5");
    expect(dominantMatch).not.toBeNull();
    expect(minorMatch).not.toBeNull();
    // distance 는 둘 다 ~0 — 시맨틱 동일.
    expect(dominantMatch!.distance).toBeLessThan(0.01);
    expect(minorMatch!.distance).toBeLessThan(0.01);
    // rankScore 는 dominant 쪽이 더 작아야 (정렬 시 위로).
    expect(dominantMatch!.rankScore).toBeLessThan(minorMatch!.rankScore);
    // 그리고 보너스가 *차감* 방향이라 rankScore 가 0 또는 음수 가능.
    expect(dominantMatch!.rankScore).toBeLessThanOrEqual(0);
  });

  it("small-ratio swatch never has a higher rankScore than its distance (no penalty)", () => {
    // ratio 가 작더라도 rankScore <= distance 가 보장돼야 한다(보너스 단방향).
    const samples: Array<{ ratio?: number }> = [
      {},
      { ratio: 0 },
      { ratio: 0.001 },
      { ratio: 0.05 },
      { ratio: 0.5 },
      { ratio: 1.0 },
    ];
    for (const { ratio } of samples) {
      const score = scoreItemByColor(
        [{ color: "#1e88e5", ratio }],
        "#e53935", // 멀리 떨어진 빨강 target
      );
      expect(score).not.toBeNull();
      expect(score!.rankScore).toBeLessThanOrEqual(score!.distance + 1e-9);
    }
  });

  it("filter-pass uses distance: small-area accent stays findable, threshold preserved", () => {
    // 작은 면적의 정확한 파랑 매칭 + 큰 면적의 *threshold 초과* 빨강.
    // distance(=파랑) 는 threshold 이하이므로 *통과* 해야 한다 — 면적 가중치
    // 가 필터 통과 판정에 끼어들면 안 됨.
    const palette = [
      { color: "#e53935", ratio: 0.9 }, // 큰 빨강 (target 과 멀다)
      { color: "#1e88e5", ratio: 0.02 }, // 작은 파랑 (target 과 동일)
    ];
    const score = scoreItemByColor(palette, "#1e88e5");
    expect(score).not.toBeNull();
    expect(score!.distance).toBeLessThan(COLOR_FILTER_THRESHOLD);
  });

  it("distance and rankScore can be set by different swatches", () => {
    // 작은 면적의 *정확* 매칭(distance 1등) + 큰 면적의 *적당* 매칭(rankScore
    // 1등) 가 한 palette 에 공존. 두 값이 서로 다른 swatch 에서 와도 정상.
    const palette = [
      { color: "#1e88e5", ratio: 0.02 }, // 완벽 매칭, 작은 면적
      { color: "#1976d2", ratio: 0.6 },  // 살짝 다른 파랑, 큰 면적
    ];
    const score = scoreItemByColor(palette, "#1e88e5");
    expect(score).not.toBeNull();
    // 정확 매칭이 distance 를 결정.
    expect(score!.distance).toBeLessThan(0.01);
    // rankScore 는 큰 면적 swatch 의 (작은 ΔE − 큰 보너스) 가 이길 수 있음.
    // 어느 쪽이 이기든 rankScore <= distance 가 보장.
    expect(score!.rankScore).toBeLessThanOrEqual(score!.distance + 1e-9);
  });
});
