/* HTML Viewer Export — pure builder helpers.
 *
 * 의도적으로 electron / fs 의존성 없이 *문자열 / 데이터 변환* 함수만 모은
 * 모듈. 메인 프로세스 한정인 electron/htmlExport.ts 가 동작 흐름을 관할
 * 하고, 이 파일은 그쪽에서 import 해 가서 쓴다. 분리하는 유일한 이유는
 * 단위 테스트 — vitest 가 electron 글로벌을 fake 하지 않아도 직접 import
 * 해 검증할 수 있다. */

/** viewer.html 한 장에 `window.__PREFLOW_VIEWER_DATA__` 를 주입.
 *
 *  - `</script>` 시퀀스를 escape 해 HTML 파서가 데이터 문자열 안에서
 *    `</script>` 를 보고 *조기 종료* 하는 사고를 방지.
 *  - `</body>` 가 있으면 그 직전, 없으면 문서 끝에 붙인다. dev/preview
 *    viewer.html 도 placeholder 한 줄을 갖고 있어 두 번 주입되더라도
 *    JS 측에서 마지막 값(브라우저가 후순위로 평가)만 보면 되므로 무해.
 *  - `String.prototype.replace` 의 *문자열* replacement 는 `$&`/`$$`/
 *    `$n` 을 백레퍼런스로 해석한다. 사용자 노트에 `$&` 가 들어가면
 *    그게 매칭된 `</body>` 로 치환되는 미묘한 사고가 가능 — 함수형
 *    replacement 로 우회. */
export function buildViewerHtml(viewerHtml: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  const inject = `<script>window.__PREFLOW_VIEWER_DATA__ = ${json};</script>`;
  if (viewerHtml.includes("</body>")) {
    return viewerHtml.replace("</body>", () => `${inject}\n</body>`);
  }
  return viewerHtml + inject;
}

/* export 시점의 폴더 구조 스냅샷 노드 — viewer/types.ts 의 ViewerFolderNode
 *  와 1:1. viewer 의 foldersFromTags 폴백과 동일 로직을 main 측에 둬, 명시
 *  스냅샷을 페이로드에 실어 보낸다(구버전 export 호환을 위해 viewer 는
 *  폴백을 계속 유지). */
export interface ViewerFolderNode {
  path: string;
  name: string;
  count: number;
}

/** items 의 `folder:` prefix 태그에서 폴더 노드 목록을 만든다.
 *  - `count`: 해당 경로에 *직접* 소속된 아이템 수(하위 미포함).
 *  - 중간(조상) 경로도 노드로 포함해 트리가 끊기지 않게 한다(직접 소속이
 *    없는 조상은 count 0).
 *  - `scopePath` 지정 시(폴더 범위 export) 그 경로(들)와 하위 경로만 남긴다.
 *    단일 string 또는 다중 string[] 모두 허용. 한 자료가 여러 폴더에 태깅돼
 *    있어도 내보낸 폴더 밖의 "유령 폴더" 가 트리에 섞이지 않게 한다.
 *    ("folder:" prefix 없는 normalized path)
 *  - `includeSubfolders=false` 면 scope 와 *정확히 일치하는* 경로만 남기고
 *    하위 폴더는 제외한다(다이얼로그의 "하위 폴더 포함" 체크 해제와 매칭).
 *  순수 함수 — vitest 로 직접 검증 가능. */
export function buildFolderNodes(
  items: Array<{ tags: string[] }>,
  scopePath?: string | string[],
  includeSubfolders: boolean = true,
): ViewerFolderNode[] {
  const FOLDER_PREFIX = "folder:";
  const direct = new Map<string, number>();
  const allPaths = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (typeof tag !== "string" || !tag.startsWith(FOLDER_PREFIX)) continue;
      const full = tag.slice(FOLDER_PREFIX.length).replace(/^\/+|\/+$/g, "");
      if (!full) continue;
      direct.set(full, (direct.get(full) ?? 0) + 1);
      let acc = "";
      for (const seg of full.split("/")) {
        if (!seg) continue;
        acc = acc ? `${acc}/${seg}` : seg;
        allPaths.add(acc);
      }
    }
  }
  // scope 는 단일 string 또는 다중 string[] 모두 허용. 정규화 후 빈 항목 제거.
  const scopes = (Array.isArray(scopePath) ? scopePath : scopePath != null ? [scopePath] : [])
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const inScope = (path: string): boolean =>
    scopes.length === 0
      || scopes.some((s) => path === s || (includeSubfolders && path.startsWith(`${s}/`)));
  return [...allPaths]
    .filter(inScope)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      count: direct.get(path) ?? 0,
    }));
}
