import fs from "fs";
import path from "path";
import { getStorageBasePath } from "./paths";

export interface StorageUsage {
  total_bytes: number;
  by_bucket: Record<string, number>;
  file_count: number;
}

export interface StorageUsageByProject {
  /** projectId → 누적 바이트 + 파일 수. 모든 버킷의 `<bucket>/<projectId>/...`
   *  파일을 합산. 대시보드 카드의 사이즈 칩 데이터 소스. */
  by_project: Record<string, { bytes: number; files: number }>;
  /** projectId 폴더 안에 들어가지 않은 파일들의 합계.
   *  references 버킷, 임시 파일 등이 여기로 떨어진다. 대시보드는 무시. */
  unscoped_bytes: number;
  total_bytes: number;
}

/** 첫 path segment 가 프로젝트 ID 형태인지 검사. assets/contis/mood 등은 모두
 *  `<bucket>/<projectId>/...` 로 저장된다.
 *
 *  ID 포맷은 두 가지를 모두 허용:
 *  - 하이픈 제거된 32 자 hex — 이 앱이 `crypto.randomUUID().replace(/-/g, "")`
 *    로 발급하는 실제 형태 (`db-utils.ts:generateId`).
 *  - 표준 8-4-4-4-12 v4 UUID — 외부에서 import 된 pack/eagle 데이터 호환.
 *
 *  정규식이 너무 헐거우면 `references` 같은 시스템 폴더가 프로젝트로 집계돼
 *  ghost 카드 데이터가 생기므로 두 패턴 중 하나에만 정확히 매칭되도록 한다. */
const PROJECT_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Phase 2.4: 동기 readdirSync/statSync 가 모든 버킷 풀 워크 중 main process 를
// 블록해 사용자가 LibraryPage 에 들어가는 순간 잠깐 멈추는 체감을 만들었다.
// 비동기 + 청크 yield 로 walk 를 양보한다.
const FS_YIELD_EVERY = 200;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function walkFiles(
  root: string,
  visit: (filePath: string, stat: fs.Stats) => void,
): Promise<void> {
  let processedSinceYield = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          visit(full, await fs.promises.stat(full));
        } catch {
          /* ignore files that disappear during the walk */
        }
      }
      processedSinceYield++;
      if (processedSinceYield >= FS_YIELD_EVERY) {
        processedSinceYield = 0;
        await yieldToEventLoop();
      }
    }
  };
  await walk(root);
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const base = getStorageBasePath();
  const usage: StorageUsage = { total_bytes: 0, by_bucket: {}, file_count: 0 };
  let buckets: fs.Dirent[];
  try {
    buckets = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return usage;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.name.startsWith(".")) continue;
    const bucketRoot = path.join(base, bucket.name);
    let bucketBytes = 0;
    await walkFiles(bucketRoot, (_filePath, stat) => {
      bucketBytes += stat.size;
      usage.file_count += 1;
    });
    usage.by_bucket[bucket.name] = bucketBytes;
    usage.total_bytes += bucketBytes;
  }
  return usage;
}

/** 디스크 walk 한 번으로 모든 프로젝트의 이미지 사용량을 산출. 같은 walk
 *  비용으로 by_bucket(`getStorageUsage`)도 만들 수 있지만, 라우터 캐시가 분리돼
 *  있어 일단은 별도 함수로 둔다. 호출 빈도가 낮고 결과가 30초 TTL 로 캐시되므로
 *  중복 walk 비용은 무시 가능. */
export async function getStorageUsageByProject(): Promise<StorageUsageByProject> {
  const base = getStorageBasePath();
  const usage: StorageUsageByProject = {
    by_project: {},
    unscoped_bytes: 0,
    total_bytes: 0,
  };
  let buckets: fs.Dirent[];
  try {
    buckets = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return usage;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.name.startsWith(".")) continue;
    const bucketRoot = path.join(base, bucket.name);
    await walkFiles(bucketRoot, (filePath, stat) => {
      usage.total_bytes += stat.size;
      const rel = path.relative(bucketRoot, filePath);
      // path.sep 이 OS 별로 다르고, walkFiles 가 path.join 으로 만든 경로라
      // posix sep 도 섞일 수 있다 — 둘 다 고려해 split.
      const segments = rel.split(/[\\/]/);
      const head = segments[0];
      if (segments.length >= 2 && head && PROJECT_ID_RE.test(head)) {
        const slot = (usage.by_project[head] ??= { bytes: 0, files: 0 });
        slot.bytes += stat.size;
        slot.files += 1;
      } else {
        usage.unscoped_bytes += stat.size;
      }
    });
  }
  return usage;
}
