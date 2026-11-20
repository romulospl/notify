// Runs "pnpm audit --prod --json" and fails on a high or critical vulnerability.
// A second pass without --prod only lists the devDependencies ones.
//
// Tells three results apart, because pnpm exits with 1 both for "found a
// vulnerability" and for "could not query" (network, registry down, endpoint
// unavailable), and the latter must not turn green:
//   0  query done, nothing high/critical (moderate and low are only listed)
//   1  query done, there is a high or critical vulnerability
//   2  could not query or the response is not an audit report
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const FAIL_FROM = "high";

// Takes the text of "pnpm audit --json" (or use --file <file> for testing).
export function interpret(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { code: 2, message: "The pnpm audit output is not JSON." };
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { code: 2, message: "The pnpm audit output is not a JSON object." };
  }
  if (report.error) {
    return { code: 2, message: `Could not query the audit: ${report.error.code ?? ""} ${report.error.message ?? ""}`.trim() };
  }
  if (typeof report.advisories !== "object" || report.advisories === null || !report.metadata?.vulnerabilities) {
    return { code: 2, message: "The response has no advisories or metadata: it is not an audit report." };
  }
  const list = Object.values(report.advisories);
  // An unknown or missing severity ("unknown", "High") must not turn green.
  const bad = list.filter((a) => !SEVERITIES.includes(a?.severity));
  if (bad.length > 0) {
    return { code: 2, message: `Unknown severity in the audit report: ${bad.map((a) => JSON.stringify(a?.severity)).join(", ")}. Expected: ${SEVERITIES.join(", ")}.` };
  }
  // The metadata totals must match the list; otherwise the response is incomplete.
  for (const level of ["high", "critical"]) {
    const total = Number(report.metadata.vulnerabilities[level] ?? 0);
    const listed = list.filter((a) => a.severity === level).length;
    if (!Number.isFinite(total) || (total > 0 && listed === 0)) {
      return { code: 2, message: `The metadata says ${total} ${level} but the advisories list has ${listed}: incomplete or inconsistent response.` };
    }
  }
  const lines = list.map(
    (a) =>
      `  ${a.severity.padEnd(8)} ${a.module_name}  vulnerable: ${a.vulnerable_versions}  fixed in: ${a.patched_versions}  ${a.github_advisory_id ?? ""}  ${a.title}\n` +
      a.findings.flatMap((f) => f.paths.map((p) => `             ${f.version} via ${p}`)).join("\n"),
  );
  const blocking = list.filter((a) => SEVERITIES.indexOf(a.severity) >= SEVERITIES.indexOf(FAIL_FROM));
  const summary = `Query done: ${list.length} advisory(ies); ${blocking.length} high/critical. Packages: ${report.metadata.totalDependencies}.`;
  const body = lines.length ? `\n${lines.join("\n")}\n` : "";
  return { code: blocking.length > 0 ? 1 : 0, message: summary + body };
}

function run(args) {
  const r = spawnSync("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { error: `Could not run pnpm: ${r.error.message}` };
  return { stdout: r.stdout };
}

// Second pass, without --prod, only to LIST what is in the devDependencies
// (e.g. the esbuild that generates the n.js served to every tenant). It never
// changes the result: the verdict comes only from the production pass.
function devOnlyNote(prodStdout) {
  const all = run(["audit", "--json"]);
  if (all.error) return `warning: the full pass did not run (${all.error})`;
  let a, p;
  try {
    a = JSON.parse(all.stdout);
    p = JSON.parse(prodStdout);
  } catch {
    return "warning: full pass (without --prod) unreadable; only the production one counts";
  }
  if (!a?.advisories || !p?.advisories) return "warning: full pass (without --prod) has no report; only the production one counts";
  const extra = Object.entries(a.advisories).filter(([id]) => !(id in p.advisories));
  if (extra.length === 0) return "Full pass (without --prod): no additional, development-only advisory.";
  return (
    "Only in devDependencies (informational, does not fail the job):\n" +
    extra.map(([, v]) => `  ${v.severity} ${v.module_name} ${v.github_advisory_id ?? ""} ${v.title}\n` + v.findings.flatMap((f) => f.paths.map((x) => `             ${f.version} via ${x}`)).join("\n")).join("\n")
  );
}

function main() {
  const i = process.argv.indexOf("--file");
  let stdout;
  if (i !== -1) {
    stdout = readFileSync(process.argv[i + 1], "utf8");
  } else {
    const r = run(["audit", "--prod", "--json"]);
    if (r.error) {
      console.error(r.error);
      process.exit(2);
    }
    stdout = r.stdout;
  }
  const { code, message } = interpret(stdout);
  (code === 2 ? console.error : console.log)(message);
  if (code !== 2 && i === -1) console.log(`\n${devOnlyNote(stdout)}`);
  process.exit(code);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
