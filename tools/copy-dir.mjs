import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [source, destination] = process.argv.slice(2);

if (!source || !destination) {
  console.error("Usage: node tools/copy-dir.mjs <source> <destination>");
  process.exit(2);
}

const from = resolve(source);
const to = resolve(destination);

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true, force: true });
