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
