import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import os from 'os';

import { REPO_ROOT } from './domains.mjs';
import { runPortableKeyframeVision } from './portable-vision.mjs';

export function runKeyframeVision(imagePath, { domainName, jsonOutputPath, dryRun = false } = {}) {
    if (dryRun) {
        return { dryRun: true, jsonOutputPath, imagePath };
    }

    mkdirSync(dirname(jsonOutputPath), { recursive: true });

    if (os.platform() === 'darwin') {
        execFileSync('swift', [
            join(REPO_ROOT, '.sos', 'plugins', 'apple-metal', 'vision.swift'),
            imagePath,
            '--ocr',
            '--json',
            '--domain', domainName,
            '--output-json', jsonOutputPath
        ], { cwd: REPO_ROOT, stdio: 'pipe' });
    } else {
        const telemetry = runPortableKeyframeVision(imagePath);
        writeFileSync(jsonOutputPath, `${JSON.stringify([telemetry], null, 2)}\n`, 'utf-8');
    }

    if (!existsSync(jsonOutputPath)) {
        throw new Error(`Vision did not produce telemetry: ${jsonOutputPath}`);
    }

    const parsed = JSON.parse(readFileSync(jsonOutputPath, 'utf-8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Vision returned no telemetry for ${imagePath}`);
    }
    return parsed[0];
}

export function formatKeyframeVisionSection(telemetry, { transcriptPath, jsonOutputPath, keyframeRelPath }) {
    const jsonLink = relative(dirname(transcriptPath), jsonOutputPath).split('\\').join('/');
    const tags = (telemetry.neuralTags ?? []).slice(0, 15);
    const ocrLines = (telemetry.ocrText ?? []).filter(Boolean);
    const lines = [
        '## Keyframe Vision Telemetry',
        '',
        `**Hero Keyframe:** ![Hero Keyframe](${keyframeRelPath})`,
        `**Raw JSON Telemetry (Tier 3):** [${jsonOutputPath.split('/').pop()}](${jsonLink})`,
        '',
        `**Dimensions:** ${telemetry.width}×${telemetry.height} · **Aspect:** ${telemetry.aspectRatio}`,
        `**Lighting:** ${telemetry.lightingCategory || 'Unknown'} · **Warmth:** ${telemetry.colorWarmth || 'Unknown'}`,
        `**Average Luminance:** ${Number(telemetry.averageLuminance || 0).toFixed(3)}`,
        ''
    ];

    if (tags.length) {
        lines.push('**Neural Scene Tags:** ' + tags.map(tag => `\`${tag}\``).join(', '));
        lines.push('');
    }

    if (ocrLines.length) {
        lines.push('**OCR Text:**');
        lines.push('');
        lines.push('```text');
        lines.push(...ocrLines);
        lines.push('```');
        lines.push('');
    }

    return lines.join('\n');
}
