# Provider Adapter 契約 v1

Phase 5 成果物。評価モデルを変えずに差し替え可能な外部依存。

## LLM Provider (`src/semantic/provider.ts`)

```ts
type SemanticProvider = {
  readonly name: string;
  readonly implementationVersion: string;
  analyze(snapshot, evidence): Promise<unknown>;
};
```

デフォルト: `NullSemanticProvider`（LLM 無効時）。`DefaultSemanticProviderFactory` は ACP 実装 (`AcpSemanticProvider`) を返す。

### Supported provider IDs

| ID | CLI | CLI alias |
|---|---|---|
| `copilot` | `copilot --acp --stdio …` | — |
| `cursor` | `agent acp` | — |
| `codex` | `codex-acp` | `openai` |
| `claude` | `claude-agent-acp` | `anthropic` |

`implementationVersion`（現行 `1.0.0`）は同じ provider 名の実装リリースを識別する不変値である。プロンプト契約またはパース契約を変え得る変更時は必ず更新し、ベースライン互換性 fingerprint に含める。

### Operator-owned execution policy

```bash
r3-doctor scan . \
  --llm-provider codex \
  --llm-model optional-model-id \
  --llm-executable codex-acp \
  --llm-max-prompt-bytes 80000 \
  --llm-max-files 20 \
  --llm-send-scope cluster-context
```

解析対象の `r3-doctor.config.json` は untrusted data であり、LLM の有効化、provider、実行ファイル、送信 scope を所有しない。外部プロセス起動と外部送信は実行者が `--llm-provider` を明示した場合だけ許可する。

### CLI utilities

- `r3-doctor llm inspect [--provider codex]` — spawn + initialize のみ。失敗時は install hint を stderr に出力。
- `r3-doctor scan . --dry-run-semantic [--llm-send-scope changed]` — ACP を呼ばずプロンプトを stdout に出力。

## Git Provider (`src/adapters/git-provider.ts`)

```ts
type GitProvider = {
  listChangedFiles(repositoryPath, baseRef): Promise<string[]>;
  resolveHeadCommit(repositoryPath): Promise<string | undefined>;
};
```

差分診断とトレンド記録が利用。

## Reporter Adapter (`src/adapters/reporter.ts`)

```ts
type ReporterAdapter = {
  format(report, 'json' | 'markdown' | 'console'): string;
};
```

CI summary や CLI 出力の形式を拡張可能。
