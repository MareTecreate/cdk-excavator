#!/usr/bin/env node
import { runCdkx } from "./cli.js";

const argv = process.argv.slice(2);
const result = await runCdkx(argv);

if (result.stdout) {
  console.log(result.stdout);
}

if (result.stderr) {
  console.error(result.stderr);
}

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

export { runCdkx };
