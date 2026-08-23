import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { discoverDomains } from '../lib/domains.mjs';
import { resolveRepoRoot } from '../lib/root.mjs';

test('discoverDomains takes the namespace from id when title contains a colon', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-domains-'));
    mkdirSync(join(root, 'journal'));
    writeFileSync(join(root, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal: Daily Log"',
        'description: "Fixture."',
        'type: "charter"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Journal: Daily Log',
        ''
    ].join('\n'));

    const domains = discoverDomains(root);
    assert.equal(domains.length, 1);
    assert.equal(domains[0].name, 'journal');
    assert.equal(domains[0].prefix, 'jrnl');
    assert.equal(domains[0].title, 'Journal: Daily Log');
    assert.equal(domains[0].vaultName, 'Journal');
    assert.equal(domains[0].exposure, 'private');
    assert.equal(domains[0].tier, 1);
});

test('resolveRepoRoot falls back to the module checkout when cwd is unavailable', () => {
    const root = resolveRepoRoot({ startPath: null, moduleUrl: import.meta.url });
    assert.equal(existsSync(join(root, '.sos', 'lib', 'domains.mjs')), true);
});
