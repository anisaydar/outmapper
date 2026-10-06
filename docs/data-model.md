# Outmapper Data Model

## Principles

The canonical model expresses knowledge and authorship, not rendering implementation. IDs are stable and opaque. User-visible names and slugs are editable and never serve as referential identity.

`RelatedTopic` is **not** a stored entity class. It is a Topic occupying a contextual role in a `GraphProjection`.

## Project

**Responsibility:** portability and isolation boundary for one knowledge universe.

Required fields:

- `format`
- `id`
- `formatVersion`
- `title`
- `createdAt`
- `updatedAt`
- `revision`

Optional fields are `description`, `defaultLocale`, `defaultDirection`, `homeTopicId`, `themeId`, `publishedSnapshotId`, and `contentLicense`.

Invariants:

- Topic Relationships remain inside one Project;
- connections to another Project use Project Links and never merge the Projects;
- all canonical references resolve within the Project or are explicitly external references;
- mutation advances the canonical revision.

Projects are created, edited, exported, imported, copied, and migrated. Retained snapshot metadata remains compatible with the portable format.

The portable format is version 2. Workspace registration, folder locations, preferred instances, incoming backlinks, navigation history, and Universe layout are deliberately outside this boundary.

## Topic

**Responsibility:** persistent navigable subject in the graph.

Required:

- `id`
- `title`
- `createdAt`
- `updatedAt`

Common optional fields:

- `description`;
- `visualAssetId`;
- `metadata`;
- `tags`.

Invariants:

- Topic identity is stable even if title changes;
- a Topic may be central in one projection and related in another;
- cycles are valid.

Topic deletion confirms removal of its dependent Key Issues, local relationships, Project Links, and Knowledge Associations. Other Projects and shared Knowledge Items are preserved.

## KeyIssue

**Responsibility:** contextual facet belonging to one Topic/map.

Required:

- `id`
- `topicId`
- `title`
- `order`
- `createdAt`
- `updatedAt`

Optional:

- `description`;
- `visualAssetId`;
- `metadata`.

Invariants:

- a KeyIssue belongs to exactly one parent Topic;
- it does not become the central Topic;
- it may connect its parent Topic to many target Topics;
- orphaned Key Issues fail validation.

## TopicRelationship

**Responsibility:** explicit relationship from a parent Topic through one of its Key Issues to a target Topic.

Required:

- `id`
- `sourceTopicId`
- `keyIssueId`
- `targetTopicId`
- `createdAt`
- `updatedAt`

Optional:

- `order`;
- `relationType`;
- `note`;
- `metadata`.

Invariants:

- `keyIssueId` belongs to `sourceTopicId`;
- target and source Topics exist in the same Project;
- multiple relationship records may target the same Topic through different Key Issues;
- the relationship does not persist renderer coordinates.

## ProjectLink

**Responsibility:** authored outgoing portal from a Topic's Key Issue to another independently stored Project.

Required:

- `id`
- `sourceTopicId`
- `keyIssueId`
- `targetProjectId`
- `cachedProjectTitle`
- `createdAt`
- `updatedAt`

Optional:

- `targetTopicId` (absent means the target's Home Topic at open time);
- `cachedTopicTitle`;
- shared target `order`;
- note;
- metadata.

Invariants:

- the source Topic and Key Issue exist, and the Key Issue belongs to that Topic;
- the target Project ID differs from the source Project ID;
- a Key Issue cannot contain duplicate links to the same Project and target Topic;
- cached titles change only when the link is edited;
- target folders and other machine paths are never canonical Project data.

Topic Relationships and Project Links use one authored order under each Key Issue. Deletion never cascades into a linked external Project.

An incoming Project portal is not canonical data. It is a derived reversal of a registered source Project's cached outgoing `ProjectLink`. If `targetTopicId` is absent or no longer resolves, the portal belongs to the target's current Home Topic.

## KnowledgeItem

**Responsibility:** generic record representing knowledge or a reference to knowledge.

Minimum stable fields:

- `id`
- `type`
- `title`
- `availability` (`local` or `external`)
- `createdAt`
- `updatedAt`

Common optional fields:

- `summary`
- authored body/content reference;
- `externalUrl`
- authors;
- source/provenance;
- `publishedAt`
- tags;
- attachment asset IDs;
- language metadata;
- type-specific/custom metadata.

Knowledge records describe notes, articles, research papers, links, videos, datasets, books, and managed file attachments. Folder import recognizes supported documents and creates corresponding Knowledge records. Attachments remain files; imported content cannot execute application code.

A KnowledgeItem may represent either locally contained content or an external reference. The state must be explicit so the UI never implies an external item is available offline.

Imported KnowledgeItem content is data, not executable application code.

## KnowledgeAssociation

**Responsibility:** attach a KnowledgeItem to a Topic or KeyIssue without duplicating the item.

Required:

- `id`
- `knowledgeItemId`
- target entity kind: `topic | keyIssue`
- target entity ID.

Optional:

- `pinned`
- authored order
- collection IDs
- contextual note/metadata.

Pinned state is contextual to the association rather than an intrinsic global property of the KnowledgeItem.

## Asset

**Responsibility:** managed binary or file resource owned by a Project.

Required:

- `id`
- Project-relative path
- original filename
- MIME type
- byte size
- SHA-256 integrity metadata;
- `createdAt`.

Optional:

- width/height;
- duration;
- `metadata`.

Assets are copied into the Project by default. Absolute machine paths are not normal Project references.

An exported package includes only Assets referenced by a Topic or Key Issue visual, a Knowledge Item attachment, Theme branding, or a Published Snapshot. The local Project retains unused Asset records and files; export hygiene does not delete them.

Published Snapshots refer to immutable asset identities. Replacing bytes that matter to a published state creates a new asset identity/version rather than mutating published history in place.

## Collection

**Responsibility:** user-defined grouping of Knowledge Items or associations.

Required:

- `id`
- `title`

Optional:

- description;
- order;
- metadata.

System presentation sections such as Pinned, Publications, Videos, Data, and Notes are derived from association state and KnowledgeItem type; they do not require each section to be persisted as a Collection.

## Theme

**Responsibility:** declarative Project presentation configuration.

Required fields are `id`, `name`, and a JSON `tokens` object. The optional `brandingAssetIds` list references managed Assets.

Theme data must not contain executable JavaScript or arbitrary trusted CSS.

## PublishedSnapshot

**Responsibility:** immutable publication record tied to a known canonical Project revision.

Required:

- `id`
- `revision`
- `publishedAt`
- `manifestPath`
- `assetIds`.

Optional:

- title/note;
- `metadata`.

The default retention policy is the current Published Snapshot plus the 10 most recent prior Published Snapshots.

## Multilingual content

Project content is Unicode and independent of the selected interface locale. Content may use any language. Direction and language metadata may be stored where known, but graph identity and geometry do not depend on language.

The interface locales are English (`en`), Arabic (`ar`), and Russian (`ru`). Arabic is RTL; English and Russian are LTR.

## Workspace registry (noncanonical)

The machine-local registry stores one entry per known folder instance:

- `instanceId`, canonical directory, and Project ID;
- cached title, description, Home Topic, Home cover path/MIME type, format version, and revision;
- canonical file fingerprints and availability status;
- first-seen, last-seen, and last-opened timestamps;
- Recent-list visibility;
- cached outgoing Project Links with source Topic and Key Issue titles.

`preferredInstance` resolves duplicate folders that carry the same Project ID. The Universe aggregates entries by Project ID. Incoming portals are rebuilt in memory from all registered entries. Neither is written to a Project folder.

Federated search results add `sourceInstanceId`, `sourceProjectId`, `sourceProjectTitle`, and an optional `mayBeOutOfDate` flag. Page metadata can mark totals as capped, results as incomplete, supply a continuation, and count stale or not-yet-searchable Projects.

## Timestamps

Keep source chronology separate from Project chronology:

- `publishedAt`: when the source says material was published;
- `createdAt`: when the Outmapper entity was created;
- `updatedAt`: when the entity was materially updated;

No dedicated chronological Knowledge UI mode is implied by these fields.

## Deletion semantics

Topic and Key Issue deletion requires confirmation. It removes dependent local relationships, outgoing Project Links, and contextual Knowledge Associations, without deleting another Project or unrelated shared Knowledge Items. Session Undo can restore an authored deletion while the corresponding history remains available.

Removing a Knowledge Item from one context removes its association. Removing it everywhere removes its associations and record. Managed Assets are retained locally; portable export selects only referenced Assets, including those retained by snapshots.
