import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(root, "packages/cli/package.json"), "utf8"),
);
const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.txt",
  "bin/cdkx.mjs",
  "dist/cli.js",
  "package.json",
];

export async function verifyCli(command, prefix = []) {
  const temporary = await mkdtemp(join(tmpdir(), "cdkx-distribution-smoke-"));
  try {
    const cli = (args, allowed = [0]) =>
      run(command, [...prefix, ...args], temporary, allowed);
    assert.equal(cli(["--version"]).trim(), `cdkx ${manifest.version}`);
    for (const language of ["en", "ja"]) {
      assert(cli(["--help", "--lang", language]).includes("cdkx"));
    }
    assert.equal(cli(["invalid-distribution-command"], [2]).trim(), "");
    const policy = JSON.parse(
      cli(["iam-policy", "--format", "json", "--lang", "en"]),
    );
    assert(policy.Statement.length > 0);
    for (const statement of policy.Statement) {
      for (const action of statement.Action) {
        assert(
          /:(?:List|Get|Describe|BatchGet)[A-Za-z]+$/.test(action),
          `Non-read action: ${action}`,
        );
      }
    }

    const input = join(temporary, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        schemaVersion: "0.1.0",
        toolVersion: manifest.version,
        resources: [
          [
            "AWS::EC2::VPC",
            "vpc-00000000000000001",
            { CidrBlock: "10.0.0.0/16", EnableDnsSupport: true },
          ],
          [
            "AWS::S3::Bucket",
            "cdkx-offline-example",
            { BucketName: "cdkx-offline-example" },
          ],
        ].map(([resourceType, identifier, properties]) => ({
          resourceType,
          identifier,
          properties,
          accountId: "123456789012",
          region: "ap-northeast-1",
          tags: {},
          sourceApi: { service: "CloudControl", operation: "GetResource" },
          isCloudFormationManaged: false,
          errors: [],
        })),
      }),
    );
    const inventory = join(temporary, "inventory.json");
    const scope = join(temporary, "scope.json");
    const model = join(temporary, "model.json");
    const gaps = join(temporary, "gaps.json");
    cli([
      "scan",
      "--fixture",
      input,
      "--region",
      "ap-northeast-1",
      "--output",
      inventory,
      "--lang",
      "en",
    ]);
    cli([
      "scope",
      "--inventory",
      inventory,
      "--mode",
      "all",
      "--output",
      scope,
      "--lang",
      "en",
    ]);
    cli(
      [
        "normalize",
        "--inventory",
        inventory,
        "--scope",
        scope,
        "--model-output",
        model,
        "--gaps-output",
        gaps,
        "--lang",
        "en",
      ],
      [0, 1],
    );
    JSON.parse(
      cli(
        [
          "plan",
          "--model",
          model,
          "--gaps",
          gaps,
          "--format",
          "json",
          "--lang",
          "en",
        ],
        [0, 1],
      ),
    );
    for (const language of ["typescript", "python"]) {
      const generated = join(temporary, language);
      const repeated = join(temporary, `${language}-repeat`);
      for (const output of [generated, repeated]) {
        cli(
          [
            "generate",
            "--model",
            model,
            "--gaps",
            gaps,
            "--language",
            language,
            "--outdir",
            output,
            "--stack-name",
            "DistributionStack",
            "--lang",
            "en",
          ],
          [0, 1],
        );
      }
      const files = await fileHashes(generated);
      assert.deepEqual(
        files,
        await fileHashes(repeated),
        `${language} output must be deterministic`,
      );
      const templates = Object.keys(files).filter(
        (path) => basename(path) === "template.json",
      );
      assert(
        templates.length >= 2,
        "VPC and regional resources must remain separate",
      );
      const types = [];
      for (const path of templates) {
        const template = JSON.parse(
          await readFile(join(generated, path), "utf8"),
        );
        for (const resource of Object.values(template.Resources)) {
          types.push(resource.Type);
          assert.equal(resource.DeletionPolicy, "Retain");
        }
      }
      assert.deepEqual(types.sort(), ["AWS::EC2::VPC", "AWS::S3::Bucket"]);
      const reports = join(temporary, `${language}-reports`);
      cli(
        [
          "report",
          "--model",
          model,
          "--gaps",
          gaps,
          "--import-review",
          join(generated, "cdk-import-review.json"),
          "--outdir",
          reports,
          "--lang",
          "en",
          "--lang",
          "ja",
        ],
        [0, 1],
      );
      const html = await readFile(join(reports, "report.html"), "utf8");
      assert(/Content-Security-Policy/i.test(html));
      assert(!/<(?:script|iframe)\b/i.test(html));
      for (const locale of ["en", "ja"]) {
        assert(
          (await readFile(join(reports, `REPORT.${locale}.md`), "utf8"))
            .length > 0,
        );
      }
      console.log(
        `Distribution ${language}: deterministic VPC/S3 generation and offline report passed.`,
      );
    }
  } finally {
    await cleanup(temporary, "cdkx-distribution-smoke-");
  }
}

export async function verifyPackage() {
  const temporary = await mkdtemp(join(tmpdir(), "cdkx-distribution-package-"));
  try {
    run(
      "pnpm",
      ["--filter", "cdk-excavator", "pack", "--pack-destination", temporary],
      root,
    );
    const tarball = join(temporary, `cdk-excavator-${manifest.version}.tgz`);
    const files = run("tar", ["-tzf", tarball], temporary)
      .trim()
      .split(/\r?\n/)
      .filter((path) => !path.endsWith("/"))
      .map((path) => path.replace(/^package\//, ""))
      .sort();
    assert.deepEqual(
      files,
      expectedPackageFiles,
      "Unexpected npm package contents",
    );
    const consumer = join(temporary, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      '{"name":"cdkx-distribution-consumer","version":"0.0.0","private":true}\n',
    );
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      consumer,
    );
    const installed = join(consumer, "node_modules/cdk-excavator");
    for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
      assert(
        (await readFile(join(installed, file))).equals(
          await readFile(join(root, file)),
        ),
      );
    }
    assert(
      (await readFile(join(installed, "dist/cli.js"))).equals(
        await readFile(join(root, "packages/cli/dist/cli.js")),
      ),
    );
    assert.equal(
      run(
        "npm",
        ["exec", "--offline", "--", "cdkx", "--version"],
        consumer,
      ).trim(),
      `cdkx ${manifest.version}`,
    );
    await verifyCli(process.execPath, [join(installed, "bin/cdkx.mjs")]);
    console.log(
      `Distribution npm package ${manifest.version}: six files, isolated install and bin resolution passed.`,
    );
  } finally {
    await cleanup(temporary, "cdkx-distribution-package-");
  }
}

async function fileHashes(directory, path = "") {
  const result = {};
  for (const entry of (
    await readdir(join(directory, path), { withFileTypes: true })
  ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), "Unexpected generated symlink");
    if (entry.isDirectory())
      Object.assign(result, await fileHashes(directory, child));
    else
      result[child] = createHash("sha256")
        .update(await readFile(join(directory, child)))
        .digest("hex");
  }
  return result;
}

function run(command, args, cwd, allowed = [0]) {
  const windowsCommand =
    process.platform === "win32" && ["pnpm", "npm"].includes(command);
  const result = spawnSync(
    windowsCommand ? (process.env.ComSpec ?? "cmd.exe") : command,
    windowsCommand ? ["/d", "/s", "/c", `${command}.cmd`, ...args] : args,
    {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        NODE_PATH: "",
        AWS_EC2_METADATA_DISABLED: "true",
      },
    },
  );
  if (!allowed.includes(result.status))
    throw new Error(
      `Distribution check failed (${result.status}): ${result.stderr || result.stdout || result.error?.message}`,
    );
  return result.stdout;
}

async function cleanup(directory, prefix) {
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert(basename(directory).startsWith(prefix));
  assert.equal(await realpath(directory), directory);
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(process.argv.length, 2, "This verifier takes no arguments.");
  await verifyPackage();
}
