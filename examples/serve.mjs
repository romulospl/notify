// Servidor estático mínimo dos exemplos de HTML e SPA, sem dependências.
//
//   node ../serve.mjs <pasta> [spa]
//
// Troca o comentário <!-- stellytics:script --> das páginas pela tag do script de
// rastreamento, montada a partir das variáveis de ambiente:
//   STELLYTICS_WEBSITE_ID   ID do site no Umami (obrigatório)
//   STELLYTICS_GATEWAY_URL  origem do gateway (padrão http://127.0.0.1:3002)
//   STELLYTICS_SCRIPT_VERSION  versão do script (padrão: a mais nova publicada)
//   PORT                porta (padrão 4001)
//   HOST                listen address (default 127.0.0.1; 0.0.0.0 in a container)
// No modo spa, caminhos sem arquivo devolvem o index.html (roteamento no navegador).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const [dir = ".", mode] = process.argv.slice(2);
const root = resolve(dir);
const port = Number(process.env.PORT ?? 4001);
const host = process.env.HOST ?? "127.0.0.1";

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

async function scriptTag() {
  const website = process.env.STELLYTICS_WEBSITE_ID;
  if (!website) throw new Error("defina STELLYTICS_WEBSITE_ID com o ID do site no Umami");
  const gateway = (process.env.STELLYTICS_GATEWAY_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
  const sri = JSON.parse(
    await readFile(new URL("../packages/tracker/published/sri.json", import.meta.url), "utf8"),
  );
  const version =
    process.env.STELLYTICS_SCRIPT_VERSION ??
    Object.keys(sri).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (!sri[version]) throw new Error(`versão ${version} do script não publicada`);
  return (
    `<script defer src="${gateway}/s/v${version}/n.js" integrity="${sri[version]}" ` +
    `crossorigin="anonymous" data-site="${website}"></script>`
  );
}

const tag = await scriptTag();

createServer(async (req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  let file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(root)) {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    if (mode !== "spa" || extname(path)) {
      res.writeHead(404).end("not found");
      return;
    }
    file = join(root, "index.html");
    body = await readFile(file);
  }
  const type = types[extname(file)] ?? "application/octet-stream";
  if (extname(file) === ".html") body = body.toString().replace("<!-- stellytics:script -->", tag);
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
}).listen(port, host, () => console.log(`http://${host}:${port}/ (${dir}${mode ? `, ${mode}` : ""})`));
