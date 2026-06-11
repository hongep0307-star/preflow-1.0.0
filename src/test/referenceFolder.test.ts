import { describe, expect, it } from "vitest";
import { folderTag, normalizeFolderPath } from "@/lib/referenceLibrary";

describe("reference library folder tags", () => {
  it("normalizes slash-separated folder paths", () => {
    expect(normalizeFolderPath(" Reference / Motion / 2D ")).toBe("Reference/Motion/2D");
  });

  it("removes an existing folder prefix before normalizing", () => {
    expect(normalizeFolderPath("folder:Reference/Motion")).toBe("Reference/Motion");
  });

  it("creates folder: tags from normalized paths", () => {
    expect(folderTag(" Reference / Motion ")).toBe("folder:Reference/Motion");
  });

  it("rejects empty folder tags", () => {
    expect(() => folderTag(" / / ")).toThrow("Folder name is required");
  });
});
