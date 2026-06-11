import { LOCAL_SERVER_BASE_URL } from "@shared/constants";
import { supabase } from "./supabase";

/** Storage URL → { bucket, filePath } 파싱.
 *
 *  로컬 스토리지의 public URL 은 다음 형태다:
 *    ${LOCAL_SERVER_BASE_URL}/storage/file/<bucket>/<filePath...>
 *  예전 실행에서 fallback port 로 저장된 URL 도 같은 storage key 로 취급한다.
 *
 *  - `filePath` 는 projectId 폴더 + 파일명 (예: "abc-123/scene_1_xxx.png")
 *  - `?t=...` 같은 cache-buster 쿼리스트링은 제거한다.
 *  - 포맷과 다른 URL (http, data:, blob: 등) 이면 null 반환. */
export function parseStorageUrl(url: string | null | undefined): { bucket: string; filePath: string } | null {
  if (!url || typeof url !== "string") return null;

  let rest = "";
  const currentPrefix = `${LOCAL_SERVER_BASE_URL}/storage/file/`;
  if (url.startsWith(currentPrefix)) {
    rest = url.slice(currentPrefix.length);
  } else {
    const httpMatch = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/storage\/file\/(.+)$/i);
    if (httpMatch?.[1]) {
      rest = httpMatch[1];
    } else if (url.startsWith("local-file://")) {
      const normalized = url.slice("local-file://".length).replace(/\\/g, "/");
      const marker = "/storage/";
      const idx = normalized.lastIndexOf(marker);
      if (idx < 0) return null;
      rest = normalized.slice(idx + marker.length);
    } else {
      return null;
    }
  }

  // strip query string / hash (cache-busters like `?t=12345` 이 붙어있음)
  const qIdx = rest.search(/[?#]/);
  if (qIdx >= 0) rest = rest.slice(0, qIdx);

  const slash = rest.indexOf("/");
  if (slash <= 0) return null;

  const bucket = decodeURIComponent(rest.slice(0, slash));
  const filePath = decodeURIComponent(rest.slice(slash + 1));
  if (!bucket || !filePath) return null;

  return { bucket, filePath };
}

export function normalizeStorageUrl(url: string | null | undefined): string | null {
  const parsed = parseStorageUrl(url);
  if (!parsed) return url ?? null;

  const encodedPath = parsed.filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${LOCAL_SERVER_BASE_URL}/storage/file/${encodeURIComponent(parsed.bucket)}/${encodedPath}`;
}

/** 주어진 public URL 이 우리 로컬 스토리지에 있는 파일이면 지운다.
 *  외부/데이터 URL 이거나 파싱 실패 시 조용히 no-op — 호출부에서 URL 의
 *  출처를 알 필요 없이 안전하게 쓸 수 있도록.
 *
 *  실패는 warn 만 찍고 삼킨다. "DB 에는 지웠는데 파일 삭제 실패" 때문에
 *  UX 가 꼬이는 건 원치 않고, 남은 고아 파일은 앱 시작시 orphan sweep 이
 *  주워가기 때문. */
export async function deleteStoredFile(url: string | null | undefined): Promise<void> {
  const parsed = parseStorageUrl(url);
  if (!parsed) return;
  try {
    const res = await supabase.storage.from(parsed.bucket).remove([parsed.filePath]);
    if (res?.error) console.warn("[storage] delete failed", parsed, res.error);
  } catch (e) {
    console.warn("[storage] delete threw", parsed, e);
  }
}

/** 프로젝트 안에서 이 URL 이 아직 어디선가 참조중인지 검사.
 *
 *  "씬 conti_image / conti_image_history / sketches" + "scene_versions 의
 *  모든 씬 snapshot" + "briefs.mood_image_urls" 를 모두 훑어 찾는다. 일부
 *  삭제 경로가 "나만의 리스트에서 빠졌으니 파일도 지운다" 로 동작하면서
 *  다른 리스트에 여전히 남아있는 URL 의 파일을 오삭제해 `HistorySheet` 가
 *  엑박을 띄우는 회귀가 있었다 — 중앙 가드로 통일한다.
 *
 *  Query string (`?t=...`) 은 cache-buster 라 DB 에 저장된 형태와 호출부
 *  형태가 다를 수 있다. 비교는 base URL (query/hash 스트립) substring 으로
 *  수행해 양쪽 모두 매칭.
 *
 *  `excludeSceneId` — 삭제 직전에 해당 씬의 history/sketches 를 이미
 *  업데이트했는데 await 타이밍상 아직 DB 에 반영 안됐을 수 있을 때, 그
 *  씬 행의 검사를 건너뛰게 해 false-positive(= 파일 안 지움 → orphan) 를
 *  줄이는 용도. 호출부가 DB 업데이트를 제대로 await 했다면 넘기지 않아도 됨. */
export async function isUrlReferencedInProject(
  projectId: string,
  url: string | null | undefined,
  opts?: { excludeSceneId?: string },
): Promise<boolean> {
  if (!url || typeof url !== "string") return false;
  const bare = url.split(/[?#]/)[0];
  if (!bare) return false;

  // 1) scenes rows — 현재 프로젝트의 모든 씬.
  let scenesQuery = supabase
    .from("scenes")
    .select("id, conti_image_url, conti_image_history, sketches")
    .eq("project_id", projectId);
  if (opts?.excludeSceneId) scenesQuery = scenesQuery.neq("id", opts.excludeSceneId);
  const { data: sceneRows } = await scenesQuery;
  for (const r of (sceneRows ?? []) as any[]) {
    if (typeof r.conti_image_url === "string" && r.conti_image_url.includes(bare)) return true;
    const hist = r.conti_image_history;
    if (Array.isArray(hist) && hist.some((u: unknown) => typeof u === "string" && u.includes(bare))) {
      return true;
    } else if (typeof hist === "string" && hist.includes(bare)) {
      return true;
    }
    const sk = r.sketches;
    if (Array.isArray(sk)) {
      if (sk.some((s: any) => typeof s?.url === "string" && s.url.includes(bare))) return true;
    } else if (typeof sk === "string" && sk.includes(bare)) {
      return true;
    }
  }

  // 2) scene_versions.scenes JSONB — 과거 버전 snapshot 들.
  const { data: versionRows } = await supabase
    .from("scene_versions")
    .select("scenes")
    .eq("project_id", projectId);
  for (const v of (versionRows ?? []) as any[]) {
    const raw = typeof v.scenes === "string" ? v.scenes : JSON.stringify(v.scenes ?? []);
    if (raw.includes(bare)) return true;
  }

  // 3) briefs.mood_image_urls — Mood Ideation 배열.
  const { data: briefRows } = await supabase
    .from("briefs")
    .select("mood_image_urls")
    .eq("project_id", projectId);
  for (const b of (briefRows ?? []) as any[]) {
    const raw =
      typeof b.mood_image_urls === "string"
        ? b.mood_image_urls
        : JSON.stringify(b.mood_image_urls ?? []);
    if (raw.includes(bare)) return true;
  }

  return false;
}

/** `deleteStoredFile` 의 안전 래퍼: 프로젝트 내 다른 위치에서 아직
 *  참조중이면 삭제를 스킵한다. 참조 검사 실패(예: 네트워크 오류)도
 *  false-positive 방향으로 수렴 — 삭제를 건너뛰어 엑박보다 orphan 을
 *  선호한다. */
export async function deleteStoredFileIfUnreferenced(
  projectId: string,
  url: string | null | undefined,
  opts?: { excludeSceneId?: string },
): Promise<void> {
  if (!url) return;
  try {
    const referenced = await isUrlReferencedInProject(projectId, url, opts);
    if (referenced) return;
  } catch (e) {
    console.warn("[storage] reference check failed; skipping delete", url, e);
    return;
  }
  await deleteStoredFile(url);
}

/** 여러 URL 을 한 번에 삭제. 버킷별로 묶어서 배치 remove 호출 하므로
 *  많은 파일을 한꺼번에 지울 때 왕복 호출 수가 줄어든다. */
export async function deleteStoredFiles(urls: Array<string | null | undefined>): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const u of urls) {
    const parsed = parseStorageUrl(u);
    if (!parsed) continue;
    const arr = byBucket.get(parsed.bucket) ?? [];
    arr.push(parsed.filePath);
    byBucket.set(parsed.bucket, arr);
  }
  if (byBucket.size === 0) return;
  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, paths]) => {
      try {
        const res = await supabase.storage.from(bucket).remove(paths);
        if (res?.error) console.warn("[storage] batch delete failed", bucket, paths, res.error);
      } catch (e) {
        console.warn("[storage] batch delete threw", bucket, paths, e);
      }
    }),
  );
}
