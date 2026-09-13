# アーキテクチャ

この文書が現在の構造上の権威です。[docs/adr/](docs/adr/) の Accepted な決定は、永続的な選択の理由を説明します。ここに記載する境界はロードマップ上の初期構造であり、実装時に公開契約を ADR とテストで固定します。

## 境界

| 境界 | 責務 | 公開契約 |
|---|---|---|
| Repository Intake | 対象リポジトリ、設定、除外、Git 履歴を読み取り、解析可能なスナップショットを作る | Repository Snapshot |
| Evidence Extraction | 構文、依存関係、複雑性、変更履歴、テスト対応から決定論的なリスクシグナルを抽出する | Evidence Set |
| Semantic Analysis | 責務、暗黙契約、重複ルール、意図の曖昧さを LLM で分析し、参照可能な根拠付き所見にする | Semantic Finding Set |
| Risk Assessment | リスクシグナルと意味所見を評価軸、リスククラスター、スコア、確信度へ変換する | Risk Assessment |
| Recommendation | 発生メカニズムに対応した優先順位付きの打ち手と確認方法を作る | Intervention Set |
| Reporting | 同じ診断結果を CLI、Markdown、JSON、CI 向けに表現する | Versioned Report Schema |
| Security Add-on | operator が許可した対象で LLM によるセキュリティ候補を評価し、評価範囲と完了状態を示す | Security Assessment（[契約 v1](docs/spec/security-addon.md)） |

ガバナンスハーネスはプロダクトコードから独立し、リポジトリ自身の変更規律を検証します。

## 所有権

- Repository Intake が入力スナップショットの範囲と識別子を所有する。
- Evidence Extraction と Semantic Analysis は観測結果を所有するが、総合スコアを決定しない。
- Risk Assessment がスコア、評価軸、確信度、リスククラスターを唯一確定する。
- Recommendation は Risk Assessment を変更せず、各打ち手を根拠となる発生メカニズムへ結び付ける。
- Reporting は診断内容を変更せず、公開形式だけを所有する。
- Security Add-on は Security Assessment を所有するが、Regression Risk Score、評価軸、確信度、calibration、core baseline へ加算しない（[ADR 0006](docs/adr/0006-security-addon.md)、Proposed）。

## 依存方向

```text
Repository Intake ─┬─> Evidence Extraction ─┐
                   └─> Semantic Analysis ───┼─> Risk Assessment ─> Recommendation
                                           └─────────────────────> Reporting
```

- Risk Assessment はファイルシステム、Git、LLM SDK、UI に直接依存しない。
- LLM プロバイダーとプログラミング言語固有解析は adapter の背後に置く。
- Reporting はスコアを再計算せず、versioned report schema を解釈する。
- 意味所見は対象ファイルまたはリスクシグナルを参照し、根拠のない自由記述を許可しない。
- Security Add-on は Repository Snapshot と LLM text port に依存し、Risk Assessment に依存させない。repository の宣言だけでは provider 起動・外部送信を許可しない。

## DDD

DDD はモデリング支援であり、必須のリポジトリ形状ではありません。

- 正規用語は [CONTEXT.md](CONTEXT.md) に置く。
- デグレリスク、確信度、リスク差分を混同しない。
- 評価結果の owner と公開契約を一つに保つ。
- 外部解析器や LLM の語彙は adapter で正規用語へ翻訳する。

## SOLID

- 収集、観測、意味解析、評価、提案、表示を独立した変更理由として分離する。
- 新しい言語、LLM、出力形式は既存の評価モデルを変更せず追加できるようにする。
- 呼び出し側は実装詳細ではなく versioned schema を利用する。
- スコアの意味を変える場合は schema と評価契約のバージョンを更新する。

## 構造上の制限

非テストのソースファイルには、デフォルトで非空行 800 行のハードリミットがあります。コメント行はカウントし、空白のみの行はカウントしません。

この制限自体をプロダクトの Regression Risk Score に流用しません。一般的なメトリクスはリスクシグナルであり、文脈、波及経路、検証状況と組み合わせて評価します。

## アーキテクチャチェック

プロダクト固有チェックは `project-checks/` に置き、`harness.config.json` に列挙します。各チェックは Accepted な ADR または記録済み incident から得た具体的制約だけを保護します。スコアを都合よく改善するためのチェック除外や閾値緩和は禁止します。
