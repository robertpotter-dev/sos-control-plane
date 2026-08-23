#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { REPO_ROOT } from './domains.mjs';
import { refreshGraphIndex } from './graph.mjs';
import { ui } from './terminal.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

const stages = [
    { name: 'Format', script: 'format.mjs' },
    { name: 'Lint', script: 'lint.mjs' },
    { name: 'Audit', script: 'audit.mjs' }
];

function runStage(stage, json) {
    const started = Date.now();
    if (!json) console.log(`\n${ui.option('RUN')}  ${ui.heading(`${stages.indexOf(stage) + 1}. ${stage.name}`)}`);
    const childArgs = [join(LIB_DIR, stage.script)];
    if (json && stage.script === 'audit.mjs') childArgs.push('--json');
    const result = spawnSync(process.execPath, childArgs, {
        cwd: REPO_ROOT,
        env: { ...process.env, SOS_ROOT: REPO_ROOT },
        encoding: json ? 'utf-8' : undefined,
        stdio: json ? 'pipe' : 'inherit'
    });
    const ms = Date.now() - started;
    const entry = { name: stage.name, ok: (result.status ?? 1) === 0, ms };

    if (result.error) {
        entry.ok = false;
        entry.error = result.error.stack;
        if (!json) console.error(ui.error(`${stage.name} could not start: ${result.error.stack}`));
        return entry;
    }
    if (!entry.ok) {
        if (json && stage.script === 'audit.mjs' && result.stdout) {
            try {
                entry.audit = JSON.parse(result.stdout);
            } catch {
                entry.error = (result.stderr || result.stdout || '').trim().slice(0, 500) || null;
            }
        } else if (json) {
            entry.error = (result.stderr || result.stdout || '').trim().slice(0, 500) || null;
        } else {
            console.error(`${ui.error('FAIL')} ${stage.name} ${ui.muted(`(${ms} ms)`)}`);
            console.error(ui.error('Check halted before later stages.'));
        }
        return entry;
    }
    if (!json) console.log(`${ui.success('PASS')} ${stage.name} ${ui.muted(`(${ms} ms)`)}`);
    if (json && stage.script === 'audit.mjs' && result.stdout) {
        try {
            entry.audit = JSON.parse(result.stdout);
        } catch {
            /* keep the stage result even if audit JSON cannot be parsed */
        }
    }
    return entry;
}

function main() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const unknown = args.filter(arg => arg !== '--json');
    if (unknown.length) {
        const message = `check does not accept arguments: ${unknown.join(' ')}`;
        if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        else console.error(ui.error(message));
        process.exitCode = 1;
        return;
    }

    if (!json) {
        console.log(ui.accent('Sovereign OS check'));
        console.log(ui.muted('Format → Lint → Audit'));
    }

    const results = [];
    for (const stage of stages) {
        const entry = runStage(stage, json);
        results.push(entry);
        if (!entry.ok) {
            if (json) {
                console.log(JSON.stringify({
                    ok: false,
                    haltedAt: stage.name,
                    stages: results
                }, null, 2));
            }
            process.exitCode = 1;
            return;
        }
    }

    try {
        refreshGraphIndex();
    } catch (error) {
        if (json) {
            console.log(JSON.stringify({
                ok: false,
                haltedAt: 'Graph index',
                stages: results,
                error: error.stack
            }, null, 2));
        } else {
            console.error(ui.error(`Graph index could not be written: ${error.stack}`));
        }
        process.exitCode = 1;
        return;
    }

    if (json) console.log(JSON.stringify({ ok: true, stages: results }, null, 2));
    else console.log(`\n${ui.success('Check complete. Formatting, lint, and graph audit all passed.')}`);
}

main();
