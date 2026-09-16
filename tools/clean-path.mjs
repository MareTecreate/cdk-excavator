import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error("Usage: node tools/clean-path.mjs <path> [path...]");
  process.exit(2);
}

await Promise.all(
  targets.map((target) =>
    rm(resolve(target), {
      force: true,
      recursive: true,
    }),
  ),
);
