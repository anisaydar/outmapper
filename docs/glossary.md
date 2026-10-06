# Outmapper Glossary

## All Projects
The Search scope that queries existing indexes across registered Projects and identifies the source Project of each result.

## Asset
A Project-owned file or binary resource identified by a stable asset ID and Project-relative location.

## AssetStore
The environment-specific capability that resolves, stores, and streams managed Assets.

## Canonical Data
Durable Project information that constitutes the user's knowledge universe and can be moved independently of runtime indexes or caches.

## Collection
A user-defined grouping used to organize Knowledge Items or their contextual associations.

## Derived / Runtime Data
Rebuildable databases, indexes, caches, document extracts, thumbnails, and other runtime material generated from Canonical Data.

## Graph
The underlying network of Topics, Key Issues, and explicit relationships in a Project.

## GraphProjection
A renderer-neutral contextual projection for one current Topic: central Topic, its Key Issues, unique Related Topics, relationships, selection state, and layout/visibility hints.

## Home Topic
The Topic opened by Home and used as the default destination of a Project Link. Studio's Set as Home Topic action changes it.

## History
Session navigation across Topics, Projects, and Universe. Back and Forward move through this history; Undo and Redo instead change authored content.

## Key Issue
A contextual facet belonging to one Topic/map. A Key Issue does not become the central Topic.

## Knowledge Association
The contextual link attaching a Knowledge Item to a Topic or Key Issue, including contextual pinning/order/collection information.

## Knowledge Item
A generic record representing a source, document, note, media item, dataset, link, or other knowledge object.

## Knowledge Panel
The contextual workspace paired with the map. It shows Topic or Key Issue details and associated Knowledge Items.

## Map
The interactive radial visual presentation of a GraphProjection.

## Project
A self-contained, portable knowledge universe containing graph entities, Knowledge Items, assets, configuration, theme data, publication metadata, and authored outgoing Project Links. Projects connect without merging their canonical data.

## Project Portal
An interactive Project-to-Project connection. Outgoing portals come from canonical Project Links; incoming portals are machine-local derived backlinks from the Registry cache.

## ProjectStore
The environment-specific capability that reads, writes, validates, migrates, and commits canonical Project data.

## Published Snapshot
An immutable publication record tied to a specific canonical Project revision and immutable asset identities.

## Related Topic
A Topic occupying the outer-ring contextual role in the current GraphProjection. `RelatedTopic` is not a stored entity class.

## SearchAdapter
The engine-neutral interface that indexes and queries searchable Project content while hiding storage-engine-specific syntax.

## Registry
The machine-local workspace file that remembers folder instances and cached Project metadata. It is not included in Project packages and is never the canonical source of Project content.

## Remove from Recent
Hides a registered folder instance from the Recent list while keeping it registered for link resolution, incoming portals, Universe, and workspace search.

## Forget Project
Removes a folder instance from the Registry without deleting its folder or files. Its links become unavailable until the Project is opened or located again.

## Import as a copy
Imports an already registered Project into a new folder with a new Project identity, preserving its content and outgoing links.

## Save as copy
Creates an independent Project in another folder with a new Project identity, preserving its content and outgoing links.

## Studio
The integrated editing state of the Outmapper application for creating and modifying Project content.

## Theme
Declarative Project presentation data such as color, typography, density, node treatment, panel treatment, and branding assets.

## Topic
A persistent navigable subject within a Project. One Topic is central in every map projection.

## Topic Relationship
An explicit record connecting a source Topic through one of its Key Issues to a target Topic.

## Universe
The workspace map with one node per Project ID and directed, aggregated lines for cached Project Links. It is derived from the Registry and includes missing or otherwise unavailable Projects.

## Viewer
The non-editing application state used to explore the map, Knowledge Panel, search, and Project content.

## Working State
The current autosaved canonical Project content shown in Viewer and edited in Studio.
