# プロジェクト

## プロダクト

**Regression Risk Recovery Doctor** — コードベースのデグレリスクを診断し、回復まで見届ける CLI。

決定論的なコード解析と LLM による意味解析を組み合わせ、Regression Risk Score と根拠付きリスクマップで、次の変更で壊れやすい構造と改善の優先順位を示します。自動修正は行わず、診断 → 打ち手 → 再 scan で回復を確認します。

## ユーザー

主要ユーザーは、AI コーディングエージェントによる大規模・反復的な変更を行うプロダクトオーナー、開発者、テックリード、レビュアです。

## 成果

ユーザーが不具合の発生前に、デグレリスクの高い構造とファイル群、想定される発生原因、根拠、優先すべき改善策を把握できる状態を作ります。総合スコアだけでなく、判断に使える説明と確信度を提供します。

## ランタイム

初期プロダクトは Node.js 22 以降で動作する TypeScript 製 CLI として計画します。解析コアは特定の言語、LLM プロバイダー、レポート形式から分離し、最初は TypeScript / JavaScript のリポジトリを対象にします。

## コマンド

- `npm run validate` — ガバナンス + 型検査 + テスト + ビルド
- `npm run build` — TypeScript ビルド
- `npm run test` — プロダクトテスト (vitest)
- `npm run r3-doctor -- scan <path> --format markdown` — リポジトリ診断
- `npm run r3-doctor -- diff <path> --base origin/main --format json` — 差分診断
- `npm run r3-doctor -- priorities <path>` — 改善投資の優先順位
- `npm run r3-doctor -- trend <path> --analyze` — スコア悪化の追跡
- `npm run harness:test` — ガバナンスハーネスのテスト
- `npm run harness:validate` — リポジトリポリシーの検証
- `npm run harness:report` — read-only 構造レポート

## ロードマップ

プロダクトの段階的な到達点と成功条件は [ROADMAP.md](ROADMAP.md) を参照してください。

## 初期化ルール

永続的なアーキテクチャ選択は [docs/adr/](docs/adr/) に記録します。スコアの意味、評価軸、入出力契約を実装より先に固定し、検証用コーパスで再現性と説明可能性を確認します。
