# cdk-excavator

`cdk-excavator` is a review-first, read-only CLI that inventories existing AWS resources and produces AWS CDK drafts plus explicit gap reports. The installed command is `cdkx`.

Node.js compatibility: `^20.17.0 || ^22.13.0 || >=23.5.0`. Use a maintained LTS release (22.13+ in the 22 series, or 24+).

```bash
npx --package cdk-excavator cdkx --help --lang en
npx --package cdk-excavator cdkx iam-policy --format json --lang en
```

> [!WARNING]
> The npm package name `cdkx` belongs to another project. Do not run `npx cdkx`; always use `npx --package cdk-excavator cdkx`.

It uses the standard AWS SDK credential chain and does not accept, store, or transmit access keys. AWS access is limited to documented `List`, `Get`, and `Describe` operations. Generated code is a draft; review every `TODO(GAP-n)`, import mapping, replacement risk, and stateful resource before running any CDK write operation manually.

Japanese and complete usage documentation is available in the [GitHub repository](https://github.com/MareTecreate/cdk-excavator).

## 日本語

`cdk-excavator` は、既存AWS環境を読み取り専用で調査し、レビュー前提のAWS CDK下書きとギャップレポートを作るCLIです。インストールされるコマンドは `cdkx` です。

Node.jsの対応範囲は `^20.17.0 || ^22.13.0 || >=23.5.0`。通常はサポート中のLTSを使用してください。

> [!WARNING]
> npmの `cdkx` パッケージ名は別製品が使用しています。`npx cdkx` を実行せず、必ず `npx --package cdk-excavator cdkx` を使ってください。

AWS SDK標準認証チェーンを使い、アクセスキーを独自に受け付け・保存・送信しません。生成コードを適用する前に、すべての `TODO(GAP-n)`、import mapping、置換リスク、状態を持つリソースを確認してください。

## License

Apache-2.0
