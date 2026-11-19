"use strict";

const MAX_TAG_SIZE = 16 * 1024 * 1024;

function readSize(bytes, offset, length, syncSafe = false) {
  if (offset + length > bytes.length) return -1;
  let size = 0;
  for (const value of bytes.subarray(offset, offset + length)) {
    if (syncSafe && value >= 128) return -1;
    size = size * (syncSafe ? 128 : 256) + value;
  }
  return size;
}

function undoUnsynchronization(bytes) {
  const result = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    result[length++] = bytes[index];
    if (bytes[index] === 255 && bytes[index + 1] === 0) ++index;
  }
  return result.subarray(0, length);
}

function imageType(bytes) {
  const signature = (offset, values) => values.every((value, index) => bytes[offset + index] === value);
  if (signature(0, [255, 216, 255])) return "image/jpeg";
  if (signature(0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (signature(0, [71, 73, 70, 56])) return "image/gif";
  if (signature(0, [82, 73, 70, 70]) && signature(8, [87, 69, 66, 80])) return "image/webp";
  return null;
}

function readPicture(frame, version) {
  const encoding = frame[0];
  if (encoding === undefined || encoding > 3) return null;
  // ID3v2.2 uses a fixed three-byte image format, later versions use a MIME string.
  const formatEnd = version === 2 ? 3 : frame.indexOf(0, 1);
  if (formatEnd < 1) return null;
  const type = frame[formatEnd + 1];
  const unit = encoding === 1 || encoding === 2 ? 2 : 1;
  for (let index = formatEnd + 2; index + unit <= frame.length; index += unit) {
    if (frame[index] !== 0 || (unit === 2 && frame[index + 1] !== 0)) continue;
    const image = frame.subarray(index + unit);
    const mime = imageType(image);
    return mime ? { type, image: new Blob([image], { type: mime }) } : null;
  }
  return null;
}

async function readArtwork(file) {
  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (header[0] !== 73 || header[1] !== 68 || header[2] !== 51) return null;
  const version = header[3];
  const tagFlags = header[5];
  if (version < 2 || version > 4 || (version === 2 && tagFlags & 0x40)) return null;
  const tagSize = readSize(header, 6, 4, true);
  if (tagSize <= 0 || tagSize > MAX_TAG_SIZE || tagSize + 10 > file.size) return null;
  let tag = new Uint8Array(await file.slice(10, 10 + tagSize).arrayBuffer());
  if (version < 4 && tagFlags & 0x80) tag = undoUnsynchronization(tag);

  let offset = 0;
  if (version >= 3 && tagFlags & 0x40) {
    const extendedSize = readSize(tag, 0, 4, version === 4);
    if (extendedSize < 6) return null;
    offset = version === 3 ? 4 + extendedSize : extendedSize;
  }
  const idLength = version === 2 ? 3 : 4;
  const headerSize = version === 2 ? 6 : 10;
  const pictureId = version === 2 ? "PIC" : "APIC";
  let fallback = null;
  while (offset + headerSize <= tag.length && tag[offset] !== 0) {
    const id = String.fromCharCode(...tag.subarray(offset, offset + idLength));
    const size = readSize(tag, offset + idLength, idLength, version === 4);
    const frameFlags = version === 2 ? 0 : tag[offset + 9];
    const bodyStart = offset + headerSize;
    offset = bodyStart + size;
    if (size <= 0 || offset > tag.length) break;
    if (id !== pictureId) continue;
    // Compressed or encrypted attachments cannot be displayed directly.
    if (frameFlags & (version === 3 ? 0xc0 : 0x0c)) continue;
    let frame = tag.subarray(bodyStart, offset);
    if (version === 4) {
      if (frameFlags & 0x02 || tagFlags & 0x80) frame = undoUnsynchronization(frame);
      if (frameFlags & 0x40) frame = frame.subarray(1);
      if (frameFlags & 0x01) frame = frame.subarray(4);
    } else if (version === 3 && frameFlags & 0x20) {
      frame = frame.subarray(1);
    }
    const picture = readPicture(frame, version);
    if (picture?.type === 3) return picture.image;
    if (!fallback && picture) fallback = picture.image;
  }
  return fallback;
}
