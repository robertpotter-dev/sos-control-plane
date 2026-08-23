import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import { discoverDomains, REPO_ROOT } from './domains.mjs';
import {
    DATE_REGEX,
    parseFrontmatter,
    REQUIRED_FRONTMATTER_KEYS,
    RETIRED_FRONTMATTER_KEYS
} from './frontmatter.mjs';
import { validateRelations } from './relations.mjs';

function getAllFiles(dir, ext = '.md') {
    let results = [];
    if (!existsSync(dir)) return results;
    const list = readdirSync(dir);
    for (const file of list) {
        if (file.startsWith('.') || file === 'node_modules') continue;
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === 'inbox' || file === 'assets') continue;
            results = results.concat(getAllFiles(fullPath, ext));
        } else if (file.endsWith(ext)) {
            results.push(fullPath);
        }
    }
    return results;
}

function lintMarkdownFile(filePath, domains = discoverDomains()) {
    const errors = [];
    const warnings = [];
    const content = readFileSync(filePath, 'utf-8');
    const relPath = relative(REPO_ROOT, filePath);
    const lines = content.split('\n');
    const parsed = parseFrontmatter(content);

    const isDomainFile = domains.some(d => relPath.startsWith(d.name + '/'));
    if (!parsed) {
        if (isDomainFile) {
            errors.push(`Missing YAML frontmatter block (--- ... ---)`);
        }
    } else if (isDomainFile) {
        if (parsed.parseError) {
            errors.push('Invalid YAML frontmatter.');
        }
        for (const reqKey of REQUIRED_FRONTMATTER_KEYS) {
            if (!parsed.keys.has(reqKey)) {
                errors.push(`Missing required frontmatter key: '${reqKey}'`);
            }
        }
        for (const retired of RETIRED_FRONTMATTER_KEYS) {
            if (parsed.keys.has(retired)) {
                errors.push(`Retired frontmatter key '${retired}' is forbidden.`);
            }
        }
        if (parsed.created && !DATE_REGEX.test(parsed.created)) {
            errors.push(`Invalid 'created' date format '${parsed.created}' (expected YYYY-MM-DD)`);
        }
        if (parsed.updated && !DATE_REGEX.test(parsed.updated)) {
            errors.push(`Invalid 'updated' date format '${parsed.updated}' (expected YYYY-MM-DD)`);
        }
        for (const error of validateRelations(parsed.relations)) {
            errors.push(error);
        }
    }

    let h1Count = 0;
    let inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;
        if (line.startsWith('# ')) h1Count++;
    }

    if (h1Count === 0) {
        warnings.push(`No top-level '# Heading' found`);
    } else if (h1Count > 1) {
        warnings.push(`Multiple top-level '# Headings' found (${h1Count})`);
    }

    let trailingWsLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.endsWith('  ') && !line.endsWith('   ') && !line.endsWith('\t')) continue;
        if (line.endsWith(' ') || line.endsWith('\t')) trailingWsLines.push(i + 1);
    }
    if (trailingWsLines.length > 0 && trailingWsLines.length < 5) {
        warnings.push(`Trailing whitespace on line(s): ${trailingWsLines.join(', ')}`);
    } else if (trailingWsLines.length >= 5) {
        warnings.push(`Trailing whitespace on ${trailingWsLines.length} lines`);
    }

    if (!content.endsWith('\n')) {
        warnings.push(`Missing newline at end of file`);
    }

    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    const bodyContent = parsed ? parsed.body : content;

    while ((match = linkRegex.exec(bodyContent)) !== null) {
        const linkTarget = match[2];
        if (
            linkTarget.startsWith('http://') ||
            linkTarget.startsWith('https://') ||
            linkTarget.startsWith('#') ||
            linkTarget.startsWith('mailto:') ||
            linkTarget.startsWith('obsidian://') ||
            /^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(linkTarget)
        ) {
            continue;
        }

        const cleanTarget = decodeURIComponent(linkTarget.split('#')[0].split('?')[0]);
        if (cleanTarget) {
            const resolvedTarget = resolve(dirname(filePath), cleanTarget);
            if (!existsSync(resolvedTarget)) {
                errors.push(`Broken local link: [${match[1]}](${linkTarget}) -> File not found: ${relative(REPO_ROOT, resolvedTarget)}`);
            }
        }
    }

    return { file: relPath, errors, warnings };
}

function lintCodeFile(filePath) {
    const errors = [];
    const warnings = [];
    const relPath = relative(REPO_ROOT, filePath);
    const content = readFileSync(filePath, 'utf-8');

    try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    } catch (e) {
        errors.push(`JavaScript Syntax Error: ${e.message}`);
    }

    const lines = content.split('\n');
    let trailingWsLines = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].endsWith(' ') || lines[i].endsWith('\t')) {
            trailingWsLines.push(i + 1);
        }
    }
    if (trailingWsLines.length > 0) {
        warnings.push(`Trailing whitespace on ${trailingWsLines.length} lines`);
    }

    if (!content.endsWith('\n')) {
        warnings.push(`Missing newline at end of file`);
    }

    return { file: relPath, errors, warnings };
}

function runLinter() {
    const args = process.argv.slice(2);
    const checkMd = !args.includes('--code');
    const checkCode = !args.includes('--md');

    console.log('🔍 Running Knowledge Graph Linter...\n');

    let totalErrors = 0;
    let totalWarnings = 0;
    let checkedFilesCount = 0;

    if (checkMd) {
        console.log('📄 Validating Markdown Schema & Link Integrity...');
        const domains = discoverDomains();
        const mdFiles = [];
        for (const d of domains) {
            mdFiles.push(...getAllFiles(d.path, '.md'));
        }
        if (existsSync(join(REPO_ROOT, 'AGENTS.md'))) mdFiles.push(join(REPO_ROOT, 'AGENTS.md'));

        for (const mf of mdFiles) {
            checkedFilesCount++;
            const res = lintMarkdownFile(mf, domains);
            if (res.errors.length > 0 || res.warnings.length > 0) {
                if (res.errors.length > 0) {
                    console.log(`\n❌ [ERROR] ${res.file}`);
                    res.errors.forEach(e => console.log(`   • ${e}`));
                    totalErrors += res.errors.length;
                }
                if (res.warnings.length > 0) {
                    if (res.errors.length === 0) console.log(`\n⚠️  [WARN]  ${res.file}`);
                    res.warnings.forEach(w => console.log(`   • ${w}`));
                    totalWarnings += res.warnings.length;
                }
            }
        }
    }

    if (checkCode) {
        console.log('\n⚙️  Validating Systems Scripts (.sos/**/*.mjs)...');
        const codeFiles = getAllFiles(join(REPO_ROOT, '.sos'), '.mjs');

        for (const cf of codeFiles) {
            checkedFilesCount++;
            const res = lintCodeFile(cf);
            if (res.errors.length > 0 || res.warnings.length > 0) {
                if (res.errors.length > 0) {
                    console.log(`\n❌ [ERROR] ${res.file}`);
                    res.errors.forEach(e => console.log(`   • ${e}`));
                    totalErrors += res.errors.length;
                }
                if (res.warnings.length > 0) {
                    if (res.errors.length === 0) console.log(`\n⚠️  [WARN]  ${res.file}`);
                    res.warnings.forEach(w => console.log(`   • ${w}`));
                    totalWarnings += res.warnings.length;
                }
            }
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`LINT SUMMARY: Scanned ${checkedFilesCount} files.`);
    if (totalErrors === 0 && totalWarnings === 0) {
        console.log('✅ ALL CHECKS PASSED: 0 errors, 0 warnings. Clean system state!');
        console.log('═══════════════════════════════════════════════════════════════\n');
        process.exit(0);
    } else {
        console.log(`Results: ${totalErrors} error(s), ${totalWarnings} warning(s).`);
        console.log('═══════════════════════════════════════════════════════════════\n');
        if (totalErrors > 0) process.exit(1);
    }
}

runLinter();
