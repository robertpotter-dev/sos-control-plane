import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { getAllMarkdownFiles } from '../lib/domains.mjs';
import { edgesFromRecords, parseRecord, physicalTier, scanRecords } from '../lib/records.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

function writeNote(root, relativePath, { id, parent = 'psn:charter', related = 'related: []', body = 'Fixture body.' } = {}) {
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
        'domain: "personal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        body,
        ''
    ].join('\n'), 'utf-8');
    return path;
}

test('parseRecord returns null when frontmatter is missing', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-records-none-'));
    const path = join(root, 'note.md');
    writeFileSync(path, '# No frontmatter\n', 'utf-8');
    assert.equal(parseRecord(path, readFileSync(path, 'utf-8'), { repoRoot: root }), null);
});

test('parseRecord sets physical tier from folder location', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-records-tier-'));
    const note = writeNote(root, 'personal/alpha.md', { id: 'psn:alpha' });
    const asset = writeNote(root, 'personal/assets/transcript.md', { id: 'psn:transcript' });
    const inbox = writeNote(root, 'personal/inbox/debrief-alpha.md', { id: 'psn:debrief-alpha' });

    assert.equal(physicalTier('personal/alpha.md'), 1);
    assert.equal(parseRecord(note, readFileSync(note, 'utf-8'), { repoRoot: root }).tier, 1);
    assert.equal(parseRecord(asset, readFileSync(asset, 'utf-8'), { repoRoot: root }).tier, 2);
    assert.equal(parseRecord(inbox, readFileSync(inbox, 'utf-8'), { repoRoot: root }).tier, 3);
});

test('parseRecord evidence lists asset then archive pointers from fixture links', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-records-evidence-'));
    mkdirSync(join(root, 'personal', 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(root, 'personal', 'assets'), { recursive: true });
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'complete.m4a'), 'audio');
    writeFileSync(join(root, 'personal', 'inbox', 'archive', 'complete.json'), '{}');
    writeFileSync(join(root, 'personal', 'assets', 'complete.events.jsonl'), '{}\n');
    writeNote(root, 'personal/assets/transcript-complete.md', {
        id: 'psn:transcript-complete',
        body: [
            '**Source Media:** [complete.m4a](../inbox/archive/complete.m4a)',
            '**Raw JSON:** [complete.json](../inbox/archive/complete.json)',
            '**Event index:** [complete.events.jsonl](complete.events.jsonl)'
        ].join('\n')
    });
    const notePath = writeNote(root, 'personal/research.md', {
        id: 'psn:research',
        body: 'Source: [complete](assets/transcript-complete.md)'
    });

    const record = parseRecord(notePath, readFileSync(notePath, 'utf-8'), {
        repoRoot: root,
        domainTierByName: { personal: 1 }
    });
    assert.equal(record.tier, 1);
    assert.deepEqual(record.evidence, [{
        asset: 'personal/assets/transcript-complete.md',
        artifacts: ['personal/assets/complete.events.jsonl'],
        archives: [
            'personal/inbox/archive/complete.m4a',
            'personal/inbox/archive/complete.json'
        ]
    }]);
    assert.deepEqual(record.evidencePaths, ['personal/assets/transcript-complete.md']);
});

test('edgesFromRecords emits from, predicate, to, and legacy from relations', () => {
    const records = [
        {
            id: 'psn:source',
            relations: [
                { id: 'psn:target', predicate: 'EVIDENCES', legacy: false },
                { id: 'psn:old', predicate: null, legacy: true }
            ]
        },
        { id: 'psn:lonely', relations: [] }
    ];
    assert.deepEqual(edgesFromRecords(records), [
        { from: 'psn:source', predicate: 'EVIDENCES', to: 'psn:target', legacy: false },
        { from: 'psn:source', predicate: null, to: 'psn:old', legacy: true }
    ]);
});

test('scanRecords walks domain markdown through getAllMarkdownFiles', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-records-scan-'));
    writeNote(root, 'personal/SPACE.md', { id: 'psn:charter', parent: 'psn:charter' });
    writeNote(root, 'personal/alpha.md', { id: 'psn:alpha' });
    writeNote(root, 'personal/assets/hidden.md', { id: 'psn:hidden' });
    const records = scanRecords({
        repoRoot: root,
        discoverDomains: () => [{ name: 'personal', path: join(root, 'personal'), tier: 1 }],
        getAllMarkdownFiles
    });
    const byId = Object.fromEntries(records.map(record => [record.id, record]));
    assert.equal(byId['psn:charter'].tier, 1);
    assert.equal(byId['psn:alpha'].tier, 1);
    assert.equal(byId['psn:hidden'].tier, 2);
});

test('audit.mjs and graph.mjs import identity from records.mjs', () => {
    const audit = readFileSync(join(SOURCE_ROOT, '.sos', 'lib', 'audit.mjs'), 'utf-8');
    const graph = readFileSync(join(SOURCE_ROOT, '.sos', 'lib', 'graph.mjs'), 'utf-8');
    assert.match(audit, /from '\.\/records\.mjs'/);
    assert.match(graph, /from '\.\/records\.mjs'/);
    assert.match(audit, /parseRecord|scanRecords/);
    assert.match(graph, /parseRecord|scanRecords/);
});
