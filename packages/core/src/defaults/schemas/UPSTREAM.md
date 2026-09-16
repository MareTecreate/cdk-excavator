# Schema Sources

`supporting-resources.json` is a structural subset of twelve resource provider schemas from the AWS-maintained [resource-provider-enhanced-schemas](https://github.com/aws-cloudformation/resource-provider-enhanced-schemas) project (MIT-0).

- Retrieved: 2026-09-13.
- Archive: `https://github.com/aws-cloudformation/resource-provider-enhanced-schemas/releases/download/latest/schemas-standard.zip`.
- Verified archive SHA-256: `40fd18d258306aa2b17ff30a7ae3ade66dd75b22cfe936996836054aba03d187`.
- License reference: repository commit `59af154985a278f3a3456317039911d1a4cac8cb`, `LICENSE` (MIT No Attribution).
- Transformation: retain type/shape, local definitions, identifiers, required, read-only, write-only, and create-only paths; omit prose, examples, defaults, and handler permissions. Runtime code never fetches or executes these schemas.
- These are offline type projections, not proof of resource availability in every AWS region or of successful resource import.

`network-connections.json` contains curated writable-property projections from the linked official CloudFormation template references. It is not a complete Resource Provider Schema; import identifiers remain subject to review.

## MIT No Attribution

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
