import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

import { sha256File } from '../lib/hash.mjs';
import { classifyInboxFile, collectInboxBatchFiles } from '../lib/inbox-scan.mjs';
import { markdownTable, parseCsv, parseXlsx, renderSpreadsheetMarkdown } from '../lib/spreadsheet.mjs';

function zipPack(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf-8');
        const compressed = deflateRawSync(data);
        const nameBuf = Buffer.from(name, 'utf-8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const localFull = Buffer.concat([local, nameBuf, compressed]);
        locals.push(localFull);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, nameBuf]));
        offset += localFull.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

function sheetXml(cells) {
    const rows = cells.map((row, rowIndex) => {
        const r = rowIndex + 1;
        const body = row.map((value, colIndex) => {
            const col = String.fromCharCode(65 + colIndex);
            return `<c r="${col}${r}" t="inlineStr"><is><t>${value}</t></is></c>`;
        }).join('');
        return `<row r="${r}">${body}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

function twoSheetWorkbook() {
    return zipPack({
        'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Tickets" sheetId="1" r:id="rId1"/>
    <sheet name="Agents" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
        'xl/worksheets/sheet1.xml': sheetXml([['id', 'status'], ['1842', 'open'], ['1843', 'closed']]),
        'xl/worksheets/sheet2.xml': sheetXml([['name', 'tickets'], ['Ada', '12']])
    });
}

function journalRoot() {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-ingest-sheet-'));
    mkdirSync(join(root, 'journal', 'inbox'), { recursive: true });
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
    return root;
}

test('classifyInboxFile treats csv and xlsx as spreadsheet captures', () => {
    assert.equal(classifyInboxFile('tickets.csv'), 'spreadsheet');
    assert.equal(classifyInboxFile('tickets.XLSX'), 'spreadsheet');
});

test('collectInboxBatchFiles accepts csv without treating it as unsupported', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-sheet-batch-'));
    const batch = join(root, 'export');
    mkdirSync(batch, { recursive: true });
    writeFileSync(join(batch, 'tickets.csv'), 'id,status\n1,open\n', 'utf-8');
    const files = collectInboxBatchFiles(batch, batch, { strict: true });
    assert.equal(files[0].type, 'spreadsheet');
});

test('parseCsv keeps quoted commas and the full grid', () => {
    const rows = parseCsv('id,summary\n"1","reboot, AP"\n2,plain\n');
    assert.deepEqual(rows, [
        ['id', 'summary'],
        ['1', 'reboot, AP'],
        ['2', 'plain']
    ]);
});

test('markdown tables escape pipes without dropping rows', () => {
    const table = markdownTable([['a|b', 'c'], ['1', '2']]);
    assert.match(table, /a\\\|b/);
    assert.equal(table.split('\n').length, 3);
});

test('parseXlsx extracts every sheet into one workbook structure', () => {
    const sheets = parseXlsx(twoSheetWorkbook());
    assert.equal(sheets.length, 2);
    assert.equal(sheets[0].name, 'Tickets');
    assert.deepEqual(sheets[1].rows, [['name', 'tickets'], ['Ada', '12']]);
    const markdown = renderSpreadsheetMarkdown(sheets);
    assert.match(markdown, /## Sheet: Tickets \(3 rows, 2 columns\)/);
    assert.match(markdown, /## Sheet: Agents \(2 rows, 2 columns\)/);
    assert.match(markdown, /\| 1843 \| closed \|/);
});

test('ingest archives a csv original and writes a full spreadsheet capture', () => {
    const root = journalRoot();
    writeFileSync(join(root, 'journal', 'inbox', 'tickets.csv'), 'id,status\n1842,open\n1843,closed\n', 'utf-8');
    const result = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/tickets.csv'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.units[0].archive, 'journal/inbox/archive/tickets.csv');
    assert.deepEqual(payload.units[0].assets, ['journal/assets/spreadsheet-tickets.md']);
    assert.equal(payload.units[0].debrief, 'journal/inbox/debrief-tickets.md');
    const capture = readFileSync(join(root, 'journal', 'assets', 'spreadsheet-tickets.md'), 'utf-8');
    assert.match(capture, /type: "spreadsheet-capture"/);
    assert.match(capture, /## CSV \(3 rows, 2 columns\)/);
    assert.match(capture, /\| 1843 \| closed \|/);
    assert.match(capture, /\[tickets\.csv\]\(\.\.\/inbox\/archive\/tickets\.csv\)/);
    assert.equal(readdirSync(join(root, 'journal', 'inbox')).includes('tickets.csv'), false);
});

test('ingest extracts every xlsx sheet into one markdown asset and skips a hashed duplicate', () => {
    const root = journalRoot();
    const xlsx = twoSheetWorkbook();
    writeFileSync(join(root, 'journal', 'inbox', 'IT-tickets.xlsx'), xlsx);
    const first = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/IT-tickets.xlsx'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.ok, true);
    const capture = readFileSync(join(root, 'journal', 'assets', 'spreadsheet-it-tickets.md'), 'utf-8');
    assert.match(capture, /## Sheet: Tickets/);
    assert.match(capture, /## Sheet: Agents/);
    assert.match(capture, /^source_sha256: "[a-f0-9]{64}"/m);
    assert.equal(readdirSync(join(root, 'journal', 'inbox', 'archive')).includes('IT-tickets.xlsx'), true);

    writeFileSync(join(root, 'journal', 'inbox', 'IT-tickets.xlsx'), xlsx);
    const second = spawnSync(process.execPath, ['.sos/lib/ingest.mjs', '--json', 'journal/inbox/IT-tickets.xlsx'], {
        cwd: join(import.meta.dirname, '..', '..'),
        env: { ...process.env, SOS_ROOT: root, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const assets = readdirSync(join(root, 'journal', 'assets')).filter(name => name.startsWith('spreadsheet-') && name.endsWith('.md'));
    assert.equal(assets.length, 1);
    const archived = readdirSync(join(root, 'journal', 'inbox', 'archive'));
    assert.ok(archived.some(name => name.startsWith('IT-tickets-duplicate-') && name.endsWith('.xlsx')));
    assert.equal(sha256File(join(root, 'journal', 'inbox', 'archive', 'IT-tickets.xlsx')), firstPayload.units[0].sourceSha256);
});
