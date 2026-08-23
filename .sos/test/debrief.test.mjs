import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

import { isDebriefRecord, writeDebriefRecord } from '../lib/debrief.mjs';
import { sha256File } from '../lib/hash.mjs';

test('folder batches produce one deterministic record with every source pointer', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-debrief-'));
    const domainPath = join(root, 'journal');
    const inbox = join(domainPath, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const spaceFile = join(domainPath, 'SPACE.md');
    writeFileSync(spaceFile, '---\nid: "jrnl:charter"\n---\n', 'utf-8');

    const record = writeDebriefRecord({
        domain: { name: 'journal', path: domainPath, prefix: 'jrnl', exposure: 'private', spaceFile },
        label: '2026-08-16',
        scope: 'batch',
        dryRun: true,
        manifest: [
            { originalPath: 'journal/inbox/2026-08-16/morning.md', archivePath: join(inbox, 'archive', '2026-08-16', 'morning.md'), artifacts: [join(domainPath, 'assets', 'text-morning.md')] },
            { originalPath: 'journal/inbox/2026-08-16/evening.m4a', archivePath: join(inbox, 'archive', '2026-08-16', 'evening.m4a'), artifacts: [join(domainPath, 'assets', 'transcript-evening.md')] }
        ]
    });

    assert.match(record.filePath, /inbox\/debrief-2026-08-16\.md$/);
    assert.match(record.content, /type: "debrief-record"/);
  assert.match(record.content, /\*\*Scope:\*\* Folder batch/);
  assert.match(record.content, /morning\.md/);
  assert.match(record.content, /transcript-evening\.md/);
  assert.match(record.content, /Graph Weave \(Required Before Tier 1 Approval\)/);
  assert.match(record.content, /no new edge is warranted/);
});

test('only deterministic debrief control records are excluded from ingest', () => {
    assert.equal(isDebriefRecord('debrief-site-visit.md'), true);
    assert.equal(isDebriefRecord('handoff-site-visit.md'), false);
    assert.equal(isDebriefRecord('site-visit.md'), false);
});

test('dry-run treats an inbox folder as one deterministic batch', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-fixture-'));
    const inbox = join(root, 'journal', 'inbox', '2026-08-16');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(inbox, 'morning.md'), '# Morning\n', 'utf-8');
    writeFileSync(join(inbox, 'evening.txt'), 'Evening note\n', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--dry-run', 'journal/inbox/2026-08-16'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Processing 1 intake unit \/ 2 captures/);
    assert.match(result.stdout, /DRY Debrief record -> journal\/inbox\/debrief-2026-08-16\.md/);
    assert.equal(existsSync(inbox), true);
    assert.equal(existsSync(join(inbox, 'morning.md')), true);
});

test('ingest rmdirs an empty batch source folder after archiving its contents', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-rmdir-'));
    const batch = join(root, 'journal', 'inbox', 'site visit');
    mkdirSync(join(batch, 'notes'), { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(batch, 'evening.txt'), 'Evening note\n', 'utf-8');
    writeFileSync(join(batch, 'notes', 'morning.md'), '# Morning\n', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/site visit'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.units[0].kind, 'batch');
    assert.equal(existsSync(batch), false);
    assert.equal(existsSync(join(root, 'journal', 'inbox', 'archive', 'site-visit', 'evening.txt')), true);
    assert.equal(existsSync(join(root, 'journal', 'inbox', 'archive', 'site-visit', 'notes', 'morning.md')), true);
});

test('ingest rmdirs a batch source folder whose only remainder is Finder metadata', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-rmdir-dsstore-'));
    const batch = join(root, 'journal', 'inbox', 'site visit');
    mkdirSync(batch, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(batch, 'morning.md'), '# Morning\n', 'utf-8');
    writeFileSync(join(batch, '.DS_Store'), 'finder', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/site visit'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(batch), false);
    assert.equal(existsSync(join(root, 'journal', 'inbox', 'archive', 'site-visit', 'morning.md')), true);
});

test('ingest keeps a batch source folder when leftover captures remain', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-rmdir-keep-'));
    const batch = join(root, 'journal', 'inbox', 'site visit');
    mkdirSync(join(batch, 'notes'), { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(batch, 'broken.pdf'), 'not a pdf\n', 'utf-8');
    writeFileSync(join(batch, 'notes', 'morning.md'), '# Morning\n', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/site visit'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(existsSync(join(batch, 'broken.pdf')), true);
    assert.equal(existsSync(join(batch, 'notes')), false);
    assert.equal(existsSync(join(root, 'journal', 'inbox', 'archive', 'site-visit', 'notes', 'morning.md')), true);
});

test('dry-run PDF captures plan a Tier 2 verbatim asset', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-pdf-'));
    const inbox = join(root, 'journal', 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(inbox, 'whitepaper.pdf'), '%PDF-1.1 fixture\n', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--dry-run', '--json', 'journal/inbox/whitepaper.pdf'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.units[0].files, 1);
    assert.equal(payload.units[0].debrief, 'journal/inbox/debrief-whitepaper.md');
    assert.match(payload.units[0].sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(payload.units[0].archive, 'journal/inbox/archive/whitepaper.pdf');
    assert.deepEqual(payload.units[0].assets, ['journal/assets/pdf-whitepaper.md']);
});

test('ingest skips PDFKit when a hashed pdf-capture already exists', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-pdf-skip-'));
    const inbox = join(root, 'journal', 'inbox');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(join(root, 'journal', 'assets'), { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    const bytes = Buffer.from('%PDF-1.1 duplicate-fixture\n');
    writeFileSync(join(inbox, 'whitepaper.pdf'), bytes);
    const hash = sha256File(join(inbox, 'whitepaper.pdf'));
    writeFileSync(join(root, 'journal', 'assets', 'pdf-whitepaper.md'), [
        '---',
        'id: "jrnl:pdf-whitepaper"',
        'type: "pdf-capture"',
        `source_sha256: "${hash}"`,
        '---',
        '',
        '# PDF Capture: whitepaper',
        ''
    ].join('\n'));

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/whitepaper.pdf'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    const assets = readdirSync(join(root, 'journal', 'assets')).filter(name => name.startsWith('pdf-') && name.endsWith('.md'));
    assert.equal(assets.length, 1);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.some(name => name.startsWith('whitepaper-duplicate-') && name.endsWith('.pdf')));
});

test('ingest skips PDFKit for a legacy same-slug archive whose size then hash match', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-pdf-legacy-'));
    const inbox = join(root, 'journal', 'inbox');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(join(root, 'journal', 'assets'), { recursive: true });
    mkdirSync(join(root, 'journal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    const bytes = Buffer.from('%PDF-1.1 legacy-fixture\n');
    writeFileSync(join(root, 'journal', 'inbox', 'archive', 'whitepaper.pdf'), bytes);
    writeFileSync(join(inbox, 'whitepaper.pdf'), bytes);
    writeFileSync(join(root, 'journal', 'assets', 'pdf-whitepaper.md'), [
        '---',
        'id: "jrnl:pdf-whitepaper"',
        'type: "pdf-capture"',
        '---',
        '',
        '# PDF Capture: whitepaper',
        ''
    ].join('\n'));

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/whitepaper.pdf'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    const assets = readdirSync(join(root, 'journal', 'assets')).filter(name => name.startsWith('pdf-') && name.endsWith('.md'));
    assert.equal(assets.length, 1);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.includes('whitepaper.pdf'));
    assert.ok(archived.some(name => name.startsWith('whitepaper-duplicate-') && name.endsWith('.pdf')));
});

function minimalPdf(text) {
    const escaped = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\n`;
    const objects = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
        `4 0 obj << /Length ${Buffer.byteLength(stream, 'latin1')} >> stream\n${stream}endstream\nendobj\n`,
        '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
    ];
    let body = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(body, 'latin1'));
        body += object;
    }
    const xrefPos = Buffer.byteLength(body, 'latin1');
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (let index = 1; index <= 5; index++) {
        xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    }
    body += `${xref}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}

test('ingest extracts PDF text into a hashed Tier 2 capture and skips a duplicate', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-pdf-live-'));
    const inbox = join(root, 'journal', 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal Charter"',
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
    const pdfPath = join(inbox, 'whitepaper.pdf');
    writeFileSync(pdfPath, minimalPdf('Hello SOS'));

    const first = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/whitepaper.pdf'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.ok, true);
    const assets = readdirSync(join(root, 'journal', 'assets')).filter(name => name.startsWith('pdf-') && name.endsWith('.md'));
    assert.equal(assets.length, 1);
    const capture = readFileSync(join(root, 'journal', 'assets', assets[0]), 'utf-8');
    assert.match(capture, /Hello SOS/);
    assert.match(capture, /^source_sha256: "[a-f0-9]{64}"/m);
    assert.match(capture, /type: "pdf-capture"/);

    writeFileSync(join(inbox, 'whitepaper.pdf'), minimalPdf('Hello SOS'));
    const second = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/whitepaper.pdf'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.ok, true);
    const assetsAfter = readdirSync(join(root, 'journal', 'assets')).filter(name => name.startsWith('pdf-') && name.endsWith('.md'));
    assert.equal(assetsAfter.length, 1);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.some(name => name.startsWith('whitepaper-duplicate-') && name.endsWith('.pdf')));
});

test('ingest --json --dry-run emits units without banners', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-json-'));
    const inbox = join(root, 'journal', 'inbox', '2026-08-16');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(inbox, 'morning.md'), '# Morning\n', 'utf-8');
    writeFileSync(join(inbox, 'evening.txt'), 'Evening note\n', 'utf-8');

    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--dry-run', '--json', 'journal/inbox/2026-08-16'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.units.length, 1);
    assert.equal(payload.units[0].kind, 'batch');
    assert.equal(payload.units[0].files, 2);
    assert.equal(payload.units[0].debrief, 'journal/inbox/debrief-2026-08-16.md');
    assert.equal(payload.units[0].error, null);
    assert.doesNotMatch(result.stdout, /SENSOR INGESTION PIPELINE/);
});

test('sos ingest --json is a native payload, not a wrapped stdout report', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-sos-json-'));
    const inbox = join(root, 'journal', 'inbox', '2026-08-16');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(root, 'journal', 'SPACE.md'), '---\nid: "jrnl:charter"\nexposure: "private"\n---\n', 'utf-8');
    writeFileSync(join(inbox, 'morning.md'), '# Morning\n', 'utf-8');

    const sourceRoot = join(import.meta.dirname, '..', '..');
    const result = spawnSync(process.execPath, [join(sourceRoot, '.sos', 'sos.mjs'), 'ingest', 'journal/inbox/2026-08-16', '--dry-run', '--json'], {
        cwd: sourceRoot,
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.units[0].files, 1);
    assert.equal(payload.command, undefined);
    assert.equal(payload.stdout, undefined);
});

test('init creates portable identity configuration only when explicitly requested', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-init-fixture-'));
    const sourceLib = join(import.meta.dirname, '..', 'lib');
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
    for (const name of ['domains.mjs', 'frontmatter.mjs', 'relations.mjs', 'root.mjs', 'yaml.mjs']) {
        copyFileSync(join(sourceLib, name), join(root, '.sos', 'lib', name));
    }
    mkdirSync(join(root, '.sos', 'vendor'), { recursive: true });
    cpSync(join(sourceLib, '..', 'vendor', 'yaml'), join(root, '.sos', 'vendor', 'yaml'), { recursive: true });

    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'sos.mjs'), 'init', '--name', 'Fixture System', '--domain', 'journal:private'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'sos.config.json')), false);
    assert.equal(JSON.parse(readFileSync(join(root, '.sos', 'config.json'), 'utf-8')).systemName, 'Fixture System');
    assert.equal(existsSync(join(root, 'journal', 'SPACE.md')), true);
    assert.match(readFileSync(join(root, 'journal', 'SPACE.md'), 'utf-8'), /Charter it in debrief before minting notes/);

    const addDomain = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'sos.mjs'), 'init', '--domain', 'research:public'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(addDomain.status, 0, addDomain.stderr);
    assert.equal(existsSync(join(root, 'research', 'SPACE.md')), true);
    assert.equal(JSON.parse(readFileSync(join(root, '.sos', 'config.json'), 'utf-8')).systemName, 'Fixture System');

    const rename = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'sos.mjs'), 'init', '--name', 'Renamed'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.notEqual(rename.status, 0);
    assert.match(rename.stderr, /will not rename/);
});

test('init --name persists onto an existing unzip config that has no systemName', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-init-zip-config-'));
    const sourceLib = join(import.meta.dirname, '..', 'lib');
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
    writeFileSync(join(root, '.sos', 'config.json'), '{"version":1,"vaults":[],"mirrors":[]}\n', 'utf-8');
    for (const name of ['domains.mjs', 'frontmatter.mjs', 'relations.mjs', 'root.mjs', 'yaml.mjs']) {
        copyFileSync(join(sourceLib, name), join(root, '.sos', 'lib', name));
    }
    mkdirSync(join(root, '.sos', 'vendor'), { recursive: true });
    cpSync(join(sourceLib, '..', 'vendor', 'yaml'), join(root, '.sos', 'vendor', 'yaml'), { recursive: true });

    const result = spawnSync(process.execPath, [
        join(import.meta.dirname, '..', 'sos.mjs'),
        'init',
        '--name', 'Robert Potter Me',
        '--vault', '/tmp/Obsidian',
        '--mirror', '/tmp/AI',
        '--domain', 'personal:private'
    ], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(root, '.sos', 'config.json'), 'utf-8'));
    assert.equal(config.systemName, 'Robert Potter Me');
    assert.deepEqual(config.vaults, ['/tmp/Obsidian']);
    assert.deepEqual(config.mirrors, ['/tmp/AI']);
    assert.match(result.stdout, /Labeled Robert Potter Me/);
    assert.match(result.stdout, /Configured vault \/tmp\/Obsidian and mirror \/tmp\/AI/);
});

test('init --name writes vaults and mirrors arrays from --vault and --mirror', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-init-sync-'));
    const sourceLib = join(import.meta.dirname, '..', 'lib');
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
    for (const name of ['domains.mjs', 'frontmatter.mjs', 'relations.mjs', 'root.mjs', 'yaml.mjs']) {
        copyFileSync(join(sourceLib, name), join(root, '.sos', 'lib', name));
    }
    mkdirSync(join(root, '.sos', 'vendor'), { recursive: true });
    cpSync(join(sourceLib, '..', 'vendor', 'yaml'), join(root, '.sos', 'vendor', 'yaml'), { recursive: true });

    const result = spawnSync(process.execPath, [
        join(import.meta.dirname, '..', 'sos.mjs'),
        'init',
        '--name', 'Fixture System',
        '--vault', '~/Vaults',
        '--mirror', '~/Backup',
        '--domain', 'journal:private'
    ], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(root, '.sos', 'config.json'), 'utf-8'));
    assert.deepEqual(config.vaults, ['~/Vaults']);
    assert.deepEqual(config.mirrors, ['~/Backup']);
    assert.equal(config.mirrorTarget, undefined);
    assert.match(result.stdout, /Labeled Fixture System/);
    assert.doesNotMatch(result.stdout, /sos config set/);
});

test('init mints domains without a dashboard label and relocates a legacy root config', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-init-domain-'));
    const sourceLib = join(import.meta.dirname, '..', 'lib');
    mkdirSync(join(root, '.sos', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
    for (const name of ['domains.mjs', 'frontmatter.mjs', 'relations.mjs', 'root.mjs', 'yaml.mjs']) {
        copyFileSync(join(sourceLib, name), join(root, '.sos', 'lib', name));
    }
    mkdirSync(join(root, '.sos', 'vendor'), { recursive: true });
    cpSync(join(sourceLib, '..', 'vendor', 'yaml'), join(root, '.sos', 'vendor', 'yaml'), { recursive: true });

    const unlabeled = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'sos.mjs'), 'init', '--domain', 'private:private'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(unlabeled.status, 0, unlabeled.stderr);
    assert.equal(existsSync(join(root, 'private', 'SPACE.md')), true);
    assert.equal(existsSync(join(root, 'sos.config.json')), false);
    assert.equal(existsSync(join(root, '.sos', 'config.json')), false);

    writeFileSync(join(root, 'sos.config.json'), `${JSON.stringify({ version: 1, systemName: 'Legacy Label', created: '2026-08-18' }, null, 2)}\n`, 'utf-8');
    const relocate = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'sos.mjs'), 'init', '--domain', 'restricted:restricted'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(relocate.status, 0, relocate.stderr);
    assert.equal(existsSync(join(root, 'sos.config.json')), false);
    assert.equal(JSON.parse(readFileSync(join(root, '.sos', 'config.json'), 'utf-8')).systemName, 'Legacy Label');
    assert.equal(existsSync(join(root, 'restricted', 'SPACE.md')), true);
});
