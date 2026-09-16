import { runCdkx } from "../packages/cli/dist/cli.js";

runCdkx(process.argv.slice(2))
  .then((result) => {
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
