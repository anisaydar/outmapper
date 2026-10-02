# Outmapper Security Model

## Trust boundary

Outmapper separates:

- **trusted application code** maintained as part of Outmapper; and
- **untrusted Project/content data** imported, authored, linked, or attached by users.

Opening a Project must never imply that its scripts, HTML, SVG markup, URLs, files, themes, or metadata are trusted to execute with application privileges.

## Threat model

Current local-runtime threats include:

- malicious `.outmapper` archives or directories;
- path traversal and absolute-path extraction;
- archive bombs and excessive resource consumption;
- hostile or misleading filenames;
- forged MIME metadata;
- script-capable HTML/SVG content;
- Markdown raw HTML;
- unsafe iframes and embedded content;
- dangerous URL schemes;
- same-origin active attachments;
- overly broad local-server filesystem exposure.

## Project import

All imported Projects are treated as hostile until validation completes.

Before committing an archive import, enforce bounded limits such as:

- compressed archive bytes;
- entry count;
- expanded per-entry bytes;
- total expanded bytes;
- compression ratio;
- path depth;
- filename length where needed.

For each entry:

1. normalize separators and Unicode handling consistently;
2. reject absolute paths;
3. reject traversal components;
4. resolve against an isolated staging root;
5. prove the destination remains inside staging;
6. reject unsafe symlink/hardlink behavior;
7. detect duplicate or case-colliding destinations;
8. apply platform filename constraints before final commit.

Never extract over a live Project.

## MIME and file handling

Do not trust filename extensions or user-supplied MIME values alone.

The localhost runtime serves ordinary inert assets with their validated MIME metadata and range support. HTML and SVG attachments are forced to download as `application/octet-stream` with a sandboxing policy rather than executing as same-origin application content. Application responses set a restrictive CSP, `nosniff`, no-referrer, and same-origin opener policy.

Large files should be streamed with explicit size/error handling rather than loaded into memory by default.

## Markdown and rich text

Markdown and text notes are treated as content data. Imported text cannot introduce application JavaScript or trusted HTML.

## HTML

Arbitrary HTML documents are not trusted executable Knowledge Items. HTML files may exist as attachments, but they do not execute as same-origin application content.

## SVG

Untrusted SVG can contain active or surprising content. Do not inline arbitrary imported SVG markup into the privileged application DOM.

Prefer safe image treatment or rigorously constrained/sanitized rendering paths.

## Iframes and external embeds

Outmapper does not render arbitrary active iframes or external embeds.

## URL schemes

Parse and allowlist supported schemes. Ordinary knowledge links should not permit script-capable or privileged schemes such as `javascript:`.

External links remain external references and must not be misrepresented as locally available content.

## Themes

Imported theme configuration is declarative data. It may set constrained design tokens and branding assets but cannot provide arbitrary JavaScript or trusted unrestricted CSS.

## Local server

The local server is a privileged bridge to real Project files.

The local server uses:

- loopback-only binding;
- explicit Project roots;
- path confinement;
- same-origin request design;
- protections against cross-origin mutation requests;
- no implicit access to arbitrary user filesystem locations;
- safe streaming of attachments.

## Content Security Policy

The application sends a restrictive CSP and avoids uncontrolled frame sources.

CSP mitigates impact but does not make unsanitized HTML safe.
