import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBinaryTrustPolicy } from "./binary-trust-policy.mjs";
import { verifyCli } from "./verify-distribution.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = process.platform === "win32" ? ".exe" : "";
const binary = resolve(
  root,
  process.argv[2] ??
    join("release", `cdkx-${process.platform}-${process.arch}${suffix}`),
);
console.log(verifyBinaryTrustPolicy(binary));
await verifyCli(binary);
console.log("Standalone distribution verification passed.");
