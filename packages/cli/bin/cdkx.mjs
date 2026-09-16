#!/usr/bin/env node
import("../dist/cli.js")
  .then(async ({ runCdkx }) => {
    const result = await runCdkx(process.argv.slice(2));

    if (result.stdout) {
      console.log(result.stdout);
    }

    if (result.stderr) {
      console.error(result.stderr);
    }

    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
