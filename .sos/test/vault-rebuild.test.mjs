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

function journalSyncFixture(systemName) {
    const fixture = mkdtempSync(join(os.tmpdir(), 'sos-sync-own-src-'));
    const vaultParent = mkdtempSync(join(os.tmpdir(), 'sos-sync-own-vault-'));
    mkdirSync(join(fixture, 'journal', 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'operator-preferences.json'), '{"preferences":[]}\n');
    writeFileSync(join(fixture, '.sos', 'config.json'), `${JSON.stringify({
        version: 1,
        systemName,
        vaults: [vaultParent],
        mirrors: []
    }, null, 2)}\n`);
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
    return { fixture, vaultParent };
}

test('sos sync stamps a new vault charter and refuses a foreign owner without --force', () => {
    const { fixture, vaultParent } = journalSyncFixture('Example Work System');
    const env = { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' };
    delete env.SOS_OBSIDIAN_ROOT;

    const first = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--json'], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8'
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const charter = join(vaultParent, 'Journal', 'Journal Charter.md');
    assert.match(readFileSync(charter, 'utf-8'), /compiled_from: "Example Work System"/);

    writeFileSync(charter, [
        '---',
        'compiled_from: "Example Personal System"',
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
        '# Keep me',
        ''
    ].join('\n'));
    writeFileSync(join(vaultParent, 'Journal', 'marker.md'), 'untouched\n');

    const blocked = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--json'], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8'
    });
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /already exists under a different system "Example Personal System"/);
    assert.doesNotMatch(payload.error, /init --domain/);
    assert.equal(readFileSync(join(vaultParent, 'Journal', 'marker.md'), 'utf-8'), 'untouched\n');
    assert.match(readFileSync(charter, 'utf-8'), /Keep me/);

    const forced = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--json', '--force'], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8'
    });
    assert.equal(forced.status, 0, forced.stderr || forced.stdout);
    assert.match(readFileSync(charter, 'utf-8'), /compiled_from: "Example Work System"/);
});

test('sos sync stops on an unstamped existing vault charter', () => {
    const { fixture, vaultParent } = journalSyncFixture('Example Personal System');
    mkdirSync(join(vaultParent, 'Journal'), { recursive: true });
    writeFileSync(join(vaultParent, 'Journal', 'Journal Charter.md'), [
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
        '# Legacy',
        ''
    ].join('\n'));
    const env = { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' };
    delete env.SOS_OBSIDIAN_ROOT;
    const result = spawnSync(process.execPath, [join(repoRoot, '.sos', 'sos.mjs'), 'sync', '--quick', '--vaults', '--json'], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /already exists and has no system stamp/);
    assert.match(payload.error, /Overwrite is not recommended: sos sync --force/);
    assert.match(readFileSync(join(vaultParent, 'Journal', 'Journal Charter.md'), 'utf-8'), /Legacy/);
});
