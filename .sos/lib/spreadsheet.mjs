import { inflateRawSync } from 'zlib';
import { readFileSync } from 'fs';
import { extname } from 'path';

function xmlDecode(text) {
    return String(text)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function tagAttr(openTag, name) {
    const match = openTag.match(new RegExp(`(?:^|[\\s:])${name}="([^"]*)"`))
        || openTag.match(new RegExp(`(?:^|[\\s:])${name}='([^']*)'`));
    return match ? xmlDecode(match[1]) : null;
}

function collectText(xml) {
    const chunks = [];
    const pattern = /<(?:[\w-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?t>/g;
    let match;
    while ((match = pattern.exec(xml))) chunks.push(xmlDecode(match[1]));
    return chunks.join('');
}

export function parseCsv(text) {
    const source = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
            if (char === '"') {
                if (source[index + 1] === '"') {
                    cell += '"';
                    index++;
                } else {
                    quoted = false;
                }
            } else {
                cell += char;
            }
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === ',') {
            row.push(cell);
            cell = '';
            continue;
        }
        if (char === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            continue;
        }
        if (char === '\r') continue;
        cell += char;
    }
    if (quoted) throw new Error('Unterminated quoted CSV field');
    if (cell.length || row.length) {
        row.push(cell);
        rows.push(row);
    }
    while (rows.length && rows.at(-1).every(value => value === '')) rows.pop();
    return rows;
}

function parseRef(ref) {
    const match = String(ref).toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    let column = 0;
    for (const char of match[1]) column = column * 26 + (char.charCodeAt(0) - 64);
    return { column, row: Number(match[2]) };
}

function readZip(buffer) {
    let eocd = -1;
    const start = Math.max(0, buffer.length - 22 - 65535);
    for (let index = buffer.length - 22; index >= start; index--) {
        if (buffer.readUInt32LE(index) === 0x06054b50) {
            eocd = index;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (missing Excel workbook container)');
    const count = buffer.readUInt16LE(eocd + 10);
    const cdSize = buffer.readUInt32LE(eocd + 12);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new Error('ZIP64 Excel workbooks are not supported');
    }
    const entries = new Map();
    let pos = cdOffset;
    const end = cdOffset + cdSize;
    while (pos < end && buffer.readUInt32LE(pos) === 0x02014b50) {
        const method = buffer.readUInt16LE(pos + 10);
        const compSize = buffer.readUInt32LE(pos + 20);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
        pos += 46 + nameLen + extraLen + commentLen;
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const compressed = buffer.subarray(dataStart, dataStart + compSize);
        let data;
        if (method === 0) data = compressed;
        else if (method === 8) data = inflateRawSync(compressed);
        else throw new Error('Unsupported ZIP compression in workbook: ' + method);
        entries.set(name.replace(/\\/g, '/'), data);
    }
    return entries;
}

function zipText(entries, path) {
    const data = entries.get(path) || entries.get(path.replace(/^\//, ''));
    return data ? data.toString('utf8') : null;
}

function parseSharedStrings(xml) {
    if (!xml) return [];
    const strings = [];
    const pattern = /<(?:[\w-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?si>/g;
    let match;
    while ((match = pattern.exec(xml))) strings.push(collectText(match[1]));
    return strings;
}

function parseRelationships(xml) {
    const map = new Map();
    if (!xml) return map;
    const pattern = /<(?:[\w-]+:)?Relationship\b([^>]*?)(?:\/>|>)/g;
    let match;
    while ((match = pattern.exec(xml))) {
        const id = tagAttr(match[1], 'Id');
        const target = tagAttr(match[1], 'Target');
        if (id && target) map.set(id, target.replace(/\\/g, '/'));
    }
    return map;
}

function cellValue(inner, type, sharedStrings) {
    if (type === 'inlineStr') return collectText(inner);
    const valueMatch = inner.match(/<(?:[\w-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?v>/);
    const raw = valueMatch ? xmlDecode(valueMatch[1]) : '';
    if (type === 's') return sharedStrings[Number(raw)] ?? '';
    if (type === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    return raw;
}

function parseSheetRows(xml, sharedStrings) {
    const cells = new Map();
    let maxRow = 0;
    let maxCol = 0;
    const pattern = /<(?:[\w-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?c>)/g;
    let match;
    while ((match = pattern.exec(xml))) {
        const ref = parseRef(tagAttr(match[1], 'r') || '');
        if (!ref) continue;
        const value = cellValue(match[2] || '', tagAttr(match[1], 't'), sharedStrings);
        cells.set(`${ref.row}:${ref.column}`, value);
        if (ref.row > maxRow) maxRow = ref.row;
        if (ref.column > maxCol) maxCol = ref.column;
    }
    const rows = [];
    for (let row = 1; row <= maxRow; row++) {
        const line = [];
        for (let column = 1; column <= maxCol; column++) line.push(cells.get(`${row}:${column}`) ?? '');
        rows.push(line);
    }
    while (rows.length && rows.at(-1).every(value => value === '')) rows.pop();
    if (!rows.length) return [];
    const width = Math.max(...rows.map(row => {
        let last = row.length;
        while (last > 0 && row[last - 1] === '') last--;
        return last;
    }), 0);
    return rows.map(row => row.slice(0, width));
}

function resolveSheetPath(target) {
    const normalized = target.replace(/^\.\//, '');
    if (normalized.startsWith('/')) return normalized.slice(1);
    if (normalized.startsWith('xl/')) return normalized;
    return 'xl/' + normalized.replace(/^\/+/, '');
}

export function parseXlsx(buffer) {
    const entries = readZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    const workbook = zipText(entries, 'xl/workbook.xml');
    if (!workbook) throw new Error('Workbook is missing xl/workbook.xml');
    const rels = parseRelationships(zipText(entries, 'xl/_rels/workbook.xml.rels'));
    const sharedStrings = parseSharedStrings(zipText(entries, 'xl/sharedStrings.xml'));
    const sheets = [];
    const sheetPattern = /<(?:[\w-]+:)?sheet\b([^>]*?)(?:\/>|>)/g;
    let match;
    while ((match = sheetPattern.exec(workbook))) {
        const name = tagAttr(match[1], 'name') || `Sheet${sheets.length + 1}`;
        const id = tagAttr(match[1], 'id') || tagAttr(match[1], 'r:id');
        const target = id ? rels.get(id) : null;
        if (!target || !/worksheet/i.test(target)) continue;
        const path = resolveSheetPath(target);
        const xml = zipText(entries, path);
        if (xml == null) throw new Error('Missing worksheet part: ' + path);
        sheets.push({ name, rows: parseSheetRows(xml, sharedStrings) });
    }
    if (!sheets.length) throw new Error('Workbook contains no worksheets');
    return sheets;
}

function escapeCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function markdownTable(rows) {
    if (!rows.length) return '_Empty sheet._';
    const width = Math.max(...rows.map(row => row.length), 1);
    const padded = rows.map(row => {
        const copy = row.slice();
        while (copy.length < width) copy.push('');
        return copy.map(escapeCell);
    });
    const header = padded[0];
    const body = padded.slice(1);
    const line = cells => '| ' + cells.join(' | ') + ' |';
    return [line(header), '| ' + header.map(() => '---').join(' | ') + ' |', ...body.map(line)].join('\n');
}

export function renderSpreadsheetMarkdown(sheets) {
    return sheets.map(sheet => {
        const width = sheet.rows.length ? Math.max(...sheet.rows.map(row => row.length), 0) : 0;
        const heading = sheets.length === 1 && sheet.name === 'CSV'
            ? `## CSV (${sheet.rows.length} rows, ${width} columns)`
            : `## Sheet: ${sheet.name} (${sheet.rows.length} rows, ${width} columns)`;
        return `${heading}\n\n${markdownTable(sheet.rows)}\n`;
    }).join('\n');
}

export function extractSpreadsheet(path) {
    const extension = extname(path).toLowerCase();
    if (extension === '.csv') {
        return [{ name: 'CSV', rows: parseCsv(readFileSync(path, 'utf-8')) }];
    }
    if (extension === '.xlsx') {
        return parseXlsx(readFileSync(path));
    }
    throw new Error('Unsupported spreadsheet type: ' + extension);
}
