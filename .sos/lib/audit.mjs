#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { extname, join, relative } from 'path';
import { discoverDomains, REPO_ROOT, getAllMarkdownFiles } from './domains.mjs';
import {
    domainNameForRelativePath,
    localMarkdownTargets,
    pathIsTierOne
} from './frontmatter.mjs';
import { validateOperatorPreferences } from './operator-preferences.mjs';
import { scanRecords } from './records.mjs';
import { ui } from './terminal.mjs';
import { validateRelations } from './relations.mjs';

function evidenceRows(node) {
    if (Array.isArray(node.evidence)) return node.evidence;
    if (!node.filePath || node.content == null) return [];
    const rows = [];
    for (const assetPath of localMarkdownTargets(node.filePath, node.content).filter(path => path.split(/[/\\]/).includes('assets'))) {
        const archives = [];
        if (existsSync(assetPath) && extname(assetPath).toLowerCase() === '.md') {
            const assetContent = readFileSync(assetPath, 'utf-8');
            for (const archivePath of localMarkdownTargets(assetPath, assetContent)) {
                const parts = archivePath.split(/[/\\]/);
                if (parts.includes('inbox') && parts.includes('archive')) archives.push(archivePath);
            }
        }
        rows.push({ asset: relative(REPO_ROOT, assetPath), archives: archives.map(path => relative(REPO_ROOT, path)) });
    }
    return rows;
}

function evidenceAudit(nodes) {
    const result = { tierOneSources: 0, completeChains: 0, directDerivatives: 0, missingAssets: [], missingArchives: [], assetsWithoutArchive: [] };
    for (const node of nodes.values()) {
        if ((node.tier ?? (pathIsTierOne(node.relPath) ? 1 : 2)) !== 1) continue;
        for (const item of evidenceRows(node)) {
            const assetPath = join(REPO_ROOT, item.asset);
            result.tierOneSources++;
            if (!existsSync(assetPath)) {
                result.missingAssets.push({ node, assetPath });
                continue;
            }
            if (extname(assetPath).toLowerCase() !== '.md') {
                result.directDerivatives++;
                continue;
            }
            const archives = (item.archives || []).map(archive => join(REPO_ROOT, archive));
            if (archives.length === 0) {
                result.assetsWithoutArchive.push({ node, assetPath });
                continue;
            }
            let intact = true;
            for (const archivePath of archives) {
                if (!existsSync(archivePath)) {
                    intact = false;
                    result.missingArchives.push({ node, assetPath, archivePath });
                }
            }
            if (intact) result.completeChains++;
        }
    }
    return result;
}

function collectAudit() {
    const domains = discoverDomains();
    const domainNames = domains.map(d => d.name);
    const domainTierMap = new Map(domains.map(d => [d.name, d.tier]));

    const records = scanRecords({ repoRoot: REPO_ROOT, discoverDomains, getAllMarkdownFiles });
    const nodeMap = new Map();
    const duplicateIds = [];

    for (const record of records) {
        if (!record.id) continue;
        const nodeInfo = {
            ...record,
            children: [],
            backlinks: []
        };

        if (nodeMap.has(record.id)) {
            duplicateIds.push({ id: record.id, file1: nodeMap.get(record.id).relPath, file2: record.relPath });
        } else {
            nodeMap.set(record.id, nodeInfo);
        }
    }

    const brokenParents = [];
    const brokenRelated = [];
    const invalidRelations = [];
    const asymmetricEdges = [];
    const orphanNodes = [];
    const ifcViolations = [];
    const byPath = new Map();
    for (const node of nodeMap.values()) byPath.set(node.filePath, node);

    const recordIfc = (source, target, channel) => {
        const srcTier = domainTierMap.get(source.domain) || 3;
        const tgtTier = domainTierMap.get(target.domain) || 3;
        if (srcTier > 1 && tgtTier === 1) {
            ifcViolations.push({
                from: source.id,
                fromFile: source.relPath,
                fromTier: srcTier,
                to: target.id,
                toFile: target.relPath,
                channel
            });
        }
    };

    for (const [id, node] of nodeMap.entries()) {
        if (node.parent && node.parent !== id) {
            if (nodeMap.has(node.parent)) {
                nodeMap.get(node.parent).children.push(id);
                recordIfc(node, nodeMap.get(node.parent), 'parent');
            } else {
                brokenParents.push({ node: id, file: node.relPath, targetParent: node.parent });
            }
        }

        for (const error of validateRelations(node.relations)) {
            invalidRelations.push({ node: id, file: node.relPath, error });
        }

        for (const relId of node.related) {
            if (nodeMap.has(relId)) {
                const targetNode = nodeMap.get(relId);
                targetNode.backlinks.push(id);
                recordIfc(node, targetNode, 'related');
                if (!targetNode.related.includes(id)) {
                    asymmetricEdges.push({
                        from: id,
                        fromTitle: node.title,
                        to: relId,
                        toTitle: targetNode.title
                    });
                }
            } else {
                brokenRelated.push({ node: id, file: node.relPath, targetRelated: relId });
            }
        }

        if (!pathIsTierOne(node.relPath)) continue;

        for (const targetPath of localMarkdownTargets(node.filePath, node.content, { bodyOnly: true })) {
            const relTarget = relative(REPO_ROOT, targetPath);
            if (relTarget.startsWith('..')) continue;
            const targetDomainName = domainNameForRelativePath(relTarget);
            if (!targetDomainName || !domainTierMap.has(targetDomainName)) continue;
            if (!pathIsTierOne(relTarget)) continue;
            const targetNode = byPath.get(targetPath) || {
                id: relTarget,
                relPath: relTarget,
                domain: targetDomainName
            };
            recordIfc(node, targetNode, 'body');
        }
    }

    for (const [id, node] of nodeMap.entries()) {
        if (!pathIsTierOne(node.relPath)) continue;
        const isRootCharter = id.endsWith(':charter');
        const hasParent = node.parent && node.parent !== id;
        const hasChildren = node.children.some(childId => {
            const child = nodeMap.get(childId);
            return child && pathIsTierOne(child.relPath);
        });
        const hasRelated = node.related.length > 0;
        const hasBacklinks = node.backlinks.some(backId => {
            const source = nodeMap.get(backId);
            return source && pathIsTierOne(source.relPath);
        });

        if (!isRootCharter && !hasParent && !hasChildren && !hasRelated && !hasBacklinks) {
            orphanNodes.push({ id, file: node.relPath, title: node.title });
        }
    }

    const domainCrossMatrix = {};
    for (const d1 of domainNames) {
        domainCrossMatrix[d1] = {};
        for (const d2 of domainNames) domainCrossMatrix[d1][d2] = 0;
    }

    const tierOneNodes = [...nodeMap.values()].filter(node => pathIsTierOne(node.relPath));
    const assetNodes = [...nodeMap.values()].filter(node => !pathIsTierOne(node.relPath));

    for (const node of tierOneNodes) {
        const srcDomain = node.domain || node.id.split(':')[0];
        for (const relId of node.related) {
            const tgtNode = nodeMap.get(relId);
            if (!tgtNode || !pathIsTierOne(tgtNode.relPath)) continue;
            const tgtDomain = tgtNode.domain || relId.split(':')[0];
            if (domainCrossMatrix[srcDomain] && domainCrossMatrix[srcDomain][tgtDomain] !== undefined) {
                domainCrossMatrix[srcDomain][tgtDomain]++;
            }
        }
    }

    const evidence = evidenceAudit(nodeMap);
    const operatorPreferences = validateOperatorPreferences(REPO_ROOT);
    const relatedEdges = tierOneNodes.reduce((acc, n) => acc + n.related.length, 0);
    const hardFailures = duplicateIds.length + brokenParents.length + brokenRelated.length + invalidRelations.length + ifcViolations.length + evidence.missingAssets.length + evidence.missingArchives.length + operatorPreferences.errors.length;
    const warnings = orphanNodes.length + evidence.assetsWithoutArchive.length;

    return {
        nodeMap,
        tierOneCount: tierOneNodes.length,
        assetCount: assetNodes.length,
        domains,
        domainNames,
        duplicateIds,
        brokenParents,
        brokenRelated,
        invalidRelations,
        ifcViolations,
        orphanNodes,
        asymmetricEdges,
        domainCrossMatrix,
        evidence,
        operatorPreferences,
        relatedEdges,
        hardFailures,
        warnings
    };
}

function printAudit(report) {
    const {
        nodeMap, tierOneCount, assetCount, domains, domainNames, duplicateIds, brokenParents, brokenRelated, invalidRelations,
        ifcViolations, orphanNodes, asymmetricEdges, domainCrossMatrix, evidence, operatorPreferences,
        relatedEdges, hardFailures, warnings
    } = report;

    console.log(`${ui.accent('Knowledge Graph Relationship Audit')}\n`);
    console.log(`Indexed ${ui.heading(tierOneCount)} Tier 1 nodes and ${ui.heading(assetCount)} Tier 2 assets across ${ui.heading(domains.length)} domain pillars.\n`);
    console.log(ui.muted('═══════════════════════════════════════════════════════════════'));
    console.log(ui.accent('                  KNOWLEDGE GRAPH AUDIT REPORT                 '));
    console.log(`${ui.muted('═══════════════════════════════════════════════════════════════')}\n`);

    console.log(ui.heading('1. PRIMARY KEY INTEGRITY:'));
    if (duplicateIds.length === 0) {
        console.log(`   ${ui.success(`OK  0 ID collisions. All ${nodeMap.size} IDs are globally unique.`)}\n`);
    } else {
        console.log(`   ${ui.error(`FAIL  ${duplicateIds.length} duplicate IDs found:`)}`);
        duplicateIds.forEach(d => console.log(`      - ${ui.command(`[${d.id}]`)} ${ui.muted(`in ${d.file1} and ${d.file2}`)}`));
        console.log('');
    }

    console.log(ui.heading('2. FOREIGN KEY (PARENT & RELATED) INTEGRITY:'));
    if (brokenParents.length === 0 && brokenRelated.length === 0 && invalidRelations.length === 0) {
        console.log(`   ${ui.success('OK  0 broken foreign keys. All parent and typed related pointers resolve cleanly.')}\n`);
    } else {
        if (brokenParents.length > 0) {
            console.log(`   ${ui.error(`FAIL  ${brokenParents.length} broken parent pointers:`)}`);
            brokenParents.forEach(b => console.log(`      - ${ui.command(`[${b.node}]`)} ${ui.muted(`(${b.file})`)} ${ui.error(`Missing parent [${b.targetParent}]`)}`));
        }
        if (brokenRelated.length > 0) {
            console.log(`   ${ui.error(`FAIL  ${brokenRelated.length} broken related pointers:`)}`);
            brokenRelated.forEach(b => console.log(`      - ${ui.command(`[${b.node}]`)} ${ui.muted(`(${b.file})`)} ${ui.error(`Missing related [${b.targetRelated}]`)}`));
        }
        if (invalidRelations.length > 0) {
            console.log(`   ${ui.error(`FAIL  ${invalidRelations.length} invalid typed relationship(s):`)}`);
            invalidRelations.forEach(item => console.log(`      - ${ui.command(`[${item.node}]`)} ${ui.muted(`(${item.file})`)} ${ui.error(item.error)}`));
        }
        console.log('');
    }

    console.log(ui.heading('3. INFORMATION FLOW CONTROL (IFC) LATTICE INTEGRITY:'));
    if (ifcViolations.length === 0) {
        console.log(`   ${ui.success('OK  0 clean-room violations. Public and restricted nodes hold no inward parent, related, or body-link edges to private nodes.')}\n`);
    } else {
        console.log(`   ${ui.error(`FAIL  ${ifcViolations.length} clean-room IFC lattice violation(s) detected:`)}`);
        ifcViolations.forEach(v => console.log(`      - ${ui.command(`[${v.from}]`)} ${ui.muted(`(${v.fromFile}, ${v.channel}, Tier ${v.fromTier})`)} ──► ${ui.error(`[${v.to}]`)} ${ui.muted(`(${v.toFile}, private)`)}`));
        console.log('');
    }

    console.log(ui.heading('4. ORPHAN / ISOLATED NODE DETECTION:'));
    if (orphanNodes.length === 0) {
        console.log(`   ${ui.success('OK  0 orphan nodes. Every Tier 1 node is connected to the graph hierarchy.')}\n`);
    } else {
        console.log(`   ${ui.warning(`WARN  ${orphanNodes.length} orphan nodes detected:`)}`);
        orphanNodes.forEach(o => console.log(`      - ${ui.option(`[${o.id}]`)} ${ui.muted(`(${o.file})`)}`));
        console.log('');
    }

    console.log(ui.heading('5. RELATIONSHIP RECIPROCITY & ASYMMETRY:'));
    console.log(`   Total Explicit Related Edges: ${ui.heading(relatedEdges)}`);
    console.log(`   Asymmetric (One-Way Directed) Edges: ${ui.heading(asymmetricEdges.length)}`);
    if (asymmetricEdges.length > 0) {
        console.log(`\n   ${ui.muted('Listing directed relationships without a reciprocal declaration:')}`);
        asymmetricEdges.forEach(e => {
            console.log(`   - ${ui.option(`[${e.from}]`)} ${ui.muted(`"${e.fromTitle}" ──►`)} ${ui.option(`[${e.to}]`)} ${ui.muted(`"${e.toTitle}"`)}`);
        });
        console.log('');
    }

    console.log(ui.heading('6. CROSS-DOMAIN CONNECTIVITY MATRIX:'));
    const headerCols = domainNames.map(d => ui.command(d.padEnd(10)));
    console.log(`   From \\ To      | ${headerCols.join(' | ')} |`);
    console.log(ui.muted('   ───────────────────────────────────────────────────────────'));
    for (const d of domainNames) {
        const row = [
            ui.command(d.padEnd(14)),
            ...domainNames.map(targetD => String(domainCrossMatrix[d]?.[targetD] || 0).padStart(10))
        ];
        console.log(`   ${row.join(' | ')} |`);
    }

    console.log(`\n${ui.heading('7. TIER 1 → TIER 2 → TIER 3 EVIDENCE LINEAGE:')}`);
    console.log(`   Tier 1 source links into Tier 2 assets: ${ui.heading(evidence.tierOneSources)}`);
    if (evidence.missingAssets.length || evidence.missingArchives.length) {
        console.log(`   ${ui.error(`FAIL  Intact evidence chains: ${evidence.completeChains}`)}`);
    } else {
        console.log(`   ${ui.success(`OK  Complete evidence chains: ${evidence.completeChains}`)}`);
    }
    if (evidence.directDerivatives > 0) console.log(`   ${ui.muted(`Direct Tier 2 derivatives (keyframes, certificates, or images): ${evidence.directDerivatives}`)}`);
    if (evidence.missingAssets.length > 0) {
        console.log(`   ${ui.error(`FAIL  Missing Tier 2 assets: ${evidence.missingAssets.length}`)}`);
        evidence.missingAssets.forEach(item => console.log(`      - ${ui.muted(item.node.relPath)} → ${ui.error(relative(REPO_ROOT, item.assetPath))}`));
    }
    if (evidence.missingArchives.length > 0) {
        console.log(`   ${ui.error(`FAIL  Missing Tier 3 archives: ${evidence.missingArchives.length}`)}`);
        evidence.missingArchives.forEach(item => console.log(`      - ${ui.muted(relative(REPO_ROOT, item.assetPath))} → ${ui.error(relative(REPO_ROOT, item.archivePath))}`));
    }
    if (evidence.assetsWithoutArchive.length > 0) {
        console.log(`   ${ui.warning(`WARN  Tier 2 assets without an archive pointer: ${evidence.assetsWithoutArchive.length}`)}`);
        evidence.assetsWithoutArchive.forEach(item => console.log(`      - ${ui.muted(item.node.relPath)} → ${ui.warning(relative(REPO_ROOT, item.assetPath))}`));
    }

    console.log(`\n${ui.heading('8. OPERATOR-PREFERENCE CONFIGURATION:')}`);
    if (!operatorPreferences.exists) {
        console.log(`   ${ui.success('OK  No operator-preference file; normal conversation behavior remains available.')}`);
    } else if (operatorPreferences.valid) {
        console.log(`   ${ui.success(`OK  Valid configuration with ${operatorPreferences.preferences.length} approved preference(s).`)}`);
    } else {
        console.log(`   ${ui.error('FAIL  Malformed operator-preference configuration; no preferences are safe to apply.')}`);
        operatorPreferences.errors.forEach(error => console.log(`      - ${ui.error(error)}`));
    }

    if (hardFailures > 0) console.log(`\n   ${ui.error(`FAIL  Audit found ${hardFailures} integrity failure(s).`)}`);
    else if (warnings > 0) console.log(`\n   ${ui.warning(`WARN  Audit passed integrity checks with ${warnings} warning(s).`)}`);
    else console.log(`\n   ${ui.success('PASS  Graph structure, IFC, evidence lineage, and operator preferences are intact.')}`);
    console.log(`\n${ui.muted('═══════════════════════════════════════════════════════════════')}\n`);
}

function jsonAudit(report) {
    const failures = [
        ...report.duplicateIds.map(item => ({ code: 'duplicate-id', id: item.id, files: [item.file1, item.file2] })),
        ...report.brokenParents.map(item => ({ code: 'broken-parent', id: item.node, path: item.file, parent: item.targetParent })),
        ...report.brokenRelated.map(item => ({ code: 'broken-related', id: item.node, path: item.file, related: item.targetRelated })),
        ...report.invalidRelations.map(item => ({ code: 'invalid-relation', id: item.node, path: item.file, error: item.error })),
        ...report.ifcViolations.map(item => ({
            code: 'ifc',
            from: item.from,
            fromPath: item.fromFile,
            fromTier: item.fromTier,
            to: item.to,
            toPath: item.toFile,
            channel: item.channel
        })),
        ...report.evidence.missingAssets.map(item => ({
            code: 'missing-asset',
            id: item.node.id,
            path: item.node.relPath,
            asset: relative(REPO_ROOT, item.assetPath)
        })),
        ...report.evidence.missingArchives.map(item => ({
            code: 'missing-archive',
            asset: relative(REPO_ROOT, item.assetPath),
            archive: relative(REPO_ROOT, item.archivePath)
        })),
        ...report.operatorPreferences.errors.map(error => ({ code: 'operator-preferences', error }))
    ];
    const warnings = [
        ...report.orphanNodes.map(item => ({ code: 'orphan', id: item.id, path: item.file })),
        ...report.evidence.assetsWithoutArchive.map(item => ({
            code: 'asset-without-archive',
            id: item.node.id,
            path: item.node.relPath,
            asset: relative(REPO_ROOT, item.assetPath)
        }))
    ];

    return {
        ok: report.hardFailures === 0,
        nodes: report.tierOneCount,
        assets: report.assetCount,
        domains: report.domains.length,
        failures,
        warnings,
        summary: {
            duplicateIds: report.duplicateIds.length,
            brokenParents: report.brokenParents.length,
            brokenRelated: report.brokenRelated.length,
            invalidRelations: report.invalidRelations.length,
            ifcViolations: report.ifcViolations.length,
            orphans: report.orphanNodes.length,
            missingAssets: report.evidence.missingAssets.length,
            missingArchives: report.evidence.missingArchives.length,
            assetsWithoutArchive: report.evidence.assetsWithoutArchive.length,
            relatedEdges: report.relatedEdges,
            asymmetricEdges: report.asymmetricEdges.length,
            tierOneSources: report.evidence.tierOneSources,
            evidenceChains: report.evidence.completeChains,
            directDerivatives: report.evidence.directDerivatives
        },
        crossDomain: report.domainCrossMatrix,
        operatorPreferences: {
            exists: report.operatorPreferences.exists,
            valid: report.operatorPreferences.valid,
            count: report.operatorPreferences.preferences.length,
            errors: report.operatorPreferences.errors
        }
    };
}

function main() {
    const json = process.argv.slice(2).includes('--json');
    const report = collectAudit();
    if (json) console.log(JSON.stringify(jsonAudit(report), null, 2));
    else printAudit(report);
    if (report.hardFailures > 0) process.exitCode = 1;
}

main();
