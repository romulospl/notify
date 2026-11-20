// Publishes the package.json version to published/vX.Y.Z/n.js and records the SRI in published/sri.json.
// A published version is immutable: the script refuses to overwrite a version that already exists.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle, currentVersion, fileName, publishedDir, readManifest, sri, sriFile } from "./bundle.ts";

const version = currentVersion();
const dir = join(publishedDir, `v${version}`);
const manifest = existsSync(sriFile) ? readManifest() : {};

if (existsSync(dir) || manifest[version]) {
  console.error(`Version ${version} is already published and cannot change. Bump the version in package.json.`);
  process.exit(1);
}

const content = await bundle();
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, fileName), content);
manifest[version] = sri(content);
writeFileSync(sriFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`published/v${version}/${fileName} ${manifest[version]}`);
