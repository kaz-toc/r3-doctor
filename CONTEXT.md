# r3-doctor コンテキスト

r3-doctor は、現在の不具合ではなく、コードベースに蓄積した将来のデグレ発生リスクを評価し、原因と打ち手を説明するための言語を定義します。

## Language

**デグレリスク（Regression Risk）**:
現在は正しく動作していても、将来の変更によって既存の振る舞いを失う可能性を高めるコードベースの性質。
_Avoid_: バグ、現在の不具合、不具合率

**Regression Risk Score**:
デグレリスクを 0 から 100 で表す相対指標。高いほど危険であり、絶対的な障害発生確率ではない。
_Avoid_: Bug Score、品質点、障害確率

**評価軸（Risk Axis）**:
構造的脆弱性、変更波及、検証不足など、デグレリスクを互いに区別して評価する観点。
_Avoid_: チェック項目、ルール

**リスクシグナル（Risk Signal）**:
スコアと説明の根拠になる、コード、依存関係、テスト、変更履歴、意味解析から得た観測事実。
_Avoid_: LLM の感想、推測

**リスククラスター（Risk Cluster）**:
同じデグレ発生メカニズムに関与する構造、ファイル、依存関係のまとまり。
_Avoid_: 問題ファイル、バグ箇所

**トリガー変更（Trigger Change）**:
潜在的な弱点を実際のデグレとして表面化させやすい将来の変更種別。
_Avoid_: 原因コミット

**発生メカニズム（Failure Mechanism）**:
トリガー変更が構造上の弱点を通じて既存の振る舞いを失わせる因果経路。
_Avoid_: 根本原因（デグレ発生前の診断に対して）

**確信度（Confidence）**:
利用できた証拠の量、一貫性、再現性に基づく診断の信頼可能性。リスクの大きさとは別に示す。
_Avoid_: 精度、正解率（検証結果がない場合）

**打ち手（Intervention）**:
特定のリスクシグナルまたは発生メカニズムを弱める、根拠と確認方法を伴う改善案。
_Avoid_: 自動修正、一般的ベストプラクティス

**ベースライン（Baseline）**:
同じ設定と評価契約で取得した、比較可能な過去の診断結果。
_Avoid_: 前回の数字（評価条件が異なる場合）

**リスク差分（Risk Delta）**:
ベースラインと現在の診断結果の間で増減したデグレリスクと、その根拠の変化。
_Avoid_: コード差分

**シグナル強度（Signal Strength）**:
1 件の観測値が、その signal の開始閾値をどれだけ超えているかを 0–100 へ正規化した強度。
_Avoid_: 障害確率、severity ラベルそのもの

**Evidence Confidence**:
analyzer coverage、入力完全性、測定再現性に基づく根拠の信頼可能性。
_Avoid_: score の正しさ、障害確率

**Calibration Status**:
outcome data による score 検証状態（`uncalibrated`、`provisional`、`validated`）。
_Avoid_: score 値そのもの、品質ラベルの暗黙推定

**Contribution Points**:
Repository score のうち各 axis が実際に加えた点数。
_Avoid_: axis score の構成比、百分率表示だけ

**Facts View**:
観測済み Evidence、metric、path、解析範囲、未評価領域だけを示す現状表示。
_Avoid_: score 解釈、priority、改善案

**Summary View**:
score、上位 cluster、主要因、Evidence confidence、Calibration status、制約を示す診断要約。
_Avoid_: 新しい事実の生成、intervention 詳細

**Actions View**:
優先順位付き intervention、理由、最初の一手、確認方法を示す改善ポイント表示。
_Avoid_: 全 Evidence table、無関係な cluster

**All View**:
Summary、Actions、Facts を重複なく 3 章として合成した一体レポート表示。
_Avoid_: 章間での Evidence や limitation の重複
