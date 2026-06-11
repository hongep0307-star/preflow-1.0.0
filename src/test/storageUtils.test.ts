import { describe, expect, it } from "vitest";
import { LOCAL_SERVER_BASE_URL } from "@shared/constants";
import { parseStorageUrl } from "@/lib/storageUtils";

describe("parseStorageUrl", () => {
  it("parses current local-server storage URLs", () => {
    expect(parseStorageUrl(`${LOCAL_SERVER_BASE_URL}/storage/file/references/2026-04/ref/file.png`)).toEqual({
      bucket: "references",
      filePath: "2026-04/ref/file.png",
    });
  });

  it("accepts stale fallback ports and strips query/hash fragments", () => {
    expect(parseStorageUrl("http://127.0.0.1:41235/storage/file/references/a/b/video.mp4?t=123#poster")).toEqual({
      bucket: "references",
      filePath: "a/b/video.mp4",
    });
  });

  it("decodes URL-encoded storage paths", () => {
    expect(parseStorageUrl("http://127.0.0.1:19876/storage/file/references/folder%20one/image%20name.png")).toEqual({
      bucket: "references",
      filePath: "folder one/image name.png",
    });
  });

  it("parses local-file URLs inside app storage", () => {
    expect(parseStorageUrl("local-file:///C:/Users/me/AppData/Roaming/Pre-Flow/storage/references/a/b.png")).toEqual({
      bucket: "references",
      filePath: "a/b.png",
    });
  });

  it("ignores external URLs", () => {
    expect(parseStorageUrl("https://example.com/image.png")).toBeNull();
    expect(parseStorageUrl("data:image/png;base64,abc")).toBeNull();
  });
});
