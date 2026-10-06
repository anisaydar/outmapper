# Changelog

All notable changes to Outmapper are documented in this file.

## [0.2.0] - 2026-10-06

### Added

- Project Links connect separate Projects, with incoming and outgoing portals for moving between their maps.
- Universe shows how your Projects connect, including missing Projects and multiple folder copies.
- All Projects search finds Topics, Key Issues, Knowledge, and indexed document text across registered Projects, and opens results in their source Project.
- New Topic in Studio, creating and linking a Topic from a Key Issue, Home Topic selection, and drag or keyboard reordering.
- Upload, replace, and remove Topic and Key Issue covers, with inherited Topic covers and editable Project settings.
- Back, Forward, and History navigation across Topics, Projects, and Universe.
- Save as copy, Import as a copy, and controls for choosing or reconnecting Project folder copies.

### Changed

- Portable Projects use format version 2. Older Projects are upgraded when opened and saved.
- Project exports include only referenced Assets and explain that linked Projects are saved separately; unused local files are preserved.
- Studio autosaves related edits together, keeps Undo and Redo available, and lets Cancel discard the current editing session when its history is still available.
- Project copies retain separate Undo histories. Remove from Recent hides a folder entry; Forget Project stops tracking it without deleting its files.
- Maps and Universe adapt labels and controls to smaller screens, with keyboard navigation, light and dark themes, and reduced motion.

### Fixed

- Prevented occasional save-conflict errors when switching Projects while the active Project was being read.
- Kept the map camera steady as incoming portals arrive and entrance animations finish.
- Made portal cards more compact and consistent to close by clicking outside them.
- Added clear English, Arabic, and Russian messages for Project, cover, import, and workspace errors.

## [0.1.0] - 2026-10-02

### Added

- Interactive radial exploration of Topics, Key Issues, Related Topics, and their relationships.
- Contextual Knowledge Panel for notes, articles, research papers, videos, datasets, links, and attached files.
- Local Project creation, opening, recent-Project access, autosave, session undo/redo, and recovery checkpoints.
- Studio authoring for Topics, Key Issues, relationships, Knowledge Items, and Project-owned assets.
- Folder import with file previews, type filters, duplicate indicators, progress, and cancellation.
- SQLite full-text search across Project entities, metadata, and extracted PDF text.
- Portable `.outmapper` backup, export, validation, migration, and staged import using Project `formatVersion: 1`.
- English, Arabic, and Russian interfaces with RTL, keyboard navigation, semantic relationship navigation, and reduced-motion support.
- Theme-aware Outmapper application mark and interface for light and dark appearances.
- Local CLI with installation-free and global launch options, loopback-only serving, browser launch, safe port selection, and clean shutdown.
