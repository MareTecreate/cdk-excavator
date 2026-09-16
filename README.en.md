# cdk-excavator

[日本語](README.md)

A read-only CLI that inventories existing AWS resources and generates review-first AWS CDK drafts and gap reports for the scope you select. The command is `cdkx`.

> This tool never deploys, imports or changes AWS settings. Generated projects are drafts, not a guarantee of faithful reconstruction or safe migration. Review every `TODO(GAP-n)`, secret, replacement risk and stateful resource before operating CDK manually.

## Install

These npm commands apply after publication. Before publication, use the source instructions below.

Runtime Node.js support: `^20.17.0 || ^22.13.0 || >=23.5.0`. Prefer a maintained LTS release.

```bash
npm install --global cdk-excavator
cdkx --version
```

Or run without a global installation:

```bash
npx --package cdk-excavator cdkx --help --lang en
```

**The npm package `cdkx` belongs to another project. Do not run `npx cdkx`; use `npx --package cdk-excavator cdkx`.**

### Run from source

With Node.js 22.13+ and pnpm 11.7.0 installed, run in this directory:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec cdkx --help --lang en
```

Replace `cdkx` below with `pnpm exec cdkx` when using the source checkout.

## AWS credentials and safety

The standard AWS SDK credential chain supports existing AWS CLI profiles, environment variables and SSO. Select a profile with `scan --profile <name>`. There is no custom access-key input/store and no telemetry.

Inspect the read-only IAM policy candidate with:

```bash
cdkx iam-policy --stage all --format json --lang en
```

The policy is not a guarantee of service-specific permissions or read support for every additional resource type. Inventory, generated projects, reports and verbose logs can contain account IDs, ARNs, resource names, tags and policies. Protect them like AWS CLI output and redact before sharing. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Quick start

Run these commands in order. Only `scan` accesses AWS in this example.

```bash
mkdir cdkx-work
cdkx doctor --region ap-northeast-1 --output-dir cdkx-work --lang en
cdkx scan --region ap-northeast-1 --output cdkx-work/inventory.json --lang en
cdkx scope --inventory cdkx-work/inventory.json --mode all --output cdkx-work/scope.json --lang en
cdkx normalize --inventory cdkx-work/inventory.json --scope cdkx-work/scope.json --model-output cdkx-work/model.json --gaps-output cdkx-work/gaps.json --lang en
cdkx plan --model cdkx-work/model.json --gaps cdkx-work/gaps.json --format table --lang en
cdkx generate --model cdkx-work/model.json --gaps cdkx-work/gaps.json --outdir cdkx-work/cdk.out --stack-name ExcavatedStack --language typescript --lang en
cdkx report --model cdkx-work/model.json --gaps cdkx-work/gaps.json --import-review cdkx-work/cdk.out/cdk-import-review.json --outdir cdkx-work/reports --lang ja --lang en
```

Exit codes: `0` success, `1` partial success with output requiring review, `2` failure. Inspect collection errors or gaps after exit `1`; chaining the commands with `&&` stops on partial success.

## Select only what you need

Replace the `scope` command above with your preferred selection. Substitute your own inventory ID or tag.

```bash
cdkx scope --inventory cdkx-work/inventory.json --mode vpc --vpc-id vpc-0123456789abcdef0 --output cdkx-work/scope.json
cdkx scope --inventory cdkx-work/inventory.json --mode tag --tag App=my-app --with-deps --output cdkx-work/scope.json
cdkx scope --inventory cdkx-work/inventory.json --mode seed --resource-id vpc-0123456789abcdef0 --depth 2 --output cdkx-work/scope.json
```

- Seed selection follows outgoing references to dependencies, not reverse references. Depth `0` selects only the seed.
- Filter selection roots with `--region`; add `--with-deps` to tag selection only when referenced dependencies are wanted.
- `interactive` selects from a local inventory and confirms existing-reference handling for boundary resources. See `cdkx interactive --help`.
- Control collection with `scan --resource-type`, `--exclude-resource-type`, `--all-regions` and `--global-services include|exclude|only`. Listener discovery also needs parent LoadBalancer identifiers.
- `--query` filters non-interactive JSON summaries using JMESPath; it does not change stored inventory or generated files.

## Outputs and limits

Generate TypeScript or Python CDK drafts, `gaps.json`, Japanese/English Markdown and a self-contained offline HTML report. Validating a generated Python project additionally requires Python 3.10+.

The default scan covers 21 types across VPC networking, EC2, RDS, ALB, IAM and S3; bundled schemas cover 22 types. Coverage does not mean all AWS services/properties or successful import. Retrieve additional schemas with `cdkx schemas`, which makes read-only `DescribeType` calls. See `cdkx <command> --help` for options.

- `scope.json` records selections, reasons, relationships and boundaries; `model.json` and `gaps.json` record normalization and unsupported/excluded properties. Resource coverage is not reconstruction accuracy.
- Stacks are partitioned by observed account, region, VPC/regional/global placement and resource count. S3 is regional, IAM is global, and AZ placement is retained without forcing one stack per AZ.
- `stack-plan.json` explains partitions and references. Multiple-stack projects place templates and import materials under each `stacks/<name>/` directory.
- External, cross-environment, cyclic or ambiguous references remain review items. The tool does not infer every runtime connection or permission.
- CloudFormation-managed resources are excluded by default; use `--include-managed` only for review. AWS-owned IAM policies remain existing ARN references.
- Known converter incompatibilities fall back to generic L1 with reasons in `converter-fallbacks.json` and exit `1`; unknown internal errors stop generation.
- Retain settings do not guarantee a safe migration. Inspect `cdk-import-review.json`, `cdk-import-map.json` and `IMPORT.md`; review differences, replacements, secrets and portability before running CDK yourself. S3 object data is not copied.

## Standalone binaries

GitHub Release binary targets are Windows x64, Linux x64, macOS arm64 and macOS x64. v0.1.0 Windows binaries are unsigned; macOS binaries are ad-hoc signed and not notarized. Follow your organization's execution/signing policy; do not use a binary that does not satisfy it.

Download assets and `SHA256SUMS` from the same Release. Verify before execution using `sha256sum --check SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS. On Windows, compare `Get-FileHash .\cdkx-windows-x64.exe -Algorithm SHA256` with the checksum entry. Checksums and npm provenance do not replace OS code signing.

To build for your current OS/CPU, use Node.js 22.23.2 and pnpm 11.7.0, then run `pnpm install --frozen-lockfile`, `pnpm binary:build` and `pnpm binary:verify`. Windows also requires Windows SDK `signtool.exe` and PowerShell 7 (`pwsh`); macOS requires `codesign`. The build prints the output path under `release/`. Verify an npm source build with `pnpm build` followed by `pnpm package:verify`; these distribution checks use synthetic input without AWS API calls.

## License

[Apache-2.0](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt) and [bundled-schema provenance/licenses](packages/core/src/defaults/schemas/UPSTREAM.md). Standalone binaries also include the [Node.js license](NODE_LICENSE.txt).
