// Checks the licenses of the production dependencies against scripts/licenses/allowed.json.
//
// Usage:
//   node scripts/deps/check-licenses.mjs [--allowlist <file>] [--now YYYY-MM-DD]
//        [--npm <output of "pnpm licenses list --json --prod">]
//        [--go <TSV output of "go-licenses report": package, version, license>]
//
// Exits with 0 if everything is allowed, 1 if a package is not on the list (the
// list goes to standard output) and 2 if the input is empty or unreadable. Empty
// input never counts as "no problem": it would mean that the query failed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- SPDX -----------------------------------------------------------------

function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

// Evaluates a simple SPDX expression. AND takes precedence over OR. "X WITH Y"
// counts as X (the exception only adds permission to the text of license X).
// Returns { ok, ids } or throws Error if the expression is invalid.
export function evaluate(expr, isAllowed) {
  const tokens = tokenize(expr);
  let pos = 0;
  const ids = new Set();
  const peek = () => tokens[pos];
  const isOp = (t) => t === "AND" || t === "OR" || t === "WITH";

  function parseOr() {
    let v = parseAnd();
    while (peek() === "OR") {
      pos++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  }
  function parseAnd() {
    let v = parseAtom();
    while (peek() === "AND") {
      pos++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  }
  function parseAtom() {
    const t = peek();
    if (t === undefined) throw new Error("incomplete expression");
    if (t === "(") {
      pos++;
      const v = parseOr();
      if (peek() !== ")") throw new Error("unclosed parenthesis");
      pos++;
      return v;
    }
    if (t === ")" || isOp(t)) throw new Error(`unexpected token "${t}"`);
    pos++;
    ids.add(t);
    let v = isAllowed(t);
    if (peek() === "WITH") {
      pos++;
      if (peek() === undefined || isOp(peek()) || peek() === "(" || peek() === ")") {
        throw new Error("WITH without an exception");
      }
      pos++;
    }
    return v;
  }

  const ok = parseOr();
  if (pos !== tokens.length) throw new Error(`unexpected token "${tokens[pos]}"`);
  return { ok, ids: [...ids] };
}

// Ids that are not a license: no license, private or only pointed to in a file.
const NOT_A_LICENSE = /^(unknown|unlicensed|none|n\/a)$|^see license|^custom|^\(?\s*$/i;

// --- check ----------------------------------------------------------------

// npm: exact name, or prefix when "package" ends in "*" (e.g. "@img/sharp-libvips-*",
// one binary per platform). go: exact module or a subpackage of it ("module/..."); the
// "/" prefix does not apply to npm, where "@scope" must not match "@scope/x".
function exceptionFor(exceptions, ecosystem, name, license) {
  return exceptions.find((e) => {
    if (e.ecosystem !== ecosystem || e.license !== license) return false;
    if (name === e.package) return true;
    if (ecosystem === "go") return name.startsWith(`${e.package}/`);
    return e.package.endsWith("*") && name.startsWith(e.package.slice(0, -1));
  });
}

const MAX_EXCEPTION_DAYS = 183; // "at most 183 days" (CONTRIBUTING.md)

// Returns the reason if date/expires are invalid, or null. An invalid date
// can never "expire" (Invalid Date < now is false), so it is checked first.
function exceptionProblem(ex) {
  const parse = (v) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
  };
  if (typeof ex.reason !== "string" || ex.reason.trim() === "") return "missing reason";
  const from = parse(ex.date);
  const to = parse(ex.expires);
  if (!from) return `invalid date ("${ex.date}", use YYYY-MM-DD)`;
  if (!to) return `invalid expires ("${ex.expires}", use YYYY-MM-DD)`;
  if ((to - from) / 86400000 > MAX_EXCEPTION_DAYS) return `period longer than ${MAX_EXCEPTION_DAYS} days (date ${ex.date}, expires ${ex.expires})`;
  if (to < from) return "expires before date";
  return null;
}

// deps: [{ ecosystem, name, version, license }]
// Returns { violations: [{ecosystem,name,version,license,reason}], used: Map }
export function check(deps, allowlist, now = new Date()) {
  const allowed = new Set(allowlist.allowed);
  const exceptions = allowlist.exceptions ?? [];
  const violations = [];
  const used = new Set();
  for (const d of deps) {
    const license = (d.license ?? "").trim();
    let reason = null;
    if (NOT_A_LICENSE.test(license)) {
      reason = license === "" ? "no license declared" : `no valid license ("${license}")`;
    } else {
      try {
        if (!evaluate(license, (id) => allowed.has(id)).ok) {
          reason = "not on the allowlist";
        }
      } catch (err) {
        reason = `license expression not recognized (${err.message})`;
      }
    }
    if (reason === null) continue;

    const ex = exceptionFor(exceptions, d.ecosystem, d.name, license);
    if (ex) {
      const problem = exceptionProblem(ex);
      if (problem) {
        violations.push({ ...d, license, reason: `incomplete or invalid exception (${problem}): ${reason}` });
      } else if (new Date(`${ex.expires}T23:59:59Z`) < now) {
        violations.push({ ...d, license, reason: `exception expired on ${ex.expires}: ${reason}` });
      } else {
        used.add(ex);
      }
      continue;
    }
    violations.push({ ...d, license, reason });
  }
  return { violations, used, unusedExceptions: exceptions.filter((e) => !used.has(e)) };
}

// --- inputs ---------------------------------------------------------------

export function parseNpm(text) {
  const data = JSON.parse(text);
  const deps = [];
  for (const [license, pkgs] of Object.entries(data)) {
    for (const p of pkgs) {
      deps.push({ ecosystem: "npm", name: p.name, version: (p.versions ?? []).join(","), license: p.license ?? license });
    }
  }
  return deps;
}

export function parseGo(text) {
  const deps = [];
  for (const line of text.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 3) continue; // go noise (e.g. "go: downloading")
    deps.push({ ecosystem: "go", name: cols[0], version: cols[1], license: cols[2] });
  }
  return deps;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const allowlistFile =
    opt("--allowlist") ?? fileURLToPath(new URL("../licenses/allowed.json", import.meta.url));
  const now = opt("--now") ? new Date(`${opt("--now")}T00:00:00Z`) : new Date();
  const allowlist = JSON.parse(readFileSync(allowlistFile, "utf8"));

  const deps = [];
  try {
    if (opt("--npm")) deps.push(...parseNpm(readFileSync(opt("--npm"), "utf8")));
    if (opt("--go")) deps.push(...parseGo(readFileSync(opt("--go"), "utf8")));
  } catch (err) {
    console.error(`Could not read the dependency list: ${err.message}`);
    process.exit(2);
  }
  for (const eco of [opt("--npm") && "npm", opt("--go") && "go"].filter(Boolean)) {
    const n = deps.filter((d) => d.ecosystem === eco).length;
    if (n === 0) {
      console.error(`The ${eco} list came back empty: the query failed, there is no "zero dependencies".`);
      process.exit(2);
    }
    console.log(`${eco}: ${n} packages checked`);
  }
  if (deps.length === 0) {
    console.error("Nothing to check: pass --npm and/or --go.");
    process.exit(2);
  }

  const { violations, used, unusedExceptions } = check(deps, allowlist, now);
  for (const e of used) {
    console.log(`exception in use: ${e.ecosystem} ${e.package} (${e.license}), from ${e.date}, expires on ${e.expires}`);
  }
  for (const e of unusedExceptions) {
    console.log(`warning: unused exception (can be removed): ${e.ecosystem} ${e.package} (${e.license})`);
  }
  if (violations.length === 0) {
    console.log("Licenses: all allowed.");
    return;
  }
  console.log(`\n${violations.length} package(s) with a license not on the allowlist:\n`);
  for (const v of violations) {
    console.log(`  ${v.ecosystem}  ${v.name}@${v.version}  license: ${v.license || "(none)"}  -> ${v.reason}`);
  }
  console.log(
    "\nOptions: replace the dependency; or, if the license is OSI-approved, add the SPDX id to 'allowed'; or, if it is a one-off case, record an exception with reason, date and expires in scripts/licenses/allowed.json (see CONTRIBUTING.md).",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
