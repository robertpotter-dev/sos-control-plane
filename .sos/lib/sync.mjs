import { execSync, spawnSync } from 'child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync
} from 'fs';
import os from 'os';
import { basename, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { discoverDomains, REPO_ROOT as SYSTEM_ROOT, getAllMarkdownFiles } from './domains.mjs';
import { domainNameForRelativePath, parseFrontmatter } from './frontmatter.mjs';
import { refreshGraphIndex } from './graph.mjs';
import { sha256String } from './hash.mjs';
import { scanRecords } from './records.mjs';
import { extractRtfText } from './rtf.mjs';
import { ui } from './terminal.mjs';
import {
    binaryFingerprint,
    fingerprintsMatch,
    loadVaultManifest,
    pruneManifest,
    saveVaultManifest,
    textFingerprint
} from './vault-manifest.mjs';
import { resetCompiledVault } from './vault-rebuild.mjs';
import { mirrorTree } from './mirror-tree.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const SYSTEM_NAME = basename(SYSTEM_ROOT);
import { resolvedVaults, resolvedMirrors } from './system-config.mjs';
const VAULT_TARGETS = resolvedVaults(SYSTEM_ROOT);
const MIRROR_TARGETS = resolvedMirrors(SYSTEM_ROOT).map(m => join(m, SYSTEM_NAME));
const DOMAIN_VAULTS = new Map(discoverDomains().map(domain => [domain.name.toLowerCase(), domain.vaultName]));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const json = args.includes('--json');
const rebuild = args.includes('--rebuild');
const knownOptions = new Set(['--dry-run', '--json', '--quick', '-q', '--vaults', '-v', '--mirrors', '-m', '--all', '--rebuild']);
const unknownOptions = args.filter(arg => arg.startsWith('-') && !knownOptions.has(arg));
if (unknownOptions.length > 0) {
    const message = `Unknown sync option: ${unknownOptions.join(', ')}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(ui.error(message));
    process.exit(1);
}
const syncStats = { directories: 0, textWrites: 0, fileCopies: 0, textSkips: 0, fileSkips: 0, deletions: 0, backupRuns: 0 };
let vaultManifest = { version: 1, files: {} };
let CURRENT_VAULT_TARGET = null;
const vaultSeen = new Set();

function vaultKey(targetPath) {
    const root = CURRENT_VAULT_TARGET;
    if (!root) return targetPath;
    return `${root}::${relative(root, targetPath)}`;
}

function rememberVault(key, fingerprint) {
    vaultSeen.add(key);
    vaultManifest.files[key] = fingerprint;
}

function ensureDirectory(path) {
    if (dryRun) {
        if (!existsSync(path)) syncStats.directories++;
        return;
    }
    mkdirSync(path, { recursive: true });
}

function writeText(path, content) {
    const key = vaultKey(path);
    const fingerprint = textFingerprint(sha256String(content));
    if (existsSync(path) && fingerprintsMatch(vaultManifest.files[key], fingerprint)) {
        syncStats.textSkips++;
        rememberVault(key, fingerprint);
        return;
    }
    if (existsSync(path)) {
        try {
            if (readFileSync(path, 'utf-8') === content) {
                syncStats.textSkips++;
                rememberVault(key, fingerprint);
                return;
            }
        } catch {
            // Destination exists but cannot be read; rewrite.
        }
    }
    if (dryRun) {
        syncStats.textWrites++;
        return;
    }
    writeFileSync(path, content, 'utf-8');
    syncStats.textWrites++;
    rememberVault(key, fingerprint);
}

function copyUnchanged(source, target) {
    if (!existsSync(target)) return false;
    try {
        const srcStat = statSync(source);
        const dstStat = statSync(target);
        return dstStat.isFile() && srcStat.size === dstStat.size && dstStat.mtimeMs >= srcStat.mtimeMs;
    } catch {
        return false;
    }
}

function copyFile(source, target) {
    const key = vaultKey(target);
    const srcStat = statSync(source);
    const fingerprint = binaryFingerprint(srcStat);
    if (existsSync(target) && fingerprintsMatch(vaultManifest.files[key], fingerprint)) {
        syncStats.fileSkips++;
        rememberVault(key, fingerprint);
        return;
    }
    if (copyUnchanged(source, target)) {
        syncStats.fileSkips++;
        rememberVault(key, fingerprint);
        return;
    }
    if (dryRun) {
        syncStats.fileCopies++;
        return;
    }
    copyFileSync(source, target);
    syncStats.fileCopies++;
    rememberVault(key, fingerprint);
}

function removePath(path, options) {
    if (dryRun) {
        if (existsSync(path)) syncStats.deletions++;
        return;
    }
    rmSync(path, options);
}

// 1. Build Global Node Graph Index across all domains
function buildNodeIndex() {
    const idMap = new Map();
    const domains = discoverDomains();
    const domainByName = new Map(domains.map(domain => [domain.name, domain]));
    const records = scanRecords({ repoRoot: SYSTEM_ROOT, discoverDomains, getAllMarkdownFiles });

    for (const record of records) {
        if (!record.id) continue;
        const domainName = domainNameForRelativePath(record.relPath);
        const d = domainByName.get(domainName);
        if (!d) continue;

        const vaultName = d.vaultName;
        const entry = basename(record.filePath);
        let baseNoExt = basename(record.filePath, '.md');
        let relInVault = relative(d.path, record.filePath);

        if (entry === 'SPACE.md') {
            baseNoExt = `${vaultName} Charter`;
            relInVault = `${baseNoExt}.md`;
        }

        const relWithoutExt = relInVault.replace(/\.md$/, '');

        idMap.set(record.id, {
            id: record.id,
            domain: d.name,
            vaultName,
            relInVault,
            relWithoutExt,
            basenameNoExt: baseNoExt,
            title: record.title || baseNoExt,
            fullPath: record.filePath
        });
    }

    return idMap;
}

// 2. Transform Markdown content for Obsidian build
function transformForObsidian(content, currentVault, idMap) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return content;

    let yaml = match[1];
    let body = match[2];

    // Transform parent: "domain:id"
    const parsed = parseFrontmatter(content);
    yaml = yaml.replace(/^parent:\s*["']?([^"'\r\n]+)["']?/m, (match, parentId) => {
        const resolvedParent = (parsed?.parent ?? parentId).trim();
        if (!resolvedParent || resolvedParent === 'null' || resolvedParent === '[]') return match;
        const target = idMap.get(resolvedParent);
        if (!target) return match;

        if (target.vaultName === currentVault) {
            return `parent: "[[${target.basenameNoExt}]]"`;
        } else {
            const uri = `obsidian://open?vault=${target.vaultName}&file=${encodeURIComponent(target.relWithoutExt)}`;
            return `parent: "[${target.title}](${uri})"`;
        }
    });

    // Obsidian Properties does not support typed edge objects as link fields.
    // The canonical repository retains predicates; the mobile projection lowers
    // them to a normal list of navigable links.
    const relations = parsed?.relations ?? [];
    const transformedRelations = relations.map(({ id }) => {
        const target = idMap.get(id);
        let destination = id;
        if (target?.vaultName === currentVault) {
            destination = `[[${target.basenameNoExt}]]`;
        } else if (target) {
            const uri = `obsidian://open?vault=${target.vaultName}&file=${encodeURIComponent(target.relWithoutExt)}`;
            destination = `[${target.title}](${uri})`;
        }
        return `  - "${destination}"`;
    });
    const relatedReplacement = transformedRelations.length > 0
        ? `related:\n${transformedRelations.join('\n')}`
        : 'related: []';
    yaml = yaml.replace(/^related:\s*\[([\s\S]*?)\]/m, relatedReplacement);
    yaml = yaml.replace(/^related:\s*\r?\n(?:^[ \t]+.*(?:\r?\n|$))*/m, `${relatedReplacement}\n`);

    // Transform cross-domain relative links in body text
    // e.g. a cross-domain relative note link becomes an Obsidian vault URI.
    body = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, linkTarget) => {
        if (linkTarget.startsWith('http') || linkTarget.startsWith('obsidian:') || linkTarget.startsWith('#') || linkTarget.startsWith('mailto:')) {
            return match;
        }

        const crossMatch = linkTarget.match(/(?:\.\.\/)+([a-zA-Z0-9_-]+)\/(.+?)(?:\.md)?$/);
        if (crossMatch) {
            const candidateDomain = crossMatch[1].toLowerCase();
            const targetVault = DOMAIN_VAULTS.get(candidateDomain);
            if (targetVault) {
                const targetSubPath = crossMatch[2].replace(/\.md$/, '');

                if (targetVault !== currentVault) {
                    const uri = `obsidian://open?vault=${targetVault}&file=${encodeURIComponent(targetSubPath)}`;
                    return `[${linkText}](${uri})`;
                }
            }
        }

        return match;
    });

    // Convert .rtf link targets to .md for native Obsidian preview
    body = body.replace(/(\[[^\]]+\]\([^)]+?)\.rtf\)/gi, '$1.md)');

    return `---\n${yaml.trim()}\n---\n${body}`;
}

// 3. Sync and Compile a Domain to its Obsidian Vault
function syncDomainVault(targetBasePath, domainName, vaultName, idMap) {
    const sourceDir = join(SYSTEM_ROOT, domainName);
    const targetDir = join(targetBasePath, vaultName);

    console.log(`\n${ui.heading('Vault')}  ${ui.command(domainName)} ${ui.muted('→')} ${ui.command(vaultName)}`);
    if (rebuild) {
        const removed = resetCompiledVault(targetDir, { dryRun });
        for (const path of removed) {
            syncStats.deletions++;
            console.log(`  ${ui.warning(dryRun ? 'WOULD REMOVE' : 'REMOVED')} ${ui.muted(relative(targetBasePath, path))}`);
        }
        if (removed.length && !json) {
            console.log(`  ${ui.option('REBUILD')} ${ui.muted('kept .obsidian and live inbox/; archive restored from git')}`);
        }
    }
    ensureDirectory(join(targetDir, 'inbox', 'archive'));

    function copyAndCompile(src, dst) {
        const entries = readdirSync(src);
        for (const entry of entries) {
            if (entry === '.DS_Store' || entry === '.gitkeep' || entry === 'inbox') continue;
            if (src.endsWith('.obsidian') && (entry.startsWith('workspace') || entry === 'cache')) continue;

            let targetEntry = entry;
            if (entry === 'SPACE.md') {
                targetEntry = `${vaultName} Charter.md`;
            }

            const srcPath = join(src, entry);
            const dstPath = join(dst, targetEntry);
            const stat = statSync(srcPath);

            if (stat.isDirectory()) {
                ensureDirectory(dstPath);
                copyAndCompile(srcPath, dstPath);
            } else if (entry.endsWith('.md')) {
                const rawContent = readFileSync(srcPath, 'utf-8');
                let compiledContent = transformForObsidian(rawContent, vaultName, idMap);
                compiledContent = compiledContent.replace(/\bSPACE\.md\b/g, `${vaultName}%20Charter.md`);
                writeText(dstPath, compiledContent);
            } else {
                copyFile(srcPath, dstPath);
            }
        }
    }

    copyAndCompile(sourceDir, targetDir);

    // Specifically sync inbox/archive (Tier 3 ground-source subdirectories, binaries, PDFs, RTFs) to Obsidian
    function syncArchiveRecursive(srcDir, dstDir) {
        if (!existsSync(srcDir)) return;
        ensureDirectory(dstDir);
        const entries = readdirSync(srcDir);
        for (const entry of entries) {
            if (entry.startsWith('.') || entry === '.gitkeep') continue;
            const srcPath = join(srcDir, entry);
            const dstPath = join(dstDir, entry);
            const stat = statSync(srcPath);

            if (stat.isDirectory()) {
                ensureDirectory(dstPath);
                syncArchiveRecursive(srcPath, dstPath);
            } else if (stat.isFile()) {
                if (entry.endsWith('.rtf')) {
                    try {
                        const txtContent = extractRtfText(srcPath, basename(entry, '.rtf'));
                        const mdFilename = entry.replace(/\.rtf$/i, '.md');
                        const mdContent = `# ${basename(entry, '.rtf').replace(/[-_]/g, ' ')}\n\n> *Archived RTF Ground Source Document*\n\n---\n\n${txtContent}`;
                        writeText(join(dstDir, mdFilename), mdContent);
                    } catch {
                        copyFile(srcPath, dstPath);
                    }
                } else if (entry.endsWith('.md')) {
                    const rawContent = readFileSync(srcPath, 'utf-8');
                    let compiledContent = transformForObsidian(rawContent, vaultName, idMap);
                    compiledContent = compiledContent.replace(/\bSPACE\.md\b/g, `${vaultName}%20Charter.md`);
                    writeText(dstPath, compiledContent);
                } else {
                    copyFile(srcPath, dstPath);
                }
            }
        }
    }

    const srcArchive = join(sourceDir, 'inbox', 'archive');
    const dstArchive = join(targetDir, 'inbox', 'archive');
    syncArchiveRecursive(srcArchive, dstArchive);

    // Clean up deleted markdown notes in target (excluding inbox, inbox/archive, and workspace files)
    function cleanupOrphans(src, dst) {
        if (!existsSync(dst)) return;
        const dstEntries = readdirSync(dst);
        for (const entry of dstEntries) {
            if (entry === 'inbox' || entry === '.obsidian' || entry === '.DS_Store') continue;
            if (dst.endsWith('.obsidian') && (entry.startsWith('workspace') || entry === 'cache')) continue;

            // Remove legacy SPACE.md in target if present
            if (entry === 'SPACE.md') {
                removePath(join(dst, entry), { force: true });
                console.log(`  ${ui.warning(dryRun ? 'WOULD REMOVE' : 'REMOVED')} ${ui.muted(`legacy SPACE.md in ${vaultName} vault`)}`);
                continue;
            }

            let sourceEntry = entry;
            if (entry === `${vaultName} Charter.md`) {
                sourceEntry = 'SPACE.md';
            }

            const dstPath = join(dst, entry);
            const srcPath = join(src, sourceEntry);

            if (!existsSync(srcPath)) {
                removePath(dstPath, { recursive: true, force: true });
                console.log(`  ${ui.warning(dryRun ? 'WOULD REMOVE' : 'REMOVED')} ${ui.muted(relative(targetBasePath, dstPath))}`);
            } else if (statSync(dstPath).isDirectory()) {
                cleanupOrphans(srcPath, dstPath);
            }
        }
    }

    cleanupOrphans(sourceDir, targetDir);
}

// 4. Sync all vaults with smart compilation
function syncVaults(idMap) {
    const vaultsRequested = args.includes('--vaults') || args.includes('-v') || rebuild;
    if (VAULT_TARGETS.length === 0) {
        if (vaultsRequested) {
            const message = 'No vault targets configured. Run: sos config add vault <path>';
            if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
            else console.error(ui.error(message));
            process.exit(1);
        }
        if (!json) console.log(ui.muted('No vault targets configured. Skipping compilation.'));
        return;
    }
    console.log(ui.accent('Vault compilation'));
    vaultManifest = loadVaultManifest();
    vaultSeen.clear();
    const domains = discoverDomains();

    for (const d of domains) {
        for (const vaultTarget of VAULT_TARGETS) {
            CURRENT_VAULT_TARGET = vaultTarget;
            syncDomainVault(vaultTarget, d.name, d.vaultName, idMap);
        }
    }
    if (!dryRun) {
        vaultManifest = pruneManifest(vaultManifest, vaultSeen);
        saveVaultManifest(vaultManifest);
    }
}

// 5. Raw untransformed mirror to AI Backup
function syncFullBackup() {
    if (MIRROR_TARGETS.length === 0) return;
    console.log(`\n${ui.accent('Raw system backup')}`);
    for (const target of MIRROR_TARGETS) {
        if (dryRun) {
            syncStats.backupRuns++;
            console.log(`  ${ui.warning('WOULD MIRROR')} ${ui.muted(SYSTEM_ROOT)} ${ui.muted('→')} ${ui.muted(target)}`);
            console.log(`  ${ui.warning('Destination cleanup enabled')}`);
            continue;
        }
        ensureDirectory(target);
        try {
            execSync(`rsync -a${json ? '' : 'v'} --delete --delete-excluded --exclude=".git" --exclude=".DS_Store" --exclude=".npm" --exclude=".cache" --exclude=".sos/cache" --exclude=".sos/runtime" "${SYSTEM_ROOT}/" "${target}/"`, {
                stdio: json ? 'ignore' : 'inherit'
            });
            syncStats.backupRuns++;
        } catch {
            try {
                if (!json) console.log(ui.muted(`rsync unavailable or failed; using local mirror to ${target}`));
                mirrorTree(SYSTEM_ROOT, target);
                syncStats.backupRuns++;
            } catch (error) {
                console.error(ui.error(`Raw backup failed to ${target}: ${error.message}`));
            }
        }
    }
}

// CLI Execution
const skipChecks = args.includes('--quick') || args.includes('-q');
const hasExplicitTarget = args.some(arg => ['--vaults', '-v', '--mirrors', '-m', '--all'].includes(arg));
const doVaults = rebuild || args.includes('--vaults') || args.includes('-v') || args.includes('--all') || !hasExplicitTarget;
const doBackup = !rebuild && (args.includes('--mirrors') || args.includes('-m') || args.includes('--all') || !hasExplicitTarget);

function runPreflightScript(script, extraArgs = []) {
    const result = spawnSync(process.execPath, [join(LIB_DIR, script), ...extraArgs], {
        cwd: SYSTEM_ROOT,
        env: { ...process.env, SOS_ROOT: SYSTEM_ROOT },
        encoding: 'utf-8',
        stdio: 'pipe'
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) {
        const error = new Error(`${script} failed`);
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        error.status = result.status;
        throw error;
    }
}

function auditPayloadFromExecError(error) {
    try {
        const parsed = JSON.parse(String(error?.stdout || ''));
        return parsed && typeof parsed === 'object' && Array.isArray(parsed.failures) ? parsed : null;
    } catch {
        return null;
    }
}

if (!skipChecks) {
    if (!json) {
        console.log(ui.accent('Sovereign OS sync'));
        console.log(dryRun
            ? `${ui.option('DRY RUN')} ${ui.muted('Preflight: Lint → Audit (format skipped)')}`
            : `${ui.option('PREFLIGHT')} ${ui.muted('Format → Lint → Audit')}`);
    }
    try {
        if (!dryRun) runPreflightScript('format.mjs');
        runPreflightScript('lint.mjs');
        runPreflightScript('audit.mjs', json ? ['--json'] : []);
        if (!json) console.log(`${ui.success('PASS')} Preflight checks completed.\n`);
    } catch (e) {
        if (json) {
            const audit = auditPayloadFromExecError(e);
            console.log(JSON.stringify({
                ok: false,
                dryRun,
                quick: false,
                preflight: { ok: false, skipped: false, audit },
                error: audit ? null : String(e.stderr || e.message || '').trim().slice(0, 500) || null
            }, null, 2));
        } else {
            console.error(`\n${ui.error('FAIL')} Preflight checks failed. Sync halted to protect vault state.`);
            console.error(ui.muted(`Run 'npm run lint' or 'sos audit' to inspect errors.`));
        }
        process.exit(1);
    }
} else if (!json) {
    console.log(ui.accent('Sovereign OS sync'));
    console.log(`${ui.warning('QUICK')} ${ui.muted('Preflight checks skipped by operator request.')}`);
}

if (!dryRun) {
    try {
        refreshGraphIndex();
    } catch (error) {
        if (json) {
            console.log(JSON.stringify({
                ok: false,
                dryRun,
                error: `Graph index could not be written: ${error.stack}`
            }, null, 2));
        } else {
            console.error(ui.error(`Graph index could not be written: ${error.stack}`));
        }
        process.exit(1);
    }
}

const idMap = buildNodeIndex();
if (!json) console.log(`Indexed ${ui.heading(idMap.size)} canonical nodes in the knowledge graph.`);

const emit = console.log;
const emitErr = console.error;
let runtimeError = null;
if (json) {
    console.log = () => {};
    console.error = message => {
        runtimeError = String(message);
    };
}

if (doVaults) {
    syncVaults(idMap);
}

if (doBackup) {
    syncFullBackup();
}

if (json) {
    console.log = emit;
    console.error = emitErr;
    console.log(JSON.stringify({
        ok: !runtimeError,
        dryRun,
        quick: skipChecks,
        rebuild,
        vaults: doVaults,
        mirrors: doBackup,
        nodes: idMap.size,
        preflight: { ok: true, skipped: skipChecks },
        planned: dryRun ? { ...syncStats } : null,
        error: runtimeError
    }, null, 2));
    if (runtimeError) process.exitCode = 1;
} else if (dryRun) {
    console.log(`\n${ui.warning('DRY RUN COMPLETE')} ${ui.muted('No files changed.')}`);
    console.log(`Planned: ${ui.heading(syncStats.directories)} director${syncStats.directories === 1 ? 'y' : 'ies'}, ${ui.heading(syncStats.textWrites)} text write(s), ${ui.heading(syncStats.fileCopies)} binary copy/copies, ${syncStats.deletions > 0 ? ui.warning(syncStats.deletions) : ui.heading(syncStats.deletions)} deletion(s), ${ui.heading(syncStats.backupRuns)} backup mirror(s).`);
    console.log(`Unchanged: ${ui.heading(syncStats.textSkips)} text file(s), ${ui.heading(syncStats.fileSkips)} binary file(s).`);
} else {
    console.log(`\n${ui.success('SYNC COMPLETE')} Build and synchronization finished.`);
    console.log(`Wrote ${ui.heading(syncStats.textWrites)} text file(s), copied ${ui.heading(syncStats.fileCopies)} binary file(s), skipped ${ui.heading(syncStats.textSkips + syncStats.fileSkips)} identical.`);
}
