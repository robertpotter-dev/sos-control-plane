import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import { discoverDomains, REPO_ROOT } from './domains.mjs';
import { ui } from './terminal.mjs';

const SKIP_DIRS = new Set(['inbox', 'assets', 'cache', 'runtime', 'vendor']);
const ROOT_FILES = ['AGENTS.md', 'DEBRIEF.md', 'SETUP.md', 'README.md', 'package.json'];

function getAllFiles(dir, extensions = ['.md', '.mjs', '.js', '.json']) {
    let results = [];
    if (!existsSync(dir)) return results;
    const list = readdirSync(dir);
    for (const file of list) {
        if (file.startsWith('.') || file === 'node_modules') continue;
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (SKIP_DIRS.has(file)) continue;
            results = results.concat(getAllFiles(fullPath, extensions));
        } else if (extensions.some(ext => file.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

function formatFile(filePath) {
    const original = readFileSync(filePath, 'utf-8');
    const isMarkdown = filePath.endsWith('.md');

    let content = original.replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const formattedLines = lines.map(line => {
        if (isMarkdown && line.endsWith('  ') && !line.endsWith('   ')) {
            return line;
        }
        return line.replace(/[ \t]+$/, '');
    });

    let cleanedContent = formattedLines.join('\n');
    cleanedContent = cleanedContent.replace(/\n{4,}/g, '\n\n\n');
    if (!cleanedContent.endsWith('\n')) cleanedContent += '\n';

    if (cleanedContent !== original) {
        writeFileSync(filePath, cleanedContent, 'utf-8');
        return true;
    }
    return false;
}

function runFormatter() {
    console.log(`${ui.option('RUN')}  ${ui.heading('Format')}`);

    const domains = discoverDomains();
    const files = [];
    for (const d of domains) {
        files.push(...getAllFiles(d.path));
    }
    files.push(...getAllFiles(join(REPO_ROOT, '.sos')));
    for (const name of ROOT_FILES) {
        const path = join(REPO_ROOT, name);
        if (existsSync(path)) files.push(path);
    }

    let modifiedCount = 0;
    for (const f of files) {
        const changed = formatFile(f);
        if (changed) {
            console.log(`  ${ui.muted(relative(REPO_ROOT, f))}`);
            modifiedCount++;
        }
    }

    console.log(`${ui.success('PASS')} Format ${ui.muted(`${modifiedCount} of ${files.length} files`)}`);
}

runFormatter();
