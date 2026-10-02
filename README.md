![Outmapper — open-source intelligence and knowledge mapping](https://github.com/anisaydar/outmapper/raw/main/.github/assets/outmapper-cover.webp)

# Outmapper

Outmapper is an open-source local platform for building and exploring interconnected intelligence and knowledge maps. After dependencies and build assets are available, the application runs without external internet access; its browser UI talks only to the loopback server.

Its core view centers one **Topic**, places that Topic's **Key Issues** on an inner ring, and places **Related Topics** on an outer ring. The map is paired with a contextual **Knowledge Panel** that keeps descriptions, sources, documents, media, datasets, notes, and other supporting material close to the relationships they explain.

## Goals

Outmapper is designed to support:

- local, offline-first research and curation;
- portable Projects that remain understandable outside the application;
- interactive Topic → Key Issue → Related Topic exploration;
- contextual knowledge collections attached to Topics and Key Issues;
- integrated Viewer and Studio editing modes;
- search across graph entities and supported document content;
- English, Arabic, and Russian interfaces;
- desktop, tablet, and mobile use;
- a localhost runtime without mandatory proprietary cloud services.

Outmapper treats the visual map as a projection over the knowledge model. The renderer is not the source of truth, and Project data is kept separate from runtime indexes and caches.

## Status

Outmapper 0.1.0 is the initial open-source release. It runs locally through a CLI and browser interface, with Projects stored on the user's filesystem.

The application release version is independent from the portable Project format, which remains at `formatVersion: 1`.

## Quickstart

Requires Node.js 22.22.2 or newer. Choose either launch option.

### Installation-free

```text
npx outmapper@latest
```

`npx` may cache the downloaded package, but you still invoke Outmapper with the full `npx outmapper@latest` command each time.

### Persistent global command

```text
npm install --global outmapper@latest
outmapper
```

A global installation provides the shorter persistent `outmapper` command. Manage that installation with:

```text
npm update --global outmapper
npm uninstall --global outmapper
```

The CLI does not create operating-system shortcuts.

Outmapper starts a loopback-only local server and opens the default browser. It prefers `http://127.0.0.1:4173`; if that default is already occupied, it selects a free local port without interrupting the existing process. Press `Ctrl+C` in the terminal for a clean shutdown.

Useful CLI commands:

```text
npx outmapper@latest --help
npx outmapper@latest --version
npx outmapper@latest --no-open
npx outmapper@latest --port 4310
npx outmapper@latest --project "C:\path\to\project"
```

With a global installation, replace `npx outmapper@latest` in those examples with `outmapper`.

User Projects never live in the installed npm package or npm cache. The default managed Project directory is:

- Windows: `%LOCALAPPDATA%\Outmapper\Projects`
- macOS: `~/Library/Application Support/Outmapper/Projects`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/Outmapper/Projects`

Use `OUTMAPPER_DATA_DIR` to move all managed application data or `OUTMAPPER_PROJECT_DIR`/`--project` to open an existing Project.

## Develop from source

```text
npm ci
npm run dev
```

The development client and API bind to loopback addresses. To exercise the prebuilt production path locally:

```text
npm run build
npm start
```

Canonical JSON and Project-owned assets remain authoritative. The native SQLite database under `.outmapper/` is derived and can be deleted and rebuilt from canonical data.

Useful environment variables:

```text
OUTMAPPER_PROJECT_DIR=C:\path\to\project
OUTMAPPER_PORT=4173
OUTMAPPER_HOST=127.0.0.1
OUTMAPPER_DATA_DIR=C:\path\to\outmapper-data
```

Only `127.0.0.1` and `::1` are accepted as server hosts.

## Features

- create, open, and revisit local Projects from the application;
- create and edit Topics and Key Issues with autosaved changes and session undo/redo;
- add notes, articles, research papers, videos, datasets, links, and file attachments to contextual Knowledge collections;
- preview and import supported files from a selected folder with type filters, duplicate indicators, progress, and cancellation;
- portable `.outmapper` backup/export and staged import into a new Project directory;
- native SQLite full-text search across Topics, Key Issues, Knowledge, metadata, and extracted PDF text;
- streamed Project-owned assets with stable IDs, SHA-256 metadata, bounded uploads, safe response headers, and byte ranges;
- background PDF.js extraction with explicit encrypted, malformed, limit, and cancellation outcomes;
- autosave, bounded session undo/redo, recovery checkpoints, migration backups, and immutable publication manifests;
- responsive Viewer and Studio interfaces in English, Arabic, and Russian, including RTL and reduced motion.

PDF extraction is derived data under `.outmapper/extracted-text/`; it is excluded from portable exports and rebuilt independently of canonical Project content.

## Verification

```text
npm run lint
npm run typecheck
npm test
npm run check:package
npm run test:browser
npm run check:pdf
npm run check:responsive-layout
npm run check:offline-release
```

`check:package` builds the precompiled CLI and performs an `npm pack --dry-run` allowlist audit; it does not publish anything. Browser checks discover Chrome/Chromium on Windows, macOS, and Linux. Set `OUTMAPPER_BROWSER_PATH` when the executable is installed elsewhere. `check:offline-release` blocks external browser requests while retaining localhost access.

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Project format](docs/project-format.md)
- [Security model](docs/security-model.md)
- [Glossary](docs/glossary.md)
- [UI reference](docs/ui-reference.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

Project links:

- [Source repository](https://github.com/anisaydar/outmapper)
- [Issue tracker](https://github.com/anisaydar/outmapper/issues)
- [Private vulnerability reporting](https://github.com/anisaydar/outmapper/security/advisories/new)

## License

Copyright 2026 Anis Aydar.

Outmapper is licensed under the [Apache License 2.0](LICENSE). User-created Project content remains separately licensed by its owners; Outmapper's software license does not impose a license on Project content. The copyright notice is recorded in [NOTICE](NOTICE), and bundled third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
