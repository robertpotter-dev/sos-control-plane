import { execFileSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import os from 'os';
import { join } from 'path';

import { commandExists, runTool } from './tools.mjs';

export function extractRtfText(sourcePath, slug = 'capture') {
    if (process.platform === 'darwin' && commandExists('textutil')) {
        const temporary = join(os.tmpdir(), 'sos-text-' + Date.now() + '-' + slug + '.txt');
        execFileSync('textutil', ['-convert', 'txt', sourcePath, '-output', temporary], { stdio: 'pipe' });
        try {
            return readFileSync(temporary, 'utf-8').trim();
        } finally {
            unlinkSync(temporary);
        }
    }
    if (commandExists('pandoc')) {
        return runTool('pandoc', ['-f', 'rtf', '-t', 'plain', sourcePath]).trim();
    }
    if (commandExists('unrtf')) {
        return runTool('unrtf', ['--text', sourcePath]).replace(/^[\s\S]*?-+\s*$/m, '').trim();
    }
    throw new Error('RTF extraction needs textutil (macOS), pandoc, or unrtf. The source remains in inbox; install one of those tools or provide a local sensor plugin, then ingest again.');
}
