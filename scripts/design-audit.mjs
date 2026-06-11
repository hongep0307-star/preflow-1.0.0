// 디자인 토큰 / 언어화 일관성 audit 스크립트
//
// 목적:
//   "한 프로그램에 있다는 느낌" 을 깨는 우회 패턴을 src/ 전역에서 스캔해
//   파일·라인 단위로 집계한다. 이후 일괄 치환(codemod) 과 CI 가드의 기준
//   데이터로 쓴다.
//
// 설계 원칙 — "신뢰할 수 있는 숫자":
//   · 주석은 라인별 상태머신으로 제거(블록 /* */, {/* */}, 라인 //) 후 검사.
//   · 한글은 "실제 UI 노출(ko-ui)" 과 "AI 프롬프트/사전 등 의도된 한글(ko-bulk)"
//     을 분리한다. ko-bulk 는 라인 단위로만 세어 과대집계를 막는다.
//   · 색은 브랜드색(const KR / #f9423a) 을 따로 떼고, 색상 피커·테스트처럼
//     정당하게 hex 를 쓰는 파일은 제외/표시한다.
//
// 카테고리:
//   [actionable]
//     font-size           text-[Npx] 임의 폰트 크기 (시맨틱 스케일 우회)
//     arbitrary-color     bg-[#..] 등 Tailwind 임의 색 클래스
//     brand-color         const KR / #f9423a 하드코딩 (= --primary 와 동일)
//     inline-color        style 의 raw hex/rgb/rgba (토큰 hsl(var()) 제외)
//     ko-ui               JSX 텍스트 / 노출 속성 / toast·alert·confirm 의 한글
//   [context]
//     ko-bulk             그 외 비주석 한글 라인 (대부분 AI 프롬프트/사전 — 의도됨)
//
// 사용:
//   node scripts/design-audit.mjs            (콘솔 요약 + design-audit-report.md)
//   node scripts/design-audit.mjs --json     (design-audit.json 추가)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const wantJson = process.argv.includes("--json");
// --check: CI 게이트. 0 으로 정리 완료한 카테고리가 다시 늘면 비정상 종료(exit 1).
const wantCheck = process.argv.includes("--check");

const rel = (full) => relative(ROOT, full);
const norm = (p) => p.split("/").join(sep);

// 한글 사전 자체 / 언어 컨텍스트 — ko 검사 제외.
const KO_EXCLUDE = new Set(["src/lib/uiCopy.ts", "src/lib/uiLanguage.tsx"].map(norm));
// 색을 정당하게 다루는 파일(피커/팔레트/색매칭/테스트) — inline-color 노이즈 표시용.
const COLOR_OK = [
  "src/components/library/ColorPicker.tsx",
  "src/lib/colorMatch.ts",
  "src/lib/colorPalette.ts",
  "src/components/assets/vision.ts",
].map(norm);
const isTest = (p) => /(^|[\\/])(test|__tests__)[\\/]/.test(p) || /\.test\.tsx?$/.test(p);
const isUiFile = (p) => /[\\/](components|pages|viewer)[\\/]/.test(p);

// ── 파일 수집 ───────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(name)) continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

// ── 라인별 주석 제거(블록 상태 보존, 라인번호 유지) ─────────────────────
function stripComments(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    let result = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) { i = line.length; } else { i = end + 2; inBlock = false; }
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "//" && line[i - 1] !== ":") break; // 라인주석 (URL :// 제외)
      if (two === "/*") { inBlock = true; i += 2; continue; }
      result += line[i];
      i += 1;
    }
    out.push(result);
  }
  return out;
}

// ── 패턴 ────────────────────────────────────────────────────────────────
const RE_FONT = /\btext-\[(\d+(?:\.\d+)?)(px|rem|em|pt)\]/g;
const RE_ARB_COLOR =
  /\b(?:bg|text|border|fill|stroke|ring|from|via|to|shadow|outline|decoration|caret|accent|divide)-\[(#[0-9a-fA-F]{3,8}|rgba?\([^\]]*\)|hsl\([^\]]*\))\]/g;
const RE_BRAND = /\bconst\s+KR\b|#f9423a\b/gi;
const RE_HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const RE_RGB = /\brgba?\(/g;
const RE_HSL_RAW = /\bhsl\((?!\s*var\()/g;
const RE_KO = /[가-힣]/;
const RE_KO_RUN = /[가-힣]+/g;
// ko-ui: 실제 화면 노출 한글
const RE_KO_JSX = />[^<>{}\n]*[가-힣][^<>{}\n]*</;
const RE_KO_ATTR = /\b(?:title|placeholder|aria-label|alt|label|tooltip|name)\s*=\s*["'][^"']*[가-힣]/;
const RE_KO_FEEDBACK = /\b(?:toast(?:\.\w+)?|alert|confirm|window\.(?:alert|confirm))\s*\(\s*[`"'][^`"']*[가-힣]/;
// ko-label: UI 컴포넌트 안의 "짧은 한글 문자열 리터럴" = 라벨 맵/삼항 후보
// (예: golden_hour: "골든아워",  asset_type==="character" ? "캐릭터" : ...).
// 긴 한글(프롬프트 문장)은 길이 컷오프로 제외한다.
const RE_KO_STR = /["'`]([^"'`\n]*[가-힣][^"'`\n]*)["'`]/g;
const KO_LABEL_MAXLEN = 14; // 한글 라벨은 통상 짧다
// 프롬프트/데이터 성격이 강한 파일은 ko-label 에서 제외(컴포넌트 폴더라도).
const KO_LABEL_SKIP = /(prompts|KnowledgeBase|Dictionary|abcdScorer|hookLibrary|agentTypes|contiTypes)/i;

const cat = {};
const order = ["font-size", "arbitrary-color", "brand-color", "inline-color", "ko-ui", "ko-label", "ko-bulk"];
for (const c of order) cat[c] = { hits: [], files: new Set() };
const labels = {
  "font-size": "임의 폰트 크기  text-[Npx]",
  "arbitrary-color": "임의 색 클래스  bg-[#..]",
  "brand-color": "브랜드색 하드코딩  const KR / #f9423a",
  "inline-color": "인라인 raw 색  #hex / rgb() / rgba()",
  "ko-ui": "UI 노출 한글  (JSX/속성/toast — uiCopy 우회)",
  "ko-label": "한글 라벨 맵 후보  (컴포넌트 내 짧은 한글 리터럴)",
  "ko-bulk": "기타 한글 라인  (대부분 AI 프롬프트·사전, 의도됨)",
};

function rec(c, file, line, snippet, count = 1, extra) {
  cat[c].hits.push({ file, line, snippet: snippet.trim().slice(0, 160), count, ...extra });
  cat[c].files.add(file);
}

// ── 스캔 ────────────────────────────────────────────────────────────────
const files = walk(SRC);
for (const full of files) {
  const f = rel(full);
  const rawLines = readFileSync(full, "utf8").split(/\r?\n/);
  const code = stripComments(rawLines);
  const test = isTest(f);
  let inTemplate = false; // 백틱 template literal(= 대부분 AI 프롬프트) 내부 여부

  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    const lineStartsInTemplate = inTemplate;
    // 이 라인의 unescaped 백틱 개수만큼 상태 토글 → 다음 라인에 반영
    const ticks = (line.match(/(?<!\\)`/g) || []).length;
    if (ticks % 2 === 1) inTemplate = !inTemplate;
    if (!line) continue;
    const ln = i + 1;
    const raw = rawLines[i];

    if (!test) {
      const fm = line.match(RE_FONT);
      if (fm) rec("font-size", f, ln, raw, fm.length);

      const am = line.match(RE_ARB_COLOR);
      if (am) rec("arbitrary-color", f, ln, raw, am.length);

      const bm = line.match(RE_BRAND);
      if (bm) rec("brand-color", f, ln, raw, bm.length);

      // inline-color: 브랜드색·임의클래스로 이미 잡힌 건 빼고, 토큰 hsl(var())은 제외
      let raws = 0;
      const noArb = line.replace(RE_ARB_COLOR, "").replace(/#f9423a/gi, "");
      raws += (noArb.match(RE_HEX) || []).length;
      raws += (noArb.match(RE_RGB) || []).length;
      raws += (noArb.match(RE_HSL_RAW) || []).length;
      if (raws > 0) rec("inline-color", f, ln, raw, raws, { colorOk: COLOR_OK.includes(f) });
    }

    // 한글
    if (!KO_EXCLUDE.has(f) && RE_KO.test(line)) {
      const visible = RE_KO_JSX.test(line) || RE_KO_ATTR.test(line) || RE_KO_FEEDBACK.test(line);
      // 짧은 한글 문자열 리터럴 = 라벨 후보. UI 파일 한정 + 프롬프트/데이터 파일 제외
      // + 백틱 템플릿(프롬프트 본문) 내부 라인 제외.
      // 이미 이중언어인 ad-hoc 맵 라인( ko: "한글" ... en: "..." )은 "미번역 갭"이
      // 아니라 uiCopy 통합 후보 → 라벨-갭에서 제외(별도로 카운트).
      const bilingual = /\bko\s*:\s*["'][^"']*[가-힣]/.test(line) && /\ben\s*:\s*["']/.test(line);
      let labelCandidate = false;
      if (isUiFile(f) && !test && !KO_LABEL_SKIP.test(f) && !lineStartsInTemplate && !bilingual) {
        RE_KO_STR.lastIndex = 0;
        let m;
        while ((m = RE_KO_STR.exec(line))) {
          if (m[1].trim().length <= KO_LABEL_MAXLEN) { labelCandidate = true; break; }
        }
      }
      if (visible && isUiFile(f) && !test) {
        rec("ko-ui", f, ln, raw, 1);
      } else if (labelCandidate) {
        rec("ko-label", f, ln, raw, 1);
      } else {
        const group = test ? "test" : isUiFile(f) ? "ui" : "lib";
        rec("ko-bulk", f, ln, raw, 1, { group, runs: (line.match(RE_KO_RUN) || []).length });
      }
    }
  }
}

// ── 집계 ────────────────────────────────────────────────────────────────
const perFile = (c) => {
  const m = new Map();
  for (const h of cat[c].hits) m.set(h.file, (m.get(h.file) || 0) + h.count);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const total = (c) => cat[c].hits.reduce((s, h) => s + h.count, 0);

// ── 콘솔 ────────────────────────────────────────────────────────────────
console.log("\n=== Pre-Flow 디자인/언어화 Audit ===");
console.log(`스캔: ${files.length}개 (.ts/.tsx, src/ · 테스트 제외 카운트)\n`);
console.log("─".repeat(70));
for (const c of order) {
  console.log(`  ${labels[c].padEnd(44)} ${String(total(c)).padStart(5)}  /  ${cat[c].files.size} 파일`);
}
console.log("─".repeat(70));

for (const c of order) {
  const rows = perFile(c).slice(0, 10);
  if (!rows.length) continue;
  console.log(`\n[${c}] 상위`);
  for (const [file, n] of rows) console.log(`  ${String(n).padStart(5)}  ${file}`);
}

// ── Markdown ────────────────────────────────────────────────────────────
let md = `# Pre-Flow 디자인 / 언어화 Audit\n\n`;
md += `> \`node scripts/design-audit.mjs\` 자동 생성 · 스캔 ${files.length}개 (src/ \\*.ts, \\*.tsx) · 테스트 파일은 코드 카운트에서 제외\n\n`;
md += `## 요약\n\n| 카테고리 | 설명 | 건수 | 파일 |\n|---|---|---:|---:|\n`;
for (const c of order) md += `| \`${c}\` | ${labels[c]} | ${total(c)} | ${cat[c].files.size} |\n`;
md += `\n**actionable** = font-size · arbitrary-color · brand-color · inline-color · ko-ui · ko-label(후보, 검토 필요) · `;
md += `**context** = ko-bulk(대부분 의도된 AI 프롬프트/사전 한글)\n\n`;

for (const c of order) {
  const rows = perFile(c);
  if (!rows.length) continue;
  md += `## ${c} — ${labels[c]}\n\n합계 ${total(c)}건 · ${rows.length}개 파일\n\n`;
  md += `| 건수 | 파일 |\n|---:|---|\n`;
  for (const [file, n] of rows) {
    const tag = c === "inline-color" && COLOR_OK.includes(file) ? " _(색 전용 파일 — 정당)_" : "";
    md += `| ${n} | \`${file}\`${tag} |\n`;
  }
  md += `\n`;
  if (c === "ko-ui" || c === "ko-label") {
    const lines = c === "ko-label" ? cat[c].hits.slice(0, 120) : cat[c].hits;
    md += `<details><summary>라인 (${c === "ko-label" ? `최대 120 / 총 ${cat[c].hits.length}` : "전체"})</summary>\n\n`;
    for (const h of lines) md += `- \`${h.file}:${h.line}\` — ${h.snippet.replace(/\|/g, "\\|")}\n`;
    md += `\n</details>\n\n`;
  }
  if (c === "ko-bulk") {
    const g = { ui: 0, lib: 0, test: 0 };
    for (const h of cat[c].hits) g[h.group] += 1;
    md += `그룹: UI 컴포넌트 ${g.ui} · lib/데이터 ${g.lib} · 테스트 ${g.test} (라인 수)\n\n`;
  }
}

writeFileSync(join(ROOT, "design-audit-report.md"), md, "utf8");
console.log(`\n리포트: design-audit-report.md`);

if (wantJson) {
  const json = {};
  for (const c of order) json[c] = { total: total(c), files: perFile(c), hits: cat[c].hits };
  writeFileSync(join(ROOT, "design-audit.json"), JSON.stringify(json, null, 2), "utf8");
  console.log(`JSON: design-audit.json`);
}

// ── CI 게이트 ─────────────────────────────────────────────────────────────
// 이 세션에서 0 으로 정리한 카테고리만 강제한다(flaky 방지). 다른 카테고리
// (inline-color/ko-bulk 등)는 의도된 잔여분이 있어 게이트하지 않는다.
//   · font-size : 임의 text-[Npx] 금지 — 반드시 시맨틱 토큰(text-caption…) 사용
//   · ko-ui     : JSX/속성/toast 의 하드코딩 한글 금지 — uiCopy 의 t() 사용
if (wantCheck) {
  const GATES = ["font-size", "ko-ui"];
  const failures = GATES.filter((c) => total(c) > 0);
  if (failures.length === 0) {
    console.log("\n✅ design-audit gate 통과 (font-size=0, ko-ui=0)");
    process.exit(0);
  }
  console.error("\n❌ design-audit gate 실패 — 아래 항목을 토큰/언어화로 고치세요:\n");
  for (const c of failures) {
    console.error(`[${c}] ${labels[c]} — ${total(c)}건`);
    for (const h of cat[c].hits.slice(0, 50)) {
      console.error(`  ${h.file}:${h.line}  ${h.snippet.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    if (cat[c].hits.length > 50) console.error(`  …외 ${cat[c].hits.length - 50}건`);
  }
  console.error(
    "\nfont-size: text-[Npx] → tailwind.config 의 시맨틱 토큰(text-caption/meta/body…)\n" +
      "ko-ui: 하드코딩 한글 → src/lib/uiCopy.ts 키 + useT() 의 t()\n",
  );
  process.exit(1);
}
