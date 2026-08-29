import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

import {
    filenameFromTitle,
    validateFetchUrl,
    allocateInboxTarget,
    fetchDownloadOptions
} from '../lib/fetch.mjs';

test('filenameFromTitle presents title and uploader as one inbox name', () => {
    assert.equal(
        filenameFromTitle("One of the best arguments against Flock you'll watch", 'More Perfect Union'),
        "One of the best arguments against Flock you'll watch — More Perfect Union"
    );
    assert.equal(filenameFromTitle('Lecture: Part 1/2', 'Channel'), 'Lecture- Part 1-2 — Channel');
    assert.equal(filenameFromTitle('Same Name', 'Same Name'), 'Same Name');
});

test('validateFetchUrl accepts http and https only', () => {
    assert.equal(validateFetchUrl('https://www.youtube.com/watch?v=abc').hostname, 'www.youtube.com');
    assert.throws(() => validateFetchUrl('ftp://example.com/video.mp4'), /http or https/);
    assert.throws(() => validateFetchUrl('not-a-url'), /Invalid URL/);
});

test('allocateInboxTarget avoids filename collisions', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-fetch-'));
    const domain = { path: join(root, 'projects') };
    const first = allocateInboxTarget(domain, 'Lecture Notes', '.mp4');
    writeFileSync(first.target, 'fixture', 'utf-8');
    const second = allocateInboxTarget(domain, 'Lecture Notes', '.mp4');
    assert.equal(first.filename, 'Lecture Notes.mp4');
    assert.equal(second.filename, 'Lecture Notes 2.mp4');
});

test('fetch --json reports missing URL as a compact error payload', () => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'lib', 'fetch.mjs'), '--json'], {
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Expected one URL/);
    assert.equal(payload.stdout, undefined);
});

test('sos fetch --json is no longer a wrapper refusal', () => {
    const sourceRoot = join(import.meta.dirname, '..', '..');
    const result = spawnSync(process.execPath, [join(sourceRoot, '.sos', 'sos.mjs'), 'fetch', '--json'], {
        cwd: sourceRoot,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.doesNotMatch(result.stdout, /not supported for fetch/);
    assert.equal(payload.command, undefined);
});

test('fetch --json download discards progress instead of buffering it', () => {
    const human = fetchDownloadOptions(false);
    const machine = fetchDownloadOptions(true);
    assert.equal(human.stdio, 'inherit');
    assert.deepEqual(human.extraArgs, []);
    assert.deepEqual(machine.stdio, ['ignore', 'ignore', 'pipe']);
    assert.deepEqual(machine.extraArgs, ['--no-progress', '--quiet']);
});
