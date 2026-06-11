/* HTML Viewer Export 디버깅 — 실제 dist/viewer.html 을 읽어 main process 의
 * loadViewerBundle 과 동일한 정규식으로 인라인한 결과를 임시 HTML 로 저장.
 * 브라우저에서 직접 열어 보면 어디서 파싱이 깨지는지 확인 가능.
 *
 * 이 스크립트는 electron 의존성 없이 순수 Node 에서 실행되도록 inline 으로
 * 작성. exit 후 자동 삭제하지 않고 dist/__test-viewer.html 로 남겨두면
 * 사용자가 직접 더블클릭해 확인할 수 있다. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const viewerHtml = await fs.readFile(path.join(dist, "viewer.html"), "utf8");
let html = viewerHtml;

html = html.replace(/\s*<link[^>]*rel=["']modulepreload["'][^>]*>\s*/g, "\n    ");

const scriptRe = /<script\b([^>]*?)\bsrc=["']\.\/?([^"']+)["']([^>]*)><\/script>/g;
const scriptMatches = [];
for (const m of html.matchAll(scriptRe)) {
  scriptMatches.push({ full: m[0], attrsBefore: m[1] || "", relPath: m[2], attrsAfter: m[3] || "" });
}
for (const entry of scriptMatches) {
  const assetPath = path.join(dist, entry.relPath);
  const body = await fs.readFile(assetPath, "utf8");
  const attrs = `${entry.attrsBefore}${entry.attrsAfter}`.replace(/\s+/g, " ").trim();
  const openTag = attrs ? `<script ${attrs}>` : "<script>";
  const safeBody = body.replace(/<\/script\s*>/gi, "<\\/script>");
  /* 함수형 replacement 로 $& / $$ / $1 백레퍼런스 해석 회피. */
  html = html.replace(entry.full, () => `${openTag}${safeBody}</script>`);
}

const linkRe = /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*?)\bhref=["']\.\/?([^"']+)["']([^>]*)>/g;
const linkMatches = [];
for (const m of html.matchAll(linkRe)) linkMatches.push({ full: m[0], relPath: m[3] });
for (const entry of linkMatches) {
  const assetPath = path.join(dist, entry.relPath);
  const body = await fs.readFile(assetPath, "utf8");
  const safeBody = body.replace(/<\/style\s*>/gi, "<\\/style>");
  html = html.replace(entry.full, () => `<style>${safeBody}</style>`);
}

const data = {
  title: "Test Export",
  generated_at: new Date().toISOString(),
  item_count: 0,
  items: [],
};
const json = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
const inject = `<script>window.__PREFLOW_VIEWER_DATA__ = ${json};</script>`;
html = html.replace("</body>", () => `${inject}\n</body>`);

const out = path.join(dist, "__test-viewer.html");
await fs.writeFile(out, html, "utf8");
console.log("Wrote test viewer:", out);
console.log("Length:", html.length);
console.log("Open this with file:// in a browser to debug.");
