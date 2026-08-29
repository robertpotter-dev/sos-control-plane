import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import test from 'node:test';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

function note({ id, title, body = '', type = 'note' }) {
    return [
        '---',
        `id: "${id}"`,
        'parent: "about-me:charter"',
        'related: []',
        `title: "${title}"`,
        `type: "${type}"`,
        'domain: "about-me"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-24',
        'updated: 2026-08-24',
        'tags: ["test"]',
        '---',
        '',
        `# ${title}`,
        '',
        body,
        ''
    ].join('\n');
}

function runTrace(root, ...args) {
    return spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'trace', ...args], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
}

test('trace stays inside one T1 evidence route and can recover exact raw lines', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-trace-'));
    mkdirSync(join(root, 'about-me', 'assets'), { recursive: true });
    mkdirSync(join(root, 'about-me', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'about-me', 'SPACE.md'), note({ id: 'about-me:charter', title: 'About Me', type: 'charter' }));
    writeFileSync(join(root, 'about-me', 'media-diet.md'), note({
        id: 'about-me:media-diet',
        title: 'Media Diet',
        body: '## Source\n\n[Event index](assets/event-index.md)'
    }));
    writeFileSync(join(root, 'about-me', 'assets', 'event-index.md'), note({
        id: 'about-me:event-index',
        title: 'Event Index',
        type: 'activity-index',
        body: '[Event index](events.jsonl)\n\n[Raw source](../inbox/archive/source.html)'
    }));
    writeFileSync(join(root, 'about-me', 'assets', 'events.jsonl'), [
        JSON.stringify({ record_id: 'event:one', occurred_at: '2026-07-03T13:18:37-05:00', title: 'Example Song', publisher: 'Northwind Topic', source_line_start: 2, source_line_end: 3 }),
        JSON.stringify({ record_id: 'event:two', occurred_at: '2026-07-04T09:00:00-05:00', title: 'Different Video', publisher: 'Elsewhere', source_line_start: 4, source_line_end: 4 }),
        ''
    ].join('\n'));
    writeFileSync(join(root, 'about-me', 'inbox', 'archive', 'source.html'), [
        '<html>',
        '<p>Watched <a>Example Song</a></p>',
        '<p>Northwind Topic</p>',
        '<p>Different Video</p>',
        '</html>',
        ''
    ].join('\n'));

    const result = runTrace(root, 'about-me:media-diet', 'Northwind', '--source', '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.node.id, 'about-me:media-diet');
    assert.deepEqual(payload.routes, [{
        asset: 'about-me/assets/event-index.md',
        artifacts: ['about-me/assets/events.jsonl'],
        archives: ['about-me/inbox/archive/source.html']
    }]);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].record.record_id, 'event:one');
    assert.equal(payload.matches[0].source.lineStart, 2);
    assert.match(payload.matches[0].source.text, /Example Song[\s\S]*Northwind Topic/);
});

test('trace applies inclusive since and exclusive until to occurred_at', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-trace-time-'));
    mkdirSync(join(root, 'about-me', 'assets'), { recursive: true });
    mkdirSync(join(root, 'about-me', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'about-me', 'SPACE.md'), note({ id: 'about-me:charter', title: 'About Me', type: 'charter' }));
    writeFileSync(join(root, 'about-me', 'media-diet.md'), note({
        id: 'about-me:media-diet',
        title: 'Media Diet',
        body: '[Event index](assets/event-index.md)'
    }));
    writeFileSync(join(root, 'about-me', 'assets', 'event-index.md'), note({
        id: 'about-me:event-index',
        title: 'Event Index',
        type: 'activity-index',
        body: '[Event index](events.jsonl)\n\n[Raw source](../inbox/archive/source.html)'
    }));
    writeFileSync(join(root, 'about-me', 'assets', 'events.jsonl'), [
        JSON.stringify({ record_id: 'event:before', occurred_at: '2026-01-31T23:59:59-05:00', source_file: 'source.html' }),
        JSON.stringify({ record_id: 'event:start', occurred_at: '2026-02-01T00:00:00-05:00', source_file: 'source.html' }),
        JSON.stringify({ record_id: 'event:inside', occurred_at: '2026-02-01T22:40:33-05:00', source_file: 'source.html' }),
        JSON.stringify({ record_id: 'event:end', occurred_at: '2026-02-02T00:00:00-05:00', source_file: 'source.html' }),
        JSON.stringify({ record_id: 'transcript:relative', start_timestamp: '00:00:02,000', source_file: 'memo.m4a' }),
        ''
    ].join('\n'));
    writeFileSync(join(root, 'about-me', 'inbox', 'archive', 'source.html'), '<html></html>\n');

    const result = runTrace(root, 'about-me:media-diet', '--since', '2026-02-01', '--until', '2026-02-02', '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.since, '2026-02-01');
    assert.equal(payload.until, '2026-02-02');
    assert.deepEqual(payload.matches.map(match => match.record.record_id), ['event:start', 'event:inside']);
});

test('trace rejects invalid or inverted temporal bounds', () => {
    const invalid = runTrace(SOURCE_ROOT, 'about-me:anything', '--since', '204-days-ago', '--json');
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stdout).error, /ISO 8601/);

    const inverted = runTrace(SOURCE_ROOT, 'about-me:anything', '--since', '2026-02-02', '--until', '2026-02-01', '--json');
    assert.equal(inverted.status, 1);
    assert.match(JSON.parse(inverted.stdout).error, /earlier than/);
});
