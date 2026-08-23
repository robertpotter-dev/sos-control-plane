import assert from 'node:assert/strict';
import test from 'node:test';

import { namespacePrefix, parseFrontmatter } from '../lib/frontmatter.mjs';
import { parseRelations, validateRelations } from '../lib/relations.mjs';

function note({ title = 'Plain Title', extra = '', related = 'related: []' } = {}) {
    return [
        '---',
        'id: "jrnl:note"',
        'parent: "jrnl:charter"',
        related,
        `title: "${title}"`,
        'description: "A title: with a colon in the description."',
        'type: "note"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test", "yaml"]',
        extra,
        '---',
        '',
        '# Body',
        ''
    ].filter(Boolean).join('\n');
}

test('parseFrontmatter keeps colons inside quoted scalars', () => {
    const parsed = parseFrontmatter(note({ title: 'Work: Hope VoIP' }));
    assert.equal(parsed.parseError, false);
    assert.equal(parsed.title, 'Work: Hope VoIP');
    assert.equal(parsed.description, 'A title: with a colon in the description.');
    assert.equal(parsed.created, '2026-08-18');
    assert.deepEqual(parsed.tags, ['test', 'yaml']);
});

test('parseFrontmatter lowercases source_sha256 when present', () => {
    const hash = 'A'.repeat(64);
    const parsed = parseFrontmatter(note({ extra: `source_sha256: "${hash}"` }));
    assert.equal(parsed.parseError, false);
    assert.equal(parsed.source_sha256, 'a'.repeat(64));
});

test('namespacePrefix reads the id namespace, not a title colon', () => {
    assert.equal(namespacePrefix('jrnl:charter'), 'jrnl');
    assert.equal(namespacePrefix('psn:note-with:extra', 'fold'), 'psn');
    assert.equal(namespacePrefix('', 'jrnl'), 'jrnl');
    assert.equal(namespacePrefix('nocolon'), 'nocolon');
    assert.equal(namespacePrefix('nocolon', 'jrnl'), 'jrnl');
});

test('parseFrontmatter reads typed related objects', () => {
    const parsed = parseFrontmatter(note({
        related: 'related:\n  - id: "jrnl:charter"\n    predicate: "IMPLEMENTS"'
    }));
    assert.deepEqual(parsed.relations, [{ id: 'jrnl:charter', predicate: 'IMPLEMENTS', legacy: false }]);
    assert.deepEqual(validateRelations(parsed.relations), []);
});

test('parseRelations still accepts a YAML fragment and flags legacy scalar lists', () => {
    const relations = parseRelations('related: ["jrnl:a", "jrnl:b"]');
    assert.equal(relations.length, 2);
    assert.equal(relations[0].legacy, true);
    assert.match(validateRelations(relations)[0], /retired untyped scalar syntax/);
});

test('invalid YAML frontmatter is marked rather than silently sliced', () => {
    const parsed = parseFrontmatter('---\n[\n---\n\n# Body\n');
    assert.equal(parsed.parseError, true);
    assert.equal(parsed.title, undefined);
    assert.equal(parsed.source_sha256, undefined);
});
