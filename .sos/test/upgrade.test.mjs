import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'os';
import test from 'node:test';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

function instanceFixture() {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-upgrade-instance-'));
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    mkdirSync(join(root, 'journal'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"instance","version":"1.0.0","type":"module"}\n', 'utf-8');
    writeFileSync(join(root, '.sos', 'lib', 'domains.mjs'), 'export const REPO_ROOT = "fixture";\n', 'utf-8');
    writeFileSync(join(root, '.sos', 'config.json'), '{"version":1,"systemName":"Workbench Fixture"}\n', 'utf-8');
    writeFileSync(join(root, '.sos', 'operator-preferences.json'), '{"preferences":["Keep this preference."]}\n', 'utf-8');
    writeFileSync(join(root, 'journal', 'SPACE.md'), '# keep me\n', 'utf-8');
    writeFileSync(join(root, 'AGENTS.md'), '# old agents\n', 'utf-8');
    writeFileSync(join(root, 'DEBRIEF.md'), '# old debrief protocol\n', 'utf-8');
    writeFileSync(join(root, '.gitignore'), 'old\n', 'utf-8');
    writeFileSync(join(root, '.sos', 'sos.mjs'), '#!/usr/bin/env node\n', 'utf-8');
    return root;
}

test('upgrade --dry-run overlays the control plane and preserves instance custody', () => {
    const dest = instanceFixture();
    const result = spawnSync(process.execPath, [
        join(SOURCE_ROOT, '.sos', 'sos.mjs'),
        'upgrade',
        '--dry-run',
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
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.toVersion, '1.5.0');
    assert.equal(payload.fromVersion, '1.0.0');
    assert.ok(payload.copied.includes('AGENTS.md'));
    assert.ok(payload.copied.includes('DEBRIEF.md'));
    assert.ok(payload.copied.includes('.sos/lib/'));
    assert.deepEqual(payload.preserved, ['.sos/config.json', '.sos/operator-preferences.json']);
    assert.ok(payload.copied.includes('SETUP.md'));
    assert.ok(payload.copied.includes('.sos/plugins/apple-metal/'));
    assert.ok(payload.copied.includes('.sos/plugins/linux/'));
    assert.ok(payload.copied.includes('.sos/plugins/windows/'));
    assert.equal(readFileSync(join(dest, 'AGENTS.md'), 'utf-8'), '# old agents\n');
    assert.equal(readFileSync(join(dest, 'DEBRIEF.md'), 'utf-8'), '# old debrief protocol\n');
    assert.equal(readFileSync(join(dest, 'journal', 'SPACE.md'), 'utf-8'), '# keep me\n');
    assert.equal(JSON.parse(readFileSync(join(dest, '.sos', 'operator-preferences.json'), 'utf-8')).preferences[0], 'Keep this preference.');
});

test('upgrade copies the control plane and keeps config, preferences, and notes', () => {
    const dest = instanceFixture();
    mkdirSync(join(dest, '.sos', 'plugins', 'linux-metal'), { recursive: true });
    writeFileSync(join(dest, '.sos', 'plugins', 'linux-metal', 'vision.sh'), 'old wrapper\n');
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
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf-8')).version, '1.5.0');
    assert.match(readFileSync(join(dest, 'AGENTS.md'), 'utf-8'), /sos upgrade/);
    assert.match(readFileSync(join(dest, 'DEBRIEF.md'), 'utf-8'), /Conversational Debrief Protocol/);
    assert.equal(JSON.parse(readFileSync(join(dest, '.sos', 'config.json'), 'utf-8')).systemName, 'Workbench Fixture');
    assert.equal(JSON.parse(readFileSync(join(dest, '.sos', 'operator-preferences.json'), 'utf-8')).preferences[0], 'Keep this preference.');
    assert.equal(readFileSync(join(dest, 'journal', 'SPACE.md'), 'utf-8'), '# keep me\n');
    assert.equal(existsSync(join(dest, '.sos', 'plugins', 'linux-metal')), false);
    assert.equal(existsSync(join(dest, '.sos', 'plugins', 'apple-metal', 'vision.swift')), true);
    assert.equal(existsSync(join(dest, '.sos', 'plugins', 'linux', 'vision.sh')), true);
    assert.equal(existsSync(join(dest, '.sos', 'plugins', 'windows', 'ocr.ps1')), true);
});

test('upgrade refuses to overlay a repository onto itself', () => {
    const result = spawnSync(process.execPath, [
        join(SOURCE_ROOT, '.sos', 'sos.mjs'),
        'upgrade',
        '--json',
        '--path',
        SOURCE_ROOT
    ], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: SOURCE_ROOT, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /onto itself/);
});

test('publish-template is unknown and has no help', () => {
    const unknown = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'publish-template', '--json'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.notEqual(unknown.status, 0);
    const payload = JSON.parse(unknown.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Unknown command: publish-template/);

    const overview = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(overview.status, 0, overview.stderr || overview.stdout);
    assert.doesNotMatch(overview.stdout, /publish-template/);

    const named = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help', 'publish-template'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.notEqual(named.status, 0);
    assert.match(named.stdout + named.stderr, /No help is available for: publish-template/);
});

test('sos help lists upgrade from the published zip or a local path', () => {
    const overview = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(overview.status, 0, overview.stderr || overview.stdout);
    assert.match(overview.stdout, /sos upgrade/);
    assert.match(overview.stdout, /Sovereign OS/);

    const named = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help', 'upgrade'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(named.status, 0, named.stderr || named.stdout);
    assert.match(named.stdout, /sos upgrade/);
    assert.match(named.stdout, /published/);
    assert.match(named.stdout, /--path/);
    assert.doesNotMatch(named.stdout, /git clone/);
    assert.doesNotMatch(named.stdout, /template/);
});

test('sos help review documents the charter body re-audit', () => {
    const named = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help', 'review'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(named.status, 0, named.stderr || named.stdout);
    assert.match(named.stdout, /review charter <domain>/);
    assert.match(named.stdout, /not in the terminal/);
});
