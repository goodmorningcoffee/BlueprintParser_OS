// @vitest-environment node
// P2.5 source contract for mode-specific eager transport and page-window adoption.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lifecycle = readFileSync(
  join(process.cwd(), "src/lib/project-lifecycle.ts"),
  "utf8",
);

describe("P2.5 page-window bootstrap coordinator", () => {
  it("keeps authenticated and demo eager request membership", () => {
    expect(lifecycle).toContain("request(\`/api/projects/");
    expect(lifecycle).toContain("request(\`/api/demo/projects/");
    expect(lifecycle).toContain("/pages?from=1&to=15\`)");
    expect(lifecycle).toContain("request(\`/api/annotation-groups?projectId=");
    expect(lifecycle).toContain("signal: record.controller.signal");
    expect(lifecycle).toContain('cache: "no-store"');
  });

  it("parses candidates before canonical success publication and pairs fatal-decode clearing", () => {
    expect(lifecycle.match(/publishBootstrapPageWindow\(/g)).toHaveLength(2);
    expect(lifecycle).toMatch(
      /publishBootstrapPageWindow\(\s*queryClient,\s*publicId,\s*chunk,\s*data\.numPages,\s*canPublish,?\s*\)/,
    );
    expect(lifecycle).toMatch(
      /catch \(error\)[\s\S]*?publishBootstrapPageWindow\(\s*queryClient,\s*data\.id,\s*null,\s*data\.numPages,\s*\(\) => ownsRecord\(queryClient, record\),?\s*\)/,
    );
    expect(lifecycle.indexOf("chunk = (await chunkResponse.json())")).toBeLessThan(
      lifecycle.indexOf("adoptProject(queryClient"),
    );
  });

  it("preserves optional HTTP-empty, fatal JSON, and auth-only scale hydration", () => {
    expect(lifecycle).toContain("if (chunkResponse.ok)");
    expect(lifecycle).not.toContain("chunkResponse.json().catch");
    expect(lifecycle).toContain("if (!options.demo && chunk)");
    expect(lifecycle).toContain('annotation.source === "takeoff-scale"');
  });
});
