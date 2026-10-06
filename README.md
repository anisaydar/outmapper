![Outmapper launch film: scattered research gathers into a knowledge map, follows a thread across Topics, opens the Universe of Projects, and ends on npx outmapper@latest](.github/assets/outmapper-launch.avif)

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
- links and portals between separate Projects, with a Universe view of their connections;
- search across one Project or all registered Projects and supported document content;
- English, Arabic, and Russian interfaces;
- desktop, tablet, and mobile use;
- a localhost runtime without mandatory proprietary cloud services.

Outmapper treats the visual map as a projection over the knowledge model. The renderer is not the source of truth, and Project data is kept separate from runtime indexes and caches.

## Status

Outmapper 0.2.0 runs locally through a CLI and browser interface, with portable Projects stored on the user's filesystem and connected through a machine-local workspace registry.

The application release version is independent from the portable Project format. New and migrated Projects use `formatVersion: 2`.

## Quickstart

Requires **Node.js >=22.22.2**. Node 22.22.2 and Node 24 are supported. Choose either launch option.

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
npx outmapper@latest --project "../my-project"
```

With a global installation, replace `npx outmapper@latest` in those examples with `outmapper`.

User Projects never live in the installed npm package or npm cache. The default managed Project directory is:

- Windows: `%LOCALAPPDATA%\Outmapper\Projects`
- macOS: `~/Library/Application Support/Outmapper/Projects`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/Outmapper/Projects`

Use `OUTMAPPER_DATA_DIR` to move all managed application data or `OUTMAPPER_PROJECT_DIR`/`--project` to open an existing Project.

### Build your first connected maps

1. Open **Settings → Projects → New Project...**, enter a title, and choose **Create Project**. Use **Add Topic** to create the first Topic.
2. Choose **Edit** to enter Studio. Edit the title and description, add Key Issues and Knowledge, or choose **New Topic** to start another Topic. Changes autosave; **Done** returns to the map.
3. In a Key Issue's **Relationships**, use **Find or create a Topic** to link an existing Topic or **Create and link new Topic…**. Choose **Upload cover**, **Replace cover**, or **Remove cover** to edit a Topic or Key Issue cover.
4. Create a second Project, then return to the first. Edit a Key Issue and choose **Link another Project…** to connect them. Open its portal to move between Projects.
5. Open **Universe** beside Search to see your Projects and their connections. In Search, choose **All Projects** to find content across registered Projects. **Back**, **Forward**, and **History** revisit Topics, Projects, and Universe.
6. Open **Settings → Current Project → Project settings… → Save as copy...** for an independent Project copy, or choose **Export Project file…** for a portable backup. When importing an already registered Project, **Import as a copy** assigns a new Project identity; **Import anyway** keeps the existing identity.

Projects remain separate files and folders when linked. All Projects search uses existing indexes; open a Project once if it is reported as not searchable. **Save as copy...** also assigns a new Project identity. Folders copied outside Outmapper share their original identity until you choose **Give this copy its own identity** in the copy chooser.

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
OUTMAPPER_PROJECT_DIR=../my-project
OUTMAPPER_PORT=4173
OUTMAPPER_HOST=127.0.0.1
OUTMAPPER_DATA_DIR=../outmapper-data
```

Only `127.0.0.1` and `::1` are accepted as server hosts.

The environment-variable block lists names and example values; set them using your shell's syntax. Keep working Projects and application data outside the source checkout or installed package.

## Features

- **Connected Projects:** Project Links and incoming/outgoing portals connect independently stored maps; Universe shows their connections, availability, and folder copies.
- **Studio authoring:** edit Topics, Key Issues, descriptions, Knowledge, and attachments with autosave, Undo/Redo, New Topic, create-and-link Topics, Home Topic selection, reordering, and Project settings.
- **Cover editing:** upload, replace, or remove PNG, JPEG, and still WebP covers. Key Issues inherit their Topic's cover unless given their own.
- **Navigation:** Back, Forward, and History work across Topics, Projects, and Universe, with keyboard controls and preserved Project editing histories.
- **Workspace search:** This Project and All Projects search cover Topics, Key Issues, Knowledge, metadata, and indexed PDF text. Results identify their source Project and flag unavailable or stale indexes.
- **Portable backups and copies:** export `.outmapper` files, validate imports before committing, import duplicates as independent copies, or save a folder copy. Exports include referenced Assets and leave linked Projects separate.
- **Local files:** review folder imports with type filters, duplicate handling, progress, and cancellation. Original files are preserved; managed attachments stream from the Project folder.
- **Offline operation:** local autosave, recovery, SQLite search, and background PDF extraction run through localhost without mandatory cloud services. External source links still require internet access.
- **Accessible views:** responsive Viewer and Studio interfaces in English, Arabic, and Russian, with RTL, light/dark themes, keyboard navigation, and reduced motion.

PDF extraction is derived data under `.outmapper/extracted-text/`; it is excluded from portable exports and rebuilt independently of canonical Project content.

## Verification

```text
npm run lint
npm run typecheck
npm test
npm run build
npm run check:package
npm run test:browser
npm run test:browser:authoring
npm run test:browser:workspace
npm run test:browser:features
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

Outmapper is licensed under the [Apache License 2.0](LICENSE). The bundled AI Landscape map, original reading notes, and translations use the same license. Linked external publications and datasets retain their owners' licenses and are not bundled copies. User-created Project content remains separately licensed by its owners; Outmapper's software license does not impose a license on Project content. The copyright notice is recorded in [NOTICE](NOTICE), and third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
