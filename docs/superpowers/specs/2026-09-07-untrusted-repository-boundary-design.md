# 敵対的リポジトリ境界の強化設計

## 目的

`scan` と `diff` の対象リポジトリ、そのファイル名、設定ファイル、Git ref を敵対的入力として扱う。対象リポジトリを読むだけの操作が、実行者の明示許可なしに外部プロセス起動、秘密情報の受け渡し、外部 LLM 送信、GitHub workflow command 実行を引き起こさないようにする。

## 信頼境界

- `r3-doctor.config.json` は対象リポジトリ所有の非信頼入力であり、宣言的なローカル解析範囲だけを設定する。
- LLM の有効化、provider、model、実行ファイル、送信 scope、ファイル数、prompt byte 数は実行者所有の execution policy とする。
- execution policy は CLI の明示フラグからのみ生成し、既定は LLM 無効とする。
- provider 子プロセスへ渡す環境変数 allowlist は維持するが、非信頼設定から任意コマンドを選べないことを第一防御とする。
- GitHub Actions では PR checkout 後の全コードを非信頼とみなし、書込権限、永続化した checkout credential、repository secret を持たせない。

## LLM execution policy

対象設定 schema から `llm` を削除し、含まれていれば strict schema error にする。`scan` と `diff` は `--llm-provider` が指定された場合だけ LLM を有効化する。追加の operator-owned flags は `--llm-model`、`--llm-executable`、`--llm-send-scope`、`--llm-max-files`、`--llm-max-prompt-bytes` とする。

`--llm-provider` がない通常実行では、追加 LLM flag を拒否する。ただし `--dry-run-semantic` は外部実行を行わないため、provider なしで scope と上限の指定を許可する。provider alias は従来どおり `openai -> codex`、`anthropic -> claude` を許可する。

有効設定は `createRepositorySnapshot` の operator 引数として注入し、snapshot の effective config と input/context fingerprint に含める。これにより既存の assessment、baseline compatibility、semantic provider API を保ちながら、値の出所だけを信頼境界の外へ移す。

## 出力境界

GitHub annotation の message は `%`、CR、LFを、property はさらに `:`、`,` を percent escape する。GitHub Summary の非信頼文字列は単一行へ正規化し、Markdown 制御文字と HTML delimiter を escape する。

永続化・CLI・GitHub 出力の `metadata.repositoryPath` は、policy の `redactPaths` が空でも固定値 `[REPOSITORY]` にする。解析内部の絶対 path は変更しない。baseline directory は Git ignore 対象にする。

## 入力境界

glob は正規表現へ直接展開せず、`*`、`**`、`?` だけを認識する memoized matcher で評価する。設定値の文字列長・配列数・数値には有限上限を設ける。

Git ref は `git rev-parse --verify --end-of-options <ref>^{commit}` で解決し、結果が完全な object ID であることを検証する。workflow の `github.base_ref` は inline shell script へ展開せず environment variable 経由で引用する。

## CI

advisory job は `contents: read` のみ、`persist-credentials: false`、10分 timeout とする。PR コードの build 自体は ephemeral runner 上の通常 CI として許容するが、その後のプロセスが利用できる書込 token と secret を配置しない。

## 検証

- repo config の `llm` が拒否され、marker executable が起動しない統合テスト
- operator policy を注入した場合だけ fake ACP provider が起動するテスト
- CLI flag の組合せ、alias、上限のテスト
- annotation 改行 command injection と Summary Markdown injection の回帰テスト
- regex meta と長い adversarial glob を線形時間で処理するテスト
- Git ref の leading dash 拒否と object ID 検証テスト
- repository path の既定匿名化と baseline 保存テスト
- `npm run validate`

