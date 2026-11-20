// Builds dist/n.js for development. What is served to tenants comes from published/ (see release.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle, fileName, root, sri } from "./bundle.ts";

const content = await bundle();
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", fileName), content);
console.log(`dist/${fileName} (${content.length} bytes, ${sri(content)})`);
