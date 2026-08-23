#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import { writeDebriefRecord, isDebriefRecord, localDateString, slugify } from './debrief.mjs';
import { discoverDomains, REPO_ROOT } from './domains.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { allocateDuplicateArchivePath, archiveMatchesSource, findAssetBySourceSha256, readSourceSha256, sha256File } from './hash.mjs';
import { classifyInboxFile, collectInboxBatchFiles, inboxDirectories } from './inbox-scan.mjs';
import { extractSpreadsheet, renderSpreadsheetMarkdown } from './spreadsheet.mjs';
import { transcribe } from './transcribe.mjs';
import { extractPdfText, executeVision } from './sensors.mjs';
import { ui } from './terminal.mjs';
import { extractRtfText } from './rtf.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

function parseArguments() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const dryRun = args.includes('--dry-run');
    const frontier = args.includes('--frontier');
    const legacy = args.filter(arg => ['--ai', '--llm', '--handoff'].includes(arg));
    if (legacy.length) throw new Error(legacy.join(', ') + ' is no longer a terminal ingestion mode. Run local sos ingest, then debrief with the AI chat of your choice.');
    const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--dry-run' && arg !== '--json' && arg !== '--frontier');
    if (unknown.length) throw new Error('Unknown option: ' + unknown.join(', '));
    const selectors = args.filter(arg => !arg.startsWith('--'));
    if (selectors.length > 1) throw new Error('Expected one inbox selector, received: ' + selectors.join(', '));
    return { selector: selectors[0] || null, dryRun, json, frontier };
}

function classify(path) {
    return classifyInboxFile(path);
}

function collectBatchFiles(root) {
    try {
        return collectInboxBatchFiles(root, root, { strict: true });
    } catch (error) {
        if (error.stack.startsWith('Unsupported file in batch ')) {
            const filePath = error.stack.slice('Unsupported file in batch '.length);
            throw new Error('Unsupported file in batch ' + relative(REPO_ROOT, root) + ': ' + filePath);
        }
        throw error;
    }
}

function scanInboxWork() {
    const work = [];
    const debriefs = [];
    for (const inbox of inboxDirectories(discoverDomains, REPO_ROOT)) {
        for (const name of readdirSync(inbox.path)) {
            if (name.startsWith('.') || name === 'archive') continue;
            const path = join(inbox.path, name);
            if (statSync(path).isFile()) {
                if (isDebriefRecord(name)) {
                    debriefs.push({ ...inbox, path, name });
                    continue;
                }
                const type = classify(path);
                if (type) work.push({ ...inbox, kind: 'single', label: basename(name, extname(name)), inboxPath: path, files: [{ path, file: name, relativePath: name, type }] });
            } else {
                const files = collectBatchFiles(path);
                if (files.length) work.push({ ...inbox, kind: 'batch', label: name, inboxPath: path, files });
            }
        }
    }
    return { work, debriefs };
}

function selectWork(scan, selector) {
    if (!selector) return scan.work;
    const selectorPath = resolve(REPO_ROOT, selector);
    let matches = scan.work.filter(item => resolve(item.inboxPath) === selectorPath);
    if (!matches.length) {
        const needle = selector.toLowerCase();
        matches = scan.work.filter(item => item.label.toLowerCase().includes(needle) || relative(REPO_ROOT, item.inboxPath).toLowerCase().includes(needle));
        const exact = matches.filter(item => item.label.toLowerCase() === needle || item.files.some(file => file.file.toLowerCase() === needle));
        if (exact.length === 1) matches = exact;
    }
    if (!matches.length) {
        const pending = scan.debriefs.filter(item => item.name.toLowerCase().includes(selector.toLowerCase()) || relative(REPO_ROOT, item.path).toLowerCase().includes(selector.toLowerCase()));
        if (pending.length) throw new Error('"' + selector + '" is already a pending debrief record. Use your AI chat to run debrief, not sos ingest.');
        throw new Error('No pending inbox capture or batch matches "' + selector + '".');
    }
    if (matches.length > 1) throw new Error('Inbox selector "' + selector + '" is ambiguous. Use a more specific path:\n' + matches.map(item => '  - ' + relative(REPO_ROOT, item.inboxPath)).join('\n'));
    return matches;
}

function allocateArchivePath(domain, sourceRelativePath, batchDirectory = null) {
    const root = batchDirectory || join(domain.path, 'inbox', 'archive');
    const normalized = sourceRelativePath.replace(/^\.\.([/\\]|$)/, '').split(sep).join('/');
    const extension = extname(normalized);
    const stem = basename(normalized, extension);
    const parent = dirname(normalized);
    let target = join(root, normalized);
    for (let counter = 2; existsSync(target); counter++) {
        const name = stem + '-' + counter + extension;
        target = join(root, parent === '.' ? name : join(parent, name));
    }
    return target;
}

function allocateBatchArchiveDirectory(domain, label) {
    const root = join(domain.path, 'inbox', 'archive');
    const stem = slugify(label) || 'batch';
    let target = join(root, stem);
    for (let counter = 2; existsSync(target); counter++) target = join(root, stem + '-' + counter);
    return target;
}

function archiveFile(source, target, dryRun) {
    if (dryRun) return target;
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    return target;
}

function isInsideInbox(source, inboxRoot) {
    const rel = relative(inboxRoot, source);
    return Boolean(rel) && !rel.startsWith('..') && !rel.startsWith('/');
}

function isFinderMetadata(name) {
    return name === '.DS_Store' || name.startsWith('._');
}

function rmdirEmptyTree(path) {
    if (!existsSync(path)) return;
    let stat;
    try {
        stat = statSync(path);
    } catch {
        return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path)) rmdirEmptyTree(join(path, name));
    let leftovers = readdirSync(path);
    if (leftovers.length && leftovers.every(isFinderMetadata)) {
        for (const name of leftovers) {
            try {
                unlinkSync(join(path, name));
            } catch {
                return;
            }
        }
        leftovers = readdirSync(path);
    }
    if (leftovers.length) return;
    try {
        rmdirSync(path);
    } catch {
        // Not empty: leftover captures stay in place for retry.
    }
}

function removeEmptyBatchSource(item, dryRun) {
    if (dryRun || item.kind !== 'batch') return;
    const inboxRoot = resolve(join(item.domain.path, 'inbox'));
    const source = resolve(item.inboxPath);
    if (!isInsideInbox(source, inboxRoot)) return;
    rmdirEmptyTree(source);
}

function charterId(domain) {
    return parseFrontmatter(readFileSync(domain.spaceFile, 'utf-8'))?.id || domain.prefix + ':charter';
}

function allocateAssetPath(domain, prefix, label) {
    const base = slugify(label) || 'capture';
    let slug = base;
    let path = join(domain.path, 'assets', prefix + '-' + slug + '.md');
    for (let counter = 2; existsSync(path); counter++) {
        slug = base + '-' + counter;
        path = join(domain.path, 'assets', prefix + '-' + slug + '.md');
    }
    return { path, slug };
}

function writeTextAsset(domain, source, archivePath, dryRun) {
    const allocation = allocateAssetPath(domain, 'text', basename(source.file, extname(source.file)));
    let text = '';
    if (!dryRun && extname(source.file).toLowerCase() === '.rtf') {
        text = extractRtfText(source.path, allocation.slug);
    } else if (!dryRun) {
        text = readFileSync(source.path, 'utf-8');
    }
    const title = basename(source.file, extname(source.file)).replace(/[_-]+/g, ' ');
    const archiveLink = relative(dirname(allocation.path), archivePath).split(sep).join('/');
    const lines = [
        '---',
        'id: "' + domain.prefix + ':text-' + allocation.slug + '"',
        'parent: "' + charterId(domain) + '"',
        'related: []',
        'title: "Text Capture: ' + title.replace(/"/g, '\\"') + '"',
        'description: "Verbatim deterministic text extraction of ' + source.file.replace(/"/g, '\\"') + '."',
        'type: "text-capture"',
        'domain: "' + domain.name + '"',
        'exposure: "' + domain.exposure + '"',
        'status: "active"',
        'created: ' + localDateString(),
        'updated: ' + localDateString(),
        'tags: ["' + domain.name + '", "assets", "text-capture", "verbatim"]',
        '---',
        '',
        '# Text Capture: ' + title,
        '',
        '**Source Capture:** [' + basename(archivePath) + '](' + archiveLink + ')',
        '',
        '---',
        '',
        '## Verbatim Text',
        '',
        dryRun ? '[Dry run: text extraction not executed.]' : text,
        ''
    ];
    if (!dryRun) {
        mkdirSync(dirname(allocation.path), { recursive: true });
        writeFileSync(allocation.path, lines.join('\n'), { encoding: 'utf-8', flag: 'wx' });
    }
    return allocation.path;
}


function writePdfAsset(domain, source, archivePath, dryRun, sourceSha256 = '') {
    const allocation = allocateAssetPath(domain, 'pdf', basename(source.file, extname(source.file)));
    let text = '';
    if (!dryRun) {
        text = extractPdfText(source.path, LIB_DIR);
    }
    const title = basename(source.file, extname(source.file)).replace(/[_-]+/g, ' ');
    const archiveLink = relative(dirname(allocation.path), archivePath).split(sep).join('/');
    const body = dryRun
        ? '[Dry run: PDF text extraction not executed.]'
        : (text || '_No extractable text layer. Open the archived PDF only if layout or figures are required._');
    const lines = [
        '---',
        'id: "' + domain.prefix + ':pdf-' + allocation.slug + '"',
        'parent: "' + charterId(domain) + '"',
        'related: []',
        'title: "PDF Capture: ' + title.replace(/"/g, '\\"') + '"',
        'description: "Verbatim deterministic text extraction of ' + source.file.replace(/"/g, '\\"') + '."',
        'type: "pdf-capture"',
        'domain: "' + domain.name + '"',
        'exposure: "' + domain.exposure + '"',
        'status: "active"',
        'created: ' + localDateString(),
        'updated: ' + localDateString(),
        ...(sourceSha256 ? ['source_sha256: "' + sourceSha256 + '"'] : []),
        'tags: ["' + domain.name + '", "assets", "pdf-capture", "verbatim"]',
        '---',
        '',
        '# PDF Capture: ' + title,
        '',
        '**Source Capture:** [' + basename(archivePath) + '](' + archiveLink + ')',
        '',
        '---',
        '',
        '## Verbatim Text',
        '',
        body,
        ''
    ];
    if (!dryRun) {
        mkdirSync(dirname(allocation.path), { recursive: true });
        writeFileSync(allocation.path, lines.join('\n'), { encoding: 'utf-8', flag: 'wx' });
    }
    return allocation.path;
}

function findLegacyCapture(domain, file, sourceSha256, { prefix, type }) {
    const slug = slugify(basename(file.file, extname(file.file))) || 'capture';
    const assetPath = join(domain.path, 'assets', prefix + '-' + slug + '.md');
    if (!existsSync(assetPath)) return null;
    if (readSourceSha256(readFileSync(assetPath, 'utf-8'))) return null;
    const parsed = parseFrontmatter(readFileSync(assetPath, 'utf-8'));
    if (parsed?.type && parsed.type !== type) return null;
    const archiveRoot = join(domain.path, 'inbox', 'archive');
    const candidates = [join(archiveRoot, file.relativePath), join(archiveRoot, basename(file.file))];
    for (const archivePath of candidates) {
        if (archiveMatchesSource(archivePath, file.path, sourceSha256)) return assetPath;
    }
    return null;
}

function writeSpreadsheetAsset(domain, source, archivePath, dryRun, sourceSha256 = '') {
    const allocation = allocateAssetPath(domain, 'spreadsheet', basename(source.file, extname(source.file)));
    let body = '[Dry run: spreadsheet extraction not executed.]';
    if (!dryRun) {
        const sheets = extractSpreadsheet(source.path);
        body = renderSpreadsheetMarkdown(sheets).trim() || '_Empty spreadsheet._';
    }
    const title = basename(source.file, extname(source.file)).replace(/[_-]+/g, ' ');
    const archiveLink = relative(dirname(allocation.path), archivePath).split(sep).join('/');
    const lines = [
        '---',
        'id: "' + domain.prefix + ':spreadsheet-' + allocation.slug + '"',
        'parent: "' + charterId(domain) + '"',
        'related: []',
        'title: "Spreadsheet Capture: ' + title.replace(/"/g, '\\"') + '"',
        'description: "Verbatim deterministic extraction of ' + source.file.replace(/"/g, '\\"') + '."',
        'type: "spreadsheet-capture"',
        'domain: "' + domain.name + '"',
        'exposure: "' + domain.exposure + '"',
        'status: "active"',
        'created: ' + localDateString(),
        'updated: ' + localDateString(),
        ...(sourceSha256 ? ['source_sha256: "' + sourceSha256 + '"'] : []),
        'tags: ["' + domain.name + '", "assets", "spreadsheet-capture", "verbatim"]',
        '---',
        '',
        '# Spreadsheet Capture: ' + title,
        '',
        '**Source Capture:** [' + basename(archivePath) + '](' + archiveLink + ')',
        '',
        '---',
        '',
        body,
        ''
    ];
    if (!dryRun) {
        mkdirSync(dirname(allocation.path), { recursive: true });
        writeFileSync(allocation.path, lines.join('\n'), { encoding: 'utf-8', flag: 'wx' });
    }
    return allocation.path;
}

function applyHashedCapture(item, file, batchDirectory, dryRun, silent, manifest, { type, skipLabel, prefix, writeAsset }) {
    const sourceSha256 = sha256File(file.path);
    const existing = findAssetBySourceSha256(join(item.domain.path, 'assets'), sourceSha256, { type })
        || findLegacyCapture(item.domain, file, sourceSha256, { prefix, type });
    if (existing) {
        if (!silent) {
            console.log(`  ${ui.warning('DEDUPE')} SHA-256 match, skipping ${skipLabel} → ${ui.muted(relative(REPO_ROOT, existing))}`);
        }
        const archiveDir = batchDirectory || join(item.domain.path, 'inbox', 'archive');
        const archivePath = allocateDuplicateArchivePath(archiveDir, basename(file.file, extname(file.file)), extname(file.file));
        archiveFile(file.path, archivePath, dryRun);
        const row = manifest.get(file.path);
        row.archivePath = archivePath;
        row.sourceSha256 = sourceSha256;
        row.artifacts.push(existing);
        return;
    }
    const archivePath = allocateArchivePath(item.domain, file.relativePath, batchDirectory);
    const assetPath = writeAsset(item.domain, file, archivePath, dryRun, sourceSha256);
    archiveFile(file.path, archivePath, dryRun);
    const row = manifest.get(file.path);
    row.archivePath = archivePath;
    row.sourceSha256 = sourceSha256;
    row.artifacts.push(assetPath);
}

function allocateVisionOutputs(domain, label) {
    const base = slugify(label) || 'visual-batch';
    let slug = base;
    let manifest = join(domain.path, 'assets', 'asset-' + slug + '-photographic-telemetry.md');
    let telemetry = join(domain.path, 'inbox', 'archive', slug + '-vision-telemetry.json');
    for (let counter = 2; existsSync(manifest) || existsSync(telemetry); counter++) {
        slug = base + '-' + counter;
        manifest = join(domain.path, 'assets', 'asset-' + slug + '-photographic-telemetry.md');
        telemetry = join(domain.path, 'inbox', 'archive', slug + '-vision-telemetry.json');
    }
    return { slug, manifest, telemetry };
}

function processVision(item, images, dryRun, { silent = false } = {}) {
    const outputs = allocateVisionOutputs(item.domain, item.label);
    if (dryRun) {
        if (!silent) console.log(`  ${ui.warning('DRY')} Vision/OCR → ${ui.muted(relative(REPO_ROOT, outputs.manifest))}`);
        return outputs.manifest;
    }
    const target = item.kind === 'batch' ? item.inboxPath : images[0].path;
    const assetId = item.domain.prefix + ':asset-' + outputs.slug + '-photographic-telemetry';

    executeVision(target, item.domain.name, outputs.manifest, outputs.telemetry, assetId, REPO_ROOT, silent);

    return outputs.manifest;
}

function withSilencedConsole(fn) {
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
        console.error = error;
    }
}

function processItem(item, dryRun, { silent = false, frontier = false } = {}) {
    const batchDirectory = item.kind === 'batch' ? allocateBatchArchiveDirectory(item.domain, item.label) : null;
    const manifest = new Map(item.files.map(file => [file.path, { originalPath: posixRel(file.path), archivePath: null, artifacts: [] }]));
    const failures = [];
    const attempt = (file, operation) => {
        try {
            operation();
        } catch (error) {
            manifest.delete(file.path);
            failures.push(file.relativePath + ': ' + error.stack);
        }
    };
    const media = item.files.filter(file => file.type === 'media');
    const text = item.files.filter(file => file.type === 'text');
    const images = item.files.filter(file => file.type === 'image');
    const documents = item.files.filter(file => file.type === 'document');
    const spreadsheets = item.files.filter(file => file.type === 'spreadsheet');

    if (frontier) {
        for (const file of item.files) {
            attempt(file, () => {
                const sourceSha256 = sha256File(file.path);
                const archivePath = allocateArchivePath(item.domain, file.relativePath, batchDirectory);
                archiveFile(file.path, archivePath, dryRun);
                const row = manifest.get(file.path);
                row.archivePath = archivePath;
                row.sourceSha256 = sourceSha256;
            });
        }
    } else {
        for (const file of media) {
            attempt(file, () => {
                const archiveRelativePath = item.kind === 'batch' ? join(basename(batchDirectory), file.relativePath) : file.relativePath;
                const result = transcribe(file.path, null, item.domain.name, { dryRun, archiveRelativePath });
                const row = manifest.get(file.path);
                row.archivePath = result.archivePath;
                row.sourceSha256 = result.sourceSha256 || null;
                row.artifacts.push(result.transcriptPath);
                if (result.keyframePath) row.artifacts.push(result.keyframePath);
            });
        }
        for (const file of text) {
            attempt(file, () => {
                const archivePath = allocateArchivePath(item.domain, file.relativePath, batchDirectory);
                const assetPath = writeTextAsset(item.domain, file, archivePath, dryRun);
                archiveFile(file.path, archivePath, dryRun);
                const row = manifest.get(file.path);
                row.archivePath = archivePath;
                row.artifacts.push(assetPath);
            });
        }
        if (images.length) {
            let assetPath = null;
            try {
                assetPath = processVision(item, images, dryRun, { silent });
            } catch (error) {
                for (const file of images) {
                    manifest.delete(file.path);
                    failures.push(file.relativePath + ': visual extraction failed — ' + error.stack);
                }
            }
            if (assetPath) {
                for (const file of images) {
                    attempt(file, () => {
                        const archivePath = allocateArchivePath(item.domain, file.relativePath, batchDirectory);
                        archiveFile(file.path, archivePath, dryRun);
                        const row = manifest.get(file.path);
                        row.archivePath = archivePath;
                        row.artifacts.push(assetPath);
                    });
                }
            }
        }
        for (const file of documents) {
            attempt(file, () => applyHashedCapture(item, file, batchDirectory, dryRun, silent, manifest, {
                type: 'pdf-capture',
                skipLabel: 'PDFKit',
                prefix: 'pdf',
                writeAsset: writePdfAsset
            }));
        }
        for (const file of spreadsheets) {
            attempt(file, () => applyHashedCapture(item, file, batchDirectory, dryRun, silent, manifest, {
                type: 'spreadsheet-capture',
                skipLabel: 'spreadsheet extract',
                prefix: 'spreadsheet',
                writeAsset: writeSpreadsheetAsset
            }));
        }
    }

    const completed = [...manifest.values()];
    try {
        let debrief = null;
        if (completed.length) {
            const record = writeDebriefRecord({
                domain: item.domain,
                label: item.label,
                scope: item.kind === 'batch' ? 'batch' : 'single',
                manifest: completed,
                dryRun,
                frontier
            });
            debrief = posixRel(record.filePath);
            if (!silent) {
                const label = dryRun ? 'DRY Debrief record' : 'Debrief record';
                const color = dryRun ? ui.warning : ui.success;
                console.log(`  ${color(label)} -> ${ui.muted(debrief)}`);
            }
        }
        return { debrief, failures, ...closedUnitFields(item, completed, batchDirectory) };
    } finally {
        removeEmptyBatchSource(item, dryRun);
    }
}

function posixRel(absPath) {
    return absPath ? relative(REPO_ROOT, absPath).split(sep).join('/') : null;
}

function closedUnitFields(item, completed, batchDirectory) {
    const hashes = [...new Set((completed || []).map(row => row.sourceSha256).filter(Boolean))];
    const assetSet = new Set();
    for (const row of completed || []) {
        for (const artifact of row.artifacts || []) {
            const relPath = posixRel(artifact);
            if (relPath && relPath.split('/').includes('assets')) assetSet.add(relPath);
        }
    }
    const assets = [...assetSet];
    let archive = null;
    if (item.kind === 'batch') {
        archive = batchDirectory ? posixRel(batchDirectory) : null;
    } else if (completed?.[0]?.archivePath) {
        archive = posixRel(completed[0].archivePath);
    }
    return {
        sourceSha256: hashes.length === 1 ? hashes[0] : null,
        archive,
        assets: assets.length ? assets : null
    };
}

function printBanner(title, subtitle) {
    console.log('');
    console.log(ui.accent('╔══════════════════════════════════════════════════════════════════════╗'));
    console.log(ui.accent('║' + title.padStart(Math.floor((70 + title.length) / 2)).padEnd(70) + '║'));
    console.log(ui.muted('║   ' + subtitle.padEnd(67) + '║'));
    console.log(ui.accent('╚══════════════════════════════════════════════════════════════════════╝'));
    console.log('');
}

function emitIngestError(message, json) {
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(ui.error('Error: ' + message));
    process.exitCode = 1;
}

function runItem(item, dryRun, json, frontier) {
    const execute = () => processItem(item, dryRun, { silent: json, frontier });
    return json ? withSilencedConsole(execute) : execute();
}

async function main() {
    let options;
    try {
        options = parseArguments();
    } catch (error) {
        emitIngestError(error.stack, process.argv.includes('--json'));
        return;
    }

    if (!options.json) printBanner('SENSOR INGESTION PIPELINE', 'Local sensor extraction • Deterministic debrief records');
    let scan;
    let work;
    try {
        scan = scanInboxWork();
        work = selectWork(scan, options.selector);
    } catch (error) {
        emitIngestError(error.stack, options.json);
        return;
    }
    if (!work.length) {
        if (options.json) {
            console.log(JSON.stringify({
                ok: true,
                dryRun: options.dryRun,
                selector: options.selector,
                units: [],
                pendingDebriefs: scan.debriefs.length
            }, null, 2));
            return;
        }
        console.log(scan.debriefs.length
            ? ui.warning(`${scan.debriefs.length} pending debrief record(s); no new captures to ingest.`)
            : ui.success('Inbox Zero — no pending captures or debrief records.'));
        return;
    }

    const totalFiles = work.reduce((count, item) => count + item.files.length, 0);
    if (!options.json) {
        const processing = `Processing ${work.length} intake ${work.length === 1 ? 'unit' : 'units'} / ${totalFiles} capture${totalFiles === 1 ? '' : 's'}.`;
        console.log(options.dryRun ? ui.warning(`Dry run — ${processing}`) : ui.heading(processing));
        if (options.selector) console.log(`Selector: ${ui.command(options.selector)}`);
    }

    const units = [];
    let failures = 0;
    for (const item of work) {
        if (!options.json) console.log(`\n${ui.command(item.kind === 'batch' ? 'Batch' : 'Capture')}: ${ui.muted(relative(REPO_ROOT, item.inboxPath))} ${ui.muted(`(${item.files.length})`)}`);
        try {
            const result = runItem(item, options.dryRun, options.json, options.frontier);
            const error = result.failures.length ? result.failures.join('\n  ') : null;
            if (error) {
                failures++;
                if (!options.json) console.error('  ' + ui.error('Error: ' + error));
            }
            units.push({
                kind: item.kind,
                path: posixRel(item.inboxPath),
                domain: item.domain.name,
                files: item.files.length,
                debrief: result.debrief,
                error,
                sourceSha256: result.sourceSha256 ?? null,
                archive: result.archive ?? null,
                assets: result.assets ?? null
            });
        } catch (error) {
            failures++;
            if (!options.json) console.error('  ' + ui.error('Error: ' + error.stack));
            units.push({
                kind: item.kind,
                path: posixRel(item.inboxPath),
                domain: item.domain.name,
                files: item.files.length,
                debrief: null,
                error: error.stack,
                sourceSha256: null,
                archive: null,
                assets: null
            });
        }
    }
    if (options.json) {
        console.log(JSON.stringify({
            ok: failures === 0,
            dryRun: options.dryRun,
            selector: options.selector,
            units,
            failed: failures
        }, null, 2));
    } else {
        printBanner(
            failures ? 'INGESTION PIPELINE INCOMPLETE' : 'INGESTION PIPELINE COMPLETE',
            failures ? failures + ' intake unit(s) failed • Sources retained for retry' : options.dryRun ? 'Dry Run Complete • No Files Changed' : 'Local Artifacts Ready • Debrief Records Pending'
        );
    }
    if (failures) process.exitCode = 1;
}

main();
