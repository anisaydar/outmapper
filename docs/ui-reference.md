# Outmapper UI Reference

## Map and Knowledge Panel

Outmapper pairs the **Map** with the **Knowledge Panel**. Both show the same selected Topic or Key Issue. The panel scrolls independently and can be collapsed with **Hide Panel** and restored with **Show Panel**.

A Topic map has one central Topic, its ordered Key Issues on the inner ring, and unique Related Topics on the outer ring. A Related Topic connected through several Key Issues appears once with several relationship lines.

Selecting a Key Issue highlights its relationships and updates the Knowledge Panel without changing the central Topic. Activating a Related Topic opens it directly. **Semantic relationships** offers a keyboard-accessible list of the same connections; selecting an entry opens its contextual card with **Open Topic**.

**Home** opens the Project's Home Topic. **Back**, **Forward**, and **History** revisit Topics, Projects, and Universe during the current session. Navigation history is separate from content **Undo** and **Redo**.

## Project portals

Project portals sit beyond Related Topics. Each represents the links between the current Topic and another Project in one direction. Up to eight portals appear around the map; **+N Projects** opens the remaining Projects grouped as **Outgoing** and **Incoming**.

Selecting a portal opens a card describing the connected Project, Topic or Key Issue, direction, and any link note. **Open Project** follows the connection. Incoming portals return to the source Topic and Key Issue. An outgoing link uses its target Topic, or the target Project's Home Topic if no destination Topic is specified or it is unavailable.

Missing Projects can be reconnected with **Locate...**. When several folders have the same Project identity, **Choose a Project copy** lets you select one and **Remember my choice** retains that preference. **Give this copy its own identity** makes a folder an independent Project. Cards and dialogs close when clicked outside their content.

## Knowledge Panel

The Knowledge Panel shows the selected Topic or Key Issue's cover, title, description, and associated Knowledge. Sections include **Pinned**, **Publications**, **Videos**, **Data**, and **Notes**. Items expand for summaries, source links, and attached files.

**Edit** opens Studio for the current Topic or Key Issue. Knowledge items have **Edit item** and **Remove item** actions. For shared items, **This context only** and **All contexts** control where an edit applies. External source links remain external; attached local files are served from the Project folder.

## Studio

The editing path is:

```text
Edit → change content (autosaved) → Done
```

Studio edits titles and descriptions in place. Related changes share an Undo step, and **Undo** and **Redo** remain available while editing. **Cancel editing** offers to discard the editing session when its checkpoint is still retained. If that history is no longer available, the interface directs you to Undo.

**New Topic** settles pending edits and opens a new Topic in Studio. **Set as Home Topic** changes the Project's default destination. A Topic's Key Issues can be added, removed, and reordered by dragging or keyboard actions.

For a Key Issue, **Find or create a Topic** adds a relationship to an existing Topic. After typing a title, **Create and link new Topic…** creates a Topic and connects it in one action. **Link another Project…** chooses a registered Project and an optional destination Topic and note. Topic relationships and Project Links share one ordered list.

Knowledge and attachments are added in their respective sections. **Import folder...** reviews supported files before adding them, with file-type filters, duplicate handling, progress, and cancellation. Original files are preserved.

## Covers and Project settings

**Upload cover**, **Replace cover**, and **Remove cover** edit a Topic or Key Issue's own image. Supported covers are PNG, JPEG, and still WebP. Images are cropped to fill their cover area; animated images, GIF, and SVG are rejected.

A Key Issue inherits its Topic's cover unless it has its own. **Set custom cover** overrides that inherited cover; removing the custom image restores inheritance.

**Settings → Current Project → Project settings…** edits the Project title and description. **Save as copy...** creates another folder with a new Project identity. **Open copy** opens the saved Project. Existing content and outgoing Project Links are preserved.

## Projects and portable files

**Settings → Projects** contains **Universe**, **New Project...**, and **Open Project...**. The **Recent** section lists previously opened folder instances and their status. A row's **Project actions** menu includes **Remove from Recent**, **Locate...**, and **Forget Project** where available.

**Remove from Recent** hides the row but keeps the Project registered for links, Universe, and search. **Forget Project** removes that folder from the workspace registry without deleting its files. The active Project cannot be forgotten.

**Export Project file…** creates a portable `.outmapper` backup containing referenced Assets. Linked external Projects are saved separately. **Import Project file…** validates a package before showing its contents and destination folder.

When that Project identity is already registered, **Import as a copy** creates a new identity; **Import anyway** preserves the existing identity. Both import into a new directory.

## Search

**Search** opens from the header or `Ctrl+K` / `Cmd+K`. **This Project** searches the active Project; **All Projects** searches existing indexes across registered Projects. Results cover Topics, Key Issues, Knowledge, metadata, and indexed document text.

All Projects results identify their **Source Project**. Opening a result activates that Project and navigates to its relevant Topic or Key Issue using the shared History stack.

The dialog reports **Projects not searchable until opened** and **Projects whose results may be out of date**. Open those Projects to create or update their indexes. **Results are partial** indicates an unfinished pass; **Search remaining Projects** continues it.

## Universe

The **Universe** button beside Search opens the workspace graph and remains pressed while it is open. Pressing it again returns to the place it was opened from. **Settings → Projects → Universe** opens the same view.

Each Project identity has one disc, using its Home Topic cover or default artwork. Multiple folder copies appear as one Project with a copies label. Linked Projects form clusters, unrelated Projects sit around them, and directed lines show their connections. Missing Projects remain visible in a muted state.

The side panel shows the selected Project's description and connection totals, **Open Project** or **Locate...**, and **Linked Projects** grouped as **Outgoing** and **Incoming**. Selecting a linked Project selects it in the graph; its open action navigates into that Project.

Arrow keys move focus between Projects. Enter selects a Project, a second Enter opens it, and Escape clears selection. Zoom controls are keyboard operable. Labels that would overlap on narrow screens appear as you zoom in or focus a Project.

## Responsive layout

Desktop and wider tablet layouts place the Map or Universe beside its panel. Collapsing the panel recenters the graph while preserving selection and navigation.

On narrow screens, **Map** and **Knowledge** provide the two Topic views. In Universe, the second tab shows the Project panel. Graphs support touch pan and pinch zoom, with fitted labels and compact controls.

## Language, themes, and accessibility

The interface supports **English**, **العربية**, and **Русский**, with **Light** and **Dark** appearance. Arabic uses right-to-left text treatment while preserving graph geometry and the physical order of the header controls. Authored Project content keeps its own language; the bundled AI Landscape has translated display content.

Graph nodes, menus, dialogs, history, and search are keyboard operable with visible focus. The semantic relationship list provides the map's connections in text. Loading and error messages are announced, and dialogs restore focus when closed.

Topic navigation, portal entrances, and graph transitions preserve spatial context. Reduced-motion preferences provide the same navigation and selection behavior with reduced animation. Incoming links are collected briefly before a newly activated map appears, keeping portals and the camera aligned with its entrance.
