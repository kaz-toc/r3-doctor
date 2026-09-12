# LLM Provider 一覧 (`llm list`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** operator が r3-doctor がサポートする LLM provider を CLI から一覧でき、必要なら各 provider の ACP 利用可否を opt-in で確認できるようにする。

**Architecture:** provider 定義の単一ソースは `provider-registry.ts` とする。inspect / list / setup が共有する core は `src/semantic/llm/` に置き、commands 層は薄い CLI アダプタに留める。catalog（副作用なし）と availability probe（外部プロセス spawn）を分離する。

**Tech Stack:** Node.js 22、TypeScript、Zod、Vitest、Commander、ACP SDK

**Spec:** `docs/spec/provider-adapters.md`、`docs/adr/0003-untrusted-repository-execution-policy.md`、`docs/adr/0005-operator-profile.md`

---

## Global Constraints

- 解析対象の `r3-doctor.config.json` は LLM 実行 policy を所有しない（ADR 0003）。`llm list` も repo config から provider を有効化しない。
- operator profile（ADR 0005）は **表示と merge 参照のみ**。list は profile を書き換えない。
- `llm inspect` の **stderr 行形式と exit code（0/1/2）は公開契約** とみなし、破壊的変更禁止。
- `llm list`（catalog）と `llm list --inspect` は **常に exit 0**（情報提供）。strict 判定は単体 `llm inspect` に委ねる。
- `--inspect` は **逐次実行**（並列 spawn 禁止）。最悪 `provider 数 × LLM_ACP_SETUP_TIMEOUT_MS`。
- JSON 出力は `report.v1` と分離した `llm-catalog.v1` schema を使う。
- catalog 組み立ては **新関数を増やして複製しない**。既存 `listLlmProviderDefinitions()` を唯一ソースとする。
- setup wizard の provider **表示順**（codex → claude → cursor → copilot）を PR1 では変更しない。
- 完了前に `npm run validate` を実行する。

---

## 1. 現状診断

| 観測 | 現状 | 影響 |
|------|------|------|
| Registry | `listLlmProviderDefinitions()` あり | CLI 未公開 |
| CLI | `llm inspect --provider <1件>` のみ | 全 provider 探索は shell loop 依存 |
| Setup | `SETUP_LLM_PROVIDER_OPTIONS` が registry と重複 | provider 追加時に drift |
| Alias | `normalizeProviderAlias`（config）と `normalizeProviderId`（provider-ids）が二重 | alias 定義 drift |
| 依存 | `setup/*` が `commands/llm-inspect.ts` を import | commands 層が domain 化しやすい |
| smoke | `status=available` を stderr grep | inspect stderr 変更は CI デグレ |

---

## 2. 採用する設計

### 比較した案

| 案 | 内容 | 判断 |
|---|---|---|
| shell loop + `llm inspect` | 追加実装なし | 順序・JSON・profile 表示が統一されず不採用 |
| `check --llm` を拡張 | readiness に provider 一覧を載せる | 目的が repo readiness であり provider catalog と混同するため不採用 |
| `llm list` + shared core | catalog / probe 分離、semantic/llm に core 抽出 | **採用** |

### 用語

| 用語 | 意味 |
|------|------|
| **Catalog** | r3-doctor がサポートする provider 定義（副作用なし） |
| **Availability probe** | ACP spawn + initialize による利用可否（`--inspect` 時のみ） |
| **Operator default** | `~/.config/r3-doctor/profile.json` の `llm.provider`（表示のみ） |

### CLI 仕様

```bash
# Catalog のみ（デフォルト・spawn なし）
r3-doctor llm list [--format console|json]

# Availability probe（逐次 spawn）
r3-doctor llm list --inspect [--provider <id>] [--path <repo>] [--format console|json]

# 既存（変更なし）
r3-doctor llm inspect [--provider codex] [--path <repo>]
```

| オプション | 適用 | 説明 |
|------------|------|------|
| `--format console\|json` | 常時 | markdown は scope 外（PR3） |
| `--inspect` | probe | 未指定時は catalog のみ |
| `--provider <id>` | probe | 1 件に絞る（`openai` / `anthropic` alias 可） |
| `--path <repo>` | probe | ACP runtime / PATH サニタイズ。未指定は `cwd` |

### Exit code

| コマンド | exit code |
|----------|-----------|
| `llm list` | 0 |
| `llm list --inspect` | 0 |
| `llm inspect` | 0 / 1 / 2（現行維持） |

### JSON schema（`llm-catalog.v1`）

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "codex",
      "displayName": "OpenAI Codex",
      "aliases": ["openai"],
      "defaultExecutable": "codex-acp",
      "installHint": "...",
      "inspect": {
        "status": "skipped | available | unavailable",
        "reason": "executable_missing",
        "agent": "@agentclientprotocol/codex-acp@1.10.0",
        "authMethods": ["api-key"]
      }
    }
  ],
  "operatorDefault": {
    "provider": "copilot",
    "profilePath": "/Users/me/.config/r3-doctor/profile.json"
  }
}
```

- catalog のみ: 各 provider の `inspect.status` は `"skipped"`。
- profile 不在時: `operatorDefault` を省略。

### `llm inspect` stderr 契約（変更禁止）

成功:

```text
provider=<id> status=available
agent=<name>@<version>
authMethods=<id>,<id>
```

失敗:

```text
provider=<id> status=unavailable reason=<LlmFailureReason>
installHint=<hint>
```

---

## 3. モジュール構成

```text
src/semantic/llm/
  types.ts        # LlmProviderInspectRow, LlmCatalogReport
  aliases.ts      # LLM_PROVIDER_ALIASES（唯一の alias 定義）
  inspect.ts      # inspectLlmProvider() → row + exitCode
  catalog.ts      # buildLlmCatalog({ inspect?, path?, profile? })
  format.ts       # formatInspectStderr, formatCatalogConsole, formatCatalogJson

src/schema/
  llm-catalog.v1.ts

src/commands/
  llm-inspect.ts  # 薄い CLI → semantic/llm（rename しない）
  llm-list.ts     # 薄い CLI → semantic/llm

src/cli.ts        # registerLlmListCommand 追加（registerLlmInspectCommand は維持）
```

### 依存方向

```text
commands/llm-*  →  semantic/llm/*  →  semantic/acp/*
setup/*         →  semantic/llm/inspect   （PR2 で commands 依存を除去）
```

---

## 4. PR 分割

### PR1 — Core + `llm list` + `llm list --inspect`（1 PR に統合）

半端リファクタと stderr デグレを避けるため、catalog / inspect 構造化 / list --inspect を **同一 PR** で land する。

#### Task 1: alias 単一ソース

**Files:**
- Create: `src/semantic/llm/aliases.ts`
- Modify: `src/semantic/provider-ids.ts`
- Modify: `src/shared/config.ts`

- [ ] `LLM_PROVIDER_ALIASES` と `listAliasesForProvider(id)` を定義
- [ ] `normalizeProviderId` が aliases を参照
- [ ] `normalizeProviderAlias`（config preprocess）が同定数を参照
- [ ] 既存 alias テスト（execution-policy / profile）が green

#### Task 2: inspect core 抽出

**Files:**
- Create: `src/semantic/llm/types.ts`
- Create: `src/semantic/llm/inspect.ts`
- Create: `src/semantic/llm/format.ts`（stderr formatter）
- Modify: `src/commands/llm-inspect.ts`

- [ ] `inspectLlmProvider()` が `LlmProviderInspectRow` + `exitCode` を返す
- [ ] `runLlmInspect()` は wrapper のまま `{ exitCode, stderr, row? }` を返す
- [ ] `formatLlmInspectStderr(row)` から stderr を生成
- [ ] **stderr golden test**（available / unavailable × reason 代表パターン）
- [ ] `tests/setup/setup.test.ts` / `llm-setup.test.ts` 変更なしで green
- [ ] `scripts/smoke-llm-integration.mjs` の grep 条件を満たす

#### Task 3: catalog builder

**Files:**
- Create: `src/schema/llm-catalog.v1.ts`
- Create: `src/semantic/llm/catalog.ts`
- Modify: `src/semantic/llm/format.ts`

- [ ] `buildLlmCatalog()` が `listLlmProviderDefinitions()` を唯一ソースに使用
- [ ] `loadOperatorProfile()` から `operatorDefault` を付与（読み取りのみ）
- [ ] `--inspect` 指定時のみ逐次 `inspectLlmProvider()`
- [ ] catalog 単体では ACP client を spawn しない（mock で call count 0 を assert）

#### Task 4: CLI

**Files:**
- Create: `src/commands/llm-list.ts`
- Modify: `src/cli.ts`

- [ ] `r3-doctor llm list` を `llm` サブコマンド配下に追加
- [ ] `registerLlmInspectCommand` は **rename しない**
- [ ] `--format console|json` のみ（markdown は PR3）

#### Task 5: Regression fixtures

**Files:**
- Create: `test-fixtures/regressions/REG-2026-024/case.json`
- Create: `tests/semantic/llm-list.test.ts`
- Create: `tests/semantic/llm-inspect-stderr.test.ts`

- [ ] REG-2026-024: catalog が 4 provider + alias を列挙
- [ ] REG-2026-024: `llm inspect` stderr 行形式固定
- [ ] catalog JSON golden（`tests/fixtures/llm-catalog.golden.json`）
- [ ] `llm list --inspect` が provider 数だけ inspect を呼ぶ（mock）

#### Task 6: Docs

**Files:**
- Modify: `docs/spec/provider-adapters.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] `llm list` / `--inspect` を CLI utilities に追記
- [ ] stderr 契約を machine-readable contract として明文化
- [ ] next step 例: `r3-doctor llm list --inspect`

#### PR1 受け入れ条件

- [ ] `npm run validate` green
- [ ] `r3-doctor llm list --format json` が 4 provider を返す
- [ ] `r3-doctor llm list` は spawn しない
- [ ] `r3-doctor llm inspect` の stderr / exit code が変わらない
- [ ] setup wizard の provider 順序が変わらない

---

### PR2 — Setup 統合と依存整理

setup 順序デグレを PR1 から隔離する。

#### Task 7: registry から setup 選択肢を派生

**Files:**
- Modify: `src/semantic/acp/provider-registry.ts`
- Modify: `src/setup/llm-providers.ts`
- Modify: `tests/setup/setup.test.ts`

- [ ] registry に `setupOrder: number` を追加（codex=1, claude=2, cursor=3, copilot=4）
- [ ] `SETUP_LLM_PROVIDER_OPTIONS` を registry から生成
- [ ] setup provider 順序の snapshot test

#### Task 8: setup / readiness の import 修正

**Files:**
- Modify: `src/setup/llm-setup.ts`
- Modify: `src/setup/readiness.ts`
- Modify: `src/setup/interactive.ts`

- [ ] `commands/llm-inspect` ではなく `semantic/llm/inspect` を import
- [ ] `runLlmInspect` wrapper は commands から re-export してもよい（optional）

#### PR2 受け入れ条件

- [ ] setup 対話の provider 順序が PR1 と同一
- [ ] provider 追加時に registry 1 箇所更新で setup / list が追随

---

### PR3 — 改善（別 issue、list PR と混ぜない）

- [ ] `check --llm` の既定 provider を profile 優先に（codex 固定をやめる）
- [ ] `llm inspect --profile` / list --inspect で profile の `executablePath` 反映
- [ ] `llm list --format markdown`
- [ ] i18n: installHint の locale 対応

---

## 5. Non-goals

- provider の動的プラグイン化
- repo config からの LLM 有効化
- `--inspect` の並列 spawn
- scan 相当の semantic 実行（list は initialize のみ）
- `check --llm` の廃止や `llm list` への統合

---

## 6. デグレ防止チェックリスト（実装前に読む）

| リスク | 対策 |
|--------|------|
| stderr 形式変更 | golden test + smoke grep 維持 |
| setup 順序変更 | PR2 まで `SETUP_LLM_PROVIDER_OPTIONS` 固定 |
| alias drift | `LLM_PROVIDER_ALIASES` 単一ソース |
| commands 肥大化 | core は `semantic/llm/`、commands は薄く |
| catalog 複製 | `listLlmProviderDefinitions()` のみ |
| assessment contract | `llm-catalog.v1` を report.v1 と分離 |
| 半端リファクタ | PR1 で core 抽出 + list + list --inspect を同時 land |

---

## 7. 検証コマンド

```bash
npm run validate

# Catalog
npm run r3-doctor -- llm list --format json

# Probe（ローカル環境依存）
npm run r3-doctor -- llm list --inspect --provider codex

# 契約維持
npm run r3-doctor -- llm inspect --provider codex 2>&1 | head -5

# smoke（課金あり）
R3_DOCTOR_LLM_INTEGRATION=1 npm run smoke:llm-integration
```

---

## 8. 関連ドキュメント更新先

| 変更 | 更新先 |
|------|--------|
| CLI 仕様 | `docs/spec/provider-adapters.md` |
| stderr 契約 | `docs/spec/provider-adapters.md` + REG-2026-024 |
| operator profile 表示 | `docs/adr/0005-operator-profile.md`（必要なら Consequences に 1 行） |
| 利用例 | `README.md` |
