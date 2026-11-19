// Confere as licencas das dependencias de producao contra scripts/licenses/allowed.json.
//
// Uso:
//   node scripts/deps/check-licenses.mjs [--allowlist <arquivo>] [--now AAAA-MM-DD]
//        [--npm <saida de "pnpm licenses list --json --prod">]
//        [--go <saida TSV de "go-licenses report": pacote, versao, licenca>]
//
// Sai com 0 se tudo estiver permitido, 1 se houver pacote fora da lista (a lista
// sai na saida padrao) e 2 se a entrada estiver vazia ou ilegivel. Entrada vazia
// nunca vale como "sem problema": significaria que a consulta falhou.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- SPDX -----------------------------------------------------------------

function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

// Avalia uma expressao SPDX simples. AND tem precedencia sobre OR. "X WITH Y"
// vale como X (a excecao so acrescenta permissao ao texto da licenca X).
// Devolve { ok, ids } ou lanca Error se a expressao for invalida.
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
    if (t === undefined) throw new Error("expressao incompleta");
    if (t === "(") {
      pos++;
      const v = parseOr();
      if (peek() !== ")") throw new Error("parentese sem fechar");
      pos++;
      return v;
    }
    if (t === ")" || isOp(t)) throw new Error(`token inesperado "${t}"`);
    pos++;
    ids.add(t);
    let v = isAllowed(t);
    if (peek() === "WITH") {
      pos++;
      if (peek() === undefined || isOp(peek()) || peek() === "(" || peek() === ")") {
        throw new Error("WITH sem excecao");
      }
      pos++;
    }
    return v;
  }

  const ok = parseOr();
  if (pos !== tokens.length) throw new Error(`token inesperado "${tokens[pos]}"`);
  return { ok, ids: [...ids] };
}

// Ids que nao sao licenca: sem licenca, privada ou so indicada em arquivo.
const NOT_A_LICENSE = /^(unknown|unlicensed|none|n\/a)$|^see license|^custom|^\(?\s*$/i;

// --- verificacao ----------------------------------------------------------

// npm: nome exato, ou prefixo quando "package" termina em "*" (ex.: "@img/sharp-libvips-*",
// um binario por plataforma). go: modulo exato ou subpacote dele ("modulo/..."); o
// prefixo por "/" nao vale para npm, onde "@escopo" nao pode casar com "@escopo/x".
function exceptionFor(exceptions, ecosystem, name, license) {
  return exceptions.find((e) => {
    if (e.ecosystem !== ecosystem || e.license !== license) return false;
    if (name === e.package) return true;
    if (ecosystem === "go") return name.startsWith(`${e.package}/`);
    return e.package.endsWith("*") && name.startsWith(e.package.slice(0, -1));
  });
}

const MAX_EXCEPTION_DAYS = 183; // "no maximo 183 dias" (CONTRIBUTING.md)

// Devolve o motivo se date/expires forem invalidos, ou null. Data invalida
// nunca pode "vencer" (Invalid Date < now e falso), por isso e checada antes.
function exceptionProblem(ex) {
  const parse = (v) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
  };
  if (typeof ex.reason !== "string" || ex.reason.trim() === "") return "falta reason";
  const from = parse(ex.date);
  const to = parse(ex.expires);
  if (!from) return `date invalida ("${ex.date}", use AAAA-MM-DD)`;
  if (!to) return `expires invalido ("${ex.expires}", use AAAA-MM-DD)`;
  if ((to - from) / 86400000 > MAX_EXCEPTION_DAYS) return `prazo maior que ${MAX_EXCEPTION_DAYS} dias (date ${ex.date}, expires ${ex.expires})`;
  if (to < from) return "expires anterior a date";
  return null;
}

// deps: [{ ecosystem, name, version, license }]
// Devolve { violations: [{ecosystem,name,version,license,reason}], used: Map }
export function check(deps, allowlist, now = new Date()) {
  const allowed = new Set(allowlist.allowed);
  const exceptions = allowlist.exceptions ?? [];
  const violations = [];
  const used = new Set();
  for (const d of deps) {
    const license = (d.license ?? "").trim();
    let reason = null;
    if (NOT_A_LICENSE.test(license)) {
      reason = license === "" ? "sem licenca declarada" : `sem licenca valida ("${license}")`;
    } else {
      try {
        if (!evaluate(license, (id) => allowed.has(id)).ok) {
          reason = "fora da allowlist";
        }
      } catch (err) {
        reason = `expressao de licenca nao reconhecida (${err.message})`;
      }
    }
    if (reason === null) continue;

    const ex = exceptionFor(exceptions, d.ecosystem, d.name, license);
    if (ex) {
      const problem = exceptionProblem(ex);
      if (problem) {
        violations.push({ ...d, license, reason: `excecao incompleta ou invalida (${problem}): ${reason}` });
      } else if (new Date(`${ex.expires}T23:59:59Z`) < now) {
        violations.push({ ...d, license, reason: `excecao vencida em ${ex.expires}: ${reason}` });
      } else {
        used.add(ex);
      }
      continue;
    }
    violations.push({ ...d, license, reason });
  }
  return { violations, used, unusedExceptions: exceptions.filter((e) => !used.has(e)) };
}

// --- entradas -------------------------------------------------------------

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
    if (cols.length < 3) continue; // ruido do go (ex.: "go: downloading")
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
    console.error(`Nao consegui ler a lista de dependencias: ${err.message}`);
    process.exit(2);
  }
  for (const eco of [opt("--npm") && "npm", opt("--go") && "go"].filter(Boolean)) {
    const n = deps.filter((d) => d.ecosystem === eco).length;
    if (n === 0) {
      console.error(`A lista de ${eco} veio vazia: a consulta falhou, nao ha "zero dependencias".`);
      process.exit(2);
    }
    console.log(`${eco}: ${n} pacotes conferidos`);
  }
  if (deps.length === 0) {
    console.error("Nada para conferir: passe --npm e/ou --go.");
    process.exit(2);
  }

  const { violations, used, unusedExceptions } = check(deps, allowlist, now);
  for (const e of used) {
    console.log(`excecao em uso: ${e.ecosystem} ${e.package} (${e.license}), de ${e.date}, vence em ${e.expires}`);
  }
  for (const e of unusedExceptions) {
    console.log(`aviso: excecao sem uso (pode ser removida): ${e.ecosystem} ${e.package} (${e.license})`);
  }
  if (violations.length === 0) {
    console.log("Licencas: todas permitidas.");
    return;
  }
  console.log(`\n${violations.length} pacote(s) com licenca fora da allowlist:\n`);
  for (const v of violations) {
    console.log(`  ${v.ecosystem}  ${v.name}@${v.version}  licenca: ${v.license || "(nenhuma)"}  -> ${v.reason}`);
  }
  console.log(
    "\nOpcoes: trocar a dependencia; ou, se a licenca for aprovada pela OSI, acrescentar o id SPDX em 'allowed'; ou, se for um caso pontual, registrar uma excecao com reason, date e expires em scripts/licenses/allowed.json (ver CONTRIBUTING.md).",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
