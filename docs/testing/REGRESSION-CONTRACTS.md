# 回帰契約

回帰契約は、確認済み incident を 1 つの観測可能な不変条件と実行可能な証拠に結びます。

## ワークフロー

1. [ledger](../incidents/LEDGER.md) に incident を記録する。
2. 1 つの観測可能な不変条件を定義する。
3. 既知の bad behavior または同等 mutant で失敗するテストを書く。
4. 最小の修正を適用する。
5. `test-fixtures/regressions/REG-YYYY-NNN/case.json` を作成する。
6. ケースの verification コマンドと `npm run validate` を実行する。
7. ledger の保護状態を更新する。

## ケース形式

```json
{
  "schemaVersion": 1,
  "id": "REG-2026-001",
  "status": "active",
  "title": "Short user-visible failure description",
  "invariant": "One observable behavior that must remain true",
  "incident": "https://github.com/owner/repository/issues/123",
  "productionFiles": ["src/example.ts"],
  "testFiles": ["tests/example.test.ts"],
  "verificationCommands": ["npm test"]
}
```

active ケースは参照ファイルの存在と、すべてのテストファイルにケース ID のリテラルが含まれることを要求する。`retired` は、Accepted な置き換えまたは削除されたプロダクト振る舞いが、不変条件がもはや適用されない理由を説明できる場合のみ使う。

テンプレートには偽の active ケースは含まれません。

## PR #28: Security context の回帰契約

`tests/security/context-regressions.test.ts` は REG-2026-030〜034 を保護する。修正前の `36312ab` で15ケースすべての失敗を確認した。REG-2026-030 は `tests/security/outbound-filter.test.ts` でも、コメント・文字列中のコード例・部分的な JSX の既存マスクを保護する。

| 契約 | 観測可能な不変条件 |
|---|---|
| REG-2026-030 | 型注釈付き・複数行の秘密値をマスクし、元行番号と残りのコードを保持する |
| REG-2026-031 | current/base の窓境界を跨いでも PEM 本文を送らず、マスクだけの窓は未完了に残す |
| REG-2026-032 | class field initializer と static block を method とともに送信・coverage に含め、所有 class 名による import 関係を保持する |
| REG-2026-033 | 別 handler の所見を保持し、同じ handler の重複報告だけを統合する |
| REG-2026-034 | 存在しても解析対象外の guard は未解決と記録し、所見の confidence を low に制限する |

検証: `npm test -- tests/security/context-regressions.test.ts tests/security/outbound-filter.test.ts`。
