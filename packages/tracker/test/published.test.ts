// Makes sure a published version does not change after it is published (#22).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundle, currentVersion, fileName, publishedDir, readManifest, sri } from "../scripts/bundle.ts";

const manifest = readManifest();
const versions = readdirSync(publishedDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name.replace(/^v/, ""));

describe("published versions", () => {
  it("every folder has a recorded SRI and vice versa", () => {
    expect(versions.sort()).toEqual(Object.keys(manifest).sort());
  });

  it.each(versions)("v%s matches the recorded SRI", (version) => {
    const content = readFileSync(join(publishedDir, `v${version}`, fileName));
    expect(sri(content)).toBe(manifest[version]);
  });

  it("the current code is that of the package.json version", async () => {
    const version = currentVersion();
    const file = join(publishedDir, `v${version}`, fileName);
    expect(existsSync(file), `run "pnpm --filter @stellytics/tracker release" to publish v${version}`).toBe(
      true,
    );
    // Changed the code without bumping the version? Bump the version in package.json and run the release.
    expect(sri(await bundle())).toBe(manifest[version]);
  });
});
