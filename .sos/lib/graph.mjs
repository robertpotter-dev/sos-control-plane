#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { discoverDomains, REPO_ROOT, getAllMarkdownFiles } from './domains.mjs';
import { pathIsTierOne } from './frontmatter.mjs';
import { edgesFromRecords, scanRecords } from './records.mjs';
import { ui } from './terminal.mjs';

export const GRAPH_INDEX_VERSION = 3;

function graphIndexPath() {
    return join(REPO_ROOT, '.sos', 'cache', 'graph-index.json');
}

function evidencePathsFrom(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.map(item => (typeof item === 'string' ? item : item?.asset)).filter(Boolean);
}

export function buildGraph() {
    const records = scanRecords({ repoRoot: REPO_ROOT, discoverDomains, getAllMarkdownFiles });
    const nodeMap = new Map();
    const tierTwoIds = new Set();
    for (const record of records) {
        if (record.id && record.tier !== 1) tierTwoIds.add(record.id);
        // The graph is the reviewed Tier 1 operating surface. Tier 2 assets are
        // discovered only through a Tier 1 note's evidence links.
        if (record.id && record.tier === 1) {
            nodeMap.set(record.id, {
                ...record,
                children: [],
                backlinks: []
            });
        }
    }

    nodeMap.tierTwoIds = tierTwoIds;
    nodeMap.edges = edgesFromRecords([...nodeMap.values()]);
    linkGraph(nodeMap);
    return nodeMap;
}

function linkGraph(nodeMap) {
    for (const node of nodeMap.values()) {
        node.children = [];
        node.backlinks = [];
    }
    for (const [id, node] of nodeMap.entries()) {
        if (node.parent && nodeMap.has(node.parent) && node.parent !== id) {
            nodeMap.get(node.parent).children.push(id);
        }
        for (const relId of node.related) {
            if (nodeMap.has(relId)) {
                nodeMap.get(relId).backlinks.push(id);
            }
        }
    }
    return nodeMap;
}

export function refreshGraphIndex() {
    writeLocalIndex(buildGraph());
}

export function writeLocalIndex(nodeMap) {
    const indexPath = graphIndexPath();
    const nodes = Array.from(nodeMap.values()).map(node => ({
        id: node.id,
        relPath: node.relPath,
        title: node.title || '',
        description: node.description || '',
        domain: node.domain || '',
        exposure: node.exposure || '',
        type: node.type || '',
        status: node.status || '',
        tags: node.tags || [],
        parent: node.parent || null,
        created: node.created || '',
        updated: node.updated || '',
        tier: node.tier ?? 1,
        relations: (node.relations || []).map(relation => ({
            id: relation.id,
            predicate: relation.predicate || null,
            legacy: Boolean(relation.legacy)
        })),
        related: node.related || [],
        evidence: node.evidence || (node.evidencePaths || []).map(asset => ({ asset, archives: [] })),
        body: node.body || ''
    }));
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify({
        version: GRAPH_INDEX_VERSION,
        generatedAt: new Date().toISOString(),
        tierTwoIds: [...(nodeMap.tierTwoIds || [])],
        edges: nodeMap.edges || edgesFromRecords(Array.from(nodeMap.values())),
        nodes
    }, null, 2)}\n`, 'utf-8');
}

function hydrateGraph(payload) {
    const nodeMap = new Map();
    for (const record of payload.nodes) {
        const evidence = Array.isArray(record.evidence) ? record.evidence : [];
        nodeMap.set(record.id, {
            id: record.id,
            relPath: record.relPath,
            filePath: join(REPO_ROOT, record.relPath),
            title: record.title || '',
            description: record.description || '',
            domain: record.domain || '',
            exposure: record.exposure || '',
            type: record.type || '',
            status: record.status || '',
            tags: record.tags || [],
            parent: record.parent || null,
            created: record.created || '',
            updated: record.updated || '',
            tier: record.tier ?? 1,
            relations: record.relations || [],
            related: record.related || [],
            evidence,
            evidencePaths: evidencePathsFrom(evidence),
            body: record.body || '',
            content: record.body || '',
            yaml: '',
            keys: new Set(),
            children: [],
            backlinks: []
        });
    }
    nodeMap.tierTwoIds = new Set(payload.tierTwoIds || []);
    nodeMap.edges = Array.isArray(payload.edges) ? payload.edges : edgesFromRecords([...nodeMap.values()]);
    return linkGraph(nodeMap);
}

function indexIsFresh(payload) {
    const generated = Date.parse(payload.generatedAt);
    if (!Number.isFinite(generated) || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) return false;
    const indexed = new Set(payload.nodes.map(node => node.relPath));
    for (const record of payload.nodes) {
        if (!record?.id || !record.relPath) return false;
        const filePath = join(REPO_ROOT, record.relPath);
        if (!existsSync(filePath)) return false;
        if (statSync(filePath).mtimeMs > generated) return false;
    }
    let diskCount = 0;
    for (const domain of discoverDomains()) {
        for (const file of getAllMarkdownFiles(domain.path)) {
            const relPath = relative(REPO_ROOT, file);
            if (!pathIsTierOne(relPath)) continue;
            diskCount++;
            if (statSync(file).mtimeMs > generated) return false;
        }
    }
    return diskCount === indexed.size;
}

export function loadGraph() {
    const indexPath = graphIndexPath();
    if (existsSync(indexPath)) {
        try {
            const payload = JSON.parse(readFileSync(indexPath, 'utf-8'));
            if (payload?.version === GRAPH_INDEX_VERSION && Array.isArray(payload.nodes) && indexIsFresh(payload)) {
                return hydrateGraph(payload);
            }
        } catch {
            // Fall through to a live scan.
        }
    }
    return buildGraph();
}

function rankedHubs(nodeMap) {
    let totalOutbound = 0;
    const hubs = [];
    for (const [id, node] of nodeMap.entries()) {
        totalOutbound += node.related.length;
        hubs.push({
            id,
            title: node.title || id,
            domain: node.domain,
            inDegree: node.backlinks.length,
            outDegree: node.related.length
        });
    }
    hubs.sort((a, b) => b.inDegree - a.inDegree);
    return { totalOutbound, hubs };
}

function printStats(nodeMap) {
    const { totalOutbound, hubs } = rankedHubs(nodeMap);
    console.log(`\n${ui.heading('Knowledge Graph Topology & Hub Metrics')}\n`);
    console.log(`• Total Canonical Nodes: ${ui.heading(nodeMap.size)}`);
    console.log(`• Total Direct Lateral Edges: ${ui.heading(totalOutbound)}`);
    console.log(`• Average Degree per Node: ${ui.heading(nodeMap.size ? (totalOutbound / nodeMap.size).toFixed(2) : '0.00')}\n`);

    console.log(ui.heading('Top scale-free hubs'));
    console.log(ui.muted('───────────────────────────────────────────────────────────────────────────'));
    for (let i = 0; i < Math.min(10, hubs.length); i++) {
        const h = hubs[i];
        console.log(` ${i + 1}. ${ui.muted(`[${h.id}]`)} ${ui.muted(`(${h.inDegree} in / ${h.outDegree} out)`)}`);
        console.log(`    "${h.title}" ${ui.muted(`[${h.domain}]`)}`);
    }
    console.log(ui.muted('───────────────────────────────────────────────────────────────────────────'));
    console.log(`\n${ui.muted('Usage:')} ${ui.command('sos graph "topic" --deep')}`);
}

function statsPayload(nodeMap) {
    const { totalOutbound, hubs } = rankedHubs(nodeMap);
    return {
        ok: true,
        resolution: 'stats',
        nodes: nodeMap.size,
        edges: totalOutbound,
        averageDegree: nodeMap.size ? Number((totalOutbound / nodeMap.size).toFixed(2)) : 0,
        hubs: hubs.slice(0, 10)
    };
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchToken(text, tok) {
    if (!text) return false;
    // Word boundary matching to prevent subword false positives (e.g. 'cat' matching 'location' or 'certificate')
    if (tok.length <= 4) {
        const regex = new RegExp(`\\b${escapeRegex(tok)}s?\\b`, 'i');
        return regex.test(text);
    }
    const regex = new RegExp(`\\b${escapeRegex(tok)}`, 'i');
    return regex.test(text);
}

const MATCH_CLASSES = [
    { name: 'exact canonical ID', rank: 0 },
    { name: 'exact note path', rank: 1 },
    { name: 'exact title', rank: 2 },
    { name: 'title phrase', rank: 3 },
    { name: 'title, ID, or path tokens', rank: 4 },
    { name: 'tags or description', rank: 5 },
    { name: 'body text', rank: 6 }
];

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[_:./-]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function matchesPhrase(text, phrase) {
    const haystack = normalizeText(text);
    const needle = normalizeText(phrase);
    return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

function matchesTokens(text, tokens) {
    return tokens.every(token => matchToken(text, token));
}

function classifyMatch(node, query, queryPath, queryTokens) {
    if (node.id.toLowerCase() === query.toLowerCase()) return MATCH_CLASSES[0];
    if (node.relPath === queryPath) return MATCH_CLASSES[1];
    if (normalizeText(node.title) === normalizeText(query)) return MATCH_CLASSES[2];
    if (matchesPhrase(node.title, query)) return MATCH_CLASSES[3];

    const identityText = `${node.title || ''} ${node.id} ${node.id.replace(/[-:]/g, ' ')} ${node.relPath}`;
    if (matchesTokens(identityText, queryTokens)) return MATCH_CLASSES[4];

    const supportingText = `${(node.tags || []).join(' ')} ${node.description || ''}`;
    if (matchesTokens(supportingText, queryTokens)) return MATCH_CLASSES[5];
    if (matchesTokens(node.body || node.content || '', queryTokens)) return MATCH_CLASSES[6];
    return null;
}

function graphRelations(node, nodeMap) {
    return node.relations.filter(relation => !nodeMap.tierTwoIds.has(relation.id));
}

function edgeRef(id, predicate, node) {
    return {
        id,
        predicate: predicate || null,
        title: node?.title || '',
        path: node?.relPath ?? null,
        domain: node?.domain ?? null,
        type: node?.type ?? null
    };
}

function identityRef(node) {
    if (!node) return null;
    return {
        id: node.id,
        title: node.title || '',
        path: node.relPath,
        domain: node.domain || '',
        type: node.type || ''
    };
}

function serializeNode(target, nodeMap, deep) {
    const parent = target.parent && target.parent !== target.id
        ? identityRef(nodeMap.get(target.parent)) || { id: target.parent, title: '', path: null, domain: '', type: '' }
        : null;
    const payload = {
        id: target.id,
        path: target.relPath,
        title: target.title || '',
        description: target.description || '',
        domain: target.domain || '',
        exposure: target.exposure || '',
        type: target.type || '',
        status: target.status || '',
        tags: target.tags || [],
        created: target.created || '',
        updated: target.updated || '',
        parent,
        related: graphRelations(target, nodeMap).map(relation => edgeRef(relation.id, relation.predicate, nodeMap.get(relation.id))),
        children: (target.children || []).map(id => identityRef(nodeMap.get(id))).filter(Boolean),
        backlinks: (target.backlinks || []).map(id => {
            const source = nodeMap.get(id);
            if (!source) return null;
            const relation = source.relations.find(item => item.id === target.id);
            return edgeRef(source.id, relation?.predicate, source);
        }).filter(Boolean),
        evidence: target.evidencePaths || []
    };
    if (deep) {
        payload.indirectEvidence = (target.backlinks || [])
            .map(id => nodeMap.get(id))
            .filter(node => node && node.relations.some(relation => relation.id === target.id && relation.predicate === 'EVIDENCES'))
            .flatMap(node => (node.evidencePaths || []).map(path => ({
                id: node.id,
                title: node.title || '',
                path: node.relPath,
                evidence: path
            })));
    }
    return payload;
}

function serializeCandidate(match, nodeMap, deep) {
    const node = match.node;
    const candidate = {
        id: node.id,
        path: node.relPath,
        title: node.title || '',
        domain: node.domain || '',
        exposure: node.exposure || '',
        type: node.type || '',
        matchClass: match.matchClass.name
    };
    if (!deep) return candidate;
    const related = graphRelations(node, nodeMap);
    const parent = node.parent && node.parent !== node.id ? nodeMap.get(node.parent) : null;
    candidate.parent = parent ? identityRef(parent) : null;
    candidate.related = related.map(relation => ({ id: relation.id, predicate: relation.predicate || null }));
    candidate.backlinks = (node.backlinks || []).map(id => {
        const source = nodeMap.get(id);
        const relation = source?.relations.find(item => item.id === node.id);
        return { id, predicate: relation?.predicate || null };
    });
    candidate.evidence = node.evidencePaths || [];
    return candidate;
}

function jsonPayload(result, nodeMap) {
    if (result.resolution === 'none') {
        return { ok: true, resolution: 'none', query: result.query, deep: result.deep };
    }
    if (result.resolution === 'tie') {
        return {
            ok: true,
            resolution: 'tie',
            query: result.query,
            deep: result.deep,
            matchClass: result.matchClass,
            count: result.tiedMatches.length,
            omitted: result.matches.length - result.tiedMatches.length,
            candidates: result.tiedMatches.map(match => serializeCandidate(match, nodeMap, result.deep))
        };
    }
    return {
        ok: true,
        resolution: 'node',
        query: result.query,
        deep: result.deep,
        matchClass: result.matchClass,
        node: serializeNode(result.node, nodeMap, result.deep)
    };
}

function printAmbiguousMatches(query, matches, nodeMap, isDeep) {
    const topClass = matches[0].matchClass;
    const tiedMatches = matches.filter(match => match.matchClass.rank === topClass.rank);
    console.log(`\n${ui.heading(`Found ${matches.length} matching node(s) for '${query}'.`)}`);
    console.log(ui.warning(`Multiple matching nodes identified by ${topClass.name}.`));
    console.log('');

    for (const match of tiedMatches.slice(0, 5)) {
        const node = match.node;
        console.log(`   - ${ui.option(`[${node.id}]`)} "${node.title}" ${ui.muted(`(${node.relPath})`)}`);
        console.log(`     ${ui.muted(match.matchClass.name)}`);
    }
    if (tiedMatches.length > 5) console.log(`   ${ui.muted(`... and ${tiedMatches.length - 5} more tied matches`)}`);
    const lowerPrecedenceCount = matches.length - tiedMatches.length;
    if (lowerPrecedenceCount > 0) console.log(`\n${ui.muted(`${lowerPrecedenceCount} lower-precedence match${lowerPrecedenceCount === 1 ? '' : 'es'} omitted.`)}`);

    if (isDeep) {
        console.log(`\n${ui.heading('DEEP CONTEXT FOR TIED MATCHES')}`);
        console.log(ui.muted('One-hop context only — this does not select a primary node.'));
        for (const match of tiedMatches.slice(0, 5)) {
            const node = match.node;
            const parent = node.parent && node.parent !== node.id ? nodeMap.get(node.parent) : null;
            const related = node.related.filter(relId => !nodeMap.tierTwoIds.has(relId));
            const backlinks = node.backlinks || [];
            console.log(`\n  ${ui.command(`[${node.id}]`)} ${ui.muted(`${node.domain || 'unknown'} · ${node.type || 'note'} · ${node.exposure || 'standard'}`)}`);
            if (node.description) console.log(`  ${node.description}`);
            if (parent) console.log(`  ${ui.muted('Parent:')} ${ui.muted(`[${parent.id}]`)} "${parent.title || ''}"`);
            else console.log(`  ${ui.muted('Parent:')} ${ui.muted('(root charter / self)')}`);
            console.log(`  ${ui.muted('Links:')} ${related.length} outbound · ${backlinks.length} inbound · ${node.evidencePaths.length} Tier 2 evidence ${node.evidencePaths.length === 1 ? 'source' : 'sources'}`);
            if (related.length) {
                const preview = related.slice(0, 3).map(relId => {
                    const relatedNode = nodeMap.get(relId);
                    return relatedNode ? `[${relId}]` : `[${relId}?]`;
                }).join(', ');
                console.log(`  ${ui.muted('Relates to:')} ${ui.muted(preview)}${related.length > 3 ? ui.muted(` +${related.length - 3}`) : ''}`);
            }
            if (backlinks.length) {
                const preview = backlinks.slice(0, 3).map(backlinkId => `[${backlinkId}]`).join(', ');
                console.log(`  ${ui.muted('Referenced by:')} ${ui.muted(preview)}${backlinks.length > 3 ? ui.muted(` +${backlinks.length - 3}`) : ''}`);
            }
        }
        if (tiedMatches.length > 5) console.log(`\n${ui.muted(`${tiedMatches.length - 5} additional tied candidates omitted from deep context.`)}`);
    }

    console.log(`\n${ui.muted('Use a canonical ID, repository-relative note path, or a more specific phrase.')}\n`);
}

function resolveQuery(nodeMap, query, isDeep) {
    const queryPath = query.replace(/\\/g, '/').replace(/^\.\//, '');
    let target = Array.from(nodeMap.values()).find(node => node.id.toLowerCase() === query.toLowerCase()) || null;
    if (target) return { resolution: 'node', query, deep: isDeep, matchClass: MATCH_CLASSES[0].name, node: target };

    target = Array.from(nodeMap.values()).find(node => node.relPath === queryPath) || null;
    if (target) return { resolution: 'node', query, deep: isDeep, matchClass: MATCH_CLASSES[1].name, node: target };

    const queryTokens = normalizeText(query).split(/\s+/).filter(Boolean);
    const matches = Array.from(nodeMap.values())
        .map(node => ({ node, matchClass: classifyMatch(node, query, queryPath, queryTokens) }))
        .filter(match => match.matchClass)
        .sort((left, right) => left.matchClass.rank - right.matchClass.rank || left.node.title.localeCompare(right.node.title) || left.node.relPath.localeCompare(right.node.relPath));

    if (matches.length === 0) return { resolution: 'none', query, deep: isDeep };

    const tiedMatches = matches.filter(match => match.matchClass.rank === matches[0].matchClass.rank);
    if (tiedMatches.length > 1) {
        return {
            resolution: 'tie',
            query,
            deep: isDeep,
            matchClass: matches[0].matchClass.name,
            matches,
            tiedMatches
        };
    }

    return {
        resolution: 'node',
        query,
        deep: isDeep,
        matchClass: matches[0].matchClass.name,
        node: matches[0].node
    };
}

function printNode(target, nodeMap, isDeep) {
    console.log(`\n${ui.muted('═════════════════════════════════════════════════════════════════════════════')}`);
    console.log(`${ui.muted('NODE:')} ${ui.command(target.id)}`);
    console.log(`${ui.muted('TITLE:')} ${target.title || '(Untitled)'}`);
    console.log(`${ui.muted('DOMAIN:')} ${target.domain} ${ui.muted(`(exposure: ${target.exposure || 'standard'}) | TYPE: ${target.type || 'note'}`)}`);
    console.log(`${ui.muted('PATH:')} ${ui.muted(target.relPath)}`);
    if (target.description) console.log(`${ui.muted('DESC:')} ${target.description}`);
    console.log(ui.muted('═════════════════════════════════════════════════════════════════════════════'));

    console.log(`\n${ui.heading('▲ FORWARD OUTBOUND EDGES')}`);
    if (target.parent && target.parent !== target.id) {
        const pNode = nodeMap.get(target.parent);
        console.log(`  └── parent: ${ui.muted(`[${target.parent}]`)} ${pNode ? `"${pNode.title}"` : ''}`);
    } else {
        console.log(ui.muted('  └── parent: (Root Charter / Self)'));
    }

    const graphRelated = target.related.filter(relId => !nodeMap.tierTwoIds.has(relId));
    if (graphRelated.length > 0) {
        console.log(`  └── related (${graphRelated.length}):`);
        for (const relId of graphRelated) {
            const rNode = nodeMap.get(relId);
            const relation = target.relations.find(item => item.id === relId);
            if (rNode) {
                console.log(`      - ${ui.option(relation?.predicate || 'RELATED')} ${ui.muted(`[${relId}]`)} "${rNode.title || ''}" ${ui.muted(`(${rNode.domain})`)}`);
                if (isDeep && rNode.description) {
                    console.log(`        └─ ${ui.muted(rNode.description)}`);
                }
            } else {
                console.log(`      - ${ui.warning(`[${relId}] (External / Unresolved Target)`)}`);
            }
        }
    } else {
        console.log(ui.muted('  └── related: [ none ]'));
    }

    if (target.children && target.children.length > 0) {
        console.log(`  └── children (${target.children.length}):`);
        for (const cId of target.children) {
            const cNode = nodeMap.get(cId);
            console.log(`      - ${ui.muted(`[${cId}]`)} "${cNode ? cNode.title : ''}"`);
        }
    }

    console.log(`\n${ui.heading('▼ VIRTUAL INBOUND BACKLINKS')}`);
    if (target.backlinks && target.backlinks.length > 0) {
        console.log(`  Found ${ui.heading(target.backlinks.length)} inbound reference(s):`);
        for (const blId of target.backlinks) {
            const blNode = nodeMap.get(blId);
            if (blNode) {
                const relation = blNode.relations.find(item => item.id === target.id);
                console.log(`  - ${ui.option(relation?.predicate || 'RELATED')} ${ui.muted(`[${blId}]`)} "${blNode.title || ''}" ${ui.muted(`[${blNode.domain}/${blNode.type}]`)}`);
                if (isDeep) {
                    if (blNode.description) console.log(`    ├─ Summary: ${ui.muted(blNode.description)}`);
                    console.log(`    └─ Path: ${ui.muted(blNode.relPath)}`);
                }
            }
        }
    } else {
        console.log(ui.muted('  - [ No inbound backlinks — leaf node ]'));
    }

    console.log(`\n${ui.heading('◉ EVIDENCE PATHS (Tier 1 → Tier 2)')}`);
    if (target.evidencePaths?.length > 0) {
        for (const evidencePath of target.evidencePaths) console.log(`  - ${ui.muted(evidencePath)}`);
    } else {
        console.log(ui.muted('  - [ No direct Tier 2 sources ]'));
    }

    if (isDeep) {
        const indirectEvidence = target.backlinks
            .map(id => nodeMap.get(id))
            .filter(node => node && node.relations.some(relation => relation.id === target.id && relation.predicate === 'EVIDENCES'))
            .flatMap(node => node.evidencePaths.map(evidencePath => ({ node, evidencePath })));

        if (indirectEvidence.length > 0) {
            console.log(`\n${ui.heading('◉ INDIRECT EVIDENCE ROUTES')}`);
            console.log(ui.muted('  Inbound EVIDENCES nodes with direct Tier 2 sources:'));
            for (const { node, evidencePath } of indirectEvidence) {
                console.log(`  - ${ui.option('EVIDENCES')} ${ui.muted(`via [${node.id}]`)} "${node.title || ''}"`);
                console.log(`    └─ ${ui.muted(evidencePath)}`);
            }
        }
    }

    if (!isDeep && target.backlinks.length > 0) {
        console.log(`\n${ui.muted('Tip:')} ${ui.command('sos graph "topic"')} ${ui.option('--deep')} ${ui.muted('expands one-hop context, virtual backlinks, and inbound EVIDENCES sources.')}`);
    }
    console.log(`${ui.muted('═════════════════════════════════════════════════════════════════════════════')}\n`);
}

function printQuery(result, nodeMap) {
    if (result.resolution === 'none') {
        console.log(`\n${ui.error(`No nodes matching '${result.query}' found in the knowledge graph.`)}`);
        console.log(`${ui.muted('Try broader keywords, e.g.:')} ${ui.command('sos graph "sovereign"')}\n`);
        return;
    }
    if (result.resolution === 'tie') {
        printAmbiguousMatches(result.query, result.matches, nodeMap, result.deep);
        return;
    }
    printNode(result.node, nodeMap, result.deep);
}

function parseGraphArgs(argv) {
    const json = argv.includes('--json');
    const deep = argv.includes('--deep') || argv.includes('-d');
    const stats = argv.includes('--stats') || argv.includes('-s');
    const query = argv.filter(arg => !arg.startsWith('-')).join(' ').trim();
    return { json, deep, stats, query };
}

function isDirectRun() {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return pathToFileURL(resolve(entry)).href === import.meta.url;
    } catch {
        return false;
    }
}

function main() {
    const args = process.argv.slice(2);
    const { json, deep, stats, query } = parseGraphArgs(args);
    const nodeMap = loadGraph();

    if (!query || stats) {
        if (json) console.log(JSON.stringify(statsPayload(nodeMap), null, 2));
        else printStats(nodeMap);
        return;
    }

    const result = resolveQuery(nodeMap, query, deep);
    if (json) console.log(JSON.stringify(jsonPayload(result, nodeMap), null, 2));
    else printQuery(result, nodeMap);
}

if (isDirectRun()) main();
