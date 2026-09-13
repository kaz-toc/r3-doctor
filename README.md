# r3-doctor

**Regression Risk Recovery Doctor** — コードベースのデグレリスクを診断し、回復まで見届ける CLI。

Regression Risk Score と根拠付きリスクマップで、次の変更で壊れやすい構造、関係するファイル群、想定原因、優先すべき打ち手を示します。

> 自動修正ツールではありません。診断 → 打ち手 → 再 scan で回復を確認します。

## 現在の状態

Phase 0–1 MVP（schema、決定論 scan、golden fixtures）と Phase 2–3 の部分実装（intervention、diff/baseline、GitHub advisory）が利用可能です。Phase 4–6 は CLI・スタブ・最小監査にとどまります。`r3-doctor scan` / `diff` / `baseline` / `trend` / `policy` / `calibration` / `plugins` コマンドは read-only 診断として動作します。

- **TypeScript / JavaScript** — 主要対象言語
- **Python / Go** — experimental stub（large-file 等の限定シグナルのみ）
- **LLM semantic 軸** — ACP provider（copilot / cursor / codex / claude）接続済み。`r3-doctor llm list` で一覧、`llm inspect` で単体確認

最初の公開リリース境界（Phase 0 + Phase 1）は満たしています。

## Quick start

```bash
# Interactive setup wizard (TTY)
r3-doctor setup .

# Non-interactive
r3-doctor check .
r3-doctor setup . --yes --locale en
r3-doctor scan . --format json
```

Optional flags: `--scan`, `--save-baseline` (requires `--scan`), `--profile` for operator LLM defaults (`~/.config/r3-doctor/profile.json`).

Agent-friendly JSON:

```bash
r3-doctor check . --json --locale en
r3-doctor setup . --yes --dry-run --json --locale en
```

`setup` writes repository config only (no LLM execution policy — see ADR 0003). Operator LLM defaults belong in `~/.config/r3-doctor/profile.json` (ADR 0005).

## Installation

Node.js 22 以降が必要です。リポジトリ clone なしで CLI を実行できます。

```bash
npx r3-doctor scan . --format json
npx r3-doctor@0.2.0 scan . --format markdown
```

npm パッケージにはコンパイル済み `dist/` と、実行時の calibration に必要な golden fixtures が含まれます。TypeScript ソースコードとテストコードは private GitHub リポジトリで管理しています。

## 目指す診断

- リポジトリ全体と評価軸ごとの Regression Risk Score
- デグレしやすい構造と関連ファイルをまとめたリスククラスター
- 想定されるトリガー変更とデグレ発生メカニズム
- コード、依存関係、テスト、変更履歴に結び付いた根拠
- 優先順位、期待効果、確認方法を伴う打ち手
- ベースラインからのリスク差分と診断の確信度

## 対象外

- 現在存在するすべてのバグの検出
- 将来の障害発生確率の保証
- テスト、型検査、静的解析、コードレビューの代替
- 根拠のない LLM 採点や自動リファクタリング

## 初期リリース方針

Node.js 22 以降で動作する TypeScript 製 CLI とし、最初は TypeScript / JavaScript リポジトリの read-only snapshot 診断に限定します。言語固有解析と LLM プロバイダーは adapter として分離し、評価契約を保ったまま段階的に対象を拡張します。

想定する操作例:

```bash
r3-doctor scan . --format markdown
r3-doctor diff . --base origin/main --format json
r3-doctor scan . --locale ja --format markdown
r3-doctor llm list --format json
r3-doctor llm list --inspect --provider codex
r3-doctor llm inspect --provider codex
r3-doctor scan . --llm-provider codex --llm-send-scope cluster-context
r3-doctor scan . --dry-run-semantic --llm-send-scope changed
```

`r3-doctor.config.json` でレポート narrative の locale を設定できます（既定 `en`）:

```json
{
  "schemaVersion": 1,
  "locale": "ja"
}
```

`locale: ja` では disclaimer・mechanism・evidence.message・intervention が日本語になります。Regression Risk Score / Confidence / Calibration などのメトリクスラベルとセクション見出しは英語固定です。CLI の `--locale ja` は config を上書きします。

## Shadow score validation

通常の v4 score と CI gate を変更せず、将来の outcome を使って4つの shadow candidate を比較できます。これは障害発生確率ではなく、候補式の prospective validation です。

```bash
r3-doctor scan . --record-validation
r3-doctor validation status .
r3-doctor validation outcome . --sample <id> --outcome no-regression
npm run validate
r3-doctor calibration compare . --repository-validation-passed
```

`no-regression` は sample の dueAt 以降でのみ記録できます。明示フラグのない scan は validation artifact を作成しません。詳細は [Shadow Score Validation](docs/spec/shadow-score-validation.md) を参照してください。

## LLM integration smoke test（開発者向け、課金あり）

codex-acp で `semantic-ambiguity` が evaluated になることを確認します。

```bash
npm run build
npm install -g @agentclientprotocol/codex-acp
R3_DOCTOR_LLM_INTEGRATION=1 OPENAI_API_KEY=... npm run smoke:llm-integration
```

CI では Actions → **LLM integration** を手動実行。repository variable `R3_DOCTOR_LLM_INTEGRATION=1` と secret `OPENAI_API_KEY` が必要。

LLM の起動と外部送信は解析対象の `r3-doctor.config.json` では設定できません。実行者が `scan` / `diff` の `--llm-provider` を指定したときだけ有効になります。model、実行ファイル、送信 scope、上限も `--llm-model`、`--llm-executable`、`--llm-send-scope`、`--llm-max-files`、`--llm-max-prompt-bytes` で指定します。対象リポジトリは信頼できない入力として扱われます。

`--llm-executable` は絶対パスまたは bare command name のみを受け付けます。相対パスと解析対象内を指す絶対パスは拒否し、bare command の探索では対象リポジトリ配下および相対 `PATH` entry を除外します。

エイリアス: `openai` → `codex`, `anthropic` → `claude`.

## Regression Risk Score の読み方

Regression Risk Score は障害発生確率ではなく、同一 assessment contract 内の相対順位と時系列比較に使う指標です。レポートの `repository.calibration.status` は outcome data に基づく解釈状態を示し、score 値そのものを実行時に書き換えません。

| status | 意味 |
|---|---|
| `uncalibrated` | calibration dataset がない。同一 contract 内の相対順位のみに使用可能。 |
| `provisional` | outcome sample または品質条件が不足。`missingConditions` に不足理由を記録。 |
| `validated` | 記録された dataset 条件（各 score band 30 samples 以上、false positive/miss rate、ranking quality、explanation usefulness、golden regression pass、team policy 条件）をすべて満たす。この条件内でのみ score の解釈に利用可能。 |

CI gate は既存どおり calibration eligibility（`policy --evaluate` の `gateEligible`）を満たすまで advisory のまま抑止されます。`gateEnabled` を有効化しても、calibration dataset が validated 条件を満たさない場合は gate は動作しません。

## プロジェクト文書

- [PROJECT.md](PROJECT.md) — プロダクトの目的、ユーザー、成果
- [ROADMAP.md](ROADMAP.md) — フェーズ、成果物、完了条件
- [ARCHITECTURE.md](ARCHITECTURE.md) — 境界、所有権、依存方向
- [CONTEXT.md](CONTEXT.md) — 正規用語
- [CONTRIBUTING.md](CONTRIBUTING.md) — 変更ワークフロー
- [AGENTS.md](AGENTS.md) — コーディングエージェントの作業規律

## 開発要件

- Node.js 22 以降
- 現時点のガバナンスハーネスにサードパーティ依存はありません

## 検証

```bash
npm run validate
```

| コマンド | 用途 |
|---|---|
| `npm run harness:test` | ガバナンスハーネスのテスト |
| `npm run harness:validate` | リポジトリポリシーの検証 |
| `npm run harness:report` | read-only 構造レポート |
| `npm run smoke:llm-integration` | codex-acp 実 CLI smoke test（`R3_DOCTOR_LLM_INTEGRATION=1` 必須） |

## 配布

- **npm**: `npx r3-doctor` — public npm にコンパイル済み CLI を公開（ソースは非公開）
- **GitHub**: [kaz-toc/r3-doctor](https://github.com/kaz-toc/r3-doctor) — private ソースリポジトリ
- **リリース手順**: [docs/operations/RELEASE.md](docs/operations/RELEASE.md)
- **変更履歴**: [CHANGELOG.md](CHANGELOG.md)

初回 publish 後の CI 再公開は Actions → **npm publish**（`NPM_TOKEN` secret 必須）を手動実行します。
