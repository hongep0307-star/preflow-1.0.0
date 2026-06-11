import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  external: ["electron", "better-sqlite3"],
  format: "cjs",
  outdir: "dist-electron",
  sourcemap: true,
};

async function run() {
  await build({ ...common, entryPoints: ["electron/main.ts"] });
  // Preload 는 main 과 동일한 옵션이지만 별도 엔트리. webPreferences.preload
  // 가 가리키는 dist-electron/preload.js 가 만들어지는 자리.
  await build({ ...common, entryPoints: ["electron/preload.ts"] });
  console.log("[electron-build] Build done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
