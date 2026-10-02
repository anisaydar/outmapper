# Outmapper Glossary

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

## Preview
Viewer rendering of the current Working State before it becomes the Published Snapshot.

## Project
A self-contained knowledge universe containing graph entities, Knowledge Items, assets, configuration, theme data, and publication metadata. No graph edge crosses Project boundaries in format version 1.

## ProjectStore
The environment-specific capability that reads, writes, validates, migrates, and commits canonical Project data.

## Published Snapshot
An immutable publication record tied to a specific canonical Project revision and immutable asset identities.

## Related Topic
A Topic occupying the outer-ring contextual role in the current GraphProjection. `RelatedTopic` is not a stored entity class.

## SearchAdapter
The engine-neutral interface that indexes and queries searchable Project content while hiding storage-engine-specific syntax.

## Studio
The integrated editing state of the Outmapper application for creating and modifying Project content.

## Theme
Declarative Project presentation data such as color, typography, density, node treatment, panel treatment, and branding assets.

## Topic
A persistent navigable subject within a Project. One Topic is central in every map projection.

## Topic Relationship
An explicit record connecting a source Topic through one of its Key Issues to a target Topic.

## Viewer
The non-editing application state used to explore the map, Knowledge Panel, search, and Project content.

## Working State
The autosaved editable canonical Project state that may be previewed and published.
