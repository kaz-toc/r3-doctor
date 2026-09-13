# r3-doctor コードベースレビュー（2026-09-13）

対象: `r3-doctor` HEAD `d0626c9`（fix: preserve shadow eligibility and outcome idempotency）
範囲: `src/` 全体、`harness/`、`scripts/`、関連 ADR / spec

## 検証状況

| 項目 | 結果 |
|---|---|
| `tsc --noEmit` | pass |
| `vitest run` | 353 pass / **1 fail**（`tests/validation-cli.test.ts` がタイムアウト。L6 参照） |
| 再現スクリプト | 一時 Git リポジトリで CLI を実行して確認（各項目の「再現」欄） |

判定の表記:
- **確認済み** — 実行して再現した
- **コード上確定** — 実行はしていないが、コードの読解だけで挙動が確定する
- **要確認** — 外部エージェントの挙動や仕様の意図に依存する

---

## サマリ

| ID | 重要度 | 判定 | 概要 |
|---|---|---|---|
| H1 | High | 要確認 | LLM エージェントを「信頼できない解析対象リポジトリ」を cwd にして起動している |
| H2 | High | 確認済み | 循環依存検出が指数時間で、密な import グラフで scan がハングする |
| H3 | High | 確認済み | `--record-validation` の書き込みで worktree が dirty になり、同一実行の baseline 保存や以降の記録が失敗する |
| M1 | Medium | 確認済み | 同一 commit で policy threshold を変えると sampleId が衝突し、scan が exit 2 になる |
| M2 | Medium | 確認済み | promotion の miss-rate チェックが 70/85 固定のため、他 threshold の cohort は必ず rejected になる |
| M3 | Medium | 確認済み | `setup --yes --json --scan` の stdout に JSON が 2 つ連結される |
| M4 | Medium | 確認済み | `.r3-doctor/calibration.json` が symlink を辿って読まれ、外部ファイルの内容がエラーメッセージに漏れる |
| M5 | Medium | コード上確定 | `units[].roots` が symlink の場合、リポジトリ外のディレクトリを走査する |
| M6 | Medium | 確認済み | validation ディレクトリに `.DS_Store` や `.tmp` があると、validation 系コマンドがすべて失敗する |
| M7 | Medium | 確認済み | 未来日時の `--occurred-at` を持つ positive outcome を記録できる |
| M8 | Medium | 確認済み | policy と validation schema の threshold 制約が不一致で、raw ZodError で scan が落ちる |
| M9 | Medium | 要確認 | `--llm-send-scope changed` が実際の変更ファイルではなく evidence を持つファイルを送る |
| M10 | Medium | 要確認 | policy の `redactPaths` が LLM プロンプトに適用されない |
| M11 | Medium | 要確認 | LLM finding がすべて score 対象外のとき、semantic 軸が 0 点で集計に入り、総合スコアが下がる |
| M12 | Medium | コード上確定 | `--format markdown` が信頼できない path / message をエスケープしない |
| L1 | Low | コード上確定 | `diff` が `--format` / `--view` の検証を（課金されうる）診断の後に行う |
| L2 | Low | 確認済み | `validation` 系の入力エラーが raw ZodError / 素の Error として出る |
| L3 | Low | 確認済み | harness のエラーメッセージで `${...}` がエスケープされ、変数が展開されない。backslash 検証も誤っている |
| L4 | Low | 要確認 | fan-out / fan-in が import 文の数で数えられ、同一モジュールへの複数 import で水増しされる |
| L5 | Low | コード上確定 | 空白や非 ASCII（日本語など）を含むパスの git churn が常に 0 になる |
| L6 | Low | 確認済み | `tests/validation-cli.test.ts` のタイムアウトが不足しており flaky |
| L7 | Low | コード上確定 | `resolveCalibrationQuality` の policy パス既定値が config の既定値と異なる |
| L8 | Low | コード上確定 | validation snapshot が contract version `4` をハードコードしている |
| L9 | Low | コード上確定 | ソースファイルの読み込みにサイズ上限がない |
| L10 | Low | 要確認 | operator profile に `sendScope` 等だけがあると、フラグなしの scan がすべて失敗する |

---

## High

### H1. LLM エージェントの cwd が解析対象リポジトリになっている

- 場所
  - [src/semantic/providers/acp-semantic-provider.ts:35](../../src/semantic/providers/acp-semantic-provider.ts#L35)（`runtimeDirectory: snapshot.repositoryPath`）
  - [src/semantic/acp/acp-client.ts:293](../../src/semantic/acp/acp-client.ts#L293)（`buildSession({ cwd: spec.cwd })`）
  - [src/semantic/llm/inspect.ts:44](../../src/semantic/llm/inspect.ts#L44)、[src/commands/llm-inspect.ts:26](../../src/commands/llm-inspect.ts#L26)、[src/commands/llm-list.ts:26](../../src/commands/llm-list.ts#L26)（既定値 `process.cwd()`）、[src/setup/readiness.ts:101](../../src/setup/readiness.ts#L101)
- 問題
  - ADR-0003 は対象リポジトリを信頼できない入力と定めています。一方、`scan/diff --llm-provider` は ACP エージェント（claude-agent-acp / codex-acp / cursor agent / copilot）をリポジトリ直下を cwd にして起動します。
  - これらのエージェントは cwd から project スコープの設定や指示ファイルを読み込むことがあります（例: `.claude/settings.json` の hooks、`CLAUDE.md` / `AGENTS.md`、`.cursor/`、MCP 設定）。
  - `LLM_TOOL_CALL_ABORT_THRESHOLD=1` は tool call を検知して中断する仕組みなので、セッション開始時の hook 実行や指示ファイルの自動注入は防げません。自動注入された指示は、プロンプト内の untrusted fence の外側に置かれます。
  - setup 側は [runtime-directory.ts](../../src/semantic/llm/runtime-directory.ts) で「Avoids untrusted repo cwd」として `os.tmpdir()` を使っています。scan / diff / check / inspect はこの方針と矛盾しています。
- 影響: 悪意あるリポジトリ（PR など）を LLM 有効で scan すると、operator のマシンで任意コマンドが実行される、または認証情報付きの provider プロセスにプロンプトインジェクションされる恐れがあります。影響の大きさは各エージェントの設定読み込み挙動に依存するため「要確認」としています。
- 修正案: `scan` / `diff` でも `mkdtemp` した空ディレクトリを runtimeDirectory / session cwd にします。プロンプトはテキストで渡しているので、cwd がリポジトリである必要はありません。`llm inspect` / `llm list --inspect` / `check --llm` も既定を tmpdir にします。

### H2. `findImportCycles` が指数時間

- 場所: [src/evidence/deterministic.ts:123-163](../../src/evidence/deterministic.ts#L123-L163)
- 問題
  - DFS はノードごとに `visiting` をリセットし、完了したノードをメモしません。そのため、すべての始点からすべての単純経路を列挙します。
  - 大規模な強連結成分（相互 import する数十ファイル。barrel と相互参照が混在する実プロジェクトで普通に起きる）で計算量が爆発します。
- 再現（完全グラフ）

  | ノード数 | エッジ数 | 時間 |
  |---|---|---|
  | 6 | 30 | 52 ms |
  | 7 | 42 | 566 ms |
  | 8 | 56 | 9,492 ms |
  | 9 | 72 | 45,424 ms |

- 影響: `scan` / `diff` / `priorities` / `policy --evaluate` / golden regression が実質ハングします。時間の上限がなく、`REPOSITORY_WALK_MAX_ENTRIES` などの予算も効きません。
- 修正案: Tarjan で SCC を求め、サイズ 2 以上の SCC（または自己ループ）を 1 つの cycle evidence にします。個別の cycle 列挙が必要なら Johnson アルゴリズムに件数上限と作業予算を付けます。

### H3. validation 記録で worktree が dirty になり、baseline 保存や以降の記録が失敗する

- 場所
  - [src/commands/scan.ts:116-136](../../src/commands/scan.ts#L116-L136)
  - [src/validation/storage.ts:103-133](../../src/validation/storage.ts#L103-L133)
  - [src/persistence/snapshot-integrity.ts:32-48](../../src/persistence/snapshot-integrity.ts#L32-L48)
  - [src/adapters/git-provider.ts:136](../../src/adapters/git-provider.ts#L136)（`--untracked-files=all`）
- 問題
  - `.r3-doctor/validation/` が gitignore されていないリポジトリ（README の手順どおり導入した場合の既定）では、次のことが起きます。
    1. `scan --record-validation --save-baseline`: validation artifact を書いた直後に `saveBaseline` の integrity check が dirty を検出し、exit 2 になります。
    2. 1 回目の記録以降、`.r3-doctor/validation/*` が untracked として残ります。そのため、別の commit でも `--record-validation`（`requireClean: true`）が必ず失敗します。
  - report の stdout 出力は永続化の後（`scan.ts:136`）なので、失敗時は診断結果も出力されません。
  - setup のヒント（[src/i18n/catalog.ts:409](../../src/i18n/catalog.ts#L409)）は baselines にしか触れていません。テスト（`tests/validation-cli.test.ts:22`）は gitignore を前提にしているため、この問題を検出できません。
- 再現

  ```text
  $ r3-doctor scan <repo> --record-validation --save-baseline --format json
  validation sample=0d35… status=created
  r3-doctor: baseline save rejected: repository changed during scan. …   (exit 2)
  $ r3-doctor scan <repo> --record-validation --format json
  r3-doctor: baseline save rejected: uncommitted changes in the repository. …   (exit 2)
  ```

- 修正案（いずれか、または組み合わせ）
  - integrity check で r3-doctor 自身の storage 配下（baselineDir / trendDir / validation）を status から除外します。
  - 永続化の順序と clean 判定を「書き込み前にまとめて判定」に変えます。
  - 少なくとも、失敗時にも report を出力し、README と setup で `.r3-doctor/` の ignore を必須として案内します。

---

## Medium

### M1. sampleId が policy threshold や時間依存の入力を含まず、同一 commit の再記録が衝突する

- 場所
  - [src/validation/snapshot.ts:32-41](../../src/validation/snapshot.ts#L32-L41)
  - [src/validation/storage.ts:119-126](../../src/validation/storage.ts#L119-L126)
  - [src/adapters/git-provider.ts:99-104](../../src/adapters/git-provider.ts#L99-L104)
- 問題
  - sampleId は `repositoryId / inputId / headSha / analysisContextFingerprint / horizonDays` から作られます。一方、重複判定は `recordedAt/dueAt` 以外の全フィールドを比較します。
  - 次の変化があると `duplicate sample ID has different content` で scan が exit 2 になり、report も出力されません。
    - policy の `advisoryThreshold` / `gateThreshold` の変更（policy.json が ignore 済み、または commit 外の場合）
    - `git log --since="<N> days ago"` が実行時刻基準のため、日をまたいだ再実行で churn evidence が変わり、v4 / shadow score が変わる
    - LLM provider 有効時の非決定的な finding
  - evaluate は threshold 別 cohort を前提にしており（[evaluate.ts:190](../../src/validation/evaluate.ts#L190)）、ID 設計と矛盾しています。
- 再現: `.r3-doctor/` を ignore したリポジトリで記録 → `policy.json` に `advisoryThreshold: 60` を追加 → 再記録すると、`config error at snapshots/8b4e….json: duplicate sample ID has different content`（exit 2）。
- 修正案
  - threshold を sampleId に含めるか、既存 sample を unchanged として扱い警告にします。
  - churn の基準時刻を HEAD の commit 日時に固定し、同一 commit の score を決定的にします。

### M2. miss-rate チェックが 70/85 固定

- 場所: [src/validation/evaluate.ts:154-162](../../src/validation/evaluate.ts#L154-L162)
- 問題: cohort は threshold ごとに分割されています（1 cohort に 1 threshold）。それなのに `threshold.advisory === 70 && threshold.gate === 85` を探すため、他の threshold の cohort では常に `actual: null, passed: false` となり、データ量が十分でも `rejected` になります。spec の「advisory threshold での miss rate」とも不一致です。
- 再現

  ```text
  thresholds 70/85: missRateCheck={"passed":true,"actual":0}
  thresholds 60/80: missRateCheck={"passed":false,"actual":null}   ← missRate 自体は 0.31 と算出済み
  ```

- 修正案: `value.thresholds[0]` / `v4.thresholds[0]`（cohort 自身の threshold）を使います。

### M3. `setup --yes --json --scan` の stdout が不正な JSON になる

- 場所: [src/setup/run.ts:135-152](../../src/setup/run.ts#L135-L152)、[src/commands/scan.ts:136](../../src/commands/scan.ts#L136)
- 問題: `runScanAction` が scan report JSON を stdout に書き、その後に setup report JSON が書かれます。README の「Agent-friendly JSON」契約を破っています。
- 再現: `JSON.parse` が `Unexpected non-whitespace character after JSON at position 5548` で失敗し、列 0 の `{` が 2 つあります。
- 修正案: `runScanAction` に出力先の注入（または出力抑止）オプションを追加し、setup からは stdout に書かせないようにします。

### M4. `calibration.json` の読み込みに境界チェックがなく、内容が漏れる

- 場所
  - [src/calibration/dataset.ts:67-111](../../src/calibration/dataset.ts#L67-L111)
  - 全 scan から [src/pipeline/diagnose.ts:60-65](../../src/pipeline/diagnose.ts#L60-L65) → [src/calibration/quality.ts:69](../../src/calibration/quality.ts#L69) 経由で呼ばれる
- 問題
  - policy は `resolveSafeRepositoryFile` とサイズ上限で読み込んでいます。一方 calibration は `path.join` + `readFile` で、symlink、リポジトリ外、巨大ファイルの対策がありません。
  - さらに `JSON.parse` のエラーメッセージ（入力断片を含む）を ConfigError にそのまま載せています。
- 再現: `.r3-doctor/calibration.json -> /etc/hosts` を置いて scan すると、次のように出力されます。

  ```text
  r3-doctor: config error at …/calibration.json: Unexpected token '#', "##
  # Host "... is not valid JSON
  ```

  CI ログにリポジトリ外ファイルの断片が出ます。巨大ファイルならメモリも圧迫します。
- 修正案: `resolveSafeRepositoryFile` + `readFileWithinByteLimit` を使い、パースエラーの詳細は出力しないようにします。

### M5. unit root の symlink でリポジトリ外を走査する

- 場所: [src/intake/snapshot.ts:142-149](../../src/intake/snapshot.ts#L142-L149)、[src/intake/snapshot.ts:165-194](../../src/intake/snapshot.ts#L165-L194)
- 問題
  - `resolveUnitRoot` は字句的な `..` の検査しかしません。`walkFiles` はディレクトリ内のエントリが symlink ならスキップしますが、root 自身は lstat / realpath で検査しません。
  - 信頼できない `r3-doctor.config.json` の `units[].roots: ["link"]`（`link -> ~/other-project`）で、リポジトリ外の `.ts/.js/.py/.go` を読み込みます。読み込んだ内容は report の path や LLM プロンプト（`--llm-send-scope all` など）に入ります。
  - `startsWith('..')` の判定は `..foo` という名前のディレクトリも誤って拒否します。
- 修正案: root を `realpath` し、リポジトリの realpath 配下であることと symlink でないことを検査します（`resolveSafeStorageDir` と同じ方式）。

### M6. validation ディレクトリ内の無関係なファイルで全コマンドが失敗する

- 場所
  - [src/validation/storage.ts:145-150](../../src/validation/storage.ts#L145-L150)
  - [src/validation/outcome.ts:120-124](../../src/validation/outcome.ts#L120-L124)
  - [src/shared/atomic-write.ts:15](../../src/shared/atomic-write.ts#L15)
- 問題
  - `.json` 以外のファイルがあると例外になります。macOS の `.DS_Store` に加え、`atomicWriteFile` がクラッシュ時に残す `.<name>.<hex>.tmp` でも同様です。
  - 一度でも発生すると `validation status` / `validation outcome` / `calibration compare` が恒久的に使えなくなります。
- 再現: `snapshots/.DS_Store` を作成すると `config error at snapshots/.DS_Store: validation snapshots must use .json filenames`（exit 2）。
- 修正案: dotfile と `.tmp` を無視するか、少なくとも警告にとどめます。

### M7. positive outcome の `occurredAt` が未来日時でも通る

- 場所: [src/validation/outcome.ts:79-90](../../src/validation/outcome.ts#L79-L90)
- 問題: `recordedAt <= occurredAt <= dueAt` しか検査していないため、観測時刻（`observedAt`）より未来の発生日時で regression を記録できます。
- 再現: `--outcome regression --occurred-at <now+10d>` が `status=created`（exit 0）になります。
- 修正案: `occurred <= observedAt` を追加します。

### M8. policy の threshold 制約と validation schema が不一致

- 場所
  - [src/operations/policy.ts:17-19](../../src/operations/policy.ts#L17-L19)（`z.number()`、advisory ≤ gate の制約なし）
  - [src/validation/schema.ts:59-62](../../src/validation/schema.ts#L59-L62)（int、advisory ≤ gate）
  - [src/commands/scan.ts:121](../../src/commands/scan.ts#L121)
- 問題: 正当な policy（`advisoryThreshold: 72.5` や advisory > gate）で `--record-validation` を付けると、raw ZodError の JSON を出して exit 2 になり、report も出力されません。
- 再現: `advisoryThreshold: 72.5` で `r3-doctor: [ { "code": "invalid_type", "expected": "integer", … "path": ["policyThresholds","advisory"] } ]` が出ます。
- 修正案: policy 側で制約を揃えるか、記録前に分かりやすい R3DoctorError を出します。

### M9. `--llm-send-scope changed` の意味が名前と一致しない

- 場所: [src/semantic/provider.ts:44-62](../../src/semantic/provider.ts#L44-L62)、[src/commands/diff.ts:92-117](../../src/commands/diff.ts#L92-L117)
- 問題
  - `changed` は「変更ファイル」ではなく「evidence を持つファイル」を選びます。`diff` では変更ファイルを計算していますが、それは診断（LLM 呼び出し）の後で、送信対象の選定には使われません。
  - `cluster-context` は evidence パスの先頭ディレクトリ配下をすべて含めるため、`src/` 構成では実質 `all` と同じになります。
  - operator が送信範囲を最小化するつもりで選んでも、想定外のファイルが外部送信されます。spec に定義がないため「要確認」としています。
- 修正案: `diff` では変更ファイル（と blast radius）で絞り込み、`scan` では `changed` を拒否するか定義を文書化します。

### M10. `redactPaths` が LLM プロンプトに適用されない

- 場所
  - [src/semantic/semantic-prompt.ts:42-53](../../src/semantic/semantic-prompt.ts#L42-L53)
  - [src/semantic/context-budget.ts:21-24](../../src/semantic/context-budget.ts#L21-L24)
  - redaction の適用箇所は [src/commands/scan.ts:114](../../src/commands/scan.ts#L114) の出力のみ
- 問題: プロンプトは `Repository: [REPOSITORY]` と伏せていますが、policy で redact 指定したパスの名前と内容はそのまま外部 LLM に送られます。redact の対象範囲が「出力のみ」という意図であれば文書化が必要です。
- 修正案: redact 対象パスを candidate から除外するか、パス文字列を置換してから送信します。

### M11. LLM 有効時に総合スコアが下がることがある

- 場所: [src/assessment/risk.ts:53-55](../../src/assessment/risk.ts#L53-L55)、[src/assessment/risk.ts:67-84](../../src/assessment/risk.ts#L67-L84)
- 問題
  - finding が 0 件なら semantic 軸は unevaluated（集計から除外）です。
  - finding が 1 件以上あり、すべて score 対象外（`relatedEvidenceIds` がない等）の場合、semantic 軸は evaluated のまま score 0 になり、`axisBase` の平均を引き下げます。
  - 結果として「LLM がノイズ的な finding を返すと総合スコアが下がる」という非単調な挙動になります。
- 修正案: score 対象の finding が 0 件なら unevaluated として扱います。

### M12. Markdown 出力が信頼できない文字列をエスケープしない

- 場所: [src/reporting/format.ts:187-194](../../src/reporting/format.ts#L187-L194)（表）、[src/reporting/view-model.ts:259-266](../../src/reporting/view-model.ts#L259-L266)（`topRationale` に path を含む）
- 問題
  - ADR-0003 は「Markdown チャネルは出力境界でエスケープする」と定めています。`--github-summary` はエスケープしていますが、`--format markdown`（scan / diff）はファイルパスや message をそのまま埋め込みます。
  - `|` を含むファイル名で表が崩れ、`[x](https://…)` や `![](…)` 形式のファイル名で、レンダリング時にリンクや画像が注入されます。
- 修正案: `reporting/github.ts` の `escapeMarkdownText` を共通化し、markdown formatter で使います。

---

## Low

### L1. `diff` の引数検証が診断の後

- 場所: [src/cli.ts:110-115](../../src/cli.ts#L110-L115)
- 問題: `parseFormat` / `parseView` が `runDiffDiagnosis` の後にあるため、`--format jsn` のような誤りでも LLM への送信・課金が発生してから失敗します（scan は先に検証しています）。

### L2. validation 系の入力エラーが raw な例外として出る

- 場所: [src/cli.ts:289-303](../../src/cli.ts#L289-L303)、[src/validation/outcome.ts:71](../../src/validation/outcome.ts#L71)、[src/validation/format.ts:14](../../src/validation/format.ts#L14)
- 問題
  - `--outcome bogus` や不正な形式の `--occurred-at` は ZodError の JSON ダンプになります（確認済み）。
  - `parseValidationFormat` は素の `Error` を投げるため、R3DoctorError の扱いと一貫しません。

### L3. harness のテンプレート文字列エスケープ誤り

- 場所
  - [harness/config.mjs:21](../../harness/config.mjs#L21)、[:24](../../harness/config.mjs#L24)、[:79](../../harness/config.mjs#L79)、[:86](../../harness/config.mjs#L86)
  - [harness/paths.mjs:21](../../harness/paths.mjs#L21)、[:25](../../harness/paths.mjs#L25)、[:32](../../harness/paths.mjs#L32)
- 問題
  - `` `\${field} …` `` のため、変数が展開されません。確認結果: `absolute repository path is prohibited: ${relativePath}`。
  - [harness/config.mjs:47](../../harness/config.mjs#L47) の `segment.includes('\\\\')` は「バックスラッシュ 2 文字」を検査しています。そのため `a\b` のような単一バックスラッシュのセグメントが通ります（確認済み）。

### L4. fan-out / fan-in が import 文の数で数えられる

- 場所: [src/evidence/deterministic.ts:372-377](../../src/evidence/deterministic.ts#L372-L377)
- 問題: `import type { A } from './a'` と `import { b } from './a'`、`export … from './a'` を別エッジとして数えるため、同一モジュールへの依存でも high-fan-out / high-fan-in が水増しされます。重複を除いたモジュール数で数えるのが妥当と思われます。

### L5. 空白や非 ASCII を含むパスの churn が常に 0

- 場所: [src/evidence/deterministic.ts:584-597](../../src/evidence/deterministic.ts#L584-L597)、[src/adapters/git-provider.ts:17-21](../../src/adapters/git-provider.ts#L17-L21)、[:99-104](../../src/adapters/git-provider.ts#L99-L104)
- 問題
  - 空白を含むパスは明示的に除外されています。
  - `GIT_CONFIG_GLOBAL=/dev/null` で `core.quotepath` が既定（true）になるため、日本語ファイル名は `"\343\201…"` 形式で出力され、snapshot のパスと一致しません。
- 修正案: `git log -z --name-only` でパースします。

### L6. `tests/validation-cli.test.ts` がタイムアウトで flaky

- 場所: [tests/validation-cli.test.ts:20-35](../../tests/validation-cli.test.ts#L20-L35)、[vitest.config.ts:13](../../vitest.config.ts#L13)
- 問題: tsx 経由の CLI を 2 回起動するのに既定の 30 秒で動かしています。今回のフル実行で `Test timed out in 30000ms` になりました。同種の CLI 統合テスト（`tests/integration.test.ts`）は 60 秒を指定しています。

### L7. calibration quality の policy パス既定値が不一致

- 場所: [src/calibration/quality.ts:68](../../src/calibration/quality.ts#L68)
- 問題: `policyFile ?? 'r3-doctor.policy.json'` は config の既定値 `.r3-doctor/policy.json` と異なります。現在の呼び出し元は常に値を渡しているので潜在バグです。

### L8. contract version のハードコード

- 場所: [src/validation/snapshot.ts:78](../../src/validation/snapshot.ts#L78)
- 問題: `assessmentContractVersion: 4` がハードコードされています。schema は `ASSESSMENT_CONTRACT_VERSION` のリテラルを要求するため、contract を上げた時点で記録がすべて失敗します。

### L9. ソースファイル読み込みにサイズ上限がない

- 場所: [src/intake/snapshot.ts:223](../../src/intake/snapshot.ts#L223)
- 問題: config や policy にはバイト上限がありますが、走査対象のソースは `readFile` で全量をメモリに載せます。信頼できないリポジトリに巨大な `.js` を置けば、メモリ枯渇を起こせます。

### L10. operator profile の部分設定で全 scan が失敗する

- 場所: [src/semantic/execution-policy.ts:47-86](../../src/semantic/execution-policy.ts#L47-L86)
- 問題: profile に `llm.sendScope` / `maxFiles` / `model` だけがあり provider がない（または `none`）場合、フラグなしの `scan` でも `--llm-send-scope requires --llm-provider` で失敗します。エラーメッセージが CLI フラグ名を指すため、原因が profile だと分かりにくいです。setup が作る profile には provider が必ず入るので、手書きの profile で起きる問題です。

---

## 推奨対応順

1. **H1 / H2 / H3** — 安全性、可用性、機能の基本動作に関わるもの
2. **M1 / M2 / M6** — shadow validation の結果の正しさ・継続性に関わるもの（直近の変更範囲）
3. **M3 / M4 / M5 / M12** — ADR-0003 の境界・出力契約の抜け
4. その他の Medium / Low

各修正は AGENTS.md の規律に従い、再現テスト（回帰契約）を先に追加してください。
