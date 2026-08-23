import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'os';
import test from 'node:test';

import { appendPluginHelp, discoverPlugins, pluginOverviewLines } from '../lib/plugins.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

test('discoverPlugins registers commands from plugin.json manifests', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-plugins-discover-'));
    const pluginDir = join(root, '.sos', 'plugins', 'sample');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        id: 'sample',
        version: '1.0.0',
        commands: {
            sample: {
                script: 'run.mjs',
                help: 'sos sample\n\nRun the sample plugin.'
            }
        }
    }, null, 2), 'utf-8');

    const { plugins, commands } = discoverPlugins(root);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].id, 'sample');
    assert.equal(commands.get('sample').script, 'run.mjs');
    assert.deepEqual(pluginOverviewLines(commands), ['  sos sample          Run the sample plugin.']);
    assert.match(appendPluginHelp('before\n\nOutput controls:', commands), /Plugins\n  sos sample/);
});

test('upgrade preserves instance plugins while overlaying the kernel', () => {
    const dest = mkdtempSync(join(os.tmpdir(), 'sos-plugins-upgrade-'));
    mkdirSync(join(dest, '.sos', 'lib'), { recursive: true });
    mkdirSync(join(dest, '.sos', 'plugins', 'ninja-tickets'), { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"name":"instance","version":"1.0.0","type":"module"}\n', 'utf-8');
    writeFileSync(join(dest, '.sos', 'lib', 'domains.mjs'), 'export const REPO_ROOT = "fixture";\n', 'utf-8');
    writeFileSync(join(dest, '.sos', 'config.json'), '{"version":1}\n', 'utf-8');
    writeFileSync(join(dest, '.sos', 'plugins', 'ninja-tickets', 'plugin.json'), '{"id":"ninja-tickets","commands":{}}\n', 'utf-8');
    writeFileSync(join(dest, '.sos', 'plugins', 'ninja-tickets', 'analyze.mjs'), 'export {}\n', 'utf-8');

    const result = spawnSync(process.execPath, [
        join(SOURCE_ROOT, '.sos', 'sos.mjs'),
        'upgrade',
        '--json',
        '--path',
        SOURCE_ROOT
    ], {
        cwd: dest,
        env: { ...process.env, SOS_ROOT: dest, NO_COLOR: '1' },
        encoding: 'utf-8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.preserved, ['.sos/config.json', '.sos/operator-preferences.json']);
    assert.equal(readFileSync(join(dest, '.sos', 'plugins', 'ninja-tickets', 'analyze.mjs'), 'utf-8'), 'export {}\n');
    assert.equal(readFileSync(join(dest, '.sos', 'plugins', 'ninja-tickets', 'plugin.json'), 'utf-8'), '{"id":"ninja-tickets","commands":{}}\n');
});
