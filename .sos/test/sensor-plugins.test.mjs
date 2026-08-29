import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { KERNEL_PLUGIN_DIRS } from '../lib/control-plane.mjs';
import { discoverPlugins } from '../lib/plugins.mjs';
import { extractWithSensor, selectSensor, validateObservationIndex } from '../lib/sensor-plugins.mjs';
import { writeT2Record } from '../lib/t2-record.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_PLUGIN = join(SOURCE_ROOT, '.sos', 'test', 'fixtures', 'sensor-plugin');

const FIXTURE_HTML = `<!doctype html>
<html>
<body data-sos-fixture="event-index">
<article data-at="2026-07-03T13:18:37-05:00" data-title="Alpha" data-start="3" data-end="7"></article>
<article data-at="2026-07-02T07:37:46-05:00" data-title="Bravo"></article>
</body>
</html>
`;

function installPlugin(root) {
    const destination = join(root, '.sos', 'plugins', 'fixture-events');
    mkdirSync(join(root, '.sos', 'plugins'), { recursive: true });
    cpSync(FIXTURE_PLUGIN, destination, { recursive: true });
}

test('kernel overlay slots are OS adapters only', () => {
    assert.deepEqual(KERNEL_PLUGIN_DIRS, ['apple-metal', 'linux', 'windows']);
    const sensorHost = readFileSync(join(SOURCE_ROOT, '.sos', 'lib', 'sensor-plugins.mjs'), 'utf-8');
    assert.doesNotMatch(sensorHost, /maxBuffer/);
});

test('agent-authored sensor probes and extracts JSONL', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sensor-plugin-'));
    installPlugin(root);
    const source = join(root, 'capture.html');
    const assets = join(root, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(source, FIXTURE_HTML, 'utf-8');

    const { sensors } = discoverPlugins(root);
    const match = selectSensor(source, sensors);
    assert.ok(match);
    assert.equal(match.sensor.pluginId, 'fixture-events');
    assert.equal(match.sensor.sensorId, 'events');
    const result = extractWithSensor(match, {
        sourcePath: source,
        outputDir: assets,
        stem: 'fixture',
        domain: { name: 'about-me', exposure: 'private' },
        sourceSha256: 'a'.repeat(64)
    });
    assert.equal(result.recordCount, 2);
    assert.equal(result.artifacts.length, 1);
    const records = readFileSync(result.artifacts[0], 'utf-8').trim().split('\n').map(JSON.parse);
    assert.equal(records[0].occurred_at, '2026-07-03T13:18:37-05:00');
    assert.equal(records[0].title, 'Alpha');
    assert.equal(records[1].title, 'Bravo');
    assert.deepEqual([records[0].source_line_start, records[0].source_line_end], [3, 7]);
});

test('a crashing probe does not block a working sensor for the same extension', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sensor-probe-isolate-'));
    installPlugin(root);
    const broken = join(root, '.sos', 'plugins', 'broken-html');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({
        id: 'broken-html',
        version: '0.0.1',
        sensors: {
            html: {
                script: 'sensor.mjs',
                description: 'Always crash on probe.',
                extensions: ['.html'],
                priority: 99
            }
        }
    }), 'utf-8');
    writeFileSync(join(broken, 'sensor.mjs'), '#!/usr/bin/env node\nprocess.exit(1);\n', 'utf-8');
    const source = join(root, 'capture.html');
    writeFileSync(source, FIXTURE_HTML, 'utf-8');

    const { sensors } = discoverPlugins(root);
    const match = selectSensor(source, sensors);
    assert.ok(match);
    assert.equal(match.sensor.pluginId, 'fixture-events');
});

test('every crashing probe for an extension is a hard failure, not an unknown source', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sensor-probe-all-fail-'));
    const broken = join(root, '.sos', 'plugins', 'broken-html');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({
        id: 'broken-html',
        version: '0.0.1',
        sensors: {
            html: {
                script: 'sensor.mjs',
                description: 'Always crash on probe.',
                extensions: ['.html']
            }
        }
    }), 'utf-8');
    writeFileSync(join(broken, 'sensor.mjs'), '#!/usr/bin/env node\nprocess.exit(1);\n', 'utf-8');
    const source = join(root, 'capture.html');
    writeFileSync(source, FIXTURE_HTML, 'utf-8');

    const { sensors } = discoverPlugins(root);
    assert.throws(() => selectSensor(source, sensors), /Sensor probe failed/);
});

test('sensor observation indexes require one addressable object per JSONL line', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sensor-jsonl-contract-'));
    const valid = join(root, 'events.jsonl');
    writeFileSync(valid, '{"record_id":"source:1","source_file":"source.html","value":1}\n');
    assert.doesNotThrow(() => validateObservationIndex({ path: valid, role: 'event-index', mediaType: 'application/x-ndjson' }));

    const arrayJson = join(root, 'events.jsonl');
    writeFileSync(arrayJson, '[{"record_id":"source:1","source_file":"source.html"}]\n');
    assert.throws(
        () => validateObservationIndex({ path: arrayJson, role: 'event-index', mediaType: 'application/x-ndjson' }),
        /must be one object/
    );
    assert.throws(
        () => validateObservationIndex({ path: join(root, 'events.json'), role: 'event-index', mediaType: 'application/json' }, { dryRun: true }),
        /must use \.jsonl/
    );

    const crlf = join(root, 'crlf.events.jsonl');
    writeFileSync(crlf, '{"record_id":"source:1","source_file":"source.html"}\r\n{"record_id":"source:2","source_file":"source.html"}\r\n');
    assert.doesNotThrow(() => validateObservationIndex({ path: crlf, role: 'event-index', mediaType: 'application/x-ndjson' }));
});

test('kernel primary Tier 2 record supplies required tags and links companions to the archive', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-t2-record-'));
    const domain = { name: 'about-me', prefix: 'about-me', exposure: 'private', path: join(root, 'about-me') };
    const archive = join(domain.path, 'inbox', 'archive', 'capture.html');
    const payload = join(domain.path, 'assets', 'capture.events.jsonl');
    mkdirSync(join(domain.path, 'inbox', 'archive'), { recursive: true });
    mkdirSync(join(domain.path, 'assets'), { recursive: true });
    writeFileSync(archive, '<html></html>', 'utf-8');
    writeFileSync(payload, '{}\n', 'utf-8');
    const record = writeT2Record({
        domain,
        label: 'capture',
        scope: 'single',
        rows: [{
            originalPath: 'about-me/inbox/capture.html',
            archivePath: archive,
            artifacts: [payload],
            sourceSha256: 'b'.repeat(64),
            sensorId: 'plugin:fixture-events/events',
            recordCount: 1,
            warnings: [],
            tags: ['structured-history'],
            summaryMarkdown: 'One event.'
        }]
    });
    const content = readFileSync(record.path, 'utf-8');
    assert.match(content, /type: "t2-record"/);
    assert.match(content, /"assets"/);
    assert.match(content, /"t2-record"/);
    assert.match(content, /capture\.events\.jsonl/);
    assert.match(content, /inbox\/archive\/capture\.html/);
});

test('unknown structured capture becomes a complete primary record and debrief only after its sensor succeeds', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sensor-ingest-'));
    const domain = join(root, 'about-me');
    mkdirSync(join(domain, 'inbox'), { recursive: true });
    installPlugin(root);
    writeFileSync(join(domain, 'SPACE.md'), [
        '---',
        'id: "about-me:charter"',
        'parent: "about-me:charter"',
        'related: []',
        'title: "About Me"',
        'description: "Fixture."',
        'type: "charter"',
        'domain: "about-me"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-24',
        'updated: 2026-08-24',
        'tags: ["test"]',
        '---',
        ''
    ].join('\n'), 'utf-8');
    writeFileSync(join(domain, 'inbox', 'capture.html'), FIXTURE_HTML, 'utf-8');

    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'lib', 'ingest.mjs'), '--json', 'about-me/inbox/capture.html'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.units[0].t2Record, 'about-me/assets/events-capture.md');
    assert.equal(existsSync(join(domain, 'inbox', 'capture.html')), false);
    assert.equal(existsSync(join(domain, 'inbox', 'archive', 'capture.html')), true);
    assert.equal(existsSync(join(domain, 'assets', 'events-capture.md')), true);
    assert.equal(existsSync(join(domain, 'assets', 'events-capture.events.jsonl')), true);
    const debrief = readFileSync(join(domain, 'inbox', 'debrief-capture.md'), 'utf-8');
    assert.match(debrief, /Primary Tier 2 Record/);
    assert.match(debrief, /events-capture\.md/);
});
