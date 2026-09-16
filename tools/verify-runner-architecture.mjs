import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedPlatforms = new Set(["darwin", "linux", "win32"]);
const allowedArchitectures = new Set(["arm64", "x64"]);

export function verifyRunnerArchitecture({
  actualArchitecture,
  actualPlatform,
  expectedArchitecture,
  expectedPlatform,
}) {
  if (!allowedPlatforms.has(expectedPlatform)) {
    throw new Error(`Unsupported expected platform: ${expectedPlatform}`);
  }
  if (!allowedArchitectures.has(expectedArchitecture)) {
    throw new Error(
      `Unsupported expected architecture: ${expectedArchitecture}`,
    );
  }
  const expected = `${expectedPlatform}-${expectedArchitecture}`;
  const actual = `${actualPlatform}-${actualArchitecture}`;
  if (actual !== expected) {
    throw new Error(
      `Runner architecture mismatch: expected ${expected}, received ${actual}.`,
    );
  }
  return actual;
}

function main() {
  const [expectedPlatform, expectedArchitecture] = process.argv.slice(2);
  const actual = verifyRunnerArchitecture({
    actualArchitecture: process.arch,
    actualPlatform: process.platform,
    expectedArchitecture,
    expectedPlatform,
  });
  console.log(`Runner architecture verified: ${actual}.`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  main();
}
