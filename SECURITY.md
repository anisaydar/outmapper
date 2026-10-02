# Security Policy

Outmapper handles local files, imported Project packages, documents, and links. Security reports are welcome and should be disclosed privately.

## Supported versions

Outmapper 0.1.x receives security fixes. Versions earlier than 0.1.0 are unsupported.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Earlier than 0.1.0 | No |

The application version does not change the portable Project format version, which remains version 1.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Report vulnerabilities only through [GitHub private vulnerability reporting](https://github.com/anisaydar/outmapper/security/advisories/new). This creates a private security advisory for the repository maintainers without disclosing the report in a public issue.

Include, where possible:

- affected version or commit;
- affected deployment mode;
- reproduction steps or proof of concept;
- expected and observed behavior;
- impact assessment;
- relevant logs, files, or screenshots with sensitive data removed.

Please allow the maintainers reasonable time to investigate and coordinate a fix before public disclosure.

## Local CLI boundary

The packaged CLI binds only to `127.0.0.1` or `::1`. It never resolves a port collision by stopping another process, and explicit busy ports fail rather than silently selecting a different address. The automatic browser launch receives only the loopback application URL and can be disabled with `--no-open`.

Installed application code and demo assets may live in an npm cache, but writable Projects and derived Project state must not. Managed Projects are created under the platform application-data directory or an explicit `OUTMAPPER_DATA_DIR`/`OUTMAPPER_PROJECT_DIR` location.

Treat Project directories and `.outmapper` packages as untrusted input. Do not report a Project sample publicly if it contains private research, credentials, or personally identifying information.
