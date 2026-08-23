import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { sha256String } from '../lib/hash.mjs';
import {
    binaryFingerprint,
    fingerprintsMatch,
    loadVaultManifest,
    pruneManifest,
    saveVaultManifest,
    textFingerprint,
    VAULT_MANIFEST_VERSION
} from '../lib/vault-manifest.mjs';

test('vault manifest round-trips text fingerprints and prunes unseen keys', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-vault-manifest-'));
    const first = loadVaultManifest(root);
    assert.equal(first.version, VAULT_MANIFEST_VERSION);
    first.files['Personal/note.md'] = textFingerprint(sha256String('compiled'));
    first.files['Personal/stale.bin'] = binaryFingerprint({ size: 1, mtimeMs: 1 });
    saveVaultManifest(first, root);

    const loaded = loadVaultManifest(root);
    assert.equal(fingerprintsMatch(loaded.files['Personal/note.md'], textFingerprint(sha256String('compiled'))), true);
    assert.equal(fingerprintsMatch(loaded.files['Personal/note.md'], textFingerprint(sha256String('other'))), false);

    const pruned = pruneManifest(loaded, ['Personal/note.md']);
    assert.equal(pruned.files['Personal/note.md'].kind, 'text');
    assert.equal(pruned.files['Personal/stale.bin'], undefined);
});

test('cleanup skip list in sync never treats .obsidian as an orphan', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'sync.mjs'), 'utf-8');
    assert.match(source, /entry === 'inbox' \|\| entry === '\.obsidian'/);
});

