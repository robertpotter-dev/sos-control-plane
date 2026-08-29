import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { allocateDuplicateArchivePath, archiveMatchesSource, findAssetBySourceSha256, sha256File } from '../lib/hash.mjs';
import { readJsonRecords, writeJsonl } from '../lib/jsonl.mjs';
import { mediaTitle, normalizeWhisperSegments } from '../lib/transcribe.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

test('sha256File is stable for identical bytes and distinct for different bytes', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-hash-'));
    const a = join(root, 'a.bin');
    const b = join(root, 'b.bin');
    const c = join(root, 'c.bin');
    writeFileSync(a, Buffer.from('same-bytes'));
    writeFileSync(b, Buffer.from('same-bytes'));
    writeFileSync(c, Buffer.from('other-bytes'));
    assert.equal(sha256File(a), sha256File(b));
    assert.notEqual(sha256File(a), sha256File(c));
    assert.match(sha256File(a), /^[a-f0-9]{64}$/);
});

test('findAssetBySourceSha256 reads the stored capture hash', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-hash-assets-'));
    mkdirSync(join(root, 'assets'));
    const hash = sha256File(process.argv[1]);
    writeFileSync(join(root, 'assets', 'pdf-note.md'), [
        '---',
        'id: "jrnl:pdf-note"',
        'title: "PDF: Capture"',
        'type: "pdf-capture"',
        `source_sha256: "${hash}"`,
        '---',
        '',
        '# PDF Capture',
        ''
    ].join('\n'));
    assert.equal(findAssetBySourceSha256(join(root, 'assets'), hash), join(root, 'assets', 'pdf-note.md'));
    assert.equal(findAssetBySourceSha256(join(root, 'assets'), hash, { type: 'pdf-capture' }), join(root, 'assets', 'pdf-note.md'));
    assert.equal(findAssetBySourceSha256(join(root, 'assets'), hash, { type: 'transcript' }), null);
    assert.equal(findAssetBySourceSha256(join(root, 'assets'), '0'.repeat(64)), null);
});

test('Whisper observations normalize to independently addressable JSONL records', () => {
    const hash = 'a'.repeat(64);
    const records = normalizeWhisperSegments({
        params: { model: '/models/ggml-base.en.bin', language: 'en' },
        transcription: [
            { timestamps: { from: '00:00:00,000', to: '00:00:01,250' }, offsets: { from: 0, to: 1250 }, text: ' First.' },
            { timestamps: { from: '00:00:01,250', to: '00:00:02,500' }, offsets: { from: 1250, to: 2500 }, text: ' Second.' }
        ]
    }, { sourceSha256: hash, sourceFile: 'memo.wav' });
    assert.equal(records.length, 2);
    assert.equal(records[0].record_id, 'whisper:aaaaaaaaaaaaaaaa:000001');
    assert.equal(records[1].index_line, 2);
    assert.equal(records[1].start_ms, 1250);

    const root = mkdtempSync(join(os.tmpdir(), 'sos-whisper-jsonl-'));
    const indexPath = join(root, 'transcript.segments.jsonl');
    writeJsonl(indexPath, records);
    assert.equal(readFileSync(indexPath, 'utf-8').trim().split('\n').length, 2);
    assert.deepEqual(readJsonRecords(indexPath), records);
});

test('mediaTitle removes capture separators without leaving presentation whitespace', () => {
    assert.equal(mediaTitle('The_Architecture_of_Context_Inversion_'), 'The Architecture Of Context Inversion');
});

function journalFixture() {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-hash-ingest-'));
    mkdirSync(join(root, 'journal', 'inbox'), { recursive: true });
    mkdirSync(join(root, 'journal', 'assets'), { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal Charter"',
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
        '# Journal',
        ''
    ].join('\n'));
    return root;
}

test('transcribe skips Whisper when an existing capture already has the source hash', () => {
    const root = journalFixture();
    const inboxFile = join(root, 'journal', 'inbox', 'memo.wav');
    writeFileSync(inboxFile, Buffer.from('not-really-audio-but-stable-bytes'));
    const hash = sha256File(inboxFile);
    writeFileSync(join(root, 'journal', 'assets', 'transcript-memo.md'), [
        '---',
        'id: "jrnl:transcript-memo"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Transcript: Memo"',
        'type: "transcript"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        `source_sha256: "${hash}"`,
        'tags: ["journal"]',
        '---',
        '',
        '# Transcript: Memo',
        ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'lib', 'transcribe.mjs'), inboxFile, '--domain', 'journal'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DEDUPLICATION SAFEGUARD/);
    assert.match(result.stdout, /Skipping redundant Whisper run/);
    assert.doesNotMatch(result.stdout, /whisper-cli|Downloading Whisper/);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.some(name => name.startsWith('memo-duplicate-') && name.endsWith('.wav')));
});

test('archiveMatchesSource uses size as a prefilter before hashing', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-hash-size-'));
    const source = join(root, 'source.bin');
    const same = join(root, 'same.bin');
    const resized = join(root, 'resized.bin');
    const different = join(root, 'different.bin');
    writeFileSync(source, Buffer.from('payload-bytes'));
    writeFileSync(same, Buffer.from('payload-bytes'));
    writeFileSync(resized, Buffer.from('payload-bytes!'));
    writeFileSync(different, Buffer.from('other-payload!'));
    const hash = sha256File(source);
    assert.equal(archiveMatchesSource(same, source, hash), true);
    assert.equal(archiveMatchesSource(resized, source, hash), false);
    assert.equal(archiveMatchesSource(different, source, hash), false);
});

test('allocateDuplicateArchivePath never overwrites an existing archive', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-hash-dup-'));
    writeFileSync(join(root, 'memo-duplicate-2.wav'), 'kept');
    const allocated = allocateDuplicateArchivePath(root, 'memo', '.wav');
    assert.equal(allocated, join(root, 'memo-duplicate-3.wav'));
});

test('transcribe skips Whisper when a legacy same-slug archive matches size then hash', () => {
    const root = journalFixture();
    mkdirSync(join(root, 'journal', 'inbox', 'archive'), { recursive: true });
    const bytes = Buffer.from('legacy-same-bytes');
    writeFileSync(join(root, 'journal', 'inbox', 'archive', 'memo.wav'), bytes);
    writeFileSync(join(root, 'journal', 'inbox', 'memo.wav'), bytes);
    writeFileSync(join(root, 'journal', 'assets', 'transcript-memo.md'), [
        '---',
        'id: "jrnl:transcript-memo"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Transcript: Memo"',
        'type: "transcript"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["journal"]',
        '---',
        '',
        '# Transcript: Memo',
        ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'lib', 'transcribe.mjs'), join(root, 'journal', 'inbox', 'memo.wav'), '--domain', 'journal'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DEDUPLICATION SAFEGUARD/);
    assert.doesNotMatch(result.stdout, /whisper-cli|Downloading Whisper/);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.includes('memo.wav'));
    assert.ok(archived.some(name => name.startsWith('memo-duplicate-') && name.endsWith('.wav')));
});

test('transcribe dry-run allocates a new slug when the same-name archive has a different size', () => {
    const root = journalFixture();
    mkdirSync(join(root, 'journal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'journal', 'inbox', 'archive', 'memo.wav'), Buffer.from('short'));
    writeFileSync(join(root, 'journal', 'inbox', 'memo.wav'), Buffer.from('a-much-longer-payload'));
    writeFileSync(join(root, 'journal', 'assets', 'transcript-memo.md'), [
        '---',
        'id: "jrnl:transcript-memo"',
        'type: "transcript"',
        'domain: "journal"',
        '---',
        '',
        '# Transcript: Memo',
        ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'lib', 'transcribe.mjs'), join(root, 'journal', 'inbox', 'memo.wav'), '--domain', 'journal', '--dry-run'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /COLLISION PREVENTION/);
    assert.match(result.stdout, /transcript-memo-2\.md/);
    assert.match(result.stdout, /journal\/assets\/transcript-memo-2\.segments\.jsonl/);
    assert.doesNotMatch(result.stdout, /inbox\/archive\/transcript-memo-2\.segments\.jsonl/);
    assert.doesNotMatch(result.stdout, /DEDUPLICATION SAFEGUARD/);
    assert.doesNotMatch(result.stdout, /whisper-cli|Downloading Whisper/);
});

test('video dry-run plans only a readable transcript and segment JSONL before raw archival', () => {
    const root = journalFixture();
    const video = join(root, 'journal', 'inbox', 'lecture.mp4');
    writeFileSync(video, Buffer.from('video-fixture'));
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'lib', 'transcribe.mjs'), video, '--domain', 'journal', '--dry-run'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /transcript-lecture\.md/);
    assert.match(result.stdout, /transcript-lecture\.segments\.jsonl/);
    assert.match(result.stdout, /inbox\/archive\/lecture\.mp4/);
    assert.doesNotMatch(result.stdout, /keyframe|\.jpg|vision/i);
});
