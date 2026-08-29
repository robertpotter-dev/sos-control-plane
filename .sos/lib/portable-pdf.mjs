import { spawnSync } from 'child_process';

import { commandExists } from './tools.mjs';

export function formatPdfPages(text) {
    const pages = String(text || '').split('\f').map(page => page.trim()).filter(Boolean);
    if (!pages.length) return '';
    return pages.map((page, index) => `## Page ${index + 1}\n\n${page}`).join('\n\n');
}

export function extractPdfWithPoppler(sourcePath) {
    if (!commandExists('pdftotext')) {
        throw new Error(
            "pdftotext is required for PDF extraction on this platform. The source remains in inbox; install poppler-utils (Linux) or poppler (macOS/Windows), then ingest again."
        );
    }
    const result = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', sourcePath, '-'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024
    });
    if ((result.status ?? 1) !== 0) {
        const detail = String(result.stderr || result.stdout || '').trim();
        throw new Error(detail || `pdftotext failed for ${sourcePath}`);
    }
    return formatPdfPages(result.stdout);
}
