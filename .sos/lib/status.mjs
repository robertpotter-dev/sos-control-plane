import { spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { fail } from './cli.mjs';
import { readControlPlaneVersion } from './control-plane.mjs';
import { getAllMarkdownFiles } from './domains.mjs';
import { pathIsTierOne } from './frontmatter.mjs';
import { scanInboxes } from './inbox-scan.mjs';
import { scanRecords } from './records.mjs';
import { configuredSystemName } from './system-config.mjs';
import { ui } from './terminal.mjs';

const EXECUTING_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function resolveVersion(repoRoot) {
    return readControlPlaneVersion(EXECUTING_ROOT) || readControlPlaneVersion(repoRoot) || '0.0.0';
}

function collectTierOneNodes(discoverDomains, repoRoot) {
    const records = scanRecords({ repoRoot, discoverDomains, getAllMarkdownFiles });
    const nodes = records
        .filter(record => record.tier === 1)
        .map(record => ({ id: record.id ?? null, path: record.filePath }));
    const seen = new Set(nodes.map(node => node.path));
    for (const domain of discoverDomains()) {
        for (const filePath of getAllMarkdownFiles(domain.path)) {
            if (!pathIsTierOne(relative(repoRoot, filePath)) || seen.has(filePath)) continue;
            nodes.push({ id: null, path: filePath });
        }
    }
    return nodes;
}

function collectTierTwoAssets(discoverDomains) {
    let count = 0;
    for (const domain of discoverDomains()) {
        const assetsDir = join(domain.path, 'assets');
        if (!existsSync(assetsDir)) continue;
        for (const name of readdirSync(assetsDir)) {
            if (name.endsWith('.md')) count++;
        }
    }
    return count;
}

function collectTierThreeArchives(discoverDomains) {
    let count = 0;
    function visit(dir) {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
            if (name.startsWith('.')) continue;
            const child = join(dir, name);
            const stat = statSync(child);
            if (stat.isDirectory()) visit(child);
            else count++;
        }
    }
    for (const domain of discoverDomains()) visit(join(domain.path, 'inbox', 'archive'));
    return count;
}

function gitState(repoRoot) {
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf-8' });
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf-8' });
    if (branch.status !== 0 || status.status !== 0) return { available: false };
    const changes = status.stdout.split(/\r?\n/).filter(Boolean);
    return { available: true, branch: branch.stdout.trim(), dirty: changes.length > 0, changes: changes.length };
}

export function statusCommand(args, options, ctx) {
    const { repoRoot, discoverDomains } = ctx;
    if (args.length > 0) return fail(`status does not accept arguments: ${args.join(' ')}`, options);
    if (options.dryRun) return fail('--dry-run is not applicable to status.', options);

    const domains = discoverDomains();
    const inbox = scanInboxes(discoverDomains, { repoRoot });
    const nodes = collectTierOneNodes(discoverDomains, repoRoot);
    const assets = collectTierTwoAssets(discoverDomains);
    const archives = collectTierThreeArchives(discoverDomains);
    const git = gitState(repoRoot);
    const version = resolveVersion(repoRoot);
    const result = {
        ok: true,
        system: configuredSystemName(repoRoot),
        version,
        root: repoRoot,
        domains: domains.map(domain => ({ name: domain.name, exposure: domain.exposure, vault: domain.vaultName })),
        graph: { tierOneNodes: nodes.length, canonicalIds: nodes.filter(node => node.id).length, assets, archives },
        inbox: {
            captures: inbox.filter(item => item.type === 'capture').length,
            batches: inbox.filter(item => item.type === 'batch').length,
            debriefs: inbox.filter(item => item.type === 'debrief').length,
            total: inbox.length
        },
        git
    };

    if (options.json) return console.log(JSON.stringify(result, null, 2));
    if (options.quiet) return;

    const domainSummary = `${domains.length} domain${domains.length === 1 ? '' : 's'}`;
    const graphSummary = `${result.graph.tierOneNodes} active note${result.graph.tierOneNodes === 1 ? '' : 's'}`;
    const assetSummary = `${result.graph.assets} asset${result.graph.assets === 1 ? '' : 's'}`;
    const archiveSummary = `${result.graph.archives} archive${result.graph.archives === 1 ? '' : 's'}`;
    const inboxSummary = result.inbox.total === 0
        ? 'Inbox Zero'
        : `${result.inbox.captures} capture${result.inbox.captures === 1 ? '' : 's'} · ${result.inbox.batches} batch${result.inbox.batches === 1 ? '' : 'es'} · ${result.inbox.debriefs} debrief${result.inbox.debriefs === 1 ? '' : 's'}`;
    const gitLeft = git.available ? (git.branch || '(detached)') : 'Git';
    const gitRight = git.available
        ? (git.dirty ? `${git.changes} uncommitted change${git.changes === 1 ? '' : 's'}` : 'clean')
        : 'unavailable';

    const MARK_WIDTH = 54;
    const DOT = ' · ';
    const formatPair = (left, right) => `${left}${DOT}${right}`;
    const center = (line, width = MARK_WIDTH) => {
        const pad = Math.max(0, Math.floor((width - line.length) / 2));
        return line.length >= width ? line : `${' '.repeat(pad)}${line}`.padEnd(width);
    };

    console.log('');
    console.log(`                          @@
                         @@@@
                        @@@@@@
                       @@@@@@@@
                      @@@@@@@@@@
                     @@@@@@@@@@@@
                     @@@@@@@@@@@@
                    @@@@@@@@@@@@@@
                   @@@@@@@@@@@@@@@@
                   @@@@@@@@@@@@@@@@
                   @@@@@@@@@@@@@@@@
                   @@@@@@@@@@@@@@@@
     @@@@@@@@@@@    @@@@@@@@@@@@@@    @@@@@@@@@@@
   @@@@@@@@@@@@@@@@  @@@@@@@@@@@@  @@@@@@@@@@@@@@@@
 @@@@@@@@@@@@@@@@@@@@ @@@@@@@@@@ @@@@@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@@@@@@@ @@@@@@@@ @@@@@@@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@@@@@@@@ @@@@@@ @@@@@@@@@@@@@@@@@@@@@@@
@@@@@@@@@@      @@@@@@@@ @@@@ @@@@@@@@      @@@@@@@@@@
 @@@@@@@@          @@@@@ @@@@ @@@@@          @@@@@@@@
   @@@@@             @@@ @@@@ @@@             @@@@@
     @@@@    @@@@  @@@@@@@@@@@@@@@@  @@@@    @@@@
           @@@@@  @@@@@@@@@@@@@@@@@@  @@@@
           @@@@@     @@@ @@@@ @@@     @@@@@
           @@@@@@@  @@@@ @@@@ @@@@  @@@@@@@
           @@@@@@@@@@@@ @@@@@@ @@@@@@@@@@@@
             @@@@@@@@@ @@@@@@@@ @@@@@@@@@
                      @@@@@@@@@@
                         @@@@
                          @@`);
    console.log('');
    console.log(ui.accent(center(formatPair('SOVEREIGN OS', result.system + ', ' + version))));
    console.log('');
    console.log(ui.command(center(formatPair(domainSummary, graphSummary))));
    console.log('');
    console.log(ui.muted(center(formatPair(assetSummary, archiveSummary))));
    console.log('');
    console.log(!git.available ? ui.error(center(formatPair(gitLeft, gitRight))) : git.dirty ? ui.warning(center(formatPair(gitLeft, gitRight))) : ui.success(center(formatPair(gitLeft, gitRight))));
    console.log('');
    console.log(result.inbox.total === 0 ? ui.success(center(inboxSummary)) : ui.warning(center(inboxSummary)));
    console.log('');
    console.log(ui.muted(center(repoRoot)));
    console.log('');
}
