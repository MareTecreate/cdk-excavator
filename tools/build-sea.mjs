import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import postject from "postject";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, readOutputArgument(process.argv.slice(2)));
const workDirectory = resolve(
  root,
  "release",
  `.sea-${process.platform}-${process.arch}`,
);
const bundlePath = join(workDirectory, "cdkx.cjs");
const blobPath = join(workDirectory, "cdkx.blob");
const configPath = join(workDirectory, "sea-config.json");

assertInsideRoot(output);
assertInsideRoot(workDirectory);
await rm(workDirectory, { force: true, recursive: true });
await mkdir(workDirectory, { recursive: true });
await mkdir(dirname(output), { recursive: true });

await build({
  bundle: true,
  entryPoints: [join(root, "tools", "sea-entry.mjs")],
  format: "cjs",
  logLevel: "warning",
  outfile: bundlePath,
  platform: "node",
  plugins: [embedCdkFromCfnWasm()],
  sourcemap: false,
  target: `node${process.versions.node.split(".")[0]}`,
});

await writeFile(
  configPath,
  `${JSON.stringify(
    {
      disableExperimentalSEAWarning: true,
      main: bundlePath,
      output: blobPath,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

run(process.execPath, ["--experimental-sea-config", configPath]);
await copyFile(process.execPath, output);

if (process.platform === "win32") {
  const signTool = await findWindowsSignTool();
  run(signTool, ["remove", "/s", output]);
  console.log("Removed the inherited Node.js Authenticode signature.");
} else if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", output], true);
}

await postject.inject(output, "NODE_SEA_BLOB", await readFile(blobPath), {
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", output]);
}

if (process.platform !== "win32") {
  await chmod(output, 0o755);
}

await rm(workDirectory, { force: true, recursive: true });
console.log(`Built ${output}`);

function embedCdkFromCfnWasm() {
  const requireFromCore = createRequire(
    pathToFileURL(join(root, "packages", "core", "package.json")),
  );
  const modulePath = requireFromCore.resolve("cdk-from-cfn");

  return {
    name: "embed-cdk-from-cfn-wasm",
    setup(context) {
      context.onResolve({ filter: /^cdk-from-cfn$/ }, () => ({
        namespace: "cdk-from-cfn-embedded",
        path: modulePath,
      }));
      context.onLoad(
        { filter: /.*/, namespace: "cdk-from-cfn-embedded" },
        async () => {
          const source = await readFile(modulePath, "utf8");
          const wasm = await readFile(
            join(dirname(modulePath), "index_bg.wasm"),
          );
          const replacement = `const wasmBytes = Buffer.from('${wasm.toString("base64")}', 'base64');`;
          const contents = source.replace(
            /const wasmPath = `\$\{__dirname\}\/index_bg\.wasm`;\r?\nconst wasmBytes = require\('fs'\)\.readFileSync\(wasmPath\);/,
            replacement,
          );

          if (contents === source) {
            throw new Error("Unable to embed cdk-from-cfn WASM payload.");
          }

          return {
            contents,
            loader: "js",
            resolveDir: dirname(modulePath),
          };
        },
      );
    },
  };
}

function readOutputArgument(args) {
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    const suffix = process.platform === "win32" ? ".exe" : "";
    return join("release", `cdkx-${process.platform}-${process.arch}${suffix}`);
  }
  return value;
}

function assertInsideRoot(path) {
  const relative = path.slice(root.length);
  if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) {
    throw new Error(`Build path must stay inside the repository: ${path}`);
  }
  if (!relative) {
    throw new Error("Build path must not be the repository root.");
  }
}

async function findWindowsSignTool() {
  const architecture =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "ia32"
        ? "x86"
        : "x64";
  const candidates = [];

  for (const directory of [
    process.env.WindowsSdkVerBinPath,
    process.env.WindowsSdkBinPath,
  ]) {
    if (directory) {
      candidates.push(join(directory, architecture, "signtool.exe"));
      candidates.push(join(directory, "signtool.exe"));
    }
  }

  const programFiles = process.env["ProgramFiles(x86)"];
  if (programFiles) {
    const sdkBin = join(programFiles, "Windows Kits", "10", "bin");
    try {
      const versions = (await readdir(sdkBin, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) =>
          right.localeCompare(left, "en", { numeric: true }),
        );
      for (const version of versions) {
        candidates.push(join(sdkBin, version, architecture, "signtool.exe"));
      }
    } catch {
      // The actionable error below covers a missing Windows SDK.
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the known Windows SDK locations.
    }
  }

  throw new Error(
    "Windows standalone builds require signtool.exe from the Windows 10/11 SDK so the inherited Node.js signature can be removed before SEA injection.",
  );
}

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
    );
  }
}
