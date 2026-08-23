import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resetCompiledVault } from '../lib/vault-rebuild.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('resetCompiledVault keeps .obsidian and live inbox, removes notes and archive', () => {
    const vault = mkdtempSync(join(os.tmpdir(), 'sos-vault-rebuild-'));
    mkdirSync(join(vault, '.obsidian', 'cache'), { recursive: true });
    mkdirSync(join(vault, 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(vault, 'assets'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{}');
    writeFileSync(join(vault, 'inbox', 'memo.md'), 'capture');
    writeFileSync(join(vault, 'inbox', 'archive', 'old.pdf'), 'pdf');
    writeFileSync(join(vault, 'self-working-signature.md'), 'Brittany Perkins');
    writeFileSync(join(vault, 'assets', 'note.md'), 'asset');

    const dry = resetCompiledVault(vault, { dryRun: true });
    assert.equal(existsSync(join(vault, 'self-working-signature.md')), true);
    assert.ok(dry.some(path => path.endsWith('self-working-signature.md')));

    const removed = resetCompiledVault(vault);
    assert.equal(existsSync(join(vault, '.obsidian', 'app.json')), true);
    assert.equal(existsSync(join(vault, 'inbox', 'memo.md')), true);
    assert.equal(existsSync(join(vault, 'inbox', 'archive')), false);
    assert.equal(existsSync(join(vault, 'self-working-signature.md')), false);
    assert.equal(existsSync(join(vault, 'assets')), false);
    assert.deepEqual(readdirSync(vault).sort(), ['.obsidian', 'inbox']);
    assert.equal(removed.length, 3);
});

test('sos sync --rebuild restores compiled notes and archive without touching live inbox or .obsidian', () => {
    const fixture = mkdtempSync(join(os.tmpdir(), 'sos-sync-rebuild-src-'));
    const obsidian = mkdtempSync(join(os.tmpdir(), 'sos-sync-rebuild-vault-'));
    mkdirSync(join(fixture, 'journal', 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'operator-preferences.json'), '{"preferences":[]}\n');
    writeFileSync(join(fixture, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal Charter"',
        'type: "charter"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Journal',
        ''
    ].join('\n'));
    writeFileSync(join(fixture, 'journal', 'working.md'), [
        '---',
        'id: "jrnl:working"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Working"',
        'type: "note"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Working',
        '',
        'Source of truth.',
        ''
    ].join('\n'));
    writeFileSync(join(fixture, 'journal', 'inbox', 'archive', 'ground.txt'), 'tier3');

    const vault = join(obsidian, 'Journal');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    mkdirSync(join(vault, 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{"kept":true}\n');
    writeFileSync(join(vault, 'inbox', 'memo.md'), 'mobile capture');
    writeFileSync(join(vault, 'inbox', 'archive', 'stale.pdf'), 'stale');
    writeFileSync(join(vault, 'working.md'), 'dest drift');

    const result = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--rebuild', '--json', '--verbose'], {
        cwd: repoRoot,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: obsidian, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.rebuild, true);
    assert.equal(readFileSync(join(vault, '.obsidian', 'app.json'), 'utf-8'), '{"kept":true}\n');
    assert.equal(readFileSync(join(vault, 'inbox', 'memo.md'), 'utf-8'), 'mobile capture');
    assert.equal(existsSync(join(vault, 'inbox', 'archive', 'stale.pdf')), false);
    assert.equal(readFileSync(join(vault, 'inbox', 'archive', 'ground.txt'), 'utf-8'), 'tier3');
    assert.match(readFileSync(join(vault, 'working.md'), 'utf-8'), /Source of truth/);
    assert.doesNotMatch(readFileSync(join(vault, 'working.md'), 'utf-8'), /dest drift/);
});

test('sos sync compiles the same domain into every configured vault without fingerprint collision', () => {
    const fixture = mkdtempSync(join(os.tmpdir(), 'sos-sync-multivault-src-'));
    const first = mkdtempSync(join(os.tmpdir(), 'sos-sync-multivault-a-'));
    const second = mkdtempSync(join(os.tmpdir(), 'sos-sync-multivault-b-'));
    mkdirSync(join(fixture, 'journal', 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'operator-preferences.json'), '{"preferences":[]}\n');
    writeFileSync(join(fixture, '.sos', 'config.json'), `${JSON.stringify({ version: 1, vaults: [first, second], mirrors: [] }, null, 2)}\n`);
    writeFileSync(join(fixture, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal Charter"',
        'type: "charter"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Journal',
        ''
    ].join('\n'));
    writeFileSync(join(fixture, 'journal', 'working.md'), [
        '---',
        'id: "jrnl:working"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Working"',
        'type: "note"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Working',
        '',
        'Compiled once for every vault.',
        ''
    ].join('\n'));

    const env = { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' };
    delete env.SOS_OBSIDIAN_ROOT;
    const result = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--json'], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(readFileSync(join(first, 'Journal', 'working.md'), 'utf-8'), /Compiled once for every vault/);
    assert.match(readFileSync(join(second, 'Journal', 'working.md'), 'utf-8'), /Compiled once for every vault/);

    const manifest = JSON.parse(readFileSync(join(fixture, '.sos', 'cache', 'vault-manifest.json'), 'utf-8'));
    const keys = Object.keys(manifest.files).filter(key => key.endsWith('::Journal/working.md') || key.endsWith('::Journal\\working.md'));
    assert.equal(keys.length, 2);
    assert.ok(keys.some(key => key.startsWith(`${first}::`)));
    assert.ok(keys.some(key => key.startsWith(`${second}::`)));
});
