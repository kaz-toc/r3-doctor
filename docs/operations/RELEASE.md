# リリース手順

## 前提

- Node.js 22 以降
- `npm run validate` が通ること
- npm アカウントに `r3-doctor` パッケージ名の publish 権限
- GitHub repository secrets:
  - `NPM_TOKEN` — npm publish 用（CI から公開する場合）
  - `OPENAI_API_KEY` — LLM integration workflow 用（任意）

## 初回公開（v0.1.0）

### 1. 公開物の確認

```bash
npm run validate
npm pack --dry-run
npx r3-doctor scan . --format markdown   # ビルド後
```

`npm pack --dry-run` で `dist/`, `README.md`, `LICENSE` のみが含まれることを確認する。

### 2. ローカルから publish（推奨: 初回）

```bash
npm login
npm publish --access public
```

### 3. 利用確認

```bash
npx r3-doctor@0.1.0 scan . --format json
```

### 4. Git タグと GitHub Release

```bash
git tag -a v0.1.0 -m "r3-doctor 0.1.0 — initial public release"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file CHANGELOG.md
```

### 5. CI から再公開（2 回目以降）

1. `package.json` の `version` を更新
2. `CHANGELOG.md` を更新
3. main に merge
4. GitHub Actions → **npm publish** → version 入力 → Run workflow

## GitHub 設定（任意）

| 種別 | 名前 | 用途 |
|------|------|------|
| Repository variable | `R3_DOCTOR_LLM_INTEGRATION=1` | LLM integration workflow を有効化 |
| Secret | `OPENAI_API_KEY` | codex-acp smoke test |
| Secret | `NPM_TOKEN` | CI npm publish |

## リリース境界

Phase 0 + Phase 1（snapshot 診断）を初回公開範囲とする。詳細は [ROADMAP.md](../../ROADMAP.md) §7 を参照。
