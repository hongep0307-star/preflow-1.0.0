import { afterEach, describe, expect, it, vi } from "vitest";
import { getStorageUsage, previewOrphanCleanup, runOrphanCleanup } from "@/lib/storageMaintenance";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  } as Response;
}

describe("storageMaintenance client", () => {
  it("requests storage usage through the local server route", async () => {
    // Parameters<typeof fetch> 를 명시해 mock.calls 가 빈 튜플로 추론되는 것을 막는다 —
    // 그렇지 않으면 .calls[0]![0] 인덱스 접근에서 TS2493 가 발생한다.
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      mockJsonResponse({ total_bytes: 10, by_bucket: { references: 10 }, file_count: 1 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(getStorageUsage()).resolves.toEqual({ total_bytes: 10, by_bucket: { references: 10 }, file_count: 1 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/storage/usage");
  });

  it("previews orphan cleanup with references bucket enabled", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ includeReferences: true });
      return mockJsonResponse({ total_files: 2, orphan_files: 1, bytes_reclaimable: 99, skipped_recent: 0, sample: [] });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(previewOrphanCleanup()).resolves.toMatchObject({ orphan_files: 1, bytes_reclaimable: 99 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/storage/orphans/preview");
  });

  it("runs orphan cleanup with references bucket enabled", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ includeReferences: true });
      return mockJsonResponse({ filesDeleted: 1, bytesFreed: 99, skippedRecent: 0, durationMs: 3 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(runOrphanCleanup()).resolves.toMatchObject({ filesDeleted: 1, bytesFreed: 99 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/storage/orphans/cleanup");
  });
});
