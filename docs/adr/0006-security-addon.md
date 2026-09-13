# ADR 0006: Security checks as an operator-consented add-on

## Status

Proposed

Extends the execution boundaries of ADR 0003 and ADR 0005. It does not supersede them.

## Context

Operators want `scan` / `diff` to report LLM-assisted security candidates for repositories they choose. The existing Regression Risk Score describes structures that are fragile under future change, while a security candidate describes a vulnerability that may exist in current code. Mixing the two would change scoring, calibration, shadow scores, and baseline compatibility.

ADR 0003 treats the analyzed repository as untrusted and forbids repository-owned LLM execution policy. ADR 0005 lets an operator profile supply LLM defaults, so a profile provider already enables semantic analysis without a CLI flag. `AnalyzerPlugin.extract()` is a deterministic `Evidence[]` contract, and `DiagnosisReport` / `DiffReport` are strict schemas.

## Decision

- Implement security checks as a built-in add-on in the same package. Do not register them as an `AnalyzerPlugin` or a Semantic Ambiguity input.
- Publish results as an independent `SecurityAssessment` (schema v1, analysis contract v1). Security results never feed the Regression Risk Score, Semantic Ambiguity, calibration, shadow scores, or core baseline fingerprints.
- A repository declaration (`addons.security`) is a request, not consent. Security execution requires an explicit `--security` / `--security-required` or an operator profile entry whose canonical repository root exactly matches the analyzed root.
- Separate add-on declarations from core configuration before hashing so that the core `inputId` and analysis context fingerprint do not change when a declaration is added.
- Reuse ACP through a purpose-neutral text port. Separate the provider `cwd` from untrusted repository roots, launch security sessions in an empty temporary directory, and treat provider/version combinations without verified confinement as `unavailable`.
- Wrap core reports in a versioned `AnalysisResult` envelope only for runs that requested the add-on. Runs without a request keep the existing output shape.
- Keep the initial release advisory: finding presence or severity never changes the exit code. Completion status and coverage state what was evaluated.

## Open questions before acceptance

1. Security-only execution. Provider selection is global (`llm` in the profile or `--llm-provider`), so enabling security also enables core semantic analysis, changes `config.llm`, and therefore changes the core `inputId` and analysis context fingerprint. Decide whether a security-specific provider setting is required for the first release.
2. Envelope trigger. A repository-only declaration resolves to `blocked`. If `blocked` alone produces the envelope, untrusted repository content can change the JSON shape consumed by existing CI jobs. Decide whether only operator-side requests may change the shape.
3. Exit code. `--security-required` is planned to exit `2` for incomplete checks, which is also the default code for `R3DoctorError` and uncaught errors. Decide whether incomplete checks need a distinct code.
4. Time budget. A 180 second total deadline for up to four batches is shorter than the existing per-prompt hard timeout plus ACP setup timeouts. Decide the per-batch deadline and default total.

## Consequences

- Core reports, report schema v2, baseline schema v4, diff schema v3, and assessment contract v4 remain unchanged.
- JSON consumers must recognize the `r3-doctor-analysis` envelope when the add-on is requested.
- Older readers reject repository configs and operator profiles that contain `addons`; operators must upgrade before adopting the declaration.
- Providers without verified confinement cannot run security checks even when semantic analysis works.
- A `completed` assessment states that the declared scope was processed. It is not a guarantee that the repository is secure.

## Alternatives

- Add a security axis or analyzer plugin: rejected because vulnerability candidates and regression risk have different meanings and would change scoring and compatibility.
- Treat an existing LLM provider setting as consent for security checks: rejected because security checks send additional code for a different purpose.
- Allow repository configs to enable execution: rejected by ADR 0003.
- Add an external plugin or service: deferred until independent release or central management is required.

## Enforcement

- Public contract: `tests/security/schema.test.ts` and [docs/spec/security-addon.md](../spec/security-addon.md).
- Core input identity: `tests/security/intake.test.ts`.
- Consent resolution and trusted profile loading: `tests/security/policy.test.ts` and `tests/security/trusted-profile.test.ts`.
- Provider launch boundary: `tests/security/acp-text-provider.test.ts` and `tests/semantic/acp-client.test.ts`.
- Repository-wide validation: `npm run validate`.
