import { existsSync, readFileSync } from 'fs';
import { extname, relative } from 'path';

import { localMarkdownTargets, parseFrontmatter } from './frontmatter.mjs';

export function physicalTier(relPath) {
    const parts = String(relPath || '').split(/[/\\]/);
    if (parts.includes('assets')) return 2;
    if (parts.includes('inbox')) return 3;
    return 1;
}

function posixRel(repoRoot, absPath) {
    return relative(repoRoot, absPath).split('\\').join('/');
}

function pathHasSegment(absPath, segment) {
    return String(absPath || '').split(/[/\\]/).includes(segment);
}

export function collectEvidence(filePath, content, repoRoot) {
    const evidence = [];
    const seen = new Set();
    for (const target of localMarkdownTargets(filePath, content)) {
        if (!pathHasSegment(target, 'assets')) continue;
        const asset = posixRel(repoRoot, target);
        if (!asset || seen.has(asset)) continue;
        seen.add(asset);
        const archives = [];
        const artifacts = [];
        if (existsSync(target) && extname(target).toLowerCase() === '.md') {
            const assetContent = readFileSync(target, 'utf-8');
            for (const linkedPath of localMarkdownTargets(target, assetContent)) {
                if (pathHasSegment(linkedPath, 'inbox') && pathHasSegment(linkedPath, 'archive')) {
                    archives.push(posixRel(repoRoot, linkedPath));
                } else if (pathHasSegment(linkedPath, 'assets') && linkedPath !== target) {
                    artifacts.push(posixRel(repoRoot, linkedPath));
                }
            }
        }
        evidence.push({ asset, artifacts, archives });
    }
    return evidence;
}

export function parseRecord(filePath, content, { repoRoot, domainTierByName } = {}) {
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;
    const relPath = posixRel(repoRoot, filePath);
    const evidence = collectEvidence(filePath, content, repoRoot);
    return {
        ...parsed,
        filePath,
        relPath,
        tier: physicalTier(relPath),
        evidence,
        evidencePaths: evidence.map(item => item.asset),
        content
    };
}

export function edgesFromRecords(records) {
    const edges = [];
    for (const record of records || []) {
        if (!record?.id) continue;
        for (const relation of record.relations || []) {
            edges.push({
                from: record.id,
                predicate: relation.predicate || null,
                to: relation.id,
                legacy: Boolean(relation.legacy)
            });
        }
    }
    return edges;
}

export function scanRecords({ repoRoot, discoverDomains, getAllMarkdownFiles }) {
    const domains = discoverDomains();
    const domainTierByName = Object.fromEntries(domains.map(domain => [domain.name, domain.tier]));
    const records = [];
    for (const domain of domains) {
        for (const filePath of getAllMarkdownFiles(domain.path)) {
            const content = readFileSync(filePath, 'utf-8');
            const record = parseRecord(filePath, content, { repoRoot, domainTierByName });
            if (record) records.push(record);
        }
    }
    return records;
}
