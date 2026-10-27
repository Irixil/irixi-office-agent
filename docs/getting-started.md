# Getting started

The October 27 source preview includes the conversation workbench and macOS Swift/WebKit shell. The maintainer's installed application has local acceptance and installation evidence. A new machine still needs the runtime prerequisites below.

## Prerequisites

- Node.js 24+, npm, Git, and a desktop browser.
- A prepared OmO 5.1.40 installation at `.irixi-runtime/omo/bin/omo`, with its corresponding local runtime packages. These binaries and packages are not bundled in this repository.
- An existing authenticated Desktop Codex CLI for real model work. The integration resolves an existing local runtime; credentials are not copied into the repository.
- On Apple Silicon macOS, the optional functional browser checker can be installed with `node scripts/install-browser-checker.mjs`. This downloads its pinned browser through Playwright. A missing checker does not establish that a generated webpage was functionally tested.

The native app wrapper requires macOS and Swift command-line tools. Other platforms have not been established as supported native app targets.

## Start the current workbench

```bash
git clone https://github.com/Irixil/irixi-office-agent.git
cd irixi-office-agent
npm ci
node scripts/start-personal-agent-p0.mjs
```

Open [localhost:58312](http://127.0.0.1:58312/?backend=openoffice&view=office). The default data directory is `~/Library/Application Support/IRiXi/Personal Agent P0/`. Existing port use stops a duplicate launch before it loads conversation state. Stop this foreground service with Ctrl+C.

For separate development data and a separate port:

```bash
node scripts/start-personal-agent-p0.mjs \
  --runtime /absolute/path/to/irixi-development-data \
  --port 58314
```

Choose a new canonical absolute directory. Keep it separate from your existing application data and actual projects.

Starting the interface does not start model work. A submitted discussion may call the configured model; an execution instruction can read or change files within the selected project and actual permissions.

## Use it

1. Open the map or project/conversation list. Start a conversation and describe the idea.
2. Say “discuss first” to explore it, or give an explicit instruction to start making it.
3. Select the project folder when needed. A saved start request can continue after the folder is selected without resending it.
4. Open the delivered result, inspect it, and request a change. Expand the work activity for tools, checks, and sub-agent results.
5. Stop work when needed. Reopen the project or create another conversation in the same project to continue.

Materials and project folders are separate. Attachments provide reference material; choosing a folder determines where project work takes place. Editing a sent message creates a revision branch and preserves the source record. A chat branch does not roll back actual files.

## Build the macOS wrapper

After preparing the runtime and source prerequisites:

```bash
node omo-pilot/macos-app/build-mac-app.mjs \
  --output /absolute/path/to/iRIXI-Personal-Agent.app
```

The builder records the checkout location in the app's configuration. The wrapper uses that checkout and its locally installed runtime; it is not a self-contained signed installer. Keep the checkout available after building. This source publication does not rebuild or replace an existing installed app.

## Checks

The workbench test files use generated temporary projects and controlled model runners. Some checks deliberately run local Git, command tools, or a prepared browser. Provider-protocol checks can run with the process/network isolation preload:

```bash
node --import ./omo-pilot/test-isolation-preload.mjs \
  --test omo-pilot/codex-provider-protocol.test.mjs
```

`npm run test:workbench` runs the selected workbench test files. `npm test` is the broader legacy desktop collection. These are separate from new real-model acceptance, which requires its own explicit account and usage budget.

## Source layout and historical entries

- `omo-pilot/`: OmO integration, conversations, tool/check bridges, and macOS wrapper source.
- `scripts/`: persistent workbench launch, reopen, and browser-checker setup.
- `app/public/`: current conversation UI and office scene.
- `native/`: historical adapted OpenOffice sources and integration.
- `npm run start:omo`: earlier OmO project-workflow entry on port 3848.
- `npm run start:legacy`: older desktop/demo backend on port 3847.
- `npm run start:zero`: retained historical native setup, not the current conversation workbench.

Private runtime data, user conversations and materials, credentials, `.local.json` configuration, and installed binaries are excluded from the public source. Report setup problems with sanitized OS/version/command details through the [issue form](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml).
