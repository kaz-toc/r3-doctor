# Architecture Decision Records

永続的、文脈なしでは意外、または巻き戻しコストの高いアーキテクチャ決定には ADR を使う。フォーマット、日常的なバグ修正、自明な実装詳細のための ADR は作らない。

1. [TEMPLATE.md](TEMPLATE.md) をコピーする。
2. 次の 4 桁番号を使う。
3. Status を Proposed にする。
4. 代替案と enforcement を記録する。
5. レビュー後にのみ Accepted に変更する。
6. Accepted な決定を黙って書き換えるのではなく Supersede する。

現在の決定:

- [ADR-0001: Lightweight governance core](0001-lightweight-governance-core.md)
- [ADR-0002: Semantic providers via ACP over stdio](0002-semantic-acp-providers.md)
- [ADR-0003: Untrusted repositories cannot own execution policy](0003-untrusted-repository-execution-policy.md)
