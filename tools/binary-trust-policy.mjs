import { spawnSync } from "node:child_process";

export function verifyBinaryTrustPolicy(
  binary,
  { platform = process.platform, spawn = spawnSync } = {},
) {
  if (platform === "win32") {
    const result = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-AuthenticodeSignature -LiteralPath $env:CDKX_BINARY_TRUST_PATH).Status.ToString()",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CDKX_BINARY_TRUST_PATH: binary },
      },
    );
    expectCommandSuccess("Get-AuthenticodeSignature", result);
    const status = result.stdout.trim();
    if (status !== "NotSigned") {
      throw new Error(
        `Windows binary trust policy requires NotSigned, received ${status || "no status"}.`,
      );
    }
    return "Binary trust policy passed: Windows artifact is intentionally unsigned.";
  }

  if (platform === "darwin") {
    const verification = spawn(
      "codesign",
      ["--verify", "--strict", "--verbose=2", binary],
      { encoding: "utf8" },
    );
    expectCommandSuccess("codesign verification", verification);

    const metadata = spawn("codesign", ["--display", "--verbose=4", binary], {
      encoding: "utf8",
    });
    expectCommandSuccess("codesign metadata inspection", metadata);
    const details = `${metadata.stdout}\n${metadata.stderr}`;
    if (!/(?:^|\r?\n)Signature=adhoc(?:\r?\n|$)/.test(details)) {
      throw new Error(
        "macOS binary trust policy requires an ad-hoc signature and forbids an unreviewed Developer ID identity.",
      );
    }
    return "Binary trust policy passed: macOS artifact is ad-hoc signed and is not Developer ID signed or notarized.";
  }

  return "Binary trust policy passed: Linux artifact relies on SHA-256 release checksums.";
}

function expectCommandSuccess(name, result) {
  if (result.status !== 0) {
    throw new Error(
      `${name} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
    );
  }
}
