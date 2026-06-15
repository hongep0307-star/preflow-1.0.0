import { describe, expect, it } from "vitest";
import { buildFolderNodes, buildViewerHtml } from "../../electron/htmlExportBuilder";

/* HTML Viewer Export — pure builder 검증.
 *
 * exportLibraryAsHtml 전체는 electron app/dialog/fs 에 의존해 jsdom 환경
 * 에서 그대로 호출하기 어렵지만, `buildViewerHtml` 만은 순수 문자열
 * 변환이라 직접 호출해 *데이터 주입 위치*, *script 닫기 escape*, *body
 * 없는 경우 폴백* 을 확인할 수 있다. */

describe("buildViewerHtml", () => {
  const baseHtml =
    `<!doctype html><html><head><title>x</title></head><body><div id="viewer-root"></div></body></html>`;

  it("injects data right before </body>", () => {
    const out = buildViewerHtml(baseHtml, { title: "T", items: [] });
    expect(out).toContain("window.__PREFLOW_VIEWER_DATA__ = ");
    /* injection 이 body 바로 앞에 와야 viewer.html placeholder 가 먼저
     *  평가되고, 우리가 박은 실제 데이터가 *마지막* 으로 덮어쓴다. */
    const injectIndex = out.indexOf("window.__PREFLOW_VIEWER_DATA__");
    const bodyCloseIndex = out.indexOf("</body>");
    expect(injectIndex).toBeGreaterThan(-1);
    expect(injectIndex).toBeLessThan(bodyCloseIndex);
  });

  it("includes every item id in the injected payload", () => {
    const data = {
      title: "Sample",
      generated_at: "2026-05-19T00:00:00.000Z",
      item_count: 3,
      items: [
        { id: "ref-a", kind: "image", title: "A" },
        { id: "ref-b", kind: "video", title: "B" },
        { id: "ref-c", kind: "gif", title: "C" },
      ],
    };
    const out = buildViewerHtml(baseHtml, data);
    expect(out).toContain("ref-a");
    expect(out).toContain("ref-b");
    expect(out).toContain("ref-c");
    expect(out).toContain("2026-05-19T00:00:00.000Z");
  });

  it("escapes </script> sequences inside data so HTML parser does not exit early", () => {
    /* 사용자가 노트에 `</script>` 텍스트를 넣어둔 경우 — 데이터를 그대로
     *  주입하면 viewer 가 inline <script> 의 닫기 태그를 만나 데이터가 잘리고
     *  렌더가 깨진다. 이 escape 가 빠지면 매우 미묘한 사용자-측 코멘트로 인한
     *  rendering bug 가 나므로 회귀 가드. */
    const data = {
      title: "Has </script> in title",
      items: [{ id: "x", kind: "image", title: "Comment with </script> inside" }],
    };
    const out = buildViewerHtml(baseHtml, data);
    /* 데이터로 들어간 닫기는 escape 형태로 남아 있고, 진짜 inline script
     *  닫기는 단 한 번만 등장해야 한다. */
    expect(out).toContain("<\\/script");
    /* "<\/script>" 패턴 외에 진짜 inline <script> 닫기는 정확히 한 번. */
    const realCloses = (out.match(/<\/script>/g) ?? []).length;
    expect(realCloses).toBe(1);
  });

  it("does not interpret $& / $$ / $1 patterns inside data as replace() backreferences", () => {
    /* 이전 회귀: 사용자 노트에 `$&` 가 들어가면 String.prototype.replace
     *  의 패턴 해석으로 `$&` 가 *매칭된 </body>* 로 치환되어 결과 HTML
     *  구조가 깨졌다. 함수형 replacement 로 우회한 뒤에는 raw 문자
     *  그대로 유지돼야 한다. */
    const data = {
      title: "Has $& and $$ and $1 in title",
      items: [{ id: "x", kind: "image", title: "Note with $& trick" }],
    };
    const out = buildViewerHtml(baseHtml, data);
    expect(out).toContain("Has $& and $$ and $1");
    expect(out).toContain("Note with $& trick");
    expect(out).toContain("</body>");
  });

  it("falls back to appending at the end when </body> is absent", () => {
    /* viewer.html 이 minified/비표준이라 </body> 가 빠진 경우에도 데이터
     *  주입은 항상 성공해야 한다. fail-soft 보장. */
    const noBody = `<div id="viewer-root"></div>`;
    const out = buildViewerHtml(noBody, { title: "Z", items: [] });
    expect(out.endsWith("</script>")).toBe(true);
    expect(out).toContain("window.__PREFLOW_VIEWER_DATA__");
  });
});

describe("buildFolderNodes", () => {
  it("parses folder: prefix tags into nodes with direct counts and ancestors", () => {
    const nodes = buildFolderNodes([
      { tags: ["folder:캐릭터/메인", "a"] },
      { tags: ["folder:캐릭터/메인"] },
      { tags: ["folder:배경"] },
      { tags: ["b"] },
    ]);
    const byPath = Object.fromEntries(nodes.map((n) => [n.path, n]));
    expect(byPath["캐릭터"]).toEqual({ path: "캐릭터", name: "캐릭터", count: 0 });
    expect(byPath["캐릭터/메인"]).toEqual({ path: "캐릭터/메인", name: "메인", count: 2 });
    expect(byPath["배경"]).toEqual({ path: "배경", name: "배경", count: 1 });
  });

  it("returns empty for items without folder tags", () => {
    expect(buildFolderNodes([{ tags: ["x", "y"] }, { tags: [] }])).toEqual([]);
  });

  it("scopePath limits the tree to that folder subtree (multi-folder items don't leak siblings)", () => {
    /* 한 자료가 여러 폴더에 태깅돼 있어도 폴더 범위 export 면 그 폴더 하위만
     *  남아야 한다 (test_01 export 시 test_02/브리프 매치 가 트리에 안 나옴). */
    const items = [
      { tags: ["folder:test_01", "folder:브리프 매치/PUBGM"] },
      { tags: ["folder:test_01/sub"] },
      { tags: ["folder:test_02"] },
    ];
    const scoped = buildFolderNodes(items, "test_01");
    expect(scoped.map((n) => n.path).sort()).toEqual(["test_01", "test_01/sub"]);
    /* scope 없으면 전체 폴더가 다 잡힌다(대조군). */
    const all = buildFolderNodes(items).map((n) => n.path);
    expect(all).toContain("test_02");
    expect(all).toContain("브리프 매치/PUBGM");
  });
});
