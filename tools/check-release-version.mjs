import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = await Promise.all(
  [
    "package.json",
    "packages/cli/package.json",
    "packages/core/package.json",
    "packages/i18n/package.json",
  ].map(async (path) => ({
    path,
    value: JSON.parse(await readFile(join(root, path), "utf8")),
  })),
);
const versions = new Set(manifests.map((manifest) => manifest.value.version));

if (versions.size !== 1) {
  throw new Error(
    `Package versions differ: ${manifests.map(({ path, value }) => `${path}=${value.version}`).join(", ")}`,
  );
}

const version = manifests[0]?.value.version;
const cliSource = await readFile(
  join(root, "packages", "cli", "src", "cli.ts"),
  "utf8",
);
if (!cliSource.includes(`CLI_VERSION = "${version}"`)) {
  throw new Error(`CLI_VERSION does not match package version ${version}.`);
}

const requestedTags = [];
if (process.argv[2] !== undefined) requestedTags.push(process.argv[2]);
if (process.env["GITHUB_REF_TYPE"] === "tag") {
  const triggerTag = process.env["GITHUB_REF_NAME"];
  if (!triggerTag)
    throw new Error("The triggering release tag name is missing.");
  requestedTags.push(triggerTag);
}
for (const requestedTag of requestedTags) {
  if (requestedTag !== `v${version}`) {
    throw new Error(`Release tag ${requestedTag} does not match v${version}.`);
  }
}

if (manifests[1]?.value.name !== "cdk-excavator") {
  throw new Error("CLI package must be named cdk-excavator.");
}

console.log(
  requestedTags.length > 0
    ? `Release version ${version} matches ${[...new Set(requestedTags)].join(", ")}.`
    : `Release metadata ${version} is consistent (no release tag requested).`,
);
