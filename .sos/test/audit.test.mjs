import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const AUDIT_SCRIPT = join(SOURCE_ROOT, '.sos', 'lib', 'audit.mjs');

function writeNote(root, relativePath, { id, parent, domain, exposure, related = 'related: []', body = 'Fixture body.' }) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, [
        '---',
        `id: "${id}"`,
        `parent: "${parent}"`,
        related,
        `title: "${id}"`,
        'description: "Fixture."',
        'type: "note"',
        `domain: "${domain}"`,
        `exposure: "${exposure}"`,
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        `# ${id}`,
        '',
        body,
        ''
    ].join('\n'), 'utf-8');
}

function twoDomainFixture() {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-audit-ifc-'));
    writeNote(root, 'personal/SPACE.md', {
        id: 'psn:charter',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private'
    });
    writeNote(root, 'projects/SPACE.md', {
        id: 'proj:charter',
        parent: 'proj:charter',
        domain: 'projects',
        exposure: 'public'
    });
    return root;
}

function runAudit(root, ...args) {
    return spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
}

test('audit reports Tier 1 counts separately from assets', () => {
    const root = twoDomainFixture();
    writeNote(root, 'projects/assets/text-fixture.md', {
        id: 'proj:text-fixture',
        parent: 'proj:charter',
        domain: 'projects',
        exposure: 'public'
    });
    const result = runAudit(root, '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.nodes, 2);
    assert.equal(payload.assets, 1);
});

test('audit fails IFC on parent and body links into private nodes', () => {
    const root = twoDomainFixture();
    writeNote(root, 'personal/secret.md', {
        id: 'psn:secret',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private'
    });
    writeNote(root, 'projects/leak.md', {
        id: 'proj:leak',
        parent: 'psn:secret',
        domain: 'projects',
        exposure: 'public',
        body: 'See [secret](../personal/secret.md).'
    });
    const result = runAudit(root, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const channels = payload.failures.filter(item => item.code === 'ifc').map(item => item.channel).sort();
    assert.deepEqual(channels, ['body', 'parent']);
});

test('audit counts an evidence chain complete only when every archive pointer exists', () => {
    const root = twoDomainFixture();
    writeNote(root, 'personal/research.md', {
        id: 'psn:research',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        body: [
            'Source: [complete](assets/transcript-complete.md)',
            'Source: [partial](assets/transcript-partial.md)'
        ].join('\n')
    });
    writeNote(root, 'personal/assets/transcript-complete.md', {
        id: 'psn:transcript-complete',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        body: [
            '**Source Media:** [complete.m4a](../inbox/archive/complete.m4a)',
            '**Raw JSON Telemetry (Tier 3):** [transcript-complete.json](../inbox/archive/transcript-complete.json)'
        ].join('\n')
    });
    writeNote(root, 'personal/assets/transcript-partial.md', {
        id: 'psn:transcript-partial',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        body: [
            '**Source Media:** [partial.m4a](../inbox/archive/partial.m4a)',
            '**Raw JSON Telemetry (Tier 3):** [transcript-partial.json](../inbox/archive/transcript-partial.json)'
        ].join('\n')
    });
    mkdirSync(join(root, 'personal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'complete.m4a'), 'audio');
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'transcript-complete.json'), '{}');
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'partial.m4a'), 'audio');

    const result = runAudit(root, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.tierOneSources, 2);
    assert.equal(payload.summary.evidenceChains, 1);
    assert.equal(payload.summary.missingArchives, 1);
    assert.equal(payload.failures.some(item => item.code === 'missing-archive'), true);
});
