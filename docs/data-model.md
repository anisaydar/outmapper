# Outmapper Data Model

## Principles

The canonical model expresses knowledge and authorship, not rendering implementation. IDs are stable and opaque. User-visible names and slugs are editable and never serve as referential identity.

`RelatedTopic` is **not** a stored entity class. It is a Topic occupying a contextual role in a `GraphProjection`.

## Project

**Responsibility:** portability and isolation boundary for one knowledge universe.

Required conceptual fields:

- `id`
- `formatVersion`
- `title`
- `createdAt`
- `updatedAt`
- `revision`

Optional fields may include description, default content locale, theme reference, published snapshot reference, and Project/content-license metadata.

Invariants:

- graph relationships do not cross Project boundaries in format version 1;
- all canonical references resolve within the Project or are explicitly external references;
- mutation advances the canonical revision.

Lifecycle: created, edited, exported/imported, migrated, archived/backed up, optionally published.

## Topic

**Responsibility:** persistent navigable subject in the graph.

Required:

- `id`
- `title`

Common optional fields:

- description/body reference;
- visual/asset reference;
- metadata;
- tags;
- created/updated timestamps.

Invariants:

- Topic identity is stable even if title changes;
- a Topic may be central in one projection and related in another;
- cycles are valid.

Deletion must surface dependent Key Issues, relationships, Knowledge Associations, and publication consequences before permanent removal.

## KeyIssue

**Responsibility:** contextual facet belonging to one Topic/map.

Required:

- `id`
- `topicId`
- `title`
- `order`

Optional:

- description/body reference;
- visual/asset reference;
- metadata;
- timestamps.

Invariants:

- a KeyIssue belongs to exactly one parent Topic in format version 1;
- it does not become the central Topic;
- it may connect its parent Topic to many target Topics;
- orphaned Key Issues should be treated as invalid or recoverable authoring errors rather than normal published data.

## TopicRelationship

**Responsibility:** explicit relationship from a parent Topic through one of its Key Issues to a target Topic.

Required:

- `id`
- `sourceTopicId`
- `keyIssueId`
- `targetTopicId`

Optional:

- authored order or tie-break hint;
- relation type;
- note/label;
- provenance metadata;
- timestamps.

Invariants:

- `keyIssueId` belongs to `sourceTopicId`;
- target and source Topics exist in the same Project;
- multiple relationship records may target the same Topic through different Key Issues;
- the relationship does not persist renderer coordinates.

## KnowledgeItem

**Responsibility:** generic record representing knowledge or a reference to knowledge.

Minimum stable fields:

- `id`
- `type`
- `title`
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

Supported Knowledge families include articles, links, Markdown/text, PDFs, local files, images, video, audio, datasets, research papers, notes, books, attachments, and explicitly supported structured/interactive references.

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
- SHA-256 integrity metadata.

Optional:

- width/height;
- duration;
- imported/created metadata;
- source metadata.

Assets are copied into the Project by default. Absolute machine paths are not normal Project references.

Published Snapshots refer to immutable asset identities. Replacing bytes that matter to a published state creates a new asset identity/version rather than mutating published history in place.

## Collection

**Responsibility:** user-defined grouping of Knowledge Items or associations.

Required:

- `id`
- `title`

Optional:

- description;
- order;
- metadata;
- visual treatment.

System presentation sections such as Pinned, Publications, Videos, Data, and Notes are derived from association state and KnowledgeItem type; they do not require each section to be persisted as a Collection.

## Theme

**Responsibility:** declarative Project presentation configuration.

May define constrained tokens such as colors, typography references, spacing/density, node treatments, edge treatments, panel appearance, logos/branding assets, and light/dark preferences.

Theme data must not contain executable JavaScript or arbitrary trusted CSS.

## PublishedSnapshot

**Responsibility:** immutable publication record tied to a known canonical Project revision.

Required:

- `id`
- Project revision
- created/published timestamp
- manifest or snapshot state reference
- referenced immutable asset identities.

Optional:

- title/note;
- publication metadata;
- deployment/export metadata.

The default retention policy is the current Published Snapshot plus the 10 most recent prior Published Snapshots.

## Multilingual content

Project content is Unicode and independent of the selected interface locale. Content may use any language. Direction and language metadata may be stored where known, but graph identity and geometry do not depend on language.

The interface locales are English (`en`), Arabic (`ar`), and Russian (`ru`). Arabic is RTL; English and Russian are LTR.

## Timestamps

Keep source chronology separate from Project chronology:

- `publishedAt`: when the source says material was published;
- `createdAt`: when the Outmapper entity was created;
- `updatedAt`: when the entity was materially updated;
- import-related timestamps may be added when useful.

No dedicated chronological Knowledge UI mode is implied by these fields.

## Deletion semantics

Normal deletion should be protective:

- show dependent references;
- prefer recoverable archive/trash semantics for authoring mistakes;
- require explicit confirmation for permanent destructive deletion;
- never silently cascade through unrelated Topic/Knowledge content;
- preserve published snapshot integrity.
