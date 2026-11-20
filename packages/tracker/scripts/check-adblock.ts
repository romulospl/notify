// Checks whether the most used block lists block the script or the gateway endpoints (#23).
// Downloads the lists on the spot (nothing is committed) and evaluates each request with the
// network rule matcher of @ghostery/adblocker, as if it came from a tenant's page.
//
// Usage: pnpm --filter @stellytics/tracker check:adblock [host...]
// Hosts passed as arguments join the list of those that must not be blocked.
import { FiltersEngine, Request } from "@ghostery/adblocker";
import type { RequestType } from "@ghostery/adblocker";
import { readManifest } from "./bundle.ts";

const UBO = "https://ublockorigin.github.io/uAssets/filters";

// Lists enabled by default in uBlock Origin (except the malicious URL one, which only has
// malware domains), which include EasyList and EasyPrivacy.
const lists: Record<string, string> = {
  EasyList: "https://easylist.to/easylist/easylist.txt",
  EasyPrivacy: "https://easylist.to/easylist/easyprivacy.txt",
  "uBO filters": `${UBO}/filters.txt`,
  "uBO privacy": `${UBO}/privacy.txt`,
  "uBO badware": `${UBO}/badware.txt`,
  "uBO quick-fixes": `${UBO}/quick-fixes.txt`,
  "uBO unbreak": `${UBO}/unbreak.txt`,
  "Peter Lowe": "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext",
};

// Hosts that must not be blocked: the neutral example from the documentation and those passed on
// the command line (accepts "e.foo.org" or "https://e.foo.org/").
const requiredHosts = [
  "gw.example.com",
  ...process.argv.slice(2).map((arg) => (arg.includes("://") ? new URL(arg).host : arg.replace(/\/.*$/, ""))),
];

// Subdomains someone might pick in production. Informational only: shows which names to avoid.
const candidateHosts = [
  "stellytics",
  "ingest",
  "events",
  "stats",
  "metrics",
  "telemetry",
  "insights",
  "analytics",
  "track",
  "tracking",
  "collect",
  "umami",
].map((label) => `${label}.example.com`);

// Third-party page (the common case) and a page on the same domain as the gateway.
const sources = ["https://www.tenant-site.example.net/", "https://www.example.com/"];

const websiteId = "5f2b6c1e-8a43-4d1f-9b7e-3c0a2d4e6f81";

interface Probe {
  label: string;
  path: string;
  type: RequestType;
}

const probes: Probe[] = [
  ...Object.keys(readManifest()).map((version) => ({
    label: `GET /s/v${version}/n.js`,
    path: `/s/v${version}/n.js`,
    type: "script" as const,
  })),
  { label: "POST /e", path: "/e", type: "xmlhttprequest" },
  { label: "GET /c", path: `/c?s=${websiteId}`, type: "xmlhttprequest" },
];

// Controls the lists must block: if any passes, the matcher or the lists are broken and the
// result above does not count. The first two are Umami's default paths on the gateway host.
const controls: { url: string; type: RequestType }[] = [
  { url: `https://${requiredHosts[0]}/umami.js`, type: "script" },
  { url: `https://${requiredHosts[0]}/api/collect`, type: "xmlhttprequest" },
  { url: "https://www.google-analytics.com/analytics.js", type: "script" },
];

async function download(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === 3) throw new Error(`failed to download ${url}: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

// Resolves the "!#include" lines (uBO's filters.txt splits the rules across several files).
async function downloadList(url: string): Promise<string> {
  const text = await download(url);
  const parts = await Promise.all(
    text.split("\n").map(async (line) => {
      const include = /^!#include\s+(\S+)/.exec(line.trim());
      return include ? downloadList(new URL(include[1]!, url).href) : line;
    }),
  );
  return parts.join("\n");
}

// Network rules only; cosmetic filters hide elements and do not affect requests.
function engineFor(text: string): FiltersEngine {
  return FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true });
}

const texts = Object.fromEntries(
  await Promise.all(
    Object.entries(lists).map(async ([name, url]) => [name, await downloadList(url)] as const),
  ),
);

// The verdict comes from the lists together, as in the browser (an exception in one list applies to the others).
const combined = engineFor(Object.values(texts).join("\n"));
const perList = Object.entries(texts).map(([name, text]) => [name, engineFor(text)] as const);

// Each list must turn into real network rules: an error, captcha or rate limit page returned
// with 200 has lines of text, but no rule, and would make the test pass without testing anything.
const MIN_NETWORK_FILTERS = 20;
console.log(`Lists downloaded at ${new Date().toISOString()}:`);
for (const [name, engine] of perList) {
  const text = texts[name]!;
  const filters = engine.getFilters().networkFilters.length;
  const version = /^! (?:Version|Last modified):\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "no version";
  console.log(`  ${name}: ${filters} network rules (${version})`);
  if (filters < MIN_NETWORK_FILTERS) throw new Error(`the ${name} list turned into only ${filters} network rules`);
}

// Returns the rules that block the request, with the source list, or [] if it passes.
function blockedBy(host: string, probe: Probe, sourceUrl: string): string[] {
  const request = Request.fromRawDetails({
    url: `https://${host}${probe.path}`,
    sourceUrl,
    type: probe.type,
  });
  const { match, redirect } = combined.match(request);
  if (!match && !redirect) return [];
  const reasons = perList.flatMap(([name, engine]) => {
    const { filter } = engine.match(request);
    return filter ? [`${name}: ${filter.toString()}`] : [];
  });
  return reasons.length > 0 ? reasons : ["(combination of lists)"];
}

function check(host: string): string[] {
  return probes.flatMap((probe) =>
    sources.flatMap((source) =>
      blockedBy(host, probe, source).map(
        (reason) => `${probe.label} on ${host} from ${new URL(source).hostname}: ${reason}`,
      ),
    ),
  );
}

let failures = 0;
console.log("\nControls (must be blocked):");
for (const control of controls) {
  const request = Request.fromRawDetails({ ...control, sourceUrl: sources[0] });
  const { match, filter } = combined.match(request);
  if (!match) failures++;
  console.log(`  ${match ? "blocked" : "PASSED "} ${control.url}${filter ? ` (${filter.toString()})` : ""}`);
}

console.log("\nHosts that must not be blocked:");
for (const host of requiredHosts) {
  const blocks = check(host);
  failures += blocks.length;
  console.log(`  ${blocks.length === 0 ? "ok     " : "BLOCKED"} ${host}`);
  for (const block of blocks) console.log(`    ${block}`);
}

// sendBeacon becomes a request of type ping, which EasyPrivacy blocks from third parties ($ping,3p).
// Informational: shows why the script uses fetch with keepalive and never sendBeacon.
const beacon = blockedBy(requiredHosts[0]!, { label: "POST /e (sendBeacon)", path: "/e", type: "ping" }, sources[0]!);
console.log("\nPOST /e as sendBeacon (informational; the script uses fetch):");
console.log(`  ${beacon.length === 0 ? "ok     " : "blocked"} ${beacon[0] ?? ""}`);

console.log("\nCandidate subdomains (informational):");
for (const host of candidateHosts) {
  const blocks = check(host);
  console.log(`  ${blocks.length === 0 ? "ok     " : "blocked"} ${host}`);
  for (const block of [...new Set(blocks.map((b) => b.replace(/^.*?: /, "")))]) {
    console.log(`    ${block}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s): request blocked on a required host or control that passed.`);
  process.exit(1);
}
console.log("\nNo request blocked on the required hosts.");
