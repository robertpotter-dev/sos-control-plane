import { readFileSync } from 'fs';

function readU16(buf, offset, le) {
    return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function readU32(buf, offset, le) {
    return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function readValue(buf, offset, type, count, le, tiffStart) {
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type];
    if (!size) return null;
    const byteLength = size * count;
    const dataOffset = byteLength <= 4 ? offset : tiffStart + readU32(buf, offset, le);
    if (dataOffset < 0 || dataOffset + byteLength > buf.length) return null;
    if (type === 2) {
        return buf.toString('utf-8', dataOffset, dataOffset + count).replace(/\0+$/, '').trim();
    }
    if (type === 3) return readU16(buf, dataOffset, le);
    if (type === 4) return readU32(buf, dataOffset, le);
    if (type === 5) {
        const values = [];
        for (let index = 0; index < count; index++) {
            const num = readU32(buf, dataOffset + index * 8, le);
            const den = readU32(buf, dataOffset + index * 8 + 4, le) || 1;
            values.push(num / den);
        }
        return count === 1 ? values[0] : values;
    }
    return null;
}

function readIfd(buf, tiffStart, ifdOffset, le) {
    const start = tiffStart + ifdOffset;
    if (start + 2 > buf.length) return {};
    const count = readU16(buf, start, le);
    const tags = {};
    for (let index = 0; index < count; index++) {
        const entry = start + 2 + index * 12;
        if (entry + 12 > buf.length) break;
        const tag = readU16(buf, entry, le);
        const type = readU16(buf, entry + 2, le);
        const valueCount = readU32(buf, entry + 4, le);
        tags[tag] = readValue(buf, entry + 8, type, valueCount, le, tiffStart);
    }
    return tags;
}

function gpsToDecimal(values, ref) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const sign = ref === 'S' || ref === 'W' ? -1 : 1;
    return sign * (values[0] + values[1] / 60 + values[2] / 3600);
}

export function readJpegExif(path) {
    const buf = readFileSync(path);
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let offset = 2;
    while (offset + 4 < buf.length) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        const size = buf.readUInt16BE(offset + 2);
        if (marker === 0xE1 && buf.toString('ascii', offset + 4, offset + 8) === 'Exif') {
            const tiffStart = offset + 10;
            const le = buf.toString('ascii', tiffStart, tiffStart + 2) === 'II';
            const ifd0 = readU32(buf, tiffStart + 4, le);
            const ifd0Tags = readIfd(buf, tiffStart, ifd0, le);
            const exifOffset = ifd0Tags[0x8769];
            const gpsOffset = ifd0Tags[0x8825];
            const exifTags = typeof exifOffset === 'number' ? readIfd(buf, tiffStart, exifOffset, le) : {};
            const gpsTags = typeof gpsOffset === 'number' ? readIfd(buf, tiffStart, gpsOffset, le) : {};
            const latitude = gpsToDecimal(gpsTags[0x0002], gpsTags[0x0001]);
            const longitude = gpsToDecimal(gpsTags[0x0004], gpsTags[0x0003]);
            const parsed = {
                make: ifd0Tags[0x010F] || null,
                model: ifd0Tags[0x0110] || null,
                dateTimeOriginal: exifTags[0x9003] || ifd0Tags[0x0132] || null,
                latitude,
                longitude
            };
            if (parsed.make || parsed.model || parsed.dateTimeOriginal || parsed.latitude != null) return parsed;
            return null;
        }
        offset += 2 + size;
    }
    return null;
}
