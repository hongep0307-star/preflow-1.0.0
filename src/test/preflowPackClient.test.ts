import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPack, exportPack, previewPack } from "@/lib/preflowPackClient";

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

describe("preflowPackClient", () => {
  it("posts folder export options to /pack/export", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        scope: "folder",
        folderTag: "folder:Motion",
        includeFiles: false,
        includeSubfolders: true,
      });
      return mockJsonResponse({ item_count: 3, total_size_bytes: 0, skipped: [] });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(exportPack({
      scope: "folder",
      folderTag: "folder:Motion",
      includeFiles: false,
      includeSubfolders: true,
    })).resolves.toMatchObject({ item_count: 3 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/pack/export");
  });

  it("opens pack preview through /pack/preview", async () => {
    // Parameters<typeof fetch> 를 명시해 mock.calls 가 빈 튜플로 추론되어
    // .calls[0]![0] 인덱스 접근에서 TS2493 가 나던 문제를 막는다.
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      mockJsonResponse({ canceled: true }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(previewPack()).resolves.toEqual({ canceled: true });
    expect(fetchMock.mock.calls[0]![0]).toContain("/pack/preview");
  });

  it("applies import strategy through /pack/import", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        tempPath: "tmp/pack.zip",
        strategy: "mergeMetadata",
      });
      return mockJsonResponse({ inserted: 0, skipped: 0, merged: 2, copied_files: 0, missing_files: [] });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(applyPack({ tempPath: "tmp/pack.zip", strategy: "mergeMetadata" })).resolves.toMatchObject({ merged: 2 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/pack/import");
  });
});
