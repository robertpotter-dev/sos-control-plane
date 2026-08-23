# Sovereign OS Control Plane

Local-first intellectual operating system and knowledge graph.

This repository is the **portable control plane**: the `sos` CLI, graph/audit/sync tooling, and the agent protocols in `AGENTS.md` and `DEBRIEF.md`. It is not a knowledge garden. Domain notes, inboxes, and pending debrief records do not belong here.

Capture → ingest → debrief → retrieve.

## What this is

A cross-platform control plane you overlay onto a private instance. Local verbs run on your machine. Semantic reasoning happens in whatever chat environment you already use. There is no hosted API, no account, and no provider key stored by this repository.

- **Local-first Orchestration.** `sos ingest` defaults to deterministic extraction using on-device tools to aggressively conserve tokens. 
- **Agentic Extraction.** For highly complex visual layouts, operators can use `sos ingest --frontier` to archive the source natively and explicitly route structural extraction to an LLM.
- **Human-in-the-loop synthesis.** `debrief` is a conversational protocol, not a terminal command. An agent proposes Tier 1 notes and typed graph edges; you approve before anything is written.
- **Typed graph, not a wiki dump.** Canonical IDs, five predicates (`DERIVES_FROM`, `GOVERNS`, `IMPLEMENTS`, `EVIDENCES`, `TRANSMUTES`), and information-flow boundaries (`private` / `restricted` / `public`) are enforced by `sos audit`.

## Requirements

Supported environments: macOS, Linux, and Windows. Core commands need:

- Node.js 18+

Git is optional. Use it only if you want history of your notes. Upgrade downloads a published zip; it does not clone.

Optional local capabilities (probed by `sos doctor`):

- `whisper-cli` for speech-bearing audio/video
- Vision APIs for image and keyframe telemetry
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

## Start a private instance

Unzip this tree and live there. Step-by-step: `SETUP.md`.

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

`sos upgrade` downloads the published zip and overlays tooling onto this living instance. It never copies domain notes or inboxes, and it never overwrites `.sos/config.json` or `.sos/operator-preferences.json`.

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

Exact syntax lives in the CLI: `sos help` and `sos help <command>`.

| Command | Role |
| --- | --- |
| `sos` / `sos status` | Read-only dashboard |
| `sos init` | Add domain charters |
| `sos config` | Configure cross-platform vault targets and sync targets |
| `sos inbox` | Inspect pending intake |
| `sos ingest` | Local extraction (or `--frontier` for LLM routing) |
| `sos fetch` | Pull remote audio/video into an inbox |
| `sos graph` | Search the reviewed graph |
| `sos audit` / `sos check` | Integrity and full local validation |
| `sos sync` | Compile and synchronize configured targets |
| `sos upgrade` | Overlay this control plane onto an instance |
| `sos doctor` | Probe local tools |

Conversational commands (`debrief`, `review charter`, `brief me on`, `weave`) are recognized in chat, not by the terminal.

## Layout

```text
AGENTS.md      Agent operating law (graph schema, IFC, command policy)
DEBRIEF.md     Conversational debrief protocol
SETUP.md       Unzip-and-live-there setup
package.json   Version and sos bin entry
.sos/          CLI, libraries, tests, vendored YAML
```

Three storage tiers live in each **instance** domain, not in this kernel:

1. **Tier 1** — reviewed Markdown nodes (`[Domain]/.../*.md`)
2. **Tier 2** — extraction assets (`[Domain]/assets/`)
3. **Tier 3** — raw archives (`[Domain]/inbox/archive/`), out of Git

## Tests

```bash
npm test
```
