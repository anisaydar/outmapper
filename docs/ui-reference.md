# Outmapper UI Reference

## Product interaction model

Outmapper is a spatial knowledge workspace composed of two synchronized surfaces:

1. the **Map**, which explains relationships;
2. the **Knowledge Panel**, which explains the selected Topic or Key Issue and exposes supporting material.

Neither surface is secondary. They share selection and navigation state while scrolling and interaction remain appropriate to each surface.

## Map hierarchy

Every projection has three visual levels:

- **Center:** one current Topic;
- **Inner ring:** that Topic's ordered Key Issues;
- **Outer ring:** unique Related Topics.

A Related Topic connected through multiple Key Issues appears once with multiple visible relationships.

Graph geometry is independent of interface text direction. Arabic changes typography, bidi behavior, and surrounding UI direction but does not automatically mirror the radial map.

## Key Issue selection

Selecting a Key Issue:

- keeps the current central Topic;
- visually emphasizes the selected Key Issue;
- highlights its connected Related Topics and relationships;
- fades unrelated relationships without removing spatial context;
- updates the Knowledge Panel to that Key Issue.

Selection should remain obvious in light and dark themes without relying on color alone.

## Related Topic selection and navigation

Activating a Related Topic node opens it directly. Selecting a Related Topic from the semantic relationship navigator first opens a contextual preview with its relationship information and an explicit **Open Topic** action.

Opening a Related Topic:

- promotes the selected Topic into the center;
- adds the previous central Topic to navigation history;
- replaces the inner ring with the new Topic's Key Issues;
- replaces/reconfigures the outer ring with the new Related Topics;
- updates the Knowledge Panel.

Motion should reinforce this continuity. Reduced-motion mode must perform the same state transition without requiring spatial animation.

## Knowledge Panel

The panel presents:

- visual/title;
- metadata/curation context;
- description;
- contextual edit action when permitted;
- Knowledge sections such as Pinned, Publications, Videos, Data, Notes, and user-defined collections/tags.

Knowledge Items can expand for summaries/actions without navigating away from the current Topic unless the user explicitly opens them.

The panel scrolls independently from the Map.

On desktop it can collapse. The map recenters or expands smoothly while preserving the current Topic, selection, and navigation context.

## Viewer and Studio

Viewer and Studio are states of the same application rather than separate products.

A normal local editing path is:

```text
View Topic -> Edit -> make changes (autosaved) -> Done
```

Studio changes autosave to the Project's Working State, and Undo/Redo stay available while editing. The local application does not expose Preview or Publish controls; Published Snapshot support remains part of the Project format and service layer.

Studio should remain contextual to what the user is viewing. Editing a selected Key Issue should preserve map context instead of moving users into an unrelated administration interface.

## Global navigation and controls

The interface should provide clear access to:

- global search;
- Project switching/backup actions;
- appearance and language settings;
- Topic history/back navigation;
- semantic relationship view;
- zoom controls;
- panel collapse on desktop.

Controls should use large enough touch targets and visible keyboard focus.

## Search

Global search can return Topics, Key Issues, Knowledge Items, tags, sources, authors, and supported document text.

Results should communicate the result type and allow direct navigation into the relevant map or Knowledge context.

## Desktop

Primary layout:

```text
Map workspace | Knowledge Panel
```

Expected behavior:

- both surfaces coexist;
- panel scroll is independent;
- collapsing the panel expands/recenters the map;
- graph history and map controls remain anchored to the map workspace;
- focus and selection persist across layout changes.

## Tablet

Use available width rather than device labels alone.

At wider widths, preserve a split layout. At narrower widths, switch toward the mobile Map/Knowledge model while retaining full graph interaction.

## Mobile

Primary navigation becomes:

```text
Map | Knowledge
```

The Map remains a real interactive graph with:

- pan;
- pinch zoom;
- semantic zoom;
- progressive label visibility;
- large touch targets;
- contextual relationship highlighting.

A Related Topic tap performs the same Topic transition as desktop interaction. The semantic relationship navigator can open a compact contextual preview before navigation.

## Semantic zoom

At distant zoom levels, prioritize:

1. central Topic;
2. Key Issues;
3. selected/relevant Related Topics.

As the user zooms or selects context, outer labels become progressively more available. Visibility thresholds are presentation behavior rather than canonical Project data.

## Accessibility

The visual graph must not be the only representation of relationships.

The semantic relationship navigator is generated from the same GraphProjection:

```text
Current Topic
  Key Issue
    Related Topic
    Related Topic
```

Requirements include:

- keyboard-operable graph nodes;
- deterministic focus order;
- visible focus;
- screen-reader labels and relationship context;
- high-contrast-safe states;
- no color-only meaning;
- reduced-motion support;
- scalable text and touch-safe targets.

## Internationalization

Outmapper ships interface support for:

- English (`en`, LTR);
- Arabic (`ar`, RTL);
- Russian (`ru`, LTR).

The selected interface locale applies consistently to controls, menus, search UI, Studio, panel labels, graph labels, and locale-sensitive dates/numbers.

Project content remains multilingual independently of the UI locale.

The interface uses bidi-safe text treatment and CSS logical properties for mixed-direction content.

## Themes

Support polished light and dark modes using shared semantic design tokens.

Theme changes should preserve hierarchy, contrast, graph legibility, selection clarity, and focus indicators rather than simply invert colors.

Project branding/theming is declarative and constrained; presentation data must not execute scripts.

## Motion character

Motion should feel continuous, controlled, and spatial rather than decorative.

Important transitions include:

- Topic promotion to center;
- graph ring entry/exit;
- Key Issue emphasis;
- relationship fades/highlights;
- panel collapse/recenter;
- bottom-sheet appearance;
- Viewer ↔ Studio state changes.

Animations must reverse or interrupt safely and must have reduced-motion equivalents.
