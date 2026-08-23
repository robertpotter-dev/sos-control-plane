import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateOperatorPreferences } from '../lib/operator-preferences.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const AUDIT_SCRIPT = join(SOURCE_ROOT, '.sos', 'lib', 'audit.mjs');

function fixture(content) {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-operator-preferences-'));
    if (content !== undefined) {
        mkdirSync(join(root, '.sos'), { recursive: true });
        writeFileSync(join(root, '.sos', 'operator-preferences.json'), content, 'utf-8');
    }
    return root;
}

test('an absent operator-preference file means no preferences', () => {
    const result = validateOperatorPreferences(fixture());

    assert.equal(result.exists, false);
    assert.equal(result.valid, true);
    assert.deepEqual(result.preferences, []);
});

test('the minimal operator-preference contract accepts natural-language rules', () => {
    const root = fixture(JSON.stringify({
        preferences: ['When I ask for a deep review, lead with longitudinal meta-analysis.']
    }));
    const result = validateOperatorPreferences(root);

    assert.equal(result.valid, true);
    assert.deepEqual(result.preferences, ['When I ask for a deep review, lead with longitudinal meta-analysis.']);
});

test('malformed preferences fail closed without returning partial entries', () => {
    for (const content of [
        '{',
        JSON.stringify({ preferences: ['Valid rule.', ''] }),
        JSON.stringify({ preferences: ['Valid rule.'], status: 'active' }),
        JSON.stringify(['Valid rule.'])
    ]) {
        const result = validateOperatorPreferences(fixture(content));
        assert.equal(result.valid, false);
        assert.deepEqual(result.preferences, []);
        assert.ok(result.errors.length > 0);
    }
});

test('sos audit returns failure for malformed operator preferences', () => {
    const root = fixture('{');
    const result = spawnSync(process.execPath, [AUDIT_SCRIPT], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Malformed operator-preference configuration/);
    assert.match(result.stdout, /Audit found 1 integrity failure/);
});

test('sos audit --json emits failures without wrapping the human report', () => {
    const root = fixture('{');
    const result = spawnSync(process.execPath, [AUDIT_SCRIPT, '--json'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.stdout, undefined);
    assert.equal(payload.failures.some(item => item.code === 'operator-preferences'), true);
    assert.doesNotMatch(result.stdout, /KNOWLEDGE GRAPH AUDIT REPORT/);
});

test('sos.mjs audit --json is a native payload', () => {
    const root = fixture('{');
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'audit', '--json'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.command, undefined);
    assert.equal(payload.elapsedMs, undefined);
    assert.equal(payload.failures[0].code, 'operator-preferences');
});
