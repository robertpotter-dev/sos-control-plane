import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
import { discoverDomains, REPO_ROOT } from './domains.mjs';

function getAllFiles(dir, extensions = ['.md', '.mjs', '.js', '.json']) {
    let results = [];
    if (!existsSync(dir)) return results;
    const list = readdirSync(dir);
    for (const file of list) {
        if (file.startsWith('.') || file === 'node_modules') continue;
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === 'inbox' || file === 'assets' || file === 'cache' || file === 'runtime' || file === 'vendor') continue;
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

    // Normalize line endings to \n
    let content = original.replace(/\r\n/g, '\n');

    // Split lines and strip trailing whitespace
    // (Note: in Markdown, two spaces at the end of a line indicates a line break, so preserve exact 2 spaces if markdown)
    const lines = content.split('\n');
    const formattedLines = lines.map(line => {
        if (isMarkdown && line.endsWith('  ') && !line.endsWith('   ')) {
            return line; // Preserve markdown 2-space line break
        }
        return line.replace(/[ \t]+$/, '');
    });

    // Remove excessive consecutive blank lines (> 2)
    let cleanedContent = formattedLines.join('\n');
    cleanedContent = cleanedContent.replace(/\n{4,}/g, '\n\n\n');

    // Ensure single trailing newline
    if (!cleanedContent.endsWith('\n')) {
        cleanedContent += '\n';
    }

    if (cleanedContent !== original) {
        writeFileSync(filePath, cleanedContent, 'utf-8');
        return true;
    }
    return false;
}

function runFormatter() {
    console.log('✨ Running Markdown & Code Formatter...\n');

    const domains = discoverDomains();
    const files = [];
    for (const d of domains) {
        files.push(...getAllFiles(d.path));
    }
    files.push(...getAllFiles(join(REPO_ROOT, '.sos')));
    if (existsSync(join(REPO_ROOT, 'AGENTS.md'))) files.push(join(REPO_ROOT, 'AGENTS.md'));
    if (existsSync(join(REPO_ROOT, 'package.json'))) files.push(join(REPO_ROOT, 'package.json'));

    let modifiedCount = 0;
    for (const f of files) {
        const changed = formatFile(f);
        if (changed) {
            console.log(`   Formatted: ${relative(REPO_ROOT, f)}`);
            modifiedCount++;
        }
    }

    console.log(`\n🎉 Done! Formatted ${modifiedCount} of ${files.length} scanned files.`);
}

runFormatter();
