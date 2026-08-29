import { dirname, resolve } from 'path';
import { parse } from './yaml.mjs';

import { parseRelationsFromValue, relationIds } from './relations.mjs';

export const REQUIRED_FRONTMATTER_KEYS = [
    'id', 'parent', 'title', 'domain', 'type', 'exposure', 'status', 'created', 'updated', 'tags'
];
export const RETIRED_FRONTMATTER_KEYS = ['reviewed'];
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function splitFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    return {
        yaml: match[1],
        body: content.slice(match[0].length),
        block: match[0]
    };
}

function scalarString(value) {
    if (value == null) return undefined;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }
    return undefined;
}

function tagList(value) {
    if (Array.isArray(value)) {
        return value.map(item => scalarString(item)).filter(Boolean);
    }
    const text = scalarString(value);
    return text ? [text] : [];
}

function emptyParsed(yaml, body) {
    return {
        yaml,
        body,
        keys: new Set(),
        parseError: true,
        id: undefined,
        parent: undefined,
        title: undefined,
        description: undefined,
        domain: undefined,
        exposure: undefined,
        type: undefined,
        status: undefined,
        created: undefined,
        updated: undefined,
        tags: [],
        relations: [],
        related: [],
        source_sha256: undefined,
        provenance: undefined,
        frontier_model: undefined,
        frontier_request: undefined,
        source_coverage: undefined,
        uncertainty: undefined,
        source_inventory: undefined,
        source_intake: undefined
    };
}

export function namespacePrefix(id, fallback = '') {
    const text = String(id || '');
    const colon = text.indexOf(':');
    if (colon > 0) return text.slice(0, colon);
    return fallback || text;
}

export function parseFrontmatter(content) {
    const split = splitFrontmatter(content);
    if (!split) return null;
    const { yaml, body } = split;
    let data = null;
    try {
        data = parse(yaml);
    } catch {
        return emptyParsed(yaml, body);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return emptyParsed(yaml, body);
    }
    const relations = parseRelationsFromValue(data.related);
    const sourceSha = scalarString(data.source_sha256);
    return {
        yaml,
        body,
        keys: new Set(Object.keys(data)),
        parseError: false,
        id: scalarString(data.id),
        parent: scalarString(data.parent),
        title: scalarString(data.title),
        description: scalarString(data.description),
        domain: scalarString(data.domain),
        exposure: scalarString(data.exposure),
        type: scalarString(data.type),
        status: scalarString(data.status),
        created: scalarString(data.created),
        updated: scalarString(data.updated),
        tags: tagList(data.tags),
        relations,
        related: relationIds(relations),
        source_sha256: sourceSha ? sourceSha.toLowerCase() : undefined,
        provenance: scalarString(data.provenance),
        frontier_model: scalarString(data.frontier_model),
        frontier_request: scalarString(data.frontier_request),
        source_coverage: scalarString(data.source_coverage),
        uncertainty: scalarString(data.uncertainty),
        source_inventory: scalarString(data.source_inventory),
        source_intake: scalarString(data.source_intake)
    };
}

export function pathIsTierOne(relPath) {
    const parts = String(relPath || '').split(/[/\\]/);
    return !parts.includes('assets') && !parts.includes('inbox');
}

export function localMarkdownTargets(filePath, content, { bodyOnly = false } = {}) {
    const split = splitFrontmatter(content);
    const source = bodyOnly ? (split?.body ?? content) : content;
    const links = [];
    const matcher = /\[[^\]]+\]\(([^)]+)\)/g;
    let match;
    while ((match = matcher.exec(source)) !== null) {
        const target = match[1].split('#')[0].split('?')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
        links.push(resolve(dirname(filePath), decodeURIComponent(target)));
    }
    return links;
}

export function domainNameForRelativePath(relPath) {
    const top = String(relPath || '').split(/[/\\]/).find(Boolean);
    return top || null;
}
