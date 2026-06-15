import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTERS,
  applyFilters,
  foldersFromTags,
  matchesColor,
  presentKinds,
  tagFrequencies,
  type ViewerFilterState,
} from "@/viewer/state/viewerFilters";
import type { ReferenceItem, ReferenceKind } from "@/viewer/types";

function makeItem(partial: Partial<ReferenceItem> & { id: string }): ReferenceItem {
  return {
    kind: "image" as ReferenceKind,
    title: "",
    timestamp_notes: [],
    ...partial,
  };
}

function filters(overrides: Partial<ViewerFilterState>): ViewerFilterState {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe("viewerFilters — applyFilters query", () => {
  const items = [
    makeItem({ id: "a", title: "Sunset over city", tags: ["mood:warm"] }),
    makeItem({ id: "b", title: "Blue ocean", notes: "calm and quiet" }),
    makeItem({
      id: "c",
      title: "Forest",
      ai_suggestions: { suggested_tags: ["green", "nature"], suggested_tags_ko: ["숲"] },
    }),
  ];

  it("matches title, tags, notes, and ai suggestions", () => {
    expect(applyFilters(items, filters({ query: "sunset" })).map((i) => i.id)).toEqual(["a"]);
    expect(applyFilters(items, filters({ query: "warm" })).map((i) => i.id)).toEqual(["a"]);
    expect(applyFilters(items, filters({ query: "quiet" })).map((i) => i.id)).toEqual(["b"]);
    expect(applyFilters(items, filters({ query: "nature" })).map((i) => i.id)).toEqual(["c"]);
    expect(applyFilters(items, filters({ query: "숲" })).map((i) => i.id)).toEqual(["c"]);
  });

  it("is case-insensitive and empty query returns all", () => {
    expect(applyFilters(items, filters({ query: "BLUE" })).map((i) => i.id)).toEqual(["b"]);
    expect(applyFilters(items, filters({ query: "" })).length).toBe(3);
  });
});

describe("viewerFilters — kind and tag filters", () => {
  const items = [
    makeItem({ id: "img", kind: "image", tags: ["a", "b"] }),
    makeItem({ id: "vid", kind: "video", tags: ["a"] }),
    makeItem({ id: "gif", kind: "gif", tags: ["b"] }),
  ];

  it("kind filter keeps only selected kinds", () => {
    const out = applyFilters(items, filters({ kinds: new Set<ReferenceKind>(["video", "gif"]) }));
    expect(out.map((i) => i.id).sort()).toEqual(["gif", "vid"]);
  });

  it("tag filter is OR-matched (any selected tag passes)", () => {
    expect(applyFilters(items, filters({ tags: new Set(["a"]) })).map((i) => i.id).sort()).toEqual([
      "img",
      "vid",
    ]);
    /* OR: a 또는 b 를 가진 모든 아이템 — img(a,b), vid(a), gif(b). */
    expect(applyFilters(items, filters({ tags: new Set(["a", "b"]) })).map((i) => i.id).sort()).toEqual([
      "gif",
      "img",
      "vid",
    ]);
  });
});

describe("viewerFilters — folder filter (folder: prefix, descendants)", () => {
  const items = [
    makeItem({ id: "root", tags: ["folder:캐릭터"] }),
    makeItem({ id: "main", tags: ["folder:캐릭터/메인"] }),
    makeItem({ id: "sub", tags: ["folder:캐릭터/메인/세부"] }),
    makeItem({ id: "other", tags: ["folder:배경"] }),
  ];

  it("includes descendants when a folder is selected", () => {
    const out = applyFilters(items, filters({ folderPath: "캐릭터" }));
    expect(out.map((i) => i.id).sort()).toEqual(["main", "root", "sub"]);
  });

  it("narrower folder excludes siblings", () => {
    const out = applyFilters(items, filters({ folderPath: "캐릭터/메인" }));
    expect(out.map((i) => i.id).sort()).toEqual(["main", "sub"]);
  });
});

describe("viewerFilters — sorting", () => {
  const items = [
    makeItem({ id: "old", title: "B", imported_at: "2020-01-01T00:00:00Z", duration_sec: 10 }),
    makeItem({ id: "new", title: "A", imported_at: "2024-01-01T00:00:00Z", duration_sec: 30 }),
    makeItem({ id: "mid", title: "C", imported_at: "2022-01-01T00:00:00Z", duration_sec: 20 }),
  ];

  it("imported_desc is default newest-first", () => {
    expect(applyFilters(items, filters({ sort: "imported_desc" })).map((i) => i.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("imported_asc, title, duration_desc", () => {
    expect(applyFilters(items, filters({ sort: "imported_asc" })).map((i) => i.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
    expect(applyFilters(items, filters({ sort: "title" })).map((i) => i.id)).toEqual([
      "new",
      "old",
      "mid",
    ]);
    expect(applyFilters(items, filters({ sort: "duration_desc" })).map((i) => i.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("viewerFilters — tagFrequencies / foldersFromTags / presentKinds", () => {
  const items = [
    makeItem({ id: "1", kind: "image", tags: ["a", "b", "folder:캐릭터/메인"] }),
    makeItem({ id: "2", kind: "video", tags: ["a", "folder:캐릭터/메인"] }),
    makeItem({ id: "3", kind: "image", tags: ["a", "folder:배경"] }),
  ];

  it("tagFrequencies excludes folder tags and sorts by count desc", () => {
    expect(tagFrequencies(items)).toEqual([
      { tag: "a", count: 3 },
      { tag: "b", count: 1 },
    ]);
  });

  it("foldersFromTags builds ancestors with direct counts", () => {
    const nodes = foldersFromTags(items);
    const byPath = Object.fromEntries(nodes.map((n) => [n.path, n]));
    expect(byPath["캐릭터"]).toEqual({ path: "캐릭터", name: "캐릭터", count: 0 });
    expect(byPath["캐릭터/메인"]).toEqual({ path: "캐릭터/메인", name: "메인", count: 2 });
    expect(byPath["배경"]).toEqual({ path: "배경", name: "배경", count: 1 });
  });

  it("presentKinds returns only kinds in stable order", () => {
    expect(presentKinds(items)).toEqual(["image", "video"]);
  });
});

describe("viewerFilters — matchesColor", () => {
  it("matches near colors and rejects far ones", () => {
    const red = makeItem({ id: "r", color_palette: [{ color: "#ff0000", ratio: 0.6 }] });
    expect(matchesColor(red, "#fb1020")).toBe(true);
    expect(matchesColor(red, "#0000ff")).toBe(false);
  });

  it("returns false for empty palette", () => {
    expect(matchesColor(makeItem({ id: "x" }), "#ff0000")).toBe(false);
  });
});
