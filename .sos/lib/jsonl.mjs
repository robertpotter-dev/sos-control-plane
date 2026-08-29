import { closeSync, openSync, readSync, readFileSync, writeFileSync } from 'fs';

export function forEachJsonlRecord(path, onRecord) {
    const fd = openSync(path, 'r');
    const decoder = new TextDecoder('utf-8');
    const buffer = Buffer.alloc(64 * 1024);
    let leftover = '';
    let index = 0;

    const consumeLine = line => {
        if (!line.trim()) return;
        index += 1;
        let record;
        try {
            record = JSON.parse(line);
        } catch (error) {
            throw new Error(`Invalid JSONL record ${index} in ${path}: ${error.message}`);
        }
        onRecord(record, index);
    };

    try {
        let bytes;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            leftover += decoder.decode(buffer.subarray(0, bytes), { stream: true });
            leftover = leftover.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            let newline;
            while ((newline = leftover.indexOf('\n')) >= 0) {
                consumeLine(leftover.slice(0, newline));
                leftover = leftover.slice(newline + 1);
            }
        }
        leftover += decoder.decode();
        leftover = leftover.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (leftover.length) consumeLine(leftover);
    } finally {
        closeSync(fd);
    }
    return index;
}

export function readJsonRecords(path) {
    const fd = openSync(path, 'r');
    let head = '';
    try {
        const buffer = Buffer.alloc(256);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        head = buffer.toString('utf-8', 0, bytes).trimStart();
    } finally {
        closeSync(fd);
    }
    if (!head) return [];
    if (head.startsWith('[')) {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in ${path}`);
        return parsed;
    }
    const records = [];
    forEachJsonlRecord(path, record => {
        records.push(record);
    });
    return records;
}

export function writeJsonl(path, records) {
    const lines = (records || []).map(record => JSON.stringify(record));
    writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '', 'utf-8');
}
