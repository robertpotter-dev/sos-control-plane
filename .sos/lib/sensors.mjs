import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, sep } from 'path';
import os from 'os';

import { extractPdfWithPoppler } from './portable-pdf.mjs';
import { runPortableVision } from './portable-vision.mjs';
import { sha256String } from './hash.mjs';
import { readJsonRecords, writeJsonl } from './jsonl.mjs';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

function throwExtractionFailed(type, detail = '') {
    const platform = os.platform();
    const extra = detail ? `\n${detail}` : '';
    throw new Error(`Fatal: Local extraction for ${type} failed on '${platform}'.${extra}\nThe source remains in inbox. Run 'sos doctor' for installation instructions, or provide a local sensor plugin for this format, then ingest again.`);
}

function appleMetalDir(repoRoot) {
    return join(repoRoot, '.sos', 'plugins', 'apple-metal');
}

export function extractPdfText(sourcePath, libDir) {
    const repoRoot = join(libDir, '..', '..');
    if (!SUPPORTED_PLATFORMS.has(os.platform())) throwExtractionFailed('PDF files');

    try {
        if (os.platform() === 'darwin') {
            try {
                return execFileSync('swift', [join(appleMetalDir(repoRoot), 'pdf.swift'), sourcePath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            } catch (swiftError) {
                try {
                    return extractPdfWithPoppler(sourcePath);
                } catch (portableError) {
                    throw new Error(`Swift PDFKit failed: ${swiftError.message}\nPortable PDF fallback failed: ${portableError.message}`);
                }
            }
        }
        return extractPdfWithPoppler(sourcePath);
    } catch (error) {
        throwExtractionFailed('PDF files', error.message);
    }
}

function attachCustody(manifestPath, custody) {
    if (!custody?.length) return;
    let content = readFileSync(manifestPath, 'utf-8');
    if (custody.length === 1 && !/^source_sha256:/m.test(content)) {
        content = content.replace(/^(tags:)/m, `source_sha256: "${custody[0].sourceSha256}"\n$1`);
    }
    const rows = custody.map(item => {
        const link = relative(dirname(manifestPath), item.archivePath).split(sep).join('/');
        return `| ${String(item.originalPath).replace(/\|/g, '\\|')} | ${item.sourceSha256} | [${basename(item.archivePath)}](${link}) |`;
    });
    content = `${content.trimEnd()}\n\n## Source Custody\n\n| Original inbox path | Source SHA-256 | Tier 3 source |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
    writeFileSync(manifestPath, content, 'utf-8');
}

export function normalizeVisionIndex(indexPath, custody = []) {
    const records = readJsonRecords(indexPath);
    const normalized = records.map((record, index) => {
        const namedPath = String(record.relativePath || record.filename || record.source_file || '');
        const matched = custody.length === 1
            ? custody[0]
            : custody.find(item => (
                basename(item.originalPath) === basename(namedPath)
                || String(item.originalPath).split(sep).join('/').endsWith(namedPath.split(sep).join('/'))
            ));
        const sourceSha256 = matched?.sourceSha256 || record.source_sha256 || sha256String(namedPath || index);
        return {
            ...record,
            record_id: `vision:${sourceSha256.slice(0, 16)}:${String(index + 1).padStart(6, '0')}`,
            source_file: matched ? basename(matched.originalPath) : (record.source_file || record.filename || null),
            source_path: matched?.originalPath || record.source_path || record.relativePath || record.filename || null,
            source_sha256: sourceSha256,
            observation_index: index,
            index_line: index + 1
        };
    });
    writeJsonl(indexPath, normalized);
    return normalized;
}

export function executeVision(targetPath, domainName, manifestPath, telemetryPath, assetId, repoRoot, silent, custody = []) {
    if (!SUPPORTED_PLATFORMS.has(os.platform())) throwExtractionFailed('images (visual analysis)');

    try {
        if (os.platform() === 'darwin') {
            try {
                execFileSync('swift', [
                    join(appleMetalDir(repoRoot), 'vision.swift'), targetPath, '--ocr', '--domain', domainName,
                    '--output', manifestPath, '--output-json', telemetryPath,
                    '--id', assetId
                ], { cwd: repoRoot, stdio: silent ? 'ignore' : 'inherit' });
            } catch {
                runPortableVision({ targetPath, domainName, manifestPath, telemetryPath, assetId, repoRoot });
            }
            normalizeVisionIndex(telemetryPath, custody);
            attachCustody(manifestPath, custody);
            return;
        }
        runPortableVision({
            targetPath,
            domainName,
            manifestPath,
            telemetryPath,
            assetId,
            repoRoot
        });
        normalizeVisionIndex(telemetryPath, custody);
        attachCustody(manifestPath, custody);
    } catch (error) {
        if (!silent) console.error(error.stack);
        throwExtractionFailed('images (visual analysis)', error.message);
    }
}
