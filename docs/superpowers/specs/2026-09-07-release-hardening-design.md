# Release Hardening 修正設計

## 目的

コードベース全体の不具合レビューで再現した、配布物、semantic 境界、依存解析、diff、glob、trend の11件を修正し、公開パッケージと診断結果が同じ契約に従う状態にする。

## 非目標

- 新しい診断軸、言語 plugin、LLM provider の追加
- 削除済みファイル本文や outgoing dependency の復元
- 保存済み assessment contract の migration
- ACP transport protocol 自体の変更

## 修正方針

### 配布物と CLI

golden calibration が実行時に読む `tests/fixtures` を npm package の `files` に含める。package smoke test は tarball の内容だけでなく、展開済み package から `calibration --golden` と `policy --evaluate` が実行できることを確認する。

`plugins` command は repository snapshot の検出結果ではなく、登録済み plugin 自身が宣言する extensions と capabilities を列挙する。空 snapshot に対する negotiation を plugin catalog として再利用しない。

### Semantic 境界

semantic finding の `path` は POSIX 形式に正規化し、絶対パス、`..` escape、snapshot に存在しないパスを拒否する。関連 evidence ID は既存 evidence に存在するものだけを許可する。

semantic finding は formatter で signal として扱い、mechanism cluster は finding の path と関連 evidence を保持する。dependency cycle だけを graph component でまとめ、その他の deterministic evidence と semantic findings は path/anchor ごとに分ける。semantic cluster の score と confidence は finding から算出する。この変更は repository score の意味を修正するため assessment contract version を更新する。

prompt は送信直前に UTF-8 byte length を検証する。context budget で削減しても固定 instruction や evidence を含む完成 prompt が上限を超える場合、provider を呼ばず明示的に失敗する。

ACP は initialize と session setup に既定 deadline を設ける。timeout 時は child process を停止し、既存の provider failure contract に変換する。prompt idle/absolute timeout は session setup 完了後に開始する。

### Deterministic evidence と diff

TypeScript/JavaScript import graph は TypeScript Compiler API で構文解析する。静的 import/export、`require()`、dynamic `import()`、import-equals を対象にし、comment/string 内の疑似 import を無視する。runtime でも parser が必要なため `typescript` は production dependency とする。

resolver は JS/TS の extension substitution と `index.tsx`、`index.jsx`、`index.mjs`、`index.cjs` を含む directory resolution を行う。blast radius 計算時は changed file を virtual target として resolution map に加え、削除・rename 前の path への incoming edge を残す。

glob は `*`、`**`、`?` だけを wildcard とし、それ以外の正規表現メタ文字を literal として escape する。

### Trend 整合性

trend entry の commit は保存時 HEAD ではなく diagnosis snapshot の `sourceCommitSha` を使用する。保存直前に repository state を再検査し、HEAD、repository root、status fingerprint が snapshot と一致しない場合は保存を拒否する。report metadata と snapshot metadata も一致を必須とする。

## 境界

```text
npm package ─> runtime fixtures ─> calibration / policy

Snapshot ─> deterministic parser ─> evidence ─┐
         └> semantic provider ─> findings ────┼> risk / reporting
Git state ─> changed files + virtual targets ─┘

Snapshot + Report + current Git state ─> Trend Store
```

- Intake は snapshot と source commit を所有する。
- Evidence は source syntax と path resolution を所有する。
- Semantic は provider output の grounding、budget、ACP lifecycle を所有する。
- Assessment は cluster と score を所有する。
- Persistence は保存対象が diagnosis input と同一であることを検証する。
- CLI は domain API を呼び出し、catalog や report を表示するだけとする。

## 回帰契約

- `npm pack` した package で golden calibration と policy evaluation が成功する。
- snapshot 外 path、absolute path、prefix sibling path の semantic finding は除外される。
- semantic-only axis は console/Markdown で score と finding を表示する。
- unrelated large files は別 cluster、semantic cluster は path/score/confidence を持つ。
- comment 内 import は edge にならず、require/dynamic import/index variants は edge になる。
- deleted/renamed TypeScript target の incoming blast radius が残る。
- regex metacharacter を含む literal path glob が正しく一致する。
- 完成 prompt は上限以下でのみ provider に渡る。
- ACP initialize/session setup が無応答でも既定時間内に終了する。
- trend は snapshot 後に HEAD または worktree state が変化した場合に保存しない。
- `plugins` は全登録 plugin の capabilities を表示する。

## 完了条件

1. 各再現を失敗する回帰テストとして固定し、修正後に成功させる。
2. `npm run validate`、`npm pack --dry-run`、packaged CLI smoke test、`git diff --check` が成功する。
3. 全差分を Standards と本設計の両面で自己レビューし、指摘を解消する。
4. branch を push し、修正内容と検証結果を記載した PR を作成する。
