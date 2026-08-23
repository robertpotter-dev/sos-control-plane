#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { fail } from './lib/cli.mjs';
import { readControlPlaneVersion } from './lib/control-plane.mjs';
import { doctorCommand } from './lib/doctor.mjs';
import { configCommand } from './lib/config-cmd.mjs';
import { inboxCommand } from './lib/inbox.mjs';
import { initCommand } from './lib/init.mjs';
import { appendPluginHelp, discoverPlugins } from './lib/plugins.mjs';
import { currentWorkingDirectory, findSystemRoot } from './lib/root.mjs';
import { statusCommand } from './lib/status.mjs';
import { colorizeHelp, ui } from './lib/terminal.mjs';

const EXECUTING_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = readControlPlaneVersion(EXECUTING_ROOT) || '0.0.0';
let REPO_ROOT;
let INSTANCE_ROOT;
let discoverDomains;
let pluginRegistry = null;

async function loadPluginRegistry() {
    if (!REPO_ROOT) throw new Error('Plugin registry requested before runtime initialization.');
    if (!pluginRegistry) pluginRegistry = discoverPlugins(REPO_ROOT);
    return pluginRegistry;
}

const HELP = `Sovereign OS

Capture → ingest → debrief → retrieve.

  1. sos inbox
  See new files, folder batches, and pending debriefs.

  2. sos ingest [selector]
  Extract locally. A file creates one debrief record; a folder creates one shared batch record.

  3. Debrief with your AI agent to review the record and save the knowledge you want to keep.

  4. sos graph "topic" --deep
  Find reviewed knowledge, links, and sources.

Commands
  sos                 System dashboard.
  sos init            Create system configuration, then add domain charters.
  sos inbox           Inspect captures, folder batches, and pending debrief records.
  sos ingest          Run the local sensor pipeline and create deterministic debrief records.
  sos fetch           Download remote video/audio into a domain inbox for ingest.
  sos graph           Search the active knowledge graph and evidence links.
  sos audit           Validate graph, IFC, evidence lineage, and operator preferences.
  sos check           Run the complete local validation pipeline.
  sos sync            Validate, compile, and synchronize configured targets.
  sos upgrade         Overlay the control plane onto this instance.
  sos doctor          Check local tools and prerequisites.
  sos config          Manage system vaults, mirrors, and preferences.

Details
  sos help inbox      Pending-intake selectors and filters.
  sos help ingest     Local extraction and batch selection.
  sos help fetch      Remote URL acquisition into a domain inbox.
  sos help graph      Canonical IDs, note paths, keywords, and --deep.
  sos help sync       Synchronization targets and preview mode.
  sos help upgrade    Download the published zip, or overlay from --path.
  sos help config     List, add, or remove system configurations.

Output controls: --json, --quiet, --verbose
`;

const COMMAND_HELP = {
    config: `Sovereign OS config

Usage:
  sos config [list | add | remove] [vault | mirror] <path>

Keys:
  vault         Compiled vault destination and mobile inbox source
  mirror        Raw system backup destination

Examples:
  sos config list
  sos config add vault "C:\\Users\\Name\\Dropbox\\Vault"
  sos config add mirror "~/Library/Mobile Documents/com~apple~CloudDocs/AI"
  sos config remove vault "C:\\Users\\Name\\Dropbox\\Vault"`,
    status: `sos status

Show a read-only snapshot of the current Sovereign OS: discovered domains, Tier 1 graph count, Tier 2 asset count, Tier 3 archive count, pending inbox work, and Git state.

Also runs when you enter just: sos

Options: --json, --quiet, --verbose`,

    inbox: `sos inbox ["path or keywords"] [--domain <name>] [--captures|--batches|--debriefs]

List pending work without changing it.

Selection
  Exact path          One pending inbox file or top-level folder batch.
  Keywords            Match words in a pending file or folder name/path.
  --domain <name>     Narrow the inbox first, then apply the selector.

Filters — choose one
  --captures          Loose unprocessed files.
  --batches           Top-level inbox folders; each is one grouped intake unit.
  --debriefs          Deterministic records awaiting conversational review.

Verbose
  --verbose           Expand batch folders to list contained files and capture kinds.

Examples:
  sos inbox
  sos inbox --domain projects
  sos inbox --debriefs
  sos inbox "voice memo"
  sos inbox "site visit" --verbose

Options: --json, --quiet, --verbose`,

    ingest: `sos ingest ["path or keywords"] [--frontier] [--dry-run]

Process pending inbox captures with deterministic local tools. Audio and video use local Whisper. Images use Apple Vision on macOS, or Tesseract / Windows OCR elsewhere (not Apple Vision scene tags). Text, RTF, PDFs, CSV, and XLSX are preserved as verbatim Tier 2 captures. Empty OCR is still a successful photo ingest. Every loose file creates one deterministic debrief record. Every top-level inbox folder is processed as one batch and creates one shared record. After the batch is archived, the empty source folder is removed.

Selection
  Exact path          One pending inbox file or top-level folder batch.
  Keywords            Match words in a pending file or folder name/path.
  Ambiguous match     Sovereign OS stops and shows the candidates.

Options
  --frontier          Bypass local extraction. Archive natively and create a Frontier Debrief for an agent to natively parse.
  --dry-run           Preview extraction, archival, and the debrief record without writing.
  --json              Compact machine payload: intake units, debrief paths, and failures. No banners.

Examples:
  sos ingest
  sos ingest "voice memo"
  sos ingest "phone directory" --frontier
  sos ingest "personal/inbox/voice-memo.m4a" --dry-run
  sos ingest "site visit" --dry-run --json

Options: --dry-run, --json, --quiet, --verbose`,

    fetch: `sos fetch <url> --domain <name> [--dry-run]

Pull remote video or audio into a domain inbox. yt-dlp resolves the URL; ffmpeg merges the best available streams when installed. The file is named from the video title and uploader, then sits in inbox as a normal capture for sos ingest.

Requirements
  yt-dlp              Required.
  ffmpeg              Recommended, to merge separate video and audio streams.

Options
  --domain <name>     Target domain inbox. Required when multiple domains exist.
  --dry-run           Preview the planned inbox destination without downloading.
  --json              Compact machine payload: destination path and metadata. No yt-dlp banners.

Examples:
  sos fetch "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --domain personal
  sos fetch "https://www.youtube.com/shorts/abc123" --domain projects --dry-run
  sos fetch "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --domain personal --dry-run --json

Options: --dry-run, --json, --quiet, --verbose`,

    graph: `sos graph <id, path, or keywords> [--deep]

Search the active knowledge graph. Results include Tier 1 source links into deterministic Tier 2 artifacts when present. This is graph retrieval, not inbox or raw-file search.

Selection
  Canonical ID        Exact graph node, e.g. proj:sitegraph.
  Exact note path     Repository-relative Markdown path for an active graph node.
  Keywords            One short phrase or idea. Do not concatenate unrelated concepts.

Resolution
  Exact ID/path       Opens the requested node directly.
  Unique best match   Opens only when one note has the highest match class.
  Tied broad query    Shows the best candidates without selecting a primary node.

Query discipline
  Read the capture or question first. Run one idea per invocation.
  Treat a listed tie as a candidate set. Use --deep after a node or tie is resolved.
  A unique body-text hit on a kitchen-sink AND query is coverage, not a decision.

Options
  --deep              Expand the selected node, or the tied best candidates when no node is selected.
  --json              Compact machine payload: a resolved node, a tied candidate set, or graph stats. No note bodies.

Examples:
  sos graph "employee of the year"
  sos graph Gemini
  sos graph work:employee-of-the-year --deep
  sos graph work:employee-of-the-year --json

Output controls: --json, --quiet, --verbose`,

    audit: `sos audit

Validate Markdown metadata, canonical IDs, graph links, semantic predicates, information-flow boundaries, Tier 1 → Tier 2 → Tier 3 evidence chains, and operator-preference configuration.

Options
  --json              Compact machine payload: failures, warnings, and counts. No banners or note bodies.

Options: --json, --quiet, --verbose`,

    check: `sos check

Run the repository's validation pipeline: formatting, linting, and audit checks.

Options
  --json              Compact machine payload: per-stage pass/fail. Failed audit includes the native audit payload.

Options: --json, --quiet, --verbose`,

    sync: `sos sync [--quick|--vaults|--mirrors|--all|--rebuild] [--dry-run] [--force]

Validate and synchronize the compiled system to its configured destinations. Use --dry-run to inspect planned changes without writing. After a successful run (not a dry run), refresh the local graph index.

Before compiling, sync reads each destination vault charter. A new vault is written. A vault stamped by this system is overwritten. A vault that already exists under a different system — or with no stamp — stops the command. Nothing is overwritten. Fix the destination yourself or with your agent, or pass --force to take it (not recommended).

--rebuild empties compiled vault files, then compiles again. It keeps the vault folder, .obsidian, and live inbox/ captures. inbox/archive is restored from git.

Options
  --force             Overwrite a destination vault that belongs to another system. Not recommended.
  --json              Compact machine payload: targets, node count, and planned write counts. No per-file log.

Options: --quick, --vaults, --mirrors, --all, --rebuild, --force, --dry-run, --json, --quiet, --verbose`,

    upgrade: `sos upgrade [--path <dir>] [--dry-run]

Overlay the published control plane onto this living instance. Downloads the main-branch zip without using Git. Copies .sos tooling, AGENTS.md, DEBRIEF.md, SETUP.md, package.json, .gitignore, and kernel sensor plugins. Keeps .sos/config.json, operator preferences, instance plugins that have plugin.json, domain notes, and inboxes.

--path overlays from a local insurance or development copy instead of downloading.

Options
  --path <dir>        Local control-plane root to overlay from instead of the published zip.
  --json              Compact machine payload: source, destination, versions, copied paths, and preserved files.
  --dry-run           Preview copies without writing.

Options: --path, --dry-run, --json, --quiet, --verbose`,

    doctor: `sos doctor

Check the local operating environment: repository discovery, domain charters, configured vault targets, and optional local extraction tools.

Options: --json, --quiet, --verbose`,

    init: `sos init [--name "System Name"] [--vault <path>] [--mirror <path>] --domain <name>:<private|restricted|public>

Mint placeholder SPACE.md charters. Domain names are lowercase. --name is optional: it writes a dashboard label to .sos/config.json and is never rewritten. --vault and --mirror seed the first config when --name creates it. Without --name, sos status uses the repository folder name. Charter each new SPACE.md in conversational debrief before minting notes.

Example:
  sos init --domain personal:private
  sos init --name "My Sovereign System" --domain research:public
  sos init --domain work:restricted`,

    debrief: `debrief — conversational command

Use this in a conversation with your AI agent, not in the terminal. It reviews pending deterministic debrief records with you, reads raw archives only when needed, and writes reviewed synthesis to Tier 1 after explicit approval.

If that domain's SPACE.md still contains the init placeholder, charter the space first. Pending inbox or debrief records may inform the interview; keep families abstract. An empty inbox is fine.

Typical flow:
  debrief
  "This shows …; preserve it in …"`,

    review: `review charter <domain> — conversational command

Use this in a conversation with your AI agent, not in the terminal. Re-read that domain's SPACE.md against the notes and folders that actually exist, then propose language or directory patches only. Wait for approval. Run sos audit after an approved write.

Typical flow:
  review charter personal`,

    brief: `brief me on <topic> — conversational command

Use this with your AI agent for a compact, one-hop context retrieval from the active knowledge graph. Say "deep brief on <topic>" to include virtual backlinks and wider synthesis.`,

    weave: `weave <node-id> — conversational command

Use this with your AI agent to propose typed graph relationships. The agent explains each candidate edge and waits for your review before changing metadata.`
};

async function initializeRuntime() {
    const executing = findSystemRoot() || findSystemRoot(EXECUTING_ROOT);
    INSTANCE_ROOT = process.env.SOS_ROOT ? resolve(process.env.SOS_ROOT) : executing;
    REPO_ROOT = executing || INSTANCE_ROOT;
    if (!REPO_ROOT) {
        const here = currentWorkingDirectory() || EXECUTING_ROOT;
        throw new Error(`No Sovereign OS system found at or above ${here}.`);
    }
    const domainsModule = await import(pathToFileURL(join(REPO_ROOT, '.sos', 'lib', 'domains.mjs')).href);
    discoverDomains = domainsModule.discoverDomains;
}

function parseCli(argv) {
    const options = { json: false, quiet: false, verbose: false, dryRun: false, help: false, version: false };
    const remaining = [];

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--json') options.json = true;
        else if (arg === '--quiet') options.quiet = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--version') options.version = true;
        else if (arg === '-v') {
            const commandName = remaining.find(value => !value.startsWith('-'));
            if (commandName === 'sync') remaining.push(arg);
            else options.version = true;
        }
        else remaining.push(arg);
    }

    if (options.quiet && options.verbose) throw new Error('--quiet and --verbose cannot be used together.');
    if (options.quiet && options.json) throw new Error('--quiet and --json cannot be used together.');

    const command = remaining[0] && !remaining[0].startsWith('-') ? remaining.shift() : 'status';
    return { command, args: remaining, options };
}

function runPlugin(entry, args, options) {
    if (options.dryRun && !entry.supportsDryRun) return fail(`--dry-run is not applicable to ${entry.command}.`, options);
    const childArgs = [join(entry.pluginDir, entry.script), ...args];
    if (options.dryRun) childArgs.push('--dry-run');
    if (options.json && entry.nativeJson) childArgs.push('--json');

    const started = Date.now();
    if (options.verbose && !options.json) {
        console.error(ui.muted(`[sos] root: ${REPO_ROOT}`));
        console.error(ui.muted(`[sos] plugin: ${entry.pluginId}`));
        console.error(ui.muted(`[sos] exec: ${process.execPath} ${childArgs.map(value => JSON.stringify(value)).join(' ')}`));
    }

    const capture = options.json || options.quiet;
    const result = spawnSync(process.execPath, childArgs, {
        cwd: REPO_ROOT,
        env: { ...process.env, SOS_ROOT: INSTANCE_ROOT },
        encoding: capture ? 'utf-8' : undefined,
        stdio: capture ? 'pipe' : 'inherit'
    });
    const exitCode = result.status ?? 1;
    const elapsedMs = Date.now() - started;

    if (options.json && entry.nativeJson) {
        if (result.stdout) process.stdout.write(result.stdout);
        else if (result.error) return fail(result.error.stack, options);
        if (options.verbose && result.stderr) process.stderr.write(result.stderr);
        if (exitCode !== 0) process.exitCode = exitCode;
        return;
    }

    if (options.json) {
        console.log(JSON.stringify({
            ok: exitCode === 0,
            command: entry.command,
            plugin: entry.pluginId,
            dryRun: options.dryRun,
            exitCode,
            elapsedMs,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error?.message ?? null
        }, null, 2));
    } else if (options.quiet && exitCode !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        else if (result.stdout) process.stdout.write(result.stdout);
        else if (result.error) console.error(result.error.stack);
    } else if (options.verbose) {
        console.error(ui.muted(`[sos] exit: ${exitCode} (${elapsedMs}ms)`));
    }
    if (exitCode !== 0) process.exitCode = exitCode;
}

function runDelegated(command, script, args, options, { supportsDryRun = false, nativeJson = false, fromExecuting = false } = {}) {
    if (options.dryRun && !supportsDryRun) return fail(`--dry-run is not applicable to ${command}.`, options);
    const libDir = fromExecuting ? join(EXECUTING_ROOT, '.sos', 'lib') : join(REPO_ROOT, '.sos', 'lib');
    const childArgs = [join(libDir, script), ...args];
    if (options.dryRun) childArgs.push('--dry-run');
    if (options.json && nativeJson) childArgs.push('--json');

    const started = Date.now();
    if (options.verbose && !options.json) {
        console.error(ui.muted(`[sos] root: ${REPO_ROOT}`));
        console.error(ui.muted(`[sos] exec: ${process.execPath} ${childArgs.map(value => JSON.stringify(value)).join(' ')}`));
    }

    const capture = options.json || options.quiet;
    const result = spawnSync(process.execPath, childArgs, {
        cwd: REPO_ROOT,
        env: { ...process.env, SOS_ROOT: INSTANCE_ROOT },
        encoding: capture ? 'utf-8' : undefined,
        stdio: capture ? 'pipe' : 'inherit'
    });
    const exitCode = result.status ?? 1;
    const elapsedMs = Date.now() - started;

    if (options.json && nativeJson) {
        if (result.stdout) process.stdout.write(result.stdout);
        else if (result.error) return fail(result.error.stack, options);
        if (options.verbose && result.stderr) process.stderr.write(result.stderr);
        if (exitCode !== 0) process.exitCode = exitCode;
        return;
    }

    if (options.json) {
        console.log(JSON.stringify({
            ok: exitCode === 0,
            command,
            dryRun: options.dryRun,
            exitCode,
            elapsedMs,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error?.message ?? null
        }, null, 2));
    } else if (options.quiet && exitCode !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        else if (result.stdout) process.stderr.write(result.stdout);
        else if (result.error) console.error(result.error.stack);
    } else if (options.verbose) {
        console.error(ui.muted(`[sos] exit: ${exitCode} (${elapsedMs}ms)`));
    }
    if (exitCode !== 0) process.exitCode = exitCode;
}

function singleSelector(args, command, options) {
    const unknown = args.filter(arg => arg.startsWith('-'));
    if (unknown.length) {
        fail(`Unknown ${command} option: ${unknown.join(', ')}`, options);
        return null;
    }
    if (args.length > 1) {
        fail(`Expected one inbox selector, received: ${args.join(', ')}`, options);
        return null;
    }
    return args;
}

async function main() {
    let parsed;
    try {
        parsed = parseCli(process.argv.slice(2));
    } catch (error) {
        return fail(error.stack);
    }
    const { command, args, options } = parsed;

    if (command === 'help' || options.help) {
        const helpTarget = command === 'help'
            ? args[0]?.toLowerCase()
            : options.help && command !== 'status'
                ? command.toLowerCase()
                : null;
        if (command === 'help' && args.length > 1) return fail('help accepts at most one command name.', options);

        let helpText = helpTarget ? COMMAND_HELP[helpTarget] : null;
        if (!helpText) {
            try {
                await initializeRuntime();
                const { commands } = await loadPluginRegistry();
                if (helpTarget) {
                    helpText = commands.get(helpTarget)?.help ?? null;
                } else {
                    helpText = appendPluginHelp(HELP, commands);
                }
            } catch (error) {
                if (helpTarget) return fail(error.stack, options);
                helpText = HELP;
            }
        }
        if (!helpText) return fail(`No help is available for: ${helpTarget}.`, options);
        if (options.json) return console.log(JSON.stringify({ ok: true, command: helpTarget, help: helpText }, null, 2));
        if (!options.quiet) console.log(colorizeHelp(helpText));
        return;
    }
    if (command === 'version' || options.version) {
        if (options.json) return console.log(JSON.stringify({ ok: true, version: VERSION }, null, 2));
        if (!options.quiet) console.log(VERSION);
        return;
    }

    try {
        await initializeRuntime();
        await loadPluginRegistry();
    } catch (error) {
        return fail(error.stack, options);
    }
    const ctx = { repoRoot: INSTANCE_ROOT, discoverDomains };
    if (command === 'status') return statusCommand(args, options, ctx);
    if (command === 'init') return initCommand(args, options, ctx);
    if (command === 'inbox') return inboxCommand(args, options, ctx);
    if (command === 'doctor') return doctorCommand(args, options, ctx);
    if (command === 'config') return configCommand(args, options, ctx);

    if (command === 'ingest') {
        const frontierIndex = args.indexOf('--frontier');
        const isFrontier = frontierIndex !== -1;
        if (isFrontier) args.splice(frontierIndex, 1);

        const forwarded = singleSelector(args, command, options);
        if (!forwarded) return;

        if (isFrontier) forwarded.push('--frontier');
        return runDelegated(command, 'ingest.mjs', forwarded, options, { supportsDryRun: true, nativeJson: true });
    }
    if (command === 'fetch') {
        return runDelegated(command, 'fetch.mjs', args, options, { supportsDryRun: true, nativeJson: true });
    }
    if (command === 'graph') return runDelegated(command, 'graph.mjs', args, options, { nativeJson: true });
    if (command === 'audit') return runDelegated(command, 'audit.mjs', args, options, { nativeJson: true });
    if (command === 'check') return runDelegated(command, 'pipeline.mjs', args, options, { nativeJson: true });
    if (command === 'sync') return runDelegated(command, 'sync.mjs', args, options, { supportsDryRun: true, nativeJson: true });
    if (command === 'upgrade') {
        return runDelegated(command, 'upgrade.mjs', args, options, { supportsDryRun: true, nativeJson: true, fromExecuting: true });
    }

    const plugin = pluginRegistry.commands.get(command);
    if (plugin) return runPlugin(plugin, args, options);

    fail(`Unknown command: ${command}. Run 'sos help' for usage.`, options);
}

main().catch(error => fail(error.stack));
