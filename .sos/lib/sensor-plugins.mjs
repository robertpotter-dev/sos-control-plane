import { spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve } from 'path';

import { forEachJsonlRecord } from './jsonl.mjs';

function parseSensorJson(result, action, sensor) {
    if (result.error) {
        if (result.error.code === 'ERR_CHILD_PROCESS_STDIO_MAX_BUFFER') {
            throw new Error(`${sensor.pluginId}/${sensor.sensorId} ${action} exceeded Node's default stdout buffer. Probe and extract must return a compact JSON envelope; observation indexes belong in files under --output-dir.`);
        }
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${sensor.pluginId}/${sensor.sensorId} ${action} failed:\n${result.stderr || result.stdout || `exit ${result.status}`}`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`${sensor.pluginId}/${sensor.sensorId} ${action} did not return JSON.`);
    }
}

function runSensorScript(sensor, args) {
    return spawnSync(process.execPath, [join(sensor.pluginDir, sensor.script), ...args], {
        cwd: sensor.pluginDir,
        env: { ...process.env },
        encoding: 'utf-8'
    });
}

export function probeSensor(sensor, sourcePath) {
    const result = runSensorScript(sensor, ['probe', '--source', sourcePath, '--json']);
    const payload = parseSensorJson(result, 'probe', sensor);
    return {
        match: Boolean(payload.match),
        confidence: Number(payload.confidence) || 0,
        format: String(payload.format || '')
    };
}

export function selectSensor(sourcePath, sensors) {
    const extension = extname(sourcePath).toLowerCase();
    const candidates = sensors.filter(sensor => sensor.extensions.includes(extension));
    const matches = [];
    const probeFailures = [];
    for (const sensor of candidates) {
        try {
            const probe = probeSensor(sensor, sourcePath);
            if (probe.match) matches.push({ sensor, probe });
        } catch (error) {
            probeFailures.push(`${sensor.pluginId}/${sensor.sensorId}: ${error.message}`);
        }
    }
    matches.sort((a, b) => b.probe.confidence - a.probe.confidence || b.sensor.priority - a.sensor.priority || a.sensor.sensorId.localeCompare(b.sensor.sensorId));
    if (matches.length > 1 && matches[0].probe.confidence === matches[1].probe.confidence && matches[0].sensor.priority === matches[1].sensor.priority) {
        throw new Error(`Multiple sensor plugins match ${sourcePath}: ${matches.slice(0, 2).map(item => `${item.sensor.pluginId}/${item.sensor.sensorId}`).join(', ')}`);
    }
    if (matches.length) return matches[0];
    if (probeFailures.length && probeFailures.length === candidates.length) {
        throw new Error(`Sensor probe failed for ${sourcePath}: ${probeFailures.join('; ')}`);
    }
    return null;
}

function resolveOutput(outputDir, path) {
    const candidate = resolve(isAbsolute(path) ? path : join(outputDir, path));
    const rel = relative(resolve(outputDir), candidate);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Sensor output escapes or aliases the assets directory: ${path}`);
    return candidate;
}

function isObservationIndex(output) {
    return extname(output.path).toLowerCase() === '.jsonl'
        || output.mediaType === 'application/x-ndjson'
        || /(^|-)index$/i.test(output.role || '');
}

export function validateObservationIndex(output, { dryRun = false } = {}) {
    if (!isObservationIndex(output)) return;
    if (extname(output.path).toLowerCase() !== '.jsonl' || output.mediaType !== 'application/x-ndjson') {
        throw new Error(`Machine observation index must use .jsonl and application/x-ndjson: ${output.path}`);
    }
    if (dryRun) return;
    const count = forEachJsonlRecord(output.path, (record, index) => {
        if (!record || Array.isArray(record) || typeof record !== 'object') {
            throw new Error(`JSONL record ${index} must be one object in ${output.path}`);
        }
        if (typeof record.record_id !== 'string' || !record.record_id.trim()) {
            throw new Error(`JSONL record ${index} has no stable record_id in ${output.path}`);
        }
        if (typeof record.source_file !== 'string' || !record.source_file.trim()) {
            throw new Error(`JSONL record ${index} has no source_file in ${output.path}`);
        }
    });
    if (!count) throw new Error(`Machine observation index contains no records: ${output.path}`);
}

export function extractWithSensor(sensorMatch, { sourcePath, outputDir, stem, domain, sourceSha256, dryRun = false }) {
    const { sensor, probe } = sensorMatch;
    const args = [
        'extract',
        '--source', sourcePath,
        '--output-dir', outputDir,
        '--stem', stem,
        '--domain', domain.name,
        '--exposure', domain.exposure,
        '--source-sha256', sourceSha256,
        '--json'
    ];
    if (dryRun) args.push('--dry-run');
    const payload = parseSensorJson(runSensorScript(sensor, args), 'extract', sensor);
    if (!payload.ok) throw new Error(`${sensor.pluginId}/${sensor.sensorId} rejected extraction: ${payload.error || 'unknown error'}`);
    if (!Array.isArray(payload.outputs) || payload.outputs.length === 0) {
        throw new Error(`${sensor.pluginId}/${sensor.sensorId} produced no Tier 2 outputs.`);
    }
    const outputs = payload.outputs.map(output => {
        const definition = typeof output === 'string' ? { path: output } : output;
        if (!definition || typeof definition.path !== 'string' || !definition.path.trim()) {
            throw new Error(`${sensor.pluginId}/${sensor.sensorId} declared an output without a path.`);
        }
        const path = resolveOutput(outputDir, definition.path);
        if (!dryRun && (!existsSync(path) || !statSync(path).isFile())) throw new Error(`Sensor declared a missing output: ${path}`);
        return {
            path,
            role: typeof definition.role === 'string' && definition.role.trim() ? definition.role.trim() : null,
            mediaType: typeof definition.mediaType === 'string' && definition.mediaType.trim() ? definition.mediaType.trim() : null,
            primary: definition.primary === true
        };
    });
    const primaryOutputs = outputs.filter(output => output.primary);
    if (primaryOutputs.length > 1) throw new Error(`${sensor.pluginId}/${sensor.sensorId} declared more than one primary Tier 2 record.`);
    if (primaryOutputs[0] && primaryOutputs[0].mediaType !== 'text/markdown' && extname(primaryOutputs[0].path).toLowerCase() !== '.md') {
        throw new Error(`${sensor.pluginId}/${sensor.sensorId} primary Tier 2 record must be Markdown.`);
    }
    for (const output of outputs) validateObservationIndex(output, { dryRun });
    const suppliedProfile = payload.recordProfile && typeof payload.recordProfile === 'object'
        ? payload.recordProfile
        : null;
    const recordProfile = suppliedProfile ? {
        prefix: typeof suppliedProfile.prefix === 'string' ? suppliedProfile.prefix : null,
        titlePrefix: typeof suppliedProfile.titlePrefix === 'string' ? suppliedProfile.titlePrefix : null,
        type: typeof suppliedProfile.type === 'string' ? suppliedProfile.type : null,
        description: typeof suppliedProfile.description === 'string' ? suppliedProfile.description : null
    } : null;
    return {
        sensorId: `plugin:${sensor.pluginId}/${sensor.sensorId}`,
        sensorVersion: sensor.pluginVersion,
        format: probe.format,
        artifacts: outputs.map(output => output.path),
        artifactDetails: outputs,
        primaryRecordPath: primaryOutputs[0]?.path || null,
        recordCount: Number(payload.recordCount) || 0,
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
        tags: [...new Set([...(sensor.tags || []), ...(Array.isArray(payload.tags) ? payload.tags.map(String) : [])])],
        summaryMarkdown: String(payload.summaryMarkdown || '').trim(),
        recordProfile
    };
}
