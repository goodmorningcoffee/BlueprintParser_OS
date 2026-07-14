// @vitest-environment node
// P2.5 tripwire: routes cannot publish annotations/window independently.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("P2.5 paired bootstrap call surface", () => {
  it("removes direct paired publications from both route pages", () => {
    for (const path of [
      "src/app/(dashboard)/project/[id]/page.tsx",
      "src/app/demo/project/[id]/page.tsx",
    ]) {
      const route = source(path);
      expect(route).not.toContain("publishBootstrapPageWindow");
      expect(route).not.toContain("queryKeys.annotations");
      expect(route).not.toContain("queryKeys.pagesWindow");
    }
  });

  it("publishes success and fatal-decode clearing through one paired helper", () => {
    const lifecycle = source("src/lib/project-lifecycle.ts");
    expect(lifecycle.match(/publishBootstrapPageWindow\(/g)).toHaveLength(2);
    expect(lifecycle).toContain("const publicId = data.id");
    expect(lifecycle).toMatch(
      /publishBootstrapPageWindow\(\s*queryClient,\s*publicId,\s*chunk,\s*data\.numPages,\s*canPublish,?\s*\)/,
    );
    expect(lifecycle).toMatch(
      /publishBootstrapPageWindow\(\s*queryClient,\s*data\.id,\s*null,\s*data\.numPages,\s*\(\) => ownsRecord\(queryClient, record\),?\s*\)/,
    );
    expect(lifecycle).not.toContain("queryClient.setQueryData(queryKeys.annotations");
  });
});
