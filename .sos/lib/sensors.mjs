import { execFileSync } from 'child_process';
import { join } from 'path';
import os from 'os';

import { extractPdfWithPoppler } from './portable-pdf.mjs';
import { runPortableVision } from './portable-vision.mjs';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

function throwExtractionFailed(type, detail = '') {
    const platform = os.platform();
    const extra = detail ? `\n${detail}` : '';
    throw new Error(`Fatal: Local extraction for ${type} failed on '${platform}'.${extra}\nRun 'sos doctor' for installation instructions, or use 'sos ingest --frontier' to bypass local extraction.`);
}

function appleMetalDir(repoRoot) {
    return join(repoRoot, '.sos', 'plugins', 'apple-metal');
}

export function extractPdfText(sourcePath, libDir) {
    const repoRoot = join(libDir, '..', '..');
    if (!SUPPORTED_PLATFORMS.has(os.platform())) throwExtractionFailed('PDF files');

    try {
        if (os.platform() === 'darwin') {
            return execFileSync('swift', [join(appleMetalDir(repoRoot), 'pdf.swift'), sourcePath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        }
        return extractPdfWithPoppler(sourcePath);
    } catch (error) {
        throwExtractionFailed('PDF files', error.message);
    }
}

export function executeVision(targetPath, domainName, manifestPath, telemetryPath, assetId, repoRoot, silent) {
    if (!SUPPORTED_PLATFORMS.has(os.platform())) throwExtractionFailed('images (visual analysis)');

    try {
        if (os.platform() === 'darwin') {
            execFileSync('swift', [
                join(appleMetalDir(repoRoot), 'vision.swift'), targetPath, '--ocr', '--domain', domainName,
                '--output', manifestPath, '--output-json', telemetryPath,
                '--id', assetId
            ], { cwd: repoRoot, stdio: silent ? 'ignore' : 'inherit' });
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
    } catch (error) {
        if (!silent) console.error(error.stack);
        throwExtractionFailed('images (visual analysis)', error.message);
    }
}
