#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function option(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const action = args[0];
const sourcePath = option(args, '--source');
if (!sourcePath) throw new Error('--source is required.');
const html = readFileSync(sourcePath, 'utf-8');

if (action === 'probe') {
    const match = /data-sos-fixture=["']event-index["']/.test(html);
    console.log(JSON.stringify({
        match,
        confidence: match ? 100 : 0,
        format: match ? 'fixture-event-html' : null
    }));
    process.exit(0);
}
if (action !== 'extract') throw new Error(`Unknown action: ${action}`);

const outputDir = option(args, '--output-dir');
const stem = option(args, '--stem') || 'capture';
if (!outputDir) throw new Error('--output-dir is required.');
mkdirSync(outputDir, { recursive: true });
const outputName = `events-${stem}.events.jsonl`;
const sourceFile = basename(sourcePath);
const records = [];
for (const match of html.matchAll(/<article\b([^>]*)>/g)) {
    const attrs = match[1];
    const attr = name => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || null;
    records.push({
        record_id: `fixture:${records.length}`,
        occurred_at: attr('data-at'),
        title: attr('data-title'),
        source_file: sourceFile,
        source_line_start: attr('data-start') ? Number(attr('data-start')) : null,
        source_line_end: attr('data-end') ? Number(attr('data-end')) : null
    });
}
writeFileSync(join(outputDir, outputName), `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
console.log(JSON.stringify({
    ok: true,
    outputs: [{ path: outputName, role: 'event-index', mediaType: 'application/x-ndjson' }],
    recordCount: records.length,
    warnings: [],
    tags: ['structured-history', 'event-index'],
    recordProfile: {
        prefix: 'events',
        titlePrefix: 'Event Index',
        type: 'activity-index',
        description: 'Fixture event index.'
    }
}));
