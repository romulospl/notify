// Bundles the script and computes the SRI. Used by the build, the release and the immutability test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

export const root = join(import.meta.dirname, "..");
export const publishedDir = join(root, "published");
export const sriFile = join(publishedDir, "sri.json");
export const fileName = "n.js";

// Map of version → SRI hash for each published version.
export type SriManifest = Record<string, string>;

export function currentVersion(): string {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    legalComments: "none",
    write: false,
  });
  return result.outputFiles[0]!.text;
}

export function sri(content: string | Buffer): string {
  return `sha384-${createHash("sha384").update(content).digest("base64")}`;
}

export function readManifest(): SriManifest {
  return JSON.parse(readFileSync(sriFile, "utf8"));
}
