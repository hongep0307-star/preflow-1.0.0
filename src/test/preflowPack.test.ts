import { describe, expect, it } from "vitest";
import { validateManifest, type PackManifest } from "@/lib/preflowPack";

const baseManifest: PackManifest = {
  version: 1,
  kind: "preflowlib",
  created_at: "2026-04-29T00:00:00.000Z",
  app_version: "1.0.0",
  library_id: "main",
  item_count: 2,
  total_size_bytes: 1234,
  include_files: true,
  scope: "folder",
  scope_label: "Reference/Motion",
  project: null,
};

describe("validateManifest", () => {
  it("accepts current preflowlib manifests", () => {
    expect(() => validateManifest(baseManifest)).not.toThrow();
  });

  // .preflowpack 는 .preflowlib 으로 통합되었지만, 옛 파일이 들어와도 같은
  // pipeline 으로 import 되어야 하므로 validateManifest 는 historical kind
  // 도 계속 받아 들여야 한다.
  it("accepts legacy preflowpack manifests for backwards compatibility", () => {
    expect(() => validateManifest({
      ...baseManifest,
      kind: "preflowpack",
      scope: "projectLinked",
      project: { id: "project_1", name: "Launch Film" },
    })).not.toThrow();
  });

  it("rejects unsupported versions", () => {
    expect(() => validateManifest({ ...baseManifest, version: 2 })).toThrow("Unsupported pack version");
  });

  it("rejects invalid kind and scope", () => {
    expect(() => validateManifest({ ...baseManifest, kind: "zip" })).toThrow("Invalid pack kind");
    expect(() => validateManifest({ ...baseManifest, scope: "single" })).toThrow("Invalid pack scope");
  });
});
