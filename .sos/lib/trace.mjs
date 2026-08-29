#!/usr/bin/env node

import { createReadStream, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createInterface } from 'readline';
import { pathToFileURL } from 'url';

import { loadGraph } from './graph.mjs';
import { REPO_ROOT } from './domains.mjs';
import { ui } from './terminal.mjs';

function normalized(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function optionValue(argv, name) {
    const index = argv.indexOf(name);
    if (index < 0) return { index: -1, value: null };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return { index, value };
}

function temporalBound(value, flag) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const epoch = Date.parse(`${value}T00:00:00Z`);
        if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
            throw new Error(`${flag} requires a real ISO date or timestamp.`);
        }
        return { raw: value, dateOnly: true, epoch };
    }
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw new Error(`${flag} requires ISO 8601 with a timezone, or YYYY-MM-DD.`);
    }
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) throw new Error(`${flag} requires a real ISO date or timestamp.`);
    return { raw: value, dateOnly: false, epoch };
}

function parseArgs(argv) {
    const json = argv.includes('--json');
    const source = argv.includes('--source');
    const limitOption = optionValue(argv, '--limit');
    const sinceOption = optionValue(argv, '--since');
    const untilOption = optionValue(argv, '--until');
    let limit = 20;
    if (limitOption.index >= 0) {
        limit = Number(limitOption.value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be an integer from 1 to 200.');
    }
    const since = temporalBound(sinceOption.value, '--since');
    const until = temporalBound(untilOption.value, '--until');
    if (since && until && since.epoch >= until.epoch) throw new Error('--since must be earlier than --until.');
    const consumedValues = new Set([limitOption, sinceOption, untilOption].filter(option => option.index >= 0).map(option => option.index + 1));
    const positional = argv.filter((value, index) => !value.startsWith('--') && !consumedValues.has(index));
    if (!positional.length) throw new Error('Usage: sos trace <t1-id-or-path> [evidence keywords] [--since ISO] [--until ISO] [--source] [--limit N]');
    return {
        selector: positional[0],
        query: positional.slice(1).join(' '),
        json,
        source,
        limit,
        since,
        until
    };
}

function resolveNode(nodeMap, selector) {
    const path = selector.replace(/\\/g, '/').replace(/^\.\//, '');
    return [...nodeMap.values()].find(node => node.id === selector || node.relPath === path) || null;
}

function routePayload(route) {
    return {
        asset: route.asset,
        artifacts: route.artifacts || [],
        archives: route.archives || []
    };
}

function occursWithin(record, since, until) {
    if (!since && !until) return true;
    const occurredAt = record?.occurred_at;
    if (typeof occurredAt !== 'string') return false;
    const localDate = occurredAt.slice(0, 10);
    const epoch = Date.parse(occurredAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isFinite(epoch)) return false;
    if (since && (since.dateOnly ? localDate < since.raw : epoch < since.epoch)) return false;
    if (until && (until.dateOnly ? localDate >= until.raw : epoch >= until.epoch)) return false;
    return true;
}

async function jsonlRecords(route, query, limit, { since = null, until = null } = {}) {
    const terms = normalized(query).split(/\s+/).filter(Boolean);
    const matches = [];
    for (const artifact of route.artifacts || []) {
        if (!artifact.toLowerCase().endsWith('.jsonl')) continue;
        const path = join(REPO_ROOT, artifact);
        if (!existsSync(path)) continue;
        const reader = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });
        for await (const line of reader) {
            if (!line) continue;
            if (terms.length && !terms.every(term => normalized(line).includes(term))) continue;
            try {
                const record = JSON.parse(line);
                if (!occursWithin(record, since, until)) continue;
                matches.push({ artifact, record, archive: route.archives?.[0] || null });
            } catch {
                // Malformed payload lines are an audit concern; trace skips them.
            }
            if (matches.length >= limit) {
                reader.close();
                return matches;
            }
        }
    }
    return matches;
}

async function sourceExcerpt(match) {
    const archive = match.archive;
    const start = Number(match.record?.source_line_start);
    const end = Number(match.record?.source_line_end);
    if (!archive || !start || !end || end < start) return null;
    const path = join(REPO_ROOT, archive);
    if (!existsSync(path)) return null;
    const lines = [];
    let lineNumber = 0;
    const reader = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of reader) {
        lineNumber++;
        if (lineNumber >= start && lineNumber <= end) lines.push(line);
        if (lineNumber >= end) {
            reader.close();
            break;
        }
    }
    return {
        archive,
        lineStart: start,
        lineEnd: end,
        text: lines.join('\n')
    };
}

function printHuman(payload) {
    console.log(`\n${ui.heading('T1 GROUNDING NODE')}`);
    console.log(`  ${ui.command(`[${payload.node.id}]`)} ${payload.node.title}`);
    console.log(`  ${ui.muted(`${payload.node.path} · exposure: ${payload.node.exposure}`)}`);
    if (payload.since || payload.until) {
        console.log(`  ${ui.muted(`time: ${payload.since || 'beginning'} ≤ occurred_at < ${payload.until || 'end'}`)}`);
    }
    console.log(`\n${ui.heading('EVIDENCE ROUTES')}`);
    if (!payload.routes.length) console.log(ui.muted('  [ No T2 manifest is linked from this node ]'));
    for (const route of payload.routes) {
        console.log(`  - ${ui.muted(route.asset)}`);
        for (const artifact of route.artifacts) console.log(`    ├─ ${ui.muted(artifact)}`);
        for (const archive of route.archives) console.log(`    └─ ${ui.muted(archive)}`);
    }
    if (payload.query || payload.since || payload.until) {
        console.log(`\n${ui.heading(`MATCHING T2 RECORDS (${payload.matches.length})`)}`);
        for (const match of payload.matches) {
            const record = match.record;
            console.log(`  - ${ui.option(record.record_id || '(record)')} ${record.occurred_at || record.occurred_at_raw || record.start_timestamp || ''}`);
            console.log(`    ${record.title || record.activity || record.text || '(untitled)'}`);
            if (record.publisher) console.log(`    ${ui.muted(record.publisher)}`);
            if (match.source) console.log(`    ${ui.muted(`${match.source.archive}:${match.source.lineStart}-${match.source.lineEnd}`)}`);
        }
    }
    console.log('');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const graph = loadGraph();
    const node = resolveNode(graph, options.selector);
    if (!node) throw new Error(`No exact Tier 1 node matches ${options.selector}. Resolve it with sos graph first.`);
    const routes = (node.evidence || []).map(routePayload);
    let matches = [];
    if (options.query || options.since || options.until) {
        for (const route of routes) {
            matches.push(...await jsonlRecords(route, options.query, options.limit - matches.length, options));
            if (matches.length >= options.limit) break;
        }
    }
    if (options.source) matches = await Promise.all(matches.map(async match => ({ ...match, source: await sourceExcerpt(match) })));
    const payload = {
        ok: true,
        node: { id: node.id, title: node.title || '', path: node.relPath, domain: node.domain, exposure: node.exposure },
        query: options.query,
        since: options.since?.raw || null,
        until: options.until?.raw || null,
        routes,
        matches
    };
    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else printHuman(payload);
}

function isDirectRun() {
    try {
        return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    main().catch(error => {
        if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.stack }, null, 2));
        else console.error(`Error: ${error.stack}`);
        process.exitCode = 1;
    });
}
