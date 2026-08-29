import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, sep } from 'path';

import { localDateString, slugify } from './debrief.mjs';

export const REQUIRED_T2_RECORD_TAGS = ['assets', 't2-record', 'sensor-output'];

function yamlString(value) {
    return JSON.stringify(String(value));
}

function posixRelative(fromPath, targetPath) {
    return relative(dirname(fromPath), targetPath).split(sep).join('/');
}

function markdownLink(fromPath, targetPath, label = basename(targetPath)) {
    return `[${label}](${posixRelative(fromPath, targetPath)})`;
}

function tableCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function routingSlug(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function outputLabel(recordPath, output) {
    const path = typeof output === 'string' ? output : output.path;
    const link = markdownLink(recordPath, path);
    const details = [output?.role, output?.mediaType].filter(Boolean).join(' · ');
    return details ? `${link} — ${tableCell(details)}` : link;
}

function recordProfile(scope, rows) {
    const supplied = rows.find(row => row.recordProfile)?.recordProfile || {};
    if (scope === 'batch') {
        const frontier = rows.some(row => row.sensorId === 'frontier:handoff');
        return {
            prefix: frontier ? 'frontier-batch-intake' : 'batch-intake',
            inventoryPrefix: frontier ? 'frontier-batch-inventory' : 'batch-inventory',
            titlePrefix: frontier ? 'Frontier Intake' : 'Batch Intake',
            type: frontier ? 'frontier-batch-intake' : 'batch-intake',
            description: frontier
                ? `Deterministic frontier escalation handoff with ${rows.length} archived sources and an explicit operator request.`
                : `Completed deterministic local batch intake record for ${rows.length} sources.`
        };
    }
    return {
        prefix: routingSlug(supplied.prefix) || 'record',
        titlePrefix: String(supplied.titlePrefix || 'Tier 2 Record'),
        type: String(supplied.type || 't2-record'),
        description: String(supplied.description || 'Completed deterministic extraction record for one source.')
    };
}

function inventoryRecord({ row, index, slug, inventoryPath }) {
    const outputs = row.artifactDetails?.length ? row.artifactDetails : (row.artifacts || []).map(path => ({ path }));
    return {
        record_id: `batch:${slug}:${String(index + 1).padStart(6, '0')}`,
        source_file: row.relativePath || row.originalPath,
        source_sha256: row.sourceSha256 || null,
        bytes: Number(row.bytes) || 0,
        detected_type: row.fileType || 'unsupported',
        sensor: row.sensorId || 'unknown',
        sensor_version: row.sensorVersion || null,
        local_baseline: row.localAdvice || null,
        tier3_archive: row.archivePath ? posixRelative(inventoryPath, row.archivePath) : null,
        tier2_outputs: outputs.map(output => ({
            path: posixRelative(inventoryPath, typeof output === 'string' ? output : output.path),
            role: typeof output === 'string' ? null : output.role || null,
            media_type: typeof output === 'string' ? null : output.mediaType || null
        })),
        status: 'complete',
        warnings: row.warnings || []
    };
}

function allocateRecordPath(domain, label, prefix, inventoryPrefix = null) {
    const base = slugify(label) || 'capture';
    let slug = base;
    let path = join(domain.path, 'assets', `${prefix}-${slug}.md`);
    let inventoryPath = inventoryPrefix ? join(domain.path, 'assets', `${inventoryPrefix}-${slug}.jsonl`) : null;
    for (let counter = 2; existsSync(path) || (inventoryPath && existsSync(inventoryPath)); counter++) {
        slug = `${base}-${counter}`;
        path = join(domain.path, 'assets', `${prefix}-${slug}.md`);
        inventoryPath = inventoryPrefix ? join(domain.path, 'assets', `${inventoryPrefix}-${slug}.jsonl`) : null;
    }
    return { path, slug, inventoryPath };
}

function normalizedTags(domain, scope, rows) {
    const tags = new Set([domain.name, ...REQUIRED_T2_RECORD_TAGS, `scope-${scope}`]);
    for (const row of rows) {
        if (row.sensorId) tags.add(`sensor-${routingSlug(row.sensorId)}`);
        for (const tag of row.tags || []) {
            const normalized = slugify(tag);
            if (normalized) tags.add(normalized);
        }
    }
    return [...tags];
}

/**
 * Writes the primary Markdown record only when an intake has no existing
 * Markdown projection, or when a batch needs one aggregate entrypoint.
 */
export function writeT2Record({ domain, label, scope, rows, dryRun = false }) {
    if (!rows?.length) throw new Error('A Tier 2 record requires at least one completed source row.');
    const profile = recordProfile(scope, rows);
    const { path, slug, inventoryPath } = allocateRecordPath(domain, label, profile.prefix, scope === 'batch' ? profile.inventoryPrefix : null);
    const date = localDateString();
    const tags = normalizedTags(domain, scope, rows);
    const hashes = [...new Set(rows.map(row => row.sourceSha256).filter(Boolean))];
    const sensors = [...new Set(rows.map(row => row.sensorId).filter(Boolean))];
    const recordCount = rows.reduce((sum, row) => sum + (Number(row.recordCount) || 0), 0);
    const title = `${profile.titlePrefix}: ${label}`;
    const frontier = rows.find(row => row.sensorId === 'frontier:handoff') || null;

    const tableRows = rows.map(row => {
        const archive = markdownLink(path, row.archivePath);
        const declaredOutputs = row.artifactDetails?.length ? row.artifactDetails : (row.artifacts || []);
        const outputs = declaredOutputs.length
            ? declaredOutputs.map(output => outputLabel(path, output)).join('<br>')
            : '—';
        const sensor = `${row.sensorId || 'unknown'}${row.sensorVersion ? ` @ ${row.sensorVersion}` : ''}`;
        return `| ${tableCell(row.originalPath)} | ${tableCell(sensor)} | ${tableCell(row.sourceSha256 || '—')} | ${archive} | ${outputs} | ${Number(row.recordCount) || '—'} | ${tableCell((row.warnings || []).join('; ') || '—')} |`;
    }).join('\n');
    const inventory = inventoryPath
        ? rows.map((row, index) => inventoryRecord({ row, index, slug, inventoryPath }))
        : [];

    const summaries = rows
        .filter(row => row.summaryMarkdown)
        .map(row => String(row.summaryMarkdown).trim())
        .join('\n\n');

    const lines = [
        '---',
        `id: ${yamlString(`${domain.prefix}:${profile.prefix}-${slug}`)}`,
        `parent: ${yamlString(`${domain.prefix}:charter`)}`,
        'related: []',
        `title: ${yamlString(title)}`,
        `description: ${yamlString(profile.description)}`,
        `type: ${yamlString(profile.type)}`,
        `domain: ${yamlString(domain.name)}`,
        `exposure: ${yamlString(domain.exposure)}`,
        'status: "active"',
        `created: ${date}`,
        `updated: ${date}`,
        ...(hashes.length === 1 ? [`source_sha256: ${yamlString(hashes[0])}`] : []),
        ...(frontier ? [
            'provenance: "frontier-handoff"',
            `frontier_request: ${yamlString(frontier.frontierRequest || '')}`
        ] : []),
        ...(inventoryPath ? [`source_inventory: ${yamlString(basename(inventoryPath))}`] : []),
        `tags: [${tags.map(yamlString).join(', ')}]`,
        '---',
        '',
        `# ${title}`,
        '',
        frontier
            ? '> Deterministic Tier 2 frontier handoff. It records custody and authorization; it is not model analysis or reviewed knowledge.'
            : '> Deterministic Tier 2 extraction. It is evidence, not reviewed knowledge.',
        '',
        '## Extraction Status',
        '',
        '- **Status:** Complete',
        `- **Scope:** ${scope === 'batch' ? 'Folder batch' : 'Single capture'}`,
        `- **Sources:** ${rows.length}`,
        `- **Sensors:** ${sensors.join(', ') || 'unknown'}`,
        `- **Indexed records:** ${recordCount || 'Not applicable'}`,
        '',
        ...(inventoryPath ? [
            '## Batch Inventory',
            '',
            `Every source in this capture set is independently addressable in ${markdownLink(path, inventoryPath)}.`,
            ''
        ] : []),
        '## Source and Output Index',
        '',
        '| Original inbox path | Sensor | Source SHA-256 | Tier 3 source | Tier 2 companions | Records | Warnings |',
        '| --- | --- | --- | --- | --- | ---: | --- |',
        tableRows,
        '',
        ...(summaries ? ['## Deterministic Summary', '', summaries, ''] : [])
    ];

    const content = `${lines.join('\n')}\n`;
    if (!dryRun) {
        mkdirSync(dirname(path), { recursive: true });
        if (inventoryPath) writeFileSync(inventoryPath, `${inventory.map(record => JSON.stringify(record)).join('\n')}\n`, { encoding: 'utf-8', flag: 'wx' });
        writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
    }
    return { path, content, slug, tags, recordCount, inventoryPath, artifacts: [path, ...(inventoryPath ? [inventoryPath] : [])] };
}
