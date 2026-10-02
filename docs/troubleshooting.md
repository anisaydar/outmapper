# Troubleshooting

## The CLI says the Node.js version is unsupported

Outmapper requires Node.js 22.22.2 or newer because the local search runtime depends on FTS5 support in Node's built-in SQLite.

```text
node --version
npx outmapper@latest --version
```

Upgrade Node.js, open a new terminal, and retry.

## The global `outmapper` command is not found

Install or reinstall the current release, then open a new terminal so it receives the latest `PATH`:

```text
npm install --global outmapper@latest
```

If the command is still unavailable, run `npm prefix --global` and ensure npm's global executable directory is on `PATH`. On Windows this is commonly `%APPDATA%\npm`; on macOS and Linux it is commonly the `bin` directory under the printed prefix. The installation-free `npx outmapper@latest` command remains available without a global installation.

## The browser did not open

The server can still be running. Open the loopback URL printed in the terminal. To make this behavior intentional, start with `--no-open`:

```text
npx outmapper@latest --no-open
```

The `OUTMAPPER_BROWSER_PATH` variable is only needed by repository browser tests; the application CLI uses the operating system's default browser launcher.

## Port 4173 is already in use

When 4173 is occupied and no port was requested, Outmapper prints and uses another free loopback port. An explicit busy port fails safely:

```text
npx outmapper@latest --port 4310
```

Choose another port or stop the process you own. Outmapper does not terminate unrelated processes.

## A Project cannot be opened

Confirm that the directory exists, is writable, and contains a valid Outmapper `project.json`. Working Projects cannot be inside the application source checkout or installed package. Copy or move the Project to an ordinary user directory and retry:

```text
npx outmapper@latest --project "/path/to/project"
```

Paths containing spaces should be quoted.

## Where Projects are stored

Default managed Projects are stored outside the repository and npm cache:

- Windows: `%LOCALAPPDATA%\Outmapper\Projects`
- macOS: `~/Library/Application Support/Outmapper/Projects`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/Outmapper/Projects`

Set `OUTMAPPER_DATA_DIR` before startup to use another application-data root.

## Search or extracted text appears stale

The `.outmapper/` directory inside a Project contains derived runtime data. With Outmapper stopped and a backup available, it can be removed and rebuilt from canonical Project files. Do not delete `project.json`, `data/`, `assets/`, `theme/`, or `snapshots/` when clearing derived state.

## Shutdown is taking longer than expected

Press `Ctrl+C` once and allow active local work to close. Avoid force-killing the process during a save or import. If shutdown remains stuck, preserve the Project directory and terminal output when reporting the issue.
