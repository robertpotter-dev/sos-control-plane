import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const GRAPH_SCRIPT = join(SOURCE_ROOT, '.sos', 'lib', 'graph.mjs');

function writeNode(root, relativePath, { id, title, description, related = 'related: []', body = 'Fixture body.' }) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, [
        '---',
        `id: "${id}"`,
        'parent: "psn:charter"',
        related,
        `title: "${title}"`,
        `description: "${description}"`,
        'type: "note"',
        'domain: "personal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-16',
        'updated: 2026-08-16',
        'tags: ["test"]',
        '---',
        '',
        `# ${title}`,
        '',
        body,
        ''
    ].join('\n'), 'utf-8');
}

function graphFixture() {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-graph-fixture-'));
    const domain = join(root, 'personal');
    mkdirSync(domain, { recursive: true });
    writeNode(root, 'personal/SPACE.md', {
        id: 'psn:charter',
        title: 'Personal Charter',
        description: 'Fixture domain charter.'
    });
    writeNode(root, 'personal/alpha.md', {
        id: 'psn:alpha',
        title: 'Alpha Note',
        description: 'A Robert system fixture.'
    });
    writeNode(root, 'personal/beta.md', {
        id: 'psn:beta',
        title: 'Beta Note',
        description: 'Another Robert system fixture.'
    });
    return root;
}

function runGraph(root, ...args) {
    return spawnSync(process.execPath, [GRAPH_SCRIPT, ...args], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
}

function runSos(root, ...args) {
    return spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), ...args], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
}

function parseJson(result) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test('ambiguous graph keywords present candidates without choosing a primary node', () => {
    const root = graphFixture();
    const result = runGraph(root, 'robert');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Multiple matching nodes identified by tags or description\./);
    assert.match(result.stdout, /\[psn:alpha\]/);
    assert.match(result.stdout, /\[psn:beta\]/);
    assert.doesNotMatch(result.stdout, /NODE:/);
    assert.equal(existsSync(join(root, '.sos', 'cache', 'graph-index.json')), false);
});

test('--deep expands tied graph candidates without selecting one', () => {
    const root = graphFixture();
    const result = runGraph(root, 'robert', '--deep');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEEP CONTEXT FOR TIED MATCHES/);
    assert.match(result.stdout, /One-hop context only — this does not select a primary node\./);
    assert.match(result.stdout, /\[psn:alpha\]/);
    assert.match(result.stdout, /Links: 0 outbound · 0 inbound · 0 Tier 2 evidence sources/);
    assert.doesNotMatch(result.stdout, /NODE:/);
});

test('exact selectors and a unique title phrase resolve directly', () => {
    const root = graphFixture();

    for (const selector of ['psn:alpha', 'personal/alpha.md', 'Alpha Note', 'Alpha']) {
        const result = runGraph(root, selector);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /NODE: psn:alpha/);
    assert.doesNotMatch(result.stdout, /Multiple matching nodes identified/);
    }
});

test('graph prints typed predicates for forward and virtual inbound edges', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-graph-typed-fixture-'));
    mkdirSync(join(root, 'personal'), { recursive: true });
    writeNode(root, 'personal/SPACE.md', {
        id: 'psn:charter',
        title: 'Personal Charter',
        description: 'Fixture domain charter.'
    });
    writeNode(root, 'personal/source.md', {
        id: 'psn:source',
        title: 'Source Note',
        description: 'Evidence fixture.',
        related: 'related:\n  - id: "psn:target"\n    predicate: "EVIDENCES"',
        body: '[Deterministic source](assets/source-evidence.md)'
    });
    writeNode(root, 'personal/target.md', {
        id: 'psn:target',
        title: 'Target Note',
        description: 'Target fixture.'
    });

    const result = runGraph(root, 'psn:target', '--deep');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /EVIDENCES \[psn:source\]/);
    assert.match(result.stdout, /INDIRECT EVIDENCE ROUTES/);
    assert.match(result.stdout, /personal\/assets\/source-evidence\.md/);
});

test('graph --json emits a compact resolved node without note bodies', () => {
    const root = graphFixture();
    const payload = parseJson(runGraph(root, 'psn:alpha', '--json'));

    assert.equal(payload.ok, true);
    assert.equal(payload.resolution, 'node');
    assert.equal(payload.matchClass, 'exact canonical ID');
    assert.equal(payload.node.id, 'psn:alpha');
    assert.equal(payload.node.path, 'personal/alpha.md');
    assert.equal(payload.node.status, 'active');
    assert.deepEqual(payload.node.tags, ['test']);
    assert.equal(payload.node.parent.id, 'psn:charter');
    assert.equal(payload.node.content, undefined);
    assert.equal(payload.stdout, undefined);
    assert.equal(JSON.stringify(payload).includes('Fixture body'), false);
});

test('graph --json lists a tied candidate set without selecting a node', () => {
    const root = graphFixture();
    const payload = parseJson(runGraph(root, 'robert', '--json'));

    assert.equal(payload.resolution, 'tie');
    assert.equal(payload.matchClass, 'tags or description');
    assert.equal(payload.node, undefined);
    assert.deepEqual(payload.candidates.map(item => item.id).sort(), ['psn:alpha', 'psn:beta']);
    assert.equal(payload.candidates[0].related, undefined);
});

test('graph --json --deep includes typed edges and indirect evidence without neighbor prose', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-graph-json-deep-'));
    mkdirSync(join(root, 'personal'), { recursive: true });
    writeNode(root, 'personal/SPACE.md', {
        id: 'psn:charter',
        title: 'Personal Charter',
        description: 'Fixture domain charter.'
    });
    writeNode(root, 'personal/source.md', {
        id: 'psn:source',
        title: 'Source Note',
        description: 'Evidence fixture.',
        related: 'related:\n  - id: "psn:target"\n    predicate: "EVIDENCES"',
        body: '[Deterministic source](assets/source-evidence.md)'
    });
    writeNode(root, 'personal/target.md', {
        id: 'psn:target',
        title: 'Target Note',
        description: 'Target fixture.'
    });

    const payload = parseJson(runGraph(root, 'psn:target', '--deep', '--json'));
    assert.equal(payload.resolution, 'node');
    assert.equal(payload.deep, true);
    assert.deepEqual(payload.node.backlinks, [{
        id: 'psn:source',
        predicate: 'EVIDENCES',
        title: 'Source Note',
        path: 'personal/source.md',
        domain: 'personal',
        type: 'note'
    }]);
    assert.deepEqual(payload.node.indirectEvidence, [{
        id: 'psn:source',
        title: 'Source Note',
        path: 'personal/source.md',
        evidence: 'personal/assets/source-evidence.md'
    }]);
    assert.equal(JSON.stringify(payload).includes('Evidence fixture.'), false);
});

test('graph --json reports body-text unique opens as coverage, not identity', () => {
    const root = graphFixture();
    writeNode(root, 'personal/gamma.md', {
        id: 'psn:gamma',
        title: 'Gamma Note',
        description: 'Unrelated description.',
        body: 'Only this note mentions xylophone in the body.'
    });

    const payload = parseJson(runGraph(root, 'xylophone', '--json'));
    assert.equal(payload.resolution, 'node');
    assert.equal(payload.matchClass, 'body text');
    assert.equal(payload.node.id, 'psn:gamma');
});

test('graph --json with no query emits compact stats', () => {
    const root = graphFixture();
    const payload = parseJson(runGraph(root, '--json'));
    assert.equal(payload.resolution, 'stats');
    assert.equal(payload.nodes, 3);
    assert.equal(payload.node, undefined);
});

test('sos graph --json is a native payload, not a wrapped stdout report', () => {
    const root = graphFixture();
    const payload = parseJson(runSos(root, 'graph', 'psn:alpha', '--json'));

    assert.equal(payload.resolution, 'node');
    assert.equal(payload.node.id, 'psn:alpha');
    assert.equal(payload.command, undefined);
    assert.equal(payload.stdout, undefined);
    assert.equal(payload.elapsedMs, undefined);
});

test('graph help documents the compact json payload', () => {
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help', 'graph'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--json\s+Compact machine payload: a resolved node, a tied candidate set, or graph stats\./);
});

test('graph reads a fresh version-4 index and does not write one on query', () => {
    const root = graphFixture();
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
        process.env.SOS_ROOT = ${JSON.stringify(root)};
        const { buildGraph, writeLocalIndex } = await import(${JSON.stringify(pathToFileURL(join(SOURCE_ROOT, '.sos', 'lib', 'graph.mjs')).href)});
        writeLocalIndex(buildGraph());
    `], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(writer.status, 0, writer.stderr);
    const indexPath = join(root, '.sos', 'cache', 'graph-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    assert.equal(index.version, 4);
    assert.ok(Array.isArray(index.edges));
    const alpha = index.nodes.find(node => node.id === 'psn:alpha');
    assert.ok(alpha);
    assert.equal(alpha.tier, 1);
    assert.ok(Array.isArray(alpha.evidence));
    alpha.title = 'Index Shadow Title';
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const payload = parseJson(runGraph(root, 'psn:alpha', '--json'));
    assert.equal(payload.node.title, 'Index Shadow Title');
});
