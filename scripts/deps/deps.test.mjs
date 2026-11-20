// Tests for the dependency checkers. Run with: node --test scripts/deps/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, evaluate, parseGo, parseNpm } from "./check-licenses.mjs";
import { interpret } from "./audit-pnpm.mjs";

const allowlist = { allowed: ["MIT", "Apache-2.0", "BSD-3-Clause"], exceptions: [] };
const dep = (license, name = "pkg") => ({ ecosystem: "npm", name, version: "1.0.0", license });
const fails = (license) => check([dep(license)], allowlist).violations.length === 1;

test("an allowed license passes", () => {
  assert.equal(check([dep("MIT")], allowlist).violations.length, 0);
});

test("a license not on the allowlist fails and shows up in the list", () => {
  const { violations } = check([dep("MIT"), dep("GPL-3.0-only", "bad")], allowlist);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, "bad");
  assert.equal(violations[0].license, "GPL-3.0-only");
});

test("no license, UNLICENSED, Unknown and SEE LICENSE fail", () => {
  for (const l of ["", "UNLICENSED", "Unknown", "SEE LICENSE IN LICENSE.md", "Custom: https://x"]) {
    assert.ok(fails(l), `should fail: "${l}"`);
  }
});

test("OR: one allowed alternative is enough (dual license)", () => {
  assert.ok(!fails("(MIT OR GPL-3.0-only)"));
  assert.ok(!fails("GPL-3.0-only OR Apache-2.0"));
  assert.ok(fails("(GPL-3.0-only OR AGPL-3.0-only)"));
});

test("AND: all of them must be allowed", () => {
  assert.ok(!fails("MIT AND Apache-2.0"));
  assert.ok(fails("MIT AND CC-BY-4.0"));
  assert.ok(fails("MIT AND (Apache-2.0 AND GPL-2.0-only)"));
});

test("AND takes precedence over OR and parentheses count", () => {
  assert.equal(evaluate("MIT OR GPL AND LGPL", (id) => id === "MIT").ok, true);
  assert.equal(evaluate("(MIT OR GPL) AND LGPL", (id) => id === "MIT").ok, false);
});

test("WITH counts as the base license", () => {
  assert.ok(!fails("Apache-2.0 WITH LLVM-exception"));
  assert.ok(fails("GPL-2.0-only WITH Classpath-exception-2.0"));
});

test("an invalid expression fails instead of passing", () => {
  for (const l of ["MIT OR", "(MIT", "MIT)", "AND MIT", "MIT WITH", "MIT AND AND Apache-2.0"]) {
    assert.ok(fails(l), `should fail: "${l}"`);
  }
});

test("an exception allows only the exact license and package", () => {
  const al = {
    ...allowlist,
    exceptions: [{ ecosystem: "npm", package: "data", license: "CC-BY-4.0", reason: "x", date: "2026-01-01", expires: "2026-07-01" }],
  };
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(check([dep("CC-BY-4.0", "data")], al, now).violations.length, 0);
  assert.equal(check([dep("CC-BY-4.0", "other")], al, now).violations.length, 1);
  assert.equal(check([dep("GPL-3.0-only", "data")], al, now).violations.length, 1, "the license changed: the exception does not apply");
});

test("an expired or incomplete exception fails", () => {
  const ex = { ecosystem: "npm", package: "data", license: "CC-BY-4.0", reason: "x", date: "2026-01-01", expires: "2026-03-01" };
  const now = new Date("2026-06-01T00:00:00Z");
  const expired = check([dep("CC-BY-4.0", "data")], { ...allowlist, exceptions: [ex] }, now);
  assert.match(expired.violations[0].reason, /expired/);
  const inc = check([dep("CC-BY-4.0", "data")], { ...allowlist, exceptions: [{ ...ex, reason: "" }] }, new Date("2026-02-01T00:00:00Z"));
  assert.match(inc.violations[0].reason, /incomplete/);
});

test("an exception with an invalid date or a long period fails (never valid forever)", () => {
  const base = { ecosystem: "npm", package: "data", license: "CC-BY-4.0", reason: "x", date: "2026-01-01", expires: "2026-03-01" };
  const now = new Date("2026-02-01T00:00:00Z");
  const run = (ex) => check([dep("CC-BY-4.0", "data")], { ...allowlist, exceptions: [{ ...base, ...ex }] }, now);
  assert.equal(run({}).violations.length, 0, "control: the valid exception passes");
  for (const expires of ["soon", "2026-1-1x", "2026-02-30", "2026-03-01T00:00:00Z", undefined]) {
    assert.match(run({ expires }).violations[0]?.reason ?? "passed", /invalid/, `expires ${expires}`);
  }
  assert.match(run({ date: "yesterday" }).violations[0]?.reason ?? "passed", /invalid/);
  assert.match(run({ expires: "2026-08-01" }).violations[0]?.reason ?? "passed", /period longer than 183/, "more than six months");
  assert.equal(run({ expires: "2026-07-02" }).violations.length, 0, "183 days passes");
  assert.match(run({ date: "2026-03-01", expires: "2026-01-01" }).violations[0]?.reason ?? "passed", /before/);
});

test("the slash prefix only applies to Go; npm only with an asterisk", () => {
  const ex = (ecosystem, pkg) => ({ ...allowlist, exceptions: [{ ecosystem, package: pkg, license: "MPL-2.0", reason: "x", date: "2026-01-01", expires: "2026-03-01" }] });
  const now = new Date("2026-02-01T00:00:00Z");
  const n = (name) => ({ ecosystem: "npm", name, version: "1", license: "MPL-2.0" });
  assert.equal(check([n("@scope/x")], ex("npm", "@scope"), now).violations.length, 1);
  assert.equal(check([n("@scope/x")], ex("npm", "@scope/*"), now).violations.length, 0);
  assert.equal(check([n("@scope/y")], ex("npm", "@scope/x"), now).violations.length, 1);
});

test("a Go exception applies to subpackages of the module", () => {
  const al = { ...allowlist, exceptions: [{ ecosystem: "go", package: "example.com/m", license: "MPL-2.0", reason: "x", date: "2026-01-01", expires: "2026-07-01" }] };
  const d = { ecosystem: "go", name: "example.com/m/internal", version: "v1", license: "MPL-2.0" };
  assert.equal(check([d], al, new Date("2026-06-01T00:00:00Z")).violations.length, 0);
});

test("parseNpm and parseGo", () => {
  const npm = parseNpm(JSON.stringify({ MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }] }));
  assert.deepEqual(npm, [{ ecosystem: "npm", name: "a", version: "1.0.0", license: "MIT" }]);
  const go = parseGo("go: downloading x\nexample.com/m\tv1.2.3\tApache-2.0\n\n");
  assert.deepEqual(go, [{ ecosystem: "go", name: "example.com/m", version: "v1.2.3", license: "Apache-2.0" }]);
});

// --- audit ----------------------------------------------------------------

const report = (severities) =>
  JSON.stringify({
    advisories: Object.fromEntries(
      severities.map((s, i) => [
        String(i),
        { severity: s, module_name: `m${i}`, vulnerable_versions: "<2", patched_versions: ">=2", github_advisory_id: "GHSA-x", title: "t", findings: [{ version: "1", paths: ["a>b"] }] },
      ]),
    ),
    metadata: { vulnerabilities: {}, totalDependencies: 10 },
  });

test("audit: no vulnerability and moderate pass", () => {
  assert.equal(interpret(report([])).code, 0);
  assert.equal(interpret(report(["moderate", "low"])).code, 0);
});

test("audit: high and critical fail", () => {
  assert.equal(interpret(report(["moderate", "high"])).code, 1);
  assert.equal(interpret(report(["critical"])).code, 1);
});

test("audit: a query failure never turns green", () => {
  const network = JSON.stringify({ error: { code: "ECONNREFUSED", message: "request failed" } });
  assert.equal(interpret(network).code, 2);
  assert.equal(interpret("").code, 2);
  assert.equal(interpret("<html>502 Bad Gateway</html>").code, 2);
  assert.equal(interpret("{}").code, 2);
  assert.equal(interpret(JSON.stringify({ advisories: {} })).code, 2);
});

test("audit: unknown or missing severity is exit 2, not green and not a TypeError", () => {
  assert.equal(interpret(report(["unknown"])).code, 2);
  assert.equal(interpret(report(["High"])).code, 2);
  const noSeverity = JSON.stringify({ advisories: { 0: { module_name: "m", findings: [] } }, metadata: { vulnerabilities: {} } });
  assert.equal(interpret(noSeverity).code, 2);
});

test("audit: a high/critical count in the metadata without advisories is exit 2", () => {
  const incons = JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { high: 2, critical: 0 }, totalDependencies: 5 } });
  assert.equal(interpret(incons).code, 2);
  const incons2 = JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { critical: 1 } } });
  assert.equal(interpret(incons2).code, 2);
});

test("audit: null, array and primitives are exit 2", () => {
  for (const t of ["null", "[]", "42", '"x"', "true"]) assert.equal(interpret(t).code, 2, t);
});
