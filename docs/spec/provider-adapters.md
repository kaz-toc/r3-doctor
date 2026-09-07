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

| ID | CLI | Config alias |
|---|---|---|
| `copilot` | `copilot --acp --stdio …` | — |
| `cursor` | `agent acp` | — |
| `codex` | `codex-acp` | `openai` |
| `claude` | `claude-agent-acp` | `anthropic` |

`implementationVersion`（現行 `1.1.0`）は同じ provider 名の実装リリースを識別する不変値である。プロンプト契約またはパース契約を変え得る変更時は必ず更新し、ベースライン互換性 fingerprint に含める。

### Config (`r3-doctor.config.json`)

```json
{
  "llm": {
    "enabled": true,
    "provider": "codex",
    "model": "optional-model-id",
    "executablePath": "optional-override",
    "maxPromptBytes": 80000,
    "maxFiles": 20,
    "sendScope": "cluster-context"
  }
}
```

### CLI utilities

- `r3-doctor llm inspect [--provider codex]` — spawn + initialize のみ。失敗時は install hint を stderr に出力。
- `r3-doctor scan . --dry-run-semantic` — ACP を呼ばずプロンプトを stdout に出力。

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
