# Sovereign OS Control Plane

Local-first intellectual operating system and knowledge graph.

This repository publishes the **portable control plane**: the `sos` CLI, graph/audit/sync tooling, and the agent protocols in `AGENTS.md` and `DEBRIEF.md`.

A **living instance** is a folder that contains this control plane plus your domains, inboxes, and `.sos/config.json`. The public kernel source does not hold domain notes, inboxes, or pending debrief records.

Unzip the published tree, or overlay it onto a folder that already has domains, and that folder is the living instance. Step-by-step: `SETUP.md`.

Capture → ingest → debrief → retrieve.

## What this is

A cross-platform control plane. Local verbs run on your machine. Semantic reasoning happens in whatever chat environment you already use. There is no hosted API, no account, and no provider key stored by this repository.

- **Local-first orchestration.** `sos ingest` uses on-device sensors to produce mechanical Tier 2 evidence and can recognize additional source-specific sensors without changing the everyday workflow.
- **Human-in-the-loop synthesis.** `debrief` is a conversational protocol, not a terminal command. An agent proposes Tier 1 notes and typed graph edges; you approve before anything is written.
- **Typed graph, not a wiki dump.** Canonical IDs, five predicates (`DERIVES_FROM`, `GOVERNS`, `IMPLEMENTS`, `EVIDENCES`, `TRANSMUTES`), and information-flow boundaries (`private` / `restricted` / `public`) are enforced by `sos audit`.

## Requirements

Supported environments: macOS, Linux, and Windows. Core commands need:

- Node.js 18+

Git is optional. Use it only if you want history of your notes. Upgrade downloads a published zip; it does not clone. Opt in to the bundled hooks with `git config core.hooksPath .sos/hooks`.

Optional local capabilities (probed by `sos doctor`, which prints a copy-paste install command and does not install):

- `whisper-cli` for speech-bearing audio/video
- Vision APIs for still-image telemetry
- OS-native text converters for proprietary formats
- `yt-dlp` and `ffmpeg` for `sos fetch`

This repository is open-source (MIT License). It is not published to npm. Run it from a checkout:

```bash
node .sos/sos.mjs help
```
Or link it globally:
```bash
npm link
sos help
```

## Start a living instance

Turn this control plane into a living instance. Step-by-step: `SETUP.md`.

1. Download `main.zip`, extract it, and `cd` into the folder.
2. Mint domains:

   ```bash
   node .sos/sos.mjs init --domain personal:private
   node .sos/sos.mjs init --domain work:restricted
   ```

   Optional `--name` writes a dashboard label to `.sos/config.json` once and is never rewritten.
3. Vaults and mirrors are optional:

   ```bash
   node .sos/sos.mjs config add vault /path/to/parent
   node .sos/sos.mjs config add mirror /path/to/backup
   node .sos/sos.mjs config list
   ```

   A vault is the parent of compiled `{VaultName}` folders (`personal` → `Personal`). Mobile captures go in `Personal/inbox/`.
4. Charter each new `SPACE.md` in conversational debrief before minting notes.
5. Point your AI agent at this folder’s `AGENTS.md`.

Keeping a second local copy for insurance or control-plane development is optional:

```bash
node .sos/sos.mjs upgrade
node .sos/sos.mjs upgrade --path /path/to/local/sos-control-plane
```

`sos upgrade` downloads the published zip and overlays `AGENTS.md`, `DEBRIEF.md`, `SETUP.md`, `README.md`, `package.json`, `.gitignore`, `.sos/sos.mjs`, `.sos/lib`, `.sos/test`, `.sos/vendor`, `.sos/hooks`, `.sos/plugins/SENSOR-PROTOCOL.md`, and the kernel sensor plugins (`apple-metal`, `linux`, `windows`). Instance plugins that have `plugin.json` stay in place. It never copies domain notes or inboxes, and it never overwrites `.sos/config.json` or `.sos/operator-preferences.json`.

## Everyday flow

```text
sos config                # list vault and mirror targets (same as sos config list)
sos inbox                 # pending files, folder batches, debrief records
sos ingest [selector]     # local extraction; one debrief record per file, one per folder batch
debrief                   # in chat: review evidence, propose notes and edges, wait for approval
sos graph "topic"         # retrieve reviewed knowledge
sos graph <id> --deep     # one-hop context and evidence
sos audit                 # after approved graph edits
sos sync                  # validate, compile configured vaults, mirror backup
```

Exact syntax lives in the CLI: `sos help` and `sos help <command>`. Agents use `AGENTS.md` as operating law; this README is the public map of the kernel.

| Command | Role |
| --- | --- |
| `sos` / `sos status` | Read-only dashboard |
| `sos init` | Add domain charters |
| `sos config` | Configure cross-platform vault targets and sync targets |
| `sos inbox` | Inspect pending intake |
| `sos ingest` | Local sensor extraction and complete primary Tier 2 records |
| `sos fetch` | Pull remote audio/video into an inbox |
| `sos graph` | Search the reviewed graph |
| `sos trace` | Follow evidence linked from one exact Tier 1 node |
| `sos audit` / `sos check` | Integrity and full local validation |
| `sos sync` | Compile and synchronize configured targets |
| `sos upgrade` | Overlay this control plane onto an instance |
| `sos doctor` | Probe local tools |

Policy for when an agent should run `sos trace` is in `AGENTS.md`. Flags: `sos help trace`.

Conversational commands (`debrief`, `review charter`, `brief me on`, `weave`) are recognized in chat, not by the terminal.

## Layout

```text
AGENTS.md, DEBRIEF.md, SETUP.md, README.md, package.json, .gitignore
.sos/sos.mjs
.sos/lib, .sos/test, .sos/vendor, .sos/hooks
.sos/plugins/SENSOR-PROTOCOL.md
.sos/plugins/apple-metal, linux, windows
```

Those paths are the overlay. `sos upgrade` replaces them. It does not copy the rest of `.sos/plugins/`. It never overwrites `.sos/config.json` or `.sos/operator-preferences.json`. Instance plugins with `plugin.json` stay in place.

Three storage tiers live in each **instance** domain, not in this kernel:

1. **Tier 1** — reviewed Markdown nodes (`[Domain]/.../*.md`)
2. **Tier 2** — extraction assets (`[Domain]/assets/`)
3. **Tier 3** — raw archives (`[Domain]/inbox/archive/`), out of Git

## Tests

```bash
npm test
```
