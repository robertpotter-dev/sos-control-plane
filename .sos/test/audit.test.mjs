import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const AUDIT_SCRIPT = join(SOURCE_ROOT, '.sos', 'lib', 'audit.mjs');

function writeNote(root, relativePath, { id, parent, domain, exposure, related = 'related: []', type = 'note', extra = [], body = 'Fixture body.' }) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, [
        '---',
        `id: "${id}"`,
        `parent: "${parent}"`,
        related,
        `title: "${id}"`,
        'description: "Fixture."',
        `type: "${type}"`,
        `domain: "${domain}"`,
        `exposure: "${exposure}"`,
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        ...extra,
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

test('audit distinguishes missing Tier 2 indexes from missing Tier 3 sources', () => {
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
            '**Timestamped Whisper Index (Tier 2):** [transcript-complete.segments.jsonl](transcript-complete.segments.jsonl)'
        ].join('\n')
    });
    writeNote(root, 'personal/assets/transcript-partial.md', {
        id: 'psn:transcript-partial',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        body: [
            '**Source Media:** [partial.m4a](../inbox/archive/partial.m4a)',
            '**Timestamped Whisper Index (Tier 2):** [transcript-partial.segments.jsonl](transcript-partial.segments.jsonl)'
        ].join('\n')
    });
    mkdirSync(join(root, 'personal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'complete.m4a'), 'audio');
    writeFileSync(join(root, 'personal', 'assets', 'transcript-complete.segments.jsonl'), '{}\n');
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'partial.m4a'), 'audio');

    const result = runAudit(root, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.tierOneSources, 2);
    assert.equal(payload.summary.evidenceChains, 1);
    assert.equal(payload.summary.missingArtifacts, 1);
    assert.equal(payload.summary.missingArchives, 0);
    assert.equal(payload.failures.some(item => item.code === 'missing-artifact'), true);
});

test('audit enforces the frontier model artifact contract', () => {
    const root = twoDomainFixture();
    writeNote(root, 'personal/assets/frontier-intake-source.md', {
        id: 'psn:frontier-intake-source',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        type: 'frontier-intake',
        extra: [
            'provenance: "frontier-handoff"',
            'frontier_request: "Analyze the visual language."',
            `source_sha256: "${'a'.repeat(64)}"`
        ]
    });
    const options = {
        id: 'psn:frontier-visual-analysis-clip',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        type: 'frontier-visual-analysis'
    };
    writeNote(root, 'personal/assets/frontier-visual-analysis-clip.md', options);

    let result = runAudit(root, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    let payload = JSON.parse(result.stdout);
    const fields = payload.failures.filter(item => item.code === 'frontier-contract').map(item => item.field).sort();
    assert.deepEqual(fields, ['frontier_model', 'frontier_request', 'provenance', 'source_coverage', 'source_intake', 'source_sha256 or source_inventory', 'uncertainty']);

    writeNote(root, 'personal/assets/frontier-visual-analysis-complete.md', {
        ...options,
        id: 'psn:frontier-visual-analysis-complete',
        extra: [
            'provenance: "frontier-model"',
            'frontier_model: "openai/gpt-5.6-terra"',
            'frontier_request: "Analyze the visual language."',
            'source_intake: "psn:frontier-intake-source"',
            `source_sha256: "${'a'.repeat(64)}"`,
            'source_coverage: "Entire 00:00:00–00:02:00 video."',
            'uncertainty: "No frame-by-frame measurements were produced."'
        ]
    });
    // Remove the deliberately incomplete fixture so the complete contract stands alone.
    const incomplete = join(root, 'personal', 'assets', 'frontier-visual-analysis-clip.md');
    unlinkSync(incomplete);
    result = runAudit(root, '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.failures.some(item => item.code === 'frontier-contract'), false);
});

test('audit verifies a frontier batch hash belongs to its referenced inventory', () => {
    const root = twoDomainFixture();
    const hash = 'b'.repeat(64);
    const absent = 'c'.repeat(64);
    const assets = join(root, 'personal', 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'frontier-batch-inventory-album.jsonl'), `${JSON.stringify({ record_id: 'batch:album:000001', source_file: 'takes/rough.wav', source_sha256: hash })}\n`, 'utf-8');
    writeNote(root, 'personal/assets/frontier-batch-intake-album.md', {
        id: 'psn:frontier-batch-intake-album',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        type: 'frontier-batch-intake',
        extra: [
            'provenance: "frontier-handoff"',
            'frontier_request: "Analyze the album project."',
            'source_inventory: "frontier-batch-inventory-album.jsonl"'
        ]
    });
    const artifact = {
        id: 'psn:frontier-batch-mix-analysis-album',
        parent: 'psn:charter',
        domain: 'personal',
        exposure: 'private',
        type: 'frontier-batch-mix-analysis'
    };
    const complete = sourceSha => [
        'provenance: "frontier-model"',
        'frontier_model: "openai/gpt-5.6-terra"',
        'frontier_request: "Analyze the album project."',
        'source_intake: "psn:frontier-batch-intake-album"',
        'source_inventory: "frontier-batch-inventory-album.jsonl"',
        `source_sha256: "${sourceSha}"`,
        'source_coverage: "The rough mix only."',
        'uncertainty: "No stems were available."'
    ];
    writeNote(root, 'personal/assets/frontier-batch-mix-analysis-album.md', { ...artifact, extra: complete(hash) });

    let result = runAudit(root, '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);

    writeNote(root, 'personal/assets/frontier-batch-mix-analysis-album.md', { ...artifact, extra: complete(absent) });
    result = runAudit(root, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.failures.some(item => item.code === 'frontier-contract' && item.field === 'source_sha256' && item.expected === 'a member of source_inventory'), true);
});
