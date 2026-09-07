# ROADMAP 完了品質の再構成設計

## 目的

`ROADMAP.md` の Phase 0–6 を、ファイルやコマンドが存在するだけではなく、公開可能な振る舞いと検証可能な契約として満たす。未リリースのため、現在の不正確な内部型・JSON・CLI 出力との後方互換性は維持しない。既存の動作する解析要素と fixture は活用し、全面書き直しは行わない。

## 成功条件

1. `scan` は対象言語、利用可能な解析能力、未評価領域を正確に報告する。
2. `diff` は current/base report に加え、変更ファイル、blast radius、新規・悪化・改善シグナル、契約互換性を返す。
3. Evidence、Semantic Finding、Risk Cluster、Intervention の参照関係を schema で検証できる。
4. Risk Cluster は評価軸単位ではなく、同一 failure mechanism と関連ファイル群を表す。
5. score、confidence、risk delta の計算と確定は Risk Assessment だけが所有する。
6. Python、Go、TypeScript/JavaScript の解析能力を対象リポジトリごとに交渉し、未対応能力をゼロ点にしない。
7. LLM が未設定、利用不能、または失敗した場合、Semantic Ambiguity を未評価として報告する。
8. path redaction、retention、calibration eligibility、opt-in gate を実装とテストで強制する。
9. console、Markdown、JSON、GitHub Summary、GitHub annotation の全出力から診断根拠を確認できる。
10. `npm run validate` と境界別統合テストが成功し、ROADMAP の各完了条件からテストへ追跡できる。

## Non-goals

- 公開済み利用者向けの後方互換レイヤー
- LLM ベンダー固有 SDK の追加
- Python/Go におけるTypeScript analyzerと同等の完全なAST解析
- Webダッシュボードや常駐サービス
- 自動リファクタリング
- 校正データの捏造または外部データ収集

## 評価契約バージョン

未リリースのため、ROADMAP 完了再構成（2026-09-06）でスコア集約・confidence 計算・mechanism-based clustering を導入した時点で `ASSESSMENT_CONTRACT_VERSION` を **v1 から v2 へ再定義**した。公開前のため v1 との後方互換は提供しない。古い baseline / trend は schema または contract mismatch として扱う。

## 変更境界に関する例外

AGENTS.md / CONTRIBUTING.md の「1 PR 1 主要境界」に対し、Phase 0–6 の初回契約確立は schema → intake → assessment → reporting → persistence → policy が同一公開型に依存するため、**未リリース期間に限り単一 PR で横断変更を許容**する。以降の変更は境界ごとに分割する。

## アーキテクチャ

```text
Repository Intake
  -> Language Detection
  -> Analyzer Registry / Capability Resolution
  -> Evidence Set
       + Semantic Provider Resolution
  -> Risk Assessment
  -> Mechanism-based Clustering
  -> Recommendation
  -> Scan Report / Diff Report
  -> Redaction
  -> Console / Markdown / JSON / GitHub
```

依存方向は一方向に保つ。Repository Intake はファイル収集だけを所有し、言語別シグナルの知識を持たない。Analyzer Registry はスナップショットに存在する言語から実行対象を選ぶ。Risk Assessment は外部I/Oに依存しない。Reporting は計算を行わず、schema 検証済みの結果を表示する。

## Repository Intake

### ファイル収集

- 対象拡張子は analyzer registry が宣言する `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go` の和集合とする。
- `exclude` はpath segmentまたは明示的globとして解釈し、単純な部分文字列一致を使わない。
- unit root は実パスへ解決し、repository root 外へ出る `..` と絶対パスを拒否する。
- symbolic link は追跡しない。ファイルsymlinkも収集しない。
- 読めないファイル、存在しないunit root、解析上限到達を区別して報告する。

### Input ID

Input ID は次を正規順序で SHA-256 へ入力して生成する。

- assessment contract version
- 正規化済み解析設定
- unit ID
- 各ファイルの相対path
- 各ファイル内容のhash

絶対repository pathと生成時刻は含めない。同一内容・同一設定ならclone先が異なっても同じIDになり、同じ行数でも内容が変われば異なるIDになる。

### 設定エラー

`r3-doctor.config.json` が存在しない場合だけ既定値を使用する。存在するが読めない、JSON不正、schema不正の場合は対象pathと原因を含む設定エラーにする。

## Analyzer と Capability Negotiation

```ts
type SourceLanguage = 'typescript-javascript' | 'python' | 'go';

type AnalyzerCapability = {
  language: SourceLanguage;
  contractVersion: number;
  signals: readonly SignalId[];
  completeness: 'full' | 'partial';
};

type AnalyzerPlugin = {
  id: string;
  extensions: readonly string[];
  capabilities: readonly AnalyzerCapability[];
  extract(snapshot: RepositorySnapshot): Promise<Evidence[]>;
};
```

- registry は実在する拡張子から対象言語を検出し、その言語用pluginだけを実行する。
- `supported` と `unevaluated` は言語ごと・signalごとに計算する。
- partial analyzer は実装していないsignalを宣言しない。
- Python/Goの初回実装は `large-file` と対応可能な基本import/test配置シグナルに限定し、未対応能力を明示する。
- 複数言語repositoryでは Evidence を共通schemaへ統合し、重複IDをエラーにする。

## Evidence と Semantic Finding

Evidence ID、Signal ID、Cluster ID、Intervention ID はschema上で異なる型として扱い、参照整合性をreport全体の `superRefine` で検証する。

Semantic Finding は次のいずれかを必須にする。

1. repository内の対象path
2. 1件以上の既存 `relatedEvidenceIds`

provider出力は使用前に配列schemaで検証し、未知のaxis、repository外path、dangling evidence referenceを拒否する。

```ts
type SemanticProviderFactory = {
  create(config: LlmConfig): SemanticProviderResolution;
};

type SemanticProviderResolution =
  | { status: 'available'; provider: SemanticProvider }
  | { status: 'unavailable'; reason: string };
```

configが無効な場合とprovider利用不能の場合を区別する。どちらもSemantic Ambiguityを未評価にする。provider実行失敗は全scanを隠さず、未評価理由をreportへ記録する。LLMへ渡す候補は `llm.maxFiles` と送信対象設定を適用した後のファイルだけとする。

## Risk Assessment

Risk Assessment は Evidence、Semantic Finding、Capability Result、任意の比較可能baselineを入力として、次を一度だけ確定する。

- axis score と contribution
- axis confidence と unevaluated
- risk clusters
- repository score と confidence
- risk delta と baseline ID

Evidence件数の単純平均でスコアが下がらないよう、シグナル種別ごとの強度を先に集約する。同一signalの低severity事例を追加して既存のhigh severityを希釈できない設計にする。重大クラスターの最大値を契約どおり30%ブレンドする。

confidenceは次の観測可能な比率から計算する。

- 対象言語で利用可能な決定論的capability / 期待capability
- 成功した解析器 / 選択された解析器
- Git履歴の利用可否
- truncationの有無
- semantic providerの利用可否とschema妥当性

Evidenceが1件あること自体はconfidenceの固定加点にしない。

## Mechanism-based Clustering

クラスターキーは少なくとも `axisId + mechanismId + connected component` で構成する。

- dependency cycle: cycle内ファイルとcycle edge
- high fan-in/out: hubと直接・推移依存path
- verification gap: 未検証sourceと関連するtest/境界
- volatility: churn対象と共変更ファイル
- semantic ambiguity: findingが参照するpath/evidence

各clusterは専用の `failureMechanism` と `triggerChanges` を持つ。関連しないlarge file、cycle、barrel exportを同じclusterに入れない。Interventionはclusterとsignalの双方へ参照可能で、verification条件は対象signalの再診断方法を示す。

## Scan Report と表示

Scan Report schemaは Repository、Axes、Clusters、Evidence、Semantic Findings、Interventions、Capabilities、Metadataを必須層として持つ。

- JSONはschema全体を返す。
- Markdownは各clusterからEvidenceのseverity、message、metricsへ辿れる節を持つ。
- consoleは上位clusterのmechanism、trigger、主要Evidence、未評価領域を表示する。
- formatterは1箇所のdispatcherへ統合し、adapterは出力先拡張の責務だけを持つ。

## Diff Report

`r3-doctor diff --format json` は Scan Report ではなく次のversioned Diff Reportを返す。

```ts
type DiffReport = {
  schemaVersion: 1;
  current: DiagnosisReport;
  base: DiagnosisReport;
  comparison: {
    compatible: boolean;
    reason?: string;
    riskDelta?: number;
    changedFiles: string[];
    blastRadius: BlastRadiusEntry[];
    newSignals: EvidenceChange[];
    worsenedSignals: EvidenceChange[];
    improvedSignals: EvidenceChange[];
  };
};
```

blast radiusは直接依存だけでなく、循環を防いだ推移探索結果と経路を持つ。working treeの変更をcurrentに含める場合はchanged filesにも含め、両者を不一致にしない。

### 契約互換性

base側に保存されたreport metadataまたはversioned assessment manifestがある場合にだけ異世代のscore deltaを比較する。base sourceを現在のassessment codeで再解析した結果だけを根拠に「互換」と判定しない。互換性を確認できない場合はscore/signal比較を抑止し、変更ファイルとblast radiusだけを返す。

## Baseline と Trend

- baseline/trend entryを個別schemaで検証する。
- 書込みは同一directory内のtemporary fileからrenameするatomic writeとする。
- baselineはinput IDだけでなく生成時刻とcontract versionをindex化し、比較可能な最新baselineを選択できる。
- trend読込み時は壊れた行を黙って全消去扱いにせず、行番号付きエラーにする。
- 異なるcontract versionのtrendは同じ系列で比較しない。
- degradation startは最終状態へ続く悪化区間の開始点とする。
- contributing clustersは開始時点から増加したcluster、contributing changesは悪化した遷移のchanged filesだけを含める。

## Policy、Calibration、Retention、Redaction

設定ファイルが存在しない場合だけ安全な既定値を使い、破損ファイルはエラーにする。

`gateEligible` は入力booleanとして信用せず、以下から実行時に導出する。

- score bandごとの最小サンプル数
- false positive / miss rateの存在
- ranking quality / explanation usefulnessの存在
- golden regressionの成功
- policyが要求する追加条件

gateは `gateEnabled: true`、`requireCalibration`条件成立、十分なconfidenceのすべてを満たす場合だけnon-zero exitを返す。workflowはadvisory job内で `policy --evaluate` を実行し、初期設定では失敗しない。

`redactPaths` はReportモデルのコピーへ適用し、console、Markdown、JSON、baseline、trend、GitHub出力のすべてで同じ結果にする。解析内部のpathは変更しない。保持期限を過ぎたbaselineとtrend entryは保存処理前に削除し、削除結果を監査理由へ記録する。

GitHub annotationはworkflow commandとして標準出力へ流すか、専用stepがファイル内容を標準出力へ出す。Job Summaryへの追記とは分離する。

## エラー処理

CLIは次の終了コード契約を持つ。

- `0`: 診断成功、またはadvisoryのみ
- `1`: 有効かつ校正済みpolicy gateの拒否
- `2`: 引数、設定、schema、Git、I/O、provider契約エラー

無効なformat、未知unit、存在しないroot、無効base refはexit 2で、対象と原因をstderrへ出す。利用不能な任意解析能力はscan自体のエラーにせず、未評価領域として扱う。

## セキュリティ

- 解析対象リポジトリ、その設定、ファイル名、内容はすべて敵対的入力になり得る。対象リポジトリはプロセス起動、provider 選択、外部送信の有効化を決定できず、これらは実行者側 CLI policy のみが所有する。
- repository root外のunit、symlink、redaction漏れを回帰テストで保護する。
- LLM送信候補は除外・上限・明示的scope適用後に生成する。
- schema不正なprovider出力をreportへ混入させない。
- CI gateは未校正状態でfail closedにせず、advisoryとして理由を残す。
- retention削除は設定済み保存directory内の検証済み対象だけに限定する。

## テスト戦略

すべてのBehavior/Defect変更をtest-firstで行う。各テストは修正前実装で意図した理由により失敗することを確認する。

### 単体テスト

- content hashによるinput IDとclone path非依存性
- 設定破損、unit path脱出、symlink除外
- 言語別plugin選択とpartial capability
- semantic provider解決、失敗fallback、grounding validation
- score非希釈性、confidence、mechanism cluster
- report参照整合性
- redaction、retention対象選択、calibration eligibility
- trend悪化区間と寄与差分

### 統合テスト

- TypeScript、Python、Go、mixed-language fixtureのscan
- temporary Git repositoryによるcommitted/working-tree diff
- assessment contract一致、不一致、不明の3状態
- baseline/trend atomic round-tripと破損時エラー
- console/Markdown/JSONのEvidence表示
- GitHub Summary、annotation、advisory、calibrated gate

### 完了検証

1. 変更境界ごとの狭いtest
2. `npm run validate`
3. `scan`、`diff`、`calibration --golden`、`trend --analyze`、`priorities`、`policy --evaluate` のCLI smoke test
4. `npm pack --dry-run`
5. ROADMAP Phase 0–6とテスト名の追跡表確認

## 移行方針

未リリースのためcompatibility shimは作らない。既存schema、fixture、configは同じ変更内で正しい初回契約へ更新する。古いbaseline/trendを自動変換せず、明確なcontract mismatchまたはschema errorとして扱う。

実装は次の順序で進める。

1. schemaと参照整合性
2. intakeと言語/capability
3. semantic providerとassessment/clustering
4. scan/diff reporting
5. baseline/trend
6. policy/calibration/redaction/retention
7. GitHub workflowとROADMAP追跡表

この順序により、後続タスクが前段の公開型へ依存でき、複数エージェントへ割り当ててもinterfaceの重複定義を避けられる。
