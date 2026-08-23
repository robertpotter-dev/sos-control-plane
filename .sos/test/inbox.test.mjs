import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { collectInboxBatchFiles, scanInboxes } from '../lib/inbox-scan.mjs';

test('collectInboxBatchFiles lists nested batch contents without strict rejection', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-inbox-scan-'));
    const batch = join(root, 'site visit');
    const nested = join(batch, 'notes');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(batch, 'photo.jpg'), 'jpg', 'utf-8');
    writeFileSync(join(nested, 'summary.md'), '# Summary\n', 'utf-8');
    writeFileSync(join(batch, 'debrief-site-visit.md'), 'pending', 'utf-8');

    const files = collectInboxBatchFiles(batch);
    assert.deepEqual(files.map(file => file.relativePath), ['notes/summary.md', 'photo.jpg']);
    assert.equal(files[0].type, 'text');
    assert.equal(files[1].type, 'image');
});

test('inbox --verbose expands batch folders in JSON output', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-inbox-verbose-'));
    const inbox = join(root, 'journal', 'inbox', 'site visit');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(inbox, 'morning.md'), '# Morning\n', 'utf-8');
    writeFileSync(join(inbox, 'photo.png'), 'png', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/sos.mjs', 'inbox', 'site visit', '--verbose', '--json'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root },
        encoding: 'utf-8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.items[0].type, 'batch');
    assert.deepEqual(payload.items[0].files.map(file => file.relativePath), ['morning.md', 'photo.png']);
});

test('inbox help documents verbose batch expansion', () => {
    const result = spawnSync(process.execPath, ['.sos/sos.mjs', 'help', 'inbox'], {
        cwd: join(import.meta.dirname, '..', '..'),
        encoding: 'utf-8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--verbose\s+Expand batch folders to list contained files and capture kinds\./);
});

test('scanInboxes classifies capture, batch, and debrief from one shared walk', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-scan-inboxes-'));
    const icloudRoot = mkdtempSync(join(os.tmpdir(), 'sos-scan-icloud-'));
    const domainPath = join(root, 'journal');
    const inbox = join(domainPath, 'inbox');
    mkdirSync(join(inbox, 'archive'), { recursive: true });
    mkdirSync(join(inbox, 'site visit'), { recursive: true });
    mkdirSync(join(icloudRoot, 'Journal', 'inbox'), { recursive: true });
    writeFileSync(join(inbox, 'memo.m4a'), 'audio', 'utf-8');
    writeFileSync(join(inbox, 'debrief-memo.md'), 'pending', 'utf-8');
    writeFileSync(join(inbox, 'archive', 'old.bin'), 'x', 'utf-8');
    writeFileSync(join(inbox, '.hidden'), 'x', 'utf-8');
    writeFileSync(join(inbox, 'site visit', 'photo.jpg'), 'jpg', 'utf-8');
    writeFileSync(join(icloudRoot, 'Journal', 'inbox', 'voice.m4a'), 'audio', 'utf-8');

    mkdirSync(join(root, '.sos'), { recursive: true });
    writeFileSync(join(root, '.sos', 'config.json'), JSON.stringify({ vaults: [icloudRoot] }));
    const domain = { name: 'journal', path: domainPath, vaultName: 'Journal' };
    const items = scanInboxes(() => [domain], { repoRoot: root, icloudRoot });
    const local = Object.fromEntries(items.filter(item => item.location === 'local').map(item => [item.type, item]));
    const mobile = items.filter(item => item.location === 'external');

    assert.deepEqual(items.map(item => `${item.location}:${item.type}`).sort(), [
        'external:capture',
        'local:batch',
        'local:capture',
        'local:debrief'
    ]);
    assert.equal(local.capture.name, 'memo.m4a');
    assert.equal(local.capture.domain, 'journal');
    assert.equal(local.capture.displayPath, 'journal/inbox/memo.m4a');
    assert.equal(local.batch.name, 'site visit');
    assert.equal(local.debrief.name, 'debrief-memo.md');
    assert.equal(local.debrief.extension, '.md');
    assert.equal(mobile.length, 1);
    assert.equal(mobile[0].name, 'voice.m4a');
    assert.equal(mobile[0].displayPath, 'external/Journal/inbox/voice.m4a');
});
