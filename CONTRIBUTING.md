# Contributing to Outmapper

Thank you for contributing to Outmapper.

## Scope

Contributions should preserve the core product boundaries described in the public documentation, especially:

- portable canonical Project data;
- a renderer-independent domain model;
- offline-capable core workflows;
- accessibility and multilingual support;
- no mandatory proprietary hosted dependency.

Large changes to the Project format, domain model, security boundary, storage abstraction, or graph interaction model should be discussed in a [GitHub issue](https://github.com/anisaydar/outmapper/issues) before implementation.

## Development setup

Outmapper uses TypeScript, React, Vite, and a local Fastify server. Install Node.js 22.22.2 or newer, then install the locked dependency graph:

```text
npm ci
npm run dev
```

Working Projects must remain outside the repository. The application creates managed Projects in the platform data directory described in the README.

## Quality expectations

- Keep TypeScript strict and types explicit at public boundaries.
- Prefer small, cohesive changes over broad refactors.
- Preserve canonical data and migration compatibility.
- Keep platform-specific code behind the documented adapters.
- Do not couple UI components directly to runtime database schemas.
- Treat imported Project content as untrusted.
- Add tests for meaningful behavior and regressions rather than implementation details.
- Keep accessibility, Arabic RTL, Russian/Cyrillic, and mixed-direction text in scope when changing shared UI.

## Checks

Run the narrow checks for the files and behavior you changed. The common project checks are:

```text
npm run lint
npm run typecheck
npm test
npm run check:package
npm run test:browser
```

`npm run check:package` builds the production artifacts, confirms CLI help/version behavior, and audits `npm pack --dry-run` output against the explicit `files` allowlist. It never publishes the package. If a change affects import/export, Project migrations, graph projection, search, security validation, or offline behavior, run the associated focused checks as well.

Browser checks require Chrome or Chromium. Set `OUTMAPPER_BROWSER_PATH` to an absolute browser executable path when automatic discovery does not find it.

## Version and release hygiene

- Keep the application version in `package.json`, `package-lock.json`, and `src/version.ts` synchronized.
- Do not change the Project `formatVersion` for an application-only release. Project format changes require their own migration and compatibility review.
- Update `CHANGELOG.md` for user-visible changes.
- Do not create tags or publish npm/GitHub releases from an ordinary pull request.
- Inspect the package with `npm run check:package` before any authorized release.

## Private and local files

The shared `.gitignore` is reserved for build output, application runtime state, secrets, and development material that should be private for every contributor. For editor files or other machine-specific paths that are private only to you, add patterns to `.git/info/exclude` instead of expanding the shared ignore file. Never place credentials, private Projects, or user research material in the npm release allowlist.

## Pull requests

A pull request should:

- describe the user-visible or architectural change;
- explain any Project-format or migration impact;
- identify security implications where relevant;
- include tests or validation evidence appropriate to the change;
- confirm whether the application version or Project format is affected;
- avoid unrelated formatting or refactoring noise.

Commit messages should be short, imperative, and scoped to one logical change.
