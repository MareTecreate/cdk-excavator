# Security Policy

## Supported versions

Security fixes are provided for the latest published minor version. Until the first public release is published, the current `main` release candidate is the only supported line.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, exposed credential, or output containing real AWS environment details. Use GitHub's private **Report a vulnerability** security-advisory form for this repository.

Include the affected version, operating system, command, minimal reproduction, impact, and whether real AWS identifiers or credentials were exposed. Remove or mask account IDs, ARNs, access keys, secrets, resource names, tags, and policies.

## Security boundaries

- cdk-excavator uses the standard AWS SDK credential chain and has no custom credential store.
- Runtime AWS operations are restricted to documented `List`, `Get`, and `Describe` APIs.
- The tool does not run `cdk deploy`, `cdk import`, or any AWS write operation.
- Generated files can contain sensitive infrastructure metadata and must be protected like AWS CLI output.
- Standalone binaries are accompanied by SHA-256 checksums. Verify the checksum before execution.

If a report shows that an AWS credential was exposed, revoke or rotate it through your normal AWS incident process before contacting the maintainers.
