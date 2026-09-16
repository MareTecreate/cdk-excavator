import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "packages", "cli", "dist");

await rm(outputDirectory, { force: true, recursive: true });
await build({
  bundle: true,
  entryPoints: [join(root, "packages", "cli", "src", "cli.ts")],
  external: [
    "@aws-sdk/client-cloudcontrol",
    "@aws-sdk/client-cloudformation",
    "@aws-sdk/client-ec2",
    "@aws-sdk/credential-provider-ini",
    "@inquirer/prompts",
    "aws-cdk-lib",
    "aws-cdk-lib/*",
    "cdk-from-cfn",
    "constructs",
    "jmespath",
    "zod",
  ],
  format: "esm",
  logLevel: "warning",
  outfile: join(outputDirectory, "cli.js"),
  platform: "node",
  plugins: [workspacePackageSources()],
  sourcemap: false,
  target: "node20",
});

function workspacePackageSources() {
  const sources = new Map([
    ["@cdk-excavator/core", join(root, "packages", "core", "src", "index.ts")],
    ["@cdk-excavator/i18n", join(root, "packages", "i18n", "src", "index.ts")],
  ]);

  return {
    name: "workspace-package-sources",
    setup(context) {
      context.onResolve(
        { filter: /^@cdk-excavator\/(?:core|i18n)$/ },
        (args) => ({ path: sources.get(args.path) }),
      );
    },
  };
}
