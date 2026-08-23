#!/usr/bin/env node

import { existsSync, statSync, mkdtempSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import os from 'os';

import { fetchPublishedControlPlane, CONTROL_PLANE_ARCHIVE_URL } from './archive-fetch.mjs';
import {
    copyControlPlane,
    isControlPlaneRoot,
    isSovereignInstance,
    PRESERVE_ON_UPGRADE,
    readControlPlaneVersion
} from './control-plane.mjs';
import { REPO_ROOT } from './domains.mjs';
import { ui } from './terminal.mjs';

function parseArguments(argv) {
    let source = null;
    let explicitPath = false;
    const json = argv.includes('--json');
    const dryRun = argv.includes('--dry-run');
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--json' || arg === '--dry-run') continue;
        if (arg === '--path') {
            source = argv[++index];
            explicitPath = true;
            if (!source) throw new Error('--path requires a control-plane directory.');
            continue;
        }
        if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
        if (source) throw new Error('Unexpected argument: ' + arg);
        source = arg;
        explicitPath = true;
    }
    return { source: source ? resolve(source) : null, explicitPath, dryRun, json };
}

function emitError(message, json, extra = {}) {
    if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
    else console.error(ui.error(message));
    process.exitCode = 1;
}

function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        emitError(error.stack, process.argv.includes('--json'));
        return;
    }

    let { source, explicitPath, dryRun, json } = options;
    const dest = resolve(REPO_ROOT);
    let downloadTempDir = null;
    let sourceLabel = source || CONTROL_PLANE_ARCHIVE_URL;

    try {
        if (!explicitPath) {
            if (!json) console.log(ui.muted(`Downloading published control plane from ${CONTROL_PLANE_ARCHIVE_URL}...`));
            downloadTempDir = mkdtempSync(join(os.tmpdir(), 'sos-control-plane-'));
            source = fetchPublishedControlPlane(downloadTempDir);
            sourceLabel = CONTROL_PLANE_ARCHIVE_URL;
        }

        if (source === dest) {
            emitError('Refusing to overlay a path onto itself. Use sos upgrade to download the published archive, or --path to a different local copy.', json, { source, destination: dest });
            return;
        }
        if (!existsSync(source) || !statSync(source).isDirectory()) {
            emitError('Control plane does not exist: ' + sourceLabel, json, { source: sourceLabel });
            return;
        }
        if (!isControlPlaneRoot(source)) {
            emitError('Source is not a Sovereign OS control plane: ' + sourceLabel, json, { source: sourceLabel });
            return;
        }
        if (!isSovereignInstance(dest)) {
            emitError('Current directory is not a Sovereign OS instance.', json, { destination: dest });
            return;
        }

        const fromVersion = readControlPlaneVersion(dest);
        const toVersion = readControlPlaneVersion(source);
        let copied;
        let removed;
        try {
            ({ copied, removed } = copyControlPlane({ source, dest, dryRun }));
        } catch (error) {
            emitError(error.stack, json, { source: sourceLabel, destination: dest });
            return;
        }

        const result = {
            ok: true,
            dryRun,
            source: sourceLabel,
            destination: dest,
            fromVersion,
            toVersion,
            copied,
            removed,
            preserved: PRESERVE_ON_UPGRADE
        };
        if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        console.log(ui.accent(dryRun ? 'Control-plane upgrade (dry run)' : 'Control-plane upgrade'));
        console.log(`${ui.muted('Source')} ${sourceLabel} ${ui.muted(toVersion || '')}`);
        console.log(`${ui.muted('Instance')} ${dest} ${ui.muted(fromVersion || '')}`);
        for (const item of copied) console.log(`  ${dryRun ? ui.warning('WOULD COPY') : ui.success('COPY')}  ${ui.muted(item)}`);
        for (const item of removed) console.log(`  ${dryRun ? ui.warning('WOULD REMOVE') : ui.warning('REMOVE')}  ${ui.muted(item)}`);
        for (const item of PRESERVE_ON_UPGRADE) console.log(`  ${ui.muted('KEEP')}  ${ui.muted(item)}`);
        console.log(`  ${ui.muted('KEEP')}  ${ui.muted('.sos/plugins/<instance plugins with plugin.json>')}`);

    } catch (error) {
        emitError(error.stack, json);
    } finally {
        if (downloadTempDir) {
            try {
                rmSync(downloadTempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
    }
}

main();
