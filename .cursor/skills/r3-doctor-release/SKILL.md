---
name: r3-doctor-release
description: >-
  Prepares and publishes r3-doctor npm releases: version bump, CHANGELOG,
  validate, pack, tag, GitHub Release, and npm publish. Use when the user asks
  to release, publish, bump version, ship a version, cut a tag, or run the
  r3-doctor release workflow.
disable-model-invocation: true
---

# r3-doctor Release

Guides the **Regression Risk Recovery Doctor** release workflow for the
`r3-doctor` npm CLI. Enforcement lives in CI and npm; this skill only
orchestrates the steps and routes to project docs.

Repository: [kaz-toc/r3-doctor](https://github.com/kaz-toc/r3-doctor)

## Prerequisites

- Node.js 22+ (`.nvmrc` → worktree Node via `project-node-runtime`)
- `pnpm` bootstrapped in the active nvm bin (`corepack enable pnpm` then
  `project-node-runtime-refresh` if `npm` is blocked)
- `npm run validate` passes on `main`
- npm account with publish rights to **`r3-doctor`**
- GitHub secrets when using CI publish: `NPM_TOKEN`
- Optional LLM CI: repository variable `R3_DOCTOR_LLM_INTEGRATION=1`, secret
  `OPENAI_API_KEY`

If `npm` is blocked with `project-node-runtime: blocked 'npm'`, fix the runtime
before continuing — do not bypass with raw paths unless the operator explicitly
asks.

## Release checklist

Copy and track progress:

```text
- [ ] Decide semver bump (patch / minor / pre-release)
- [ ] Update package.json version
- [ ] Update src/cli.ts Commander .version() to match
- [ ] Update CHANGELOG.md ([Unreleased] → new section)
- [ ] Update README install examples if version pinned
- [ ] npm install --package-lock-only (refresh lockfile)
- [ ] npm run validate
- [ ] npm pack --dry-run (dist/, README.md, LICENSE only)
- [ ] Commit on main (version + changelog)
- [ ] Push main; wait for Governance CI
- [ ] git tag -a vX.Y.Z && git push origin vX.Y.Z
- [ ] gh release create vX.Y.Z
- [ ] npm publish --access public (or npm publish workflow)
- [ ] Verify: npx r3-doctor@X.Y.Z scan . --format json
```

## Semver guidance

| Change | Bump |
| --- | --- |
| Docs, release skill, branding copy | **patch** (0.1.x) |
| New commands, report fields, non-breaking CLI flags | **minor** (0.x.0) |
| Breaking config paths, schema kind, removed commands | **major** when ≥1.0; else **minor** while 0.x |

Package name is **`r3-doctor`**. Config lives in `r3-doctor.config.json`;
persistence in `.r3-doctor/`. Do not reintroduce `reg-score` names.

## Workflow

### 1. Version bump

Edit in one commit:

- [package.json](../../package.json) — `"version"`
- [src/cli.ts](../../src/cli.ts) — `.version('X.Y.Z')`
- [CHANGELOG.md](../../CHANGELOG.md) — new section with date
- [README.md](../../README.md) — pinned `npx r3-doctor@X.Y.Z` examples
- [.github/workflows/npm-publish.yml](../../.github/workflows/npm-publish.yml) — `default` input (optional)

Then:

```bash
npm install --package-lock-only
```

### 2. Verify artifact

```bash
npm run validate
npm pack --dry-run
npm run r3-doctor -- scan . --format markdown
```

Tarball must include only `dist/`, `README.md`, `LICENSE` (see
[tests/package.test.ts](../../tests/package.test.ts)).

### 3. Land on main

```bash
git checkout main
git pull origin main
# commit version bump
git push origin main
```

Wait for **Governance CI** on the release commit.

### 4. Tag and GitHub Release

```bash
git tag -a vX.Y.Z -m "r3-doctor X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z \
  --repo kaz-toc/r3-doctor \
  --title "vX.Y.Z" \
  --notes-file CHANGELOG.md
```

Use the matching `[X.Y.Z]` section from CHANGELOG, not the whole file, when
notes should be scoped.

### 5. Publish to npm

**Local (first publish or when CI token unavailable):**

```bash
npm login
npm publish --access public
```

**CI (subsequent releases):**

GitHub Actions → **npm publish** → set `version` to match `package.json` exactly
→ Run workflow. Requires `NPM_TOKEN` secret.

### 6. Post-release verify

```bash
npm view r3-doctor version
npx r3-doctor@X.Y.Z scan . --format json
```

## CLI mapping

| User intent | Action |
| --- | --- |
| Prepare a release | Follow checklist §Release checklist |
| Bump patch/minor | Edit version files → validate → commit |
| Check package contents | `npm pack --dry-run` |
| Fix blocked npm | `corepack enable pnpm` → `project-node-runtime-refresh` |
| Publish locally | `npm publish --access public` |
| Publish via CI | Actions → **npm publish** |
| Tag + GitHub Release | `git tag` + `gh release create` |
| Full runbook | [docs/operations/RELEASE.md](../../docs/operations/RELEASE.md) |

## Do not

- Publish without a matching git tag and CHANGELOG entry
- Change `Regression Risk Score` metric naming in user-facing docs
- Add compatibility shims for `reg-score` unless explicitly requested
- Run `npm publish` or create tags without user confirmation when credentials
  are missing

## Additional resources

- [RELEASE.md](../../docs/operations/RELEASE.md) — operator runbook
- [ROADMAP.md](../../ROADMAP.md) §7 — first public release boundary
- [CHANGELOG.md](../../CHANGELOG.md) — version history
