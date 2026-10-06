# Third-party notices

Outmapper 0.2.0 includes the following components. Dependency versions are unchanged from 0.1.0; the notices below also cover the D3 Force code used by Universe.

| Component | Version | License | Use |
|---|---|---|---|
| React / React DOM | 19.3.0 | MIT | Browser UI |
| scheduler | 0.28.0 | MIT | React scheduling |
| D3 | 7.9.0 | ISC | Graph interactions and layout |
| D3 component packages | 3.x | ISC, BSD-3-Clause for d3-ease | Selection, transitions, zoom, force layout, interpolation, and supporting code |
| Fastify | 5.12.5 | MIT | Local API server |
| @fastify/static | 10.1.5 | MIT | Local client assets |
| Ajv | 8.20.0 | MIT | Project validation |
| @zip.js/zip.js | 2.18.2 | BSD-3-Clause | Portable Project archives |
| PDF.js (pdfjs-dist) | 6.3.289 | Apache-2.0 | Background PDF text extraction |
| Vite / Rolldown runtime helpers | 8.3.1 / 1.2.11 | MIT | Generated client bootstrap and module helpers |
| Cairo | Bundled font files | SIL OFL-1.1 | Latin and Arabic typography |

Complete copyright notices and license texts for code included in the client bundle are in [client dependency licenses](docs/licenses/client-dependencies.txt), including the separate BSD notice for d3-ease. Server dependencies and their transitive dependencies are installed as npm packages and retain their own license files. Development tools retain their licenses in their respective packages.

The Cairo font is from the Cairo Project Authors. Its complete SIL Open Font License 1.1 and copyright notice are included at `public/fonts/Cairo-OFL.txt` in the source repository and `dist/client/fonts/Cairo-OFL.txt` in the npm package.

## AI Landscape content

The bundled AI Landscape map, Outmapper-authored descriptions and reading notes, and their translations are Copyright 2026 Anis Aydar and distributed under the [Apache License 2.0](LICENSE). The Project manifest records `contentLicense: "Apache-2.0"`.

External papers, articles, videos, standards, and datasets are referenced through titles, metadata, summaries, and links. Their full content is not bundled; it remains subject to each source owner's license. Outmapper's license does not grant rights to those external works or change the license of user-created Project content.
