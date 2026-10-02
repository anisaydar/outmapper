# Outmapper Project Format

## Purpose

The Outmapper Project format is the portable, durable contract for one knowledge universe. It must remain movable, inspectable, migratable, and usable independently of any specific runtime database.

The format identifier is:

```json
"format": "outmapper-project"
```

The transport/archive extension is:

```text
.outmapper
```

An `.outmapper` file is a ZIP-compatible transport representation of the working Project directory, not a separate semantic model.

## Working representation

The canonical working representation is a directory containing deterministic structured data, authored content, ordinary managed assets, theme data, and snapshot manifests.

The v1 filesystem shape is:

```text
my-project/
├── project.json
├── data/
│   ├── topics/records.json
│   ├── issues/records.json
│   ├── relationships/records.json
│   ├── knowledge/records.json
│   ├── associations/records.json
│   ├── assets/records.json
│   └── collections/records.json
├── content/
├── assets/
├── theme/
│   ├── theme.json
│   └── branding/
├── snapshots/records.json
└── .outmapper/
    ├── runtime.sqlite
    ├── extracted-text/
    ├── migration-backups/
    └── runtime/
```

Everything under `.outmapper/` is local recovery or derived runtime state, not canonical portable content. Portable exports exclude that directory.

Format version 1 groups each entity collection in a deterministic `records.json` file. Any incompatible change to that physical organization requires an explicit format migration.

## `project.json`

The root manifest defines Project identity and format metadata. Conceptually:

```json
{
  "format": "outmapper-project",
  "formatVersion": 1,
  "id": "...",
  "title": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "revision": 184,
  "defaultLocale": "en",
  "defaultDirection": "auto",
  "publishedSnapshotId": "..."
}
```

Fields may evolve through explicit format migrations.

## Stable IDs

Entity references use stable opaque IDs. Filenames, titles, slugs, display order, and physical asset names do not serve as semantic identity.

Stable IDs support:

- deterministic references;
- imports and exports;
- publication snapshots;
- compatibility across imports, exports, and migrations;
- safe renaming.

## Deterministic serialization

Canonical serialization should be deterministic where practical:

- stable property ordering in generated JSON;
- stable ordering of records or indexes;
- normalized line endings where the application writes files;
- no runtime timestamps or random ordering inserted merely by opening a Project;
- stable tie-breakers for authored order.

This improves inspection, backups, testing, and optional Git use without making Git a user requirement.

## Paths

All canonical file references are Project-relative logical paths or stable asset IDs.

Normal v1 Projects must not depend on machine-specific absolute paths such as:

```text
C:\Users\name\Desktop\paper.pdf
/home/name/Downloads/paper.pdf
```

Path normalization is performed during validation/import before any file is accepted into a live Project.

## Assets

Imported local assets are streamed into `assets/<stable-asset-id>/<safe-filename>` inside the Project. Replacing current content creates a new Asset identity; old immutable identities remain available to retained Published Snapshots.

Asset metadata includes:

- stable ID;
- relative path;
- original filename;
- MIME type;
- byte size;
- SHA-256;
- optional dimensions/duration;
- import metadata where useful.

Format version 1 does not require physical content-addressed deduplication. SHA-256 integrity metadata is required for managed Assets.

Large assets should be streamed and must not require archive-size-proportional JavaScript memory use.

## Authored content

Textual bodies may live in structured fields or external authored content files such as Markdown where that improves readability and editing. The durable contract must specify which representation owns the content to avoid duplicated sources of truth.

PDF extraction, thumbnails, transcodes, and search-normalized text are derived/runtime data unless an explicit authored-content operation promotes them into canonical content. Current PDF extraction records live under `.outmapper/extracted-text/`, include the source Asset ID and SHA-256, and are ignored when missing, corrupt, failed, or stale.

## Validation

The portable contract uses JSON Schema 2020-12 and is validated with Ajv.

Validation occurs at several levels:

1. archive/path safety;
2. structural schema validation;
3. referential/domain validation;
4. migration eligibility;
5. semantic checks required before publication.

Runtime TypeScript types complement but do not replace the external schema contract.

## Format versions and migrations

Every Project declares `formatVersion`.

Migrations are explicit and deterministic:

```text
N -> N+1 -> N+2
```

A migration must not silently reinterpret old durable data only in memory. Successful migration produces the new canonical representation.

Before attempting an older-format migration, the application creates a content-addressed recoverable copy of the canonical records under `.outmapper/migration-backups/`. A failed or unavailable migration leaves both the original canonical files and that backup unchanged.

Migration interruption must not leave the only durable Project copy partially converted.

## Transport package

An `.outmapper` package uses streaming ZIP/Zip64-compatible transport.

Portable exports normally exclude:

- derived SQLite databases;
- FTS indexes;
- document extraction caches;
- generated thumbnails that are safely reproducible;
- transient layout/runtime caches;
- temporary/staging files.

The v1 package includes `.outmapper-package.json`, which records package format information and SHA-256/size integrity data for exported entries. Derived `.outmapper/` content is excluded.

## Import staging

Imports never extract directly over a live Project.

```text
package/directory
 -> isolated staging
 -> archive safety checks
 -> structural validation
 -> migrations if required
 -> referential/domain validation
 -> import preview/report
 -> commit to canonical Project
 -> derived index rebuild
```

Invalid or hostile input is rejected before it can escape staging or execute active content.

## Missing or damaged assets

A missing asset does not erase the entity that refers to it.

The application:

- preserve metadata;
- surface the asset as missing/unavailable;
- identify the broken reference;
- keep publication/snapshot integrity explicit.

## Corruption and recovery

Canonical data is designed so damage can be diagnosed at entity/file granularity where practical. Derived runtime state can be discarded and rebuilt.

Opening a damaged Project favors validation errors over silently mutating canonical data.

## Git friendliness

Git compatibility is desirable but optional. The format should minimize noisy rewrites and unstable ordering while avoiding design choices that make ordinary users depend on Git.
