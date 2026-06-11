import { spawn } from "child_process";
import http from "http";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:8080";
const MAX_WAIT = 30000;
const POLL = 500;

function checkServer() {
  return new Promise((resolve) => {
    http
      .get(DEV_URL, (res) => resolve(res.statusCode === 200))
      .on("error", () => resolve(false));
  });
}

async function waitForVite() {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    if (await checkServer()) return true;
    await new Promise((r) => setTimeout(r, POLL));
  }
  return false;
}

async function main() {
  console.log("[wait-and-electron] Waiting for Vite dev server...");
  const ready = await waitForVite();
  if (!ready) {
    console.error("[wait-and-electron] Vite dev server did not start in time.");
    process.exit(1);
  }
  console.log("[wait-and-electron] Vite ready, launching Electron...");

  const electron = await import("electron");
  const electronPath = electron.default || electron;
  // PREFLOW_PROFILE: 명시값이 있으면 그대로 따라가고, dev 진입 시 미지정이면
  // "dev" 로 채워 main.ts 의 분기가 발동하도록 강제 — userData 가
  // `preflow-dev/` 로 분리되어 production 빌드와 워크스페이스/registry/캐시가
  // 섞이지 않는다. production userData 를 그대로 보고 싶을 땐 호출자가
  // `set PREFLOW_PROFILE= && npm run dev` 처럼 빈값을 박아 명시적으로 끄면 됨.
  const profile = process.env.PREFLOW_PROFILE ?? "dev";
  const child = spawn(String(electronPath), ["."], {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_URL,
      PREFLOW_PROFILE: profile,
    },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

main();
