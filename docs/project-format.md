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

The v2 filesystem shape is:

```text
my-project/
├── project.json
├── data/
│   ├── topics/records.json
│   ├── issues/records.json
│   ├── relationships/records.json
│   ├── project-links/records.json
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

Format version 2 groups each entity collection in a deterministic `records.json` file. Any incompatible change to that physical organization requires an explicit format migration.

## `project.json`

The root manifest defines Project identity and format metadata. Conceptually:

```json
{
  "format": "outmapper-project",
  "formatVersion": 2,
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

Canonical serialization uses:

- stable property ordering in generated JSON;
- stable ordering of records or indexes;
- normalized line endings where the application writes files;
- no runtime timestamps or random ordering inserted merely by opening a Project;
- stable tie-breakers for authored order.

This improves inspection, backups, testing, and optional Git use without making Git a user requirement.

## Paths

All canonical file references are Project-relative logical paths or stable asset IDs.

Validation rejects machine-specific absolute paths, parent-directory traversal, and paths that escape the Project folder.

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

Format version 2 does not require physical content-addressed deduplication. SHA-256 integrity metadata is required for managed Assets.

## Project links

`data/project-links/records.json` stores authored outgoing links to other independently portable Projects. A Project Link records its source Topic and Key Issue, the target Project ID, an optional target Topic ID, cached display titles, shared target order, an optional note and metadata, and timestamps. Omitting `targetTopicId` means “use the target Project's Home Topic when opened.”

Project Links never store a target folder or machine path. Machine-local discovery and preferred-copy choices belong to the workspace registry outside every Project. External Projects are not embedded in exports.

Assets stream during import and export, with bounded archive and entry limits.

## Authored content

Notes and edited Knowledge text are stored in structured body fields. Imported Markdown and text files are preserved as managed attachments, and their text is also recorded in the corresponding Knowledge Item for display and search.

PDF extraction, thumbnails, transcodes, and search-normalized text are derived/runtime data unless an explicit authored-content operation promotes them into canonical content. Current PDF extraction records live under `.outmapper/extracted-text/`, include the source Asset ID and SHA-256, and are ignored when missing, corrupt, failed, or stale.

## Validation

The portable contract uses JSON Schema 2020-12 and is validated with Ajv.

Validation occurs at several levels:

1. archive/path safety;
2. structural schema validation;
3. referential/domain validation;
4. migration eligibility;
5. semantic checks for retained snapshot records and referenced Assets.

Runtime TypeScript types complement but do not replace the external schema contract.

## Format versions and migrations

Every Project declares `formatVersion`.

Migrations are explicit and deterministic:

```text
N -> N+1 -> N+2
```

A Project is migrated in memory when opened. The migrated canonical representation is persisted atomically on the next save, so read-only inspection never modifies Project files.

### Format history

- **v1:** initial canonical record collections.
- **v2:** adds `data/project-links/records.json` and the `projectLinks` collection. The v1→v2 migration supplies an empty collection.

## Transport package

An `.outmapper` package uses streaming ZIP/Zip64-compatible transport.

Portable exports normally exclude:

- derived SQLite databases;
- FTS indexes;
- document extraction caches;
- generated thumbnails that are safely reproducible;
- transient layout/runtime caches;
- temporary/staging files.

The package includes `.outmapper-package.json`, which records package format information and SHA-256/size integrity data for exported entries. Derived `.outmapper/` content is excluded. A v1 Project package is migrated during import validation and committed in v2 form.

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

When the imported Project identity is already registered, **Import as a copy** creates a new identity and **Import anyway** preserves the existing one. Both write to a new directory. **Save as copy...** copies the active Project into another folder with a new identity. Folders copied outside Outmapper retain their identity; **Give this copy its own identity** can separate them later. Linked external Projects are never copied into the package.

## Missing or damaged assets

A missing asset does not erase the entity that refers to it.

The application:

- preserves metadata;
- surfaces the asset as missing/unavailable;
- identifies the broken reference;
- checks retained snapshot references during validation.

## Corruption and recovery

Canonical data is designed so damage can be diagnosed at entity/file granularity where practical. Derived runtime state can be discarded and rebuilt.

Opening a damaged Project favors validation errors over silently mutating canonical data.

## Git friendliness

Deterministic records and stable ordering make Project changes inspectable in Git. Outmapper does not require Git to create, edit, or move Projects.
