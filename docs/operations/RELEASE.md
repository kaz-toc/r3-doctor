# リリース手順

Cursor エージェント向けのチェックリストは [`.cursor/skills/r3-doctor-release/SKILL.md`](../../.cursor/skills/r3-doctor-release/SKILL.md) を参照。

## 前提

- Node.js 22 以降
- `project-node-runtime` が `ready`（`pnpm` 未導入時は `corepack enable pnpm` → `project-node-runtime-refresh`）
- `npm run validate` が通ること
- npm アカウントに `r3-doctor` パッケージ名の publish 権限
- GitHub repository secrets:
  - `NPM_TOKEN` — npm publish 用（CI から公開する場合）
  - `OPENAI_API_KEY` — LLM integration workflow 用（任意）

## 通常リリース（vX.Y.Z）

### 1. バージョン更新

- `package.json` の `version`
- `src/cli.ts` の `.version('X.Y.Z')`
- `CHANGELOG.md` に `[X.Y.Z]` セクション
- README の `npx r3-doctor@X.Y.Z` 例（ピン留めしている場合）
- `npm install --package-lock-only`

### 2. 公開物の確認

```bash
npm run validate
npm pack --dry-run
npm run r3-doctor -- scan . --format markdown
```

`npm pack --dry-run` で `dist/`, `README.md`, `LICENSE` のみが含まれることを確認する。

### 3. main に land

```bash
git push origin main
```

**Governance CI** が release commit で成功することを確認。

### 4. タグと GitHub Release

```bash
git tag -a vX.Y.Z -m "r3-doctor X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --repo kaz-toc/r3-doctor --title "vX.Y.Z" --notes-file CHANGELOG.md
```

### 5. npm publish

**ローカル（初回または CI トークン未設定時）:**

```bash
npm login
npm publish --access public
```

**CI（2 回目以降）:**

GitHub Actions → **npm publish** → version に `package.json` と同じ値を入力 → Run workflow

### 6. 利用確認

```bash
npm view r3-doctor version
npx r3-doctor@X.Y.Z scan . --format json
```

## GitHub 設定（任意）

| 種別 | 名前 | 用途 |
|------|------|------|
| Repository variable | `R3_DOCTOR_LLM_INTEGRATION=1` | LLM integration workflow を有効化 |
| Secret | `OPENAI_API_KEY` | codex-acp probe (`llm list --inspect --provider codex`) と smoke test |
| Secret | `NPM_TOKEN` | CI npm publish |

## リリース境界

Phase 0 + Phase 1（snapshot 診断）を初回公開範囲とする。詳細は [ROADMAP.md](../../ROADMAP.md) §7 を参照。

## 初回公開メモ（v0.1.0）

v0.1.0 は GitHub Release のみ作成済み。npm 初回公開は v0.1.1 以降で実施。
