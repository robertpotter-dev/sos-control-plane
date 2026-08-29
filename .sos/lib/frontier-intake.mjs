import { extname } from 'path';

import { selectSensor } from './sensor-plugins.mjs';

const BUILTIN = {
    media: 'Local Whisper transcript and timestamped segment index',
    image: 'Local image telemetry and OCR index',
    text: 'Local verbatim text capture',
    document: 'Local PDF text extraction',
    spreadsheet: 'Local full-grid spreadsheet capture'
};

export function localBaselineAdvice(file, sensors = []) {
    if (BUILTIN[file.type]) return { available: true, route: `builtin:${file.type}`, description: BUILTIN[file.type] };
    try {
        const match = selectSensor(file.path, sensors);
        if (match) {
            return {
                available: true,
                route: `plugin:${match.sensor.pluginId}/${match.sensor.sensorId}`,
                description: match.sensor.description
            };
        }
    } catch (error) {
        return { available: false, route: null, description: `Local sensor probe was inconclusive: ${error.message}` };
    }
    return {
        available: false,
        route: null,
        description: `No installed local sensor recognizes ${extname(file.file).toLowerCase() || 'this extension'}.`
    };
}

export function frontierSummary({ request, rows }) {
    const advice = rows.map(row => `- **${row.originalPath}:** ${row.localAdvice.available
        ? `${row.localAdvice.description} (${row.localAdvice.route}) was available and explicitly declined.`
        : row.localAdvice.description}`).join('\n');
    return [
        '## Frontier Escalation Contract',
        '',
        `**Operator request:** ${request}`,
        '',
        'The raw source is archived unchanged. This record is a deterministic handoff, not a model analysis.',
        '',
        '### Local Baseline Advisory',
        '',
        advice,
        '',
        '### Required Frontier Artifact',
        '',
        `The conversational frontier model may now write a purpose-named sibling such as ${rows.length > 1 ? '`frontier-batch-visual-analysis-<slug>.md`' : '`frontier-visual-analysis-<slug>.md`'}. It must identify itself and use this contract; sos audit rejects a model artifact that omits any required field:`,
        '',
        '```yaml',
        'provenance: "frontier-model"',
        'frontier_model: "provider/model"',
        `frontier_request: ${JSON.stringify(String(request))}`,
        'source_intake: "<this handoff canonical ID>"',
        '# For one source: source_sha256: "<source hash from this handoff>"',
        '# For a batch: source_inventory: "frontier-batch-inventory-<slug>.jsonl"',
        'source_coverage: "what portions or units were examined"',
        'uncertainty: "limits, ambiguity, and unexamined material"',
        '```',
        '',
        'Create a JSONL companion only when the analysis has independently addressable source units such as time ranges, pages, images, or code symbols. Do not invent timestamps or observations merely to fill a payload.',
        ''
    ].join('\n');
}
