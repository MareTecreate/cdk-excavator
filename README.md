# cdk-excavator

[English](README.en.md)

既存AWS環境を読み取り専用で調査し、選択した範囲のAWS CDK下書きとギャップレポートを生成するCLIです。コマンド名は `cdkx` です。

> 生成物はレビュー前提です。このツールはdeploy/importやAWS設定変更を実行しません。既存構成を完全に再現する保証はなく、秘密値、置換リスク、状態を持つリソース、すべての `TODO(GAP-n)` を人が確認する必要があります。

## インストール

以下はnpm公開後の手順です。公開前は「ソースから実行」を利用できます。

Node.jsの実行時対応範囲は `^20.17.0 || ^22.13.0 || >=23.5.0` です。通常はサポート中のLTSを利用してください。

```bash
npm install --global cdk-excavator
cdkx --version
```

インストールせずに実行する場合:

```bash
npx --package cdk-excavator cdkx --help --lang ja
```

**npmの `cdkx` は別製品です。`npx cdkx` は使わず、必ず `npx --package cdk-excavator cdkx` を指定してください。**

### ソースから実行

Node.js 22.13以上とpnpm 11.7.0を用意し、このフォルダで実行します。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec cdkx --help --lang ja
```

以降の `cdkx` を `pnpm exec cdkx` に置き換えて利用できます。

## AWS認証と安全性

AWS SDK標準認証チェーンを使います。既存のAWS CLI profile、環境変数、SSO等を利用でき、profileを選ぶ場合は `scan --profile <name>` を指定します。独自のアクセスキー入力・保存機能やtelemetryはありません。

`iam-policy` で読み取り権限の候補を確認できます。追加リソース型のサービス固有権限やread対応まで保証するものではありません。

```bash
cdkx iam-policy --stage all --format json --lang ja
```

`inventory.json`、生成コード、レポート、verboseログにはアカウントID、ARN、リソース名、タグ、ポリシー等が含まれ得ます。AWS CLI出力と同じ機密性で扱い、公開・共有前にマスキングしてください。脆弱性は公開Issueに書かず、[SECURITY.md](SECURITY.md)に従って報告してください。

## クイックスタート

次の各コマンドを順番に実行します。`scan` だけが実AWSへ読み取り接続します。

```bash
mkdir cdkx-work
cdkx doctor --region ap-northeast-1 --output-dir cdkx-work --lang ja
cdkx scan --region ap-northeast-1 --output cdkx-work/inventory.json --lang ja
cdkx scope --inventory cdkx-work/inventory.json --mode all --output cdkx-work/scope.json --lang ja
cdkx normalize --inventory cdkx-work/inventory.json --scope cdkx-work/scope.json --model-output cdkx-work/model.json --gaps-output cdkx-work/gaps.json --lang ja
cdkx plan --model cdkx-work/model.json --gaps cdkx-work/gaps.json --format table --lang ja
cdkx generate --model cdkx-work/model.json --gaps cdkx-work/gaps.json --outdir cdkx-work/cdk.out --stack-name ExcavatedStack --language typescript --lang ja
cdkx report --model cdkx-work/model.json --gaps cdkx-work/gaps.json --import-review cdkx-work/cdk.out/cdk-import-review.json --outdir cdkx-work/reports --lang ja --lang en
```

終了コードは `0` が成功、`1` が成果物を伴う部分成功、`2` が失敗です。`1` の場合は収集エラーやGAPを確認してください。上記を `&&` で一括実行すると部分成功でも停止します。

## 必要な範囲だけ選ぶ

全量を生成したくない場合は、上記の `scope` を目的の選択に置き換えます。ID・タグは対象環境の値へ変更してください。

```bash
cdkx scope --inventory cdkx-work/inventory.json --mode vpc --vpc-id vpc-0123456789abcdef0 --output cdkx-work/scope.json
cdkx scope --inventory cdkx-work/inventory.json --mode tag --tag App=my-app --with-deps --output cdkx-work/scope.json
cdkx scope --inventory cdkx-work/inventory.json --mode seed --resource-id vpc-0123456789abcdef0 --depth 2 --output cdkx-work/scope.json
```

- seedは参照先の依存方向だけを辿ります。逆方向の参照は自動追加しません。`--depth 0` は起点だけです。
- `--region` で選択の起点を絞れます。タグ選択で依存先も必要な場合だけ `--with-deps` を使います。
- `interactive` はローカルinventoryから対話選択し、境界リソースを既存参照として残す確認を行います。詳細は `cdkx interactive --help` を参照してください。
- 取得自体は `scan --resource-type` / `--exclude-resource-type`、`--all-regions`、`--global-services include|exclude|only` で調整できます。Listener取得では親LoadBalancerの識別子も必要です。
- 非対話コマンドのJSON要約は `--query` (JMESPath) で絞れます。元のinventoryや生成ファイルを書き換える指定ではありません。

## 出力と対応範囲

TypeScript / PythonのCDK下書き、`gaps.json`、日英Markdown、外部通信不要の単一HTMLレポートを生成します。Pythonプロジェクトの検証にはPython 3.10以上が別途必要です。

既定のscanはVPC関連、EC2、RDS、ALB、IAM、S3の21型を対象とし、同梱schemaは22型です。全AWSサービス・プロパティの網羅性やimport成功を保証しません。必要な型のschemaは `cdkx schemas` で取得できます（`DescribeType` による読み取り接続）。各コマンドの詳細は `cdkx <command> --help` を参照してください。

- `scope.json` に対象・選択理由・依存関係・境界、`model.json` と `gaps.json` に正規化結果と未対応／除外理由を記録します。coverageは完全再現率ではありません。
- アカウント・リージョン、VPC内／リージョン／グローバルの配置とリソース数に応じてスタックを分割します。S3はリージョン、IAMはグローバルとして扱い、AZは配置情報として保持します。
- `stack-plan.json` で分割と参照処理を確認できます。複数スタックの場合、templateやimport資料は各 `stacks/<name>/` 配下に出力します。
- 境界リソース、環境間参照、循環や曖昧な参照はレビュー対象として残します。接続や権限を完全に自動推測するものではありません。
- CloudFormation管理済みリソースは既定で生成対象外です。`--include-managed` は確認目的でのみ使用してください。AWS所有のIAM管理ポリシーは既存ARN参照のまま扱います。
- 既知のconverter非対応は汎用L1へのfallbackと理由を `converter-fallbacks.json` に記録し、終了コード `1` にします。未知の内部エラーは停止します。
- 生成コードはRetainを設定しますが、それだけで安全な移行を保証しません。`cdk-import-review.json`、`cdk-import-map.json`、`IMPORT.md` を確認し、差分・置換・秘密値・移植性をレビューしてから人がCDKを操作してください。S3オブジェクトのコピーは行いません。

## standalone binary

GitHub Releasesで配布する場合の対象はWindows x64、Linux x64、macOS arm64/x64です。v0.1.0のWindows版は未署名、macOS版はad-hoc署名のみでnotarizationなしです。OSの署名・実行ポリシーに適合しない場合は利用を控え、組織の方針に従ってください。

同じReleaseのassetと `SHA256SUMS` を取得し、実行前に検証します。Linuxは `sha256sum --check SHA256SUMS`、macOSは `shasum -a 256 -c SHA256SUMS`。Windowsでは `Get-FileHash .\cdkx-windows-x64.exe -Algorithm SHA256` の値を照合してください。checksumやnpm provenanceはOSコード署名の代替ではありません。

使用中のOS/CPU向けにビルドする場合は、Node.js 22.23.2とpnpm 11.7.0で `pnpm install --frozen-lockfile`、`pnpm binary:build`、`pnpm binary:verify` を順に実行します。WindowsはWindows SDKの `signtool.exe` とPowerShell 7 (`pwsh`)、macOSは `codesign` も必要です。出力先は `release/` 配下で、ビルド時に表示されます。npm用ビルドは `pnpm build`、続いて `pnpm package:verify` で確認できます。これらの配布確認は架空入力を使い、AWS APIを呼びません。

## ライセンス

[Apache-2.0](LICENSE)。[第三者ライセンス](THIRD_PARTY_NOTICES.txt)、[同梱schemaの出典・ライセンス](packages/core/src/defaults/schemas/UPSTREAM.md)を参照してください。standalone binaryには[Node.jsライセンス](NODE_LICENSE.txt)も適用されます。
