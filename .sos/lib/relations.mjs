import { parse } from './yaml.mjs';

export const PREDICATES = new Set([
    'DERIVES_FROM',
    'GOVERNS',
    'IMPLEMENTS',
    'EVIDENCES',
    'TRANSMUTES'
]);

function unquote(value) {
    return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export function parseRelationsFromValue(related) {
    if (related == null) return [];
    if (Array.isArray(related)) {
        return related.flatMap(item => {
            if (item == null) return [];
            if (typeof item === 'string' || typeof item === 'number') {
                const id = unquote(item);
                return id ? [{ id, predicate: null, legacy: true }] : [];
            }
            if (typeof item === 'object') {
                const id = unquote(item.id);
                if (!id) return [{ id: '', predicate: item.predicate ? unquote(item.predicate) : null, legacy: false }];
                return [{
                    id,
                    predicate: item.predicate ? unquote(item.predicate) : null,
                    legacy: false
                }];
            }
            return [];
        });
    }
    return [];
}

/**
 * Parses the repository's typed `related` YAML block. Empty and legacy scalar
 * lists are accepted only so migration tooling can provide useful diagnostics.
 */
export function parseRelations(yaml) {
    if (yaml == null || yaml === '') return [];
    if (typeof yaml !== 'string') return parseRelationsFromValue(yaml?.related ?? yaml);
    try {
        const parsed = parse(yaml);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        return parseRelationsFromValue(parsed.related);
    } catch {
        return [];
    }
}

export function relationIds(relations) {
    return relations.map(relation => relation.id);
}

export function formatRelations(relations) {
    if (relations.length === 0) return 'related: []';
    return `related:\n${relations.map(({ id, predicate }) => `  - id: "${id}"\n    predicate: "${predicate}"`).join('\n')}`;
}

export function validateRelations(relations) {
    return relations.flatMap(relation => {
        if (!relation.id) return ['Relation is missing an id.'];
        if (relation.legacy) return [`Relation '${relation.id}' uses the retired untyped scalar syntax.`];
        if (!PREDICATES.has(relation.predicate)) {
            return [`Relation '${relation.id}' must declare one of: ${Array.from(PREDICATES).join(', ')}.`];
        }
        return [];
    });
}
