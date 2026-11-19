import sri from "../../../../packages/tracker/published/sri.json";
import { env } from "./env";

// Installation tag for a site (#17, self-service enrollment): the tenant only
// copies it. The script, its version and its SRI hash are the same for every
// site; only `data-site` changes. The version is the newest one in
// packages/tracker/published/sri.json, which the gateway built from the same
// checkout serves at /s/ (docs/dev/tracker.md).

const hashes: Record<string, string> = sri;

function newest(versions: string[]): string {
  const parts = (v: string) => v.split(".").map(Number);
  return versions.reduce((best, v) => {
    const [a, b] = [parts(v), parts(best)];
    for (let i = 0; i < 3; i++) {
      if (a[i]! !== b[i]!) return a[i]! > b[i]! ? v : best;
    }
    return best;
  });
}

export const TRACKER_VERSION = newest(Object.keys(hashes));
const integrity = hashes[TRACKER_VERSION]!;

export type TrackerSnippets = { html: string; nextjs: string };

export function trackerSnippets(websiteId: string): TrackerSnippets {
  const src = `${env.ingestUrl}/s/v${TRACKER_VERSION}/n.js`;
  const tag = (crossOrigin: string, end: string) =>
    [
      "<script",
      "  defer",
      `  src="${src}"`,
      `  integrity="${integrity}"`,
      `  ${crossOrigin}="anonymous"`,
      `  data-site="${websiteId}"`,
      end,
    ].join("\n");
  return { html: tag("crossorigin", "></script>"), nextjs: tag("crossOrigin", "/>") };
}
