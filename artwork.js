"use strict";

async function readVideoThumbnail(blob) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(blob);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    const frame = await new Promise((resolve) => {
      let settled = false;
      let sampleTime = 0;
      function finish(capture) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!capture || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
          resolve(null);
          return;
        }
        const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        } catch {
          resolve(null);
        }
      }
      const timer = setTimeout(() => finish(!video.seeking), 5000);
      video.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(video.duration) && video.duration > 0.25) {
          sampleTime = Math.min(2, video.duration / 5);
          try { video.currentTime = sampleTime; }
          catch { sampleTime = 0; }
        }
      }, { once: true });
      video.addEventListener("loadeddata", () => {
        if (!sampleTime || (!video.seeking && video.currentTime >= sampleTime - 0.03)) finish(true);
      });
      video.addEventListener("seeked", () => {
        if (video.readyState >= 2) finish(true);
      }, { once: true });
      video.addEventListener("error", () => finish(false), { once: true });
      video.src = url;
      video.load();
    });
    return frame ? await new Promise((resolve) => frame.toBlob(resolve, "image/jpeg", .82)) : null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

const MAX_TAG_SIZE = 16 * 1024 * 1024;

async function findMp4Box(file, start, end, wanted) {
  for (let count = 0; start + 8 <= end && count < 4096; count++) {
    const header = new DataView(await file.slice(start, Math.min(end, start + 16)).arrayBuffer());
    let size = header.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) return null;
      size = Number(header.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - start;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || size > end - start) return null;
    const type = String.fromCharCode(header.getUint8(4), header.getUint8(5), header.getUint8(6), header.getUint8(7));
    if (type === wanted) return { start: start + headerSize, end: start + size };
    start += size;
  }
  return null;
}

async function readMp4Metadata(file) {
  const metadata = {};
  const movie = await findMp4Box(file, 0, file.size, "moov");
  if (!movie) return metadata;
  const user = await findMp4Box(file, movie.start, movie.end, "udta");
  const parent = user ?? movie;
  const meta = await findMp4Box(file, parent.start, parent.end, "meta");
  if (!meta) return metadata;
  const items = await findMp4Box(file, meta.start + 4, meta.end, "ilst");
  if (!items) return metadata;
  for (const [key, tag] of [["title", "©nam"], ["artist", "©ART"], ["album", "©alb"]]) {
    const item = await findMp4Box(file, items.start, items.end, tag);
    if (!item) continue;
    const data = await findMp4Box(file, item.start, item.end, "data");
    if (data && data.end - data.start > 8 && data.end - data.start <= 8192) {
      const payload = await file.slice(data.start, data.end).arrayBuffer();
      const type = new DataView(payload).getUint32(0);
      if (type !== 1 && type !== 2) continue;
      metadata[key] = new TextDecoder(type === 2 ? "utf-16be" : "utf-8").decode(payload.slice(8)).trim().slice(0, 300);
    }
  }
  return metadata;
}

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

function readTagText(frame) {
  const encodings = ["iso-8859-1", "utf-16le", "utf-16be", "utf-8"];
  const marker = frame[0];
  let encoding = encodings[marker];
  if (!encoding || frame.length < 2 || frame.length > 8192) return "";
  let bytes = frame.subarray(1);
  if (marker === 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bytes = bytes.subarray(2);
  }
  return new TextDecoder(encoding).decode(bytes).split("\0")[0].trim();
}

async function readTrackMetadata(file, includeArtwork = true) {
  const metadata = { artwork: null, title: "", artist: "", album: "" };
  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (header[0] !== 73 || header[1] !== 68 || header[2] !== 51) return metadata;
  const version = header[3];
  const tagFlags = header[5];
  if (version < 2 || version > 4 || (version === 2 && tagFlags & 0x40)) return metadata;
  const tagSize = readSize(header, 6, 4, true);
  if (tagSize <= 0 || tagSize > MAX_TAG_SIZE || tagSize + 10 > file.size) return metadata;
  let tag = new Uint8Array(await file.slice(10, 10 + tagSize).arrayBuffer());
  if (version < 4 && tagFlags & 0x80) tag = undoUnsynchronization(tag);

  let offset = 0;
  if (version >= 3 && tagFlags & 0x40) {
    const extendedSize = readSize(tag, 0, 4, version === 4);
    if (extendedSize < 6) return metadata;
    offset = version === 3 ? 4 + extendedSize : extendedSize;
  }
  const idLength = version === 2 ? 3 : 4;
  const headerSize = version === 2 ? 6 : 10;
  const pictureId = version === 2 ? "PIC" : "APIC";
  const textFields = version === 2
    ? { TT2: "title", TP1: "artist", TAL: "album" }
    : { TIT2: "title", TPE1: "artist", TALB: "album" };
  let frontCover = false;
  while (offset + headerSize <= tag.length && tag[offset] !== 0) {
    const id = String.fromCharCode(...tag.subarray(offset, offset + idLength));
    const size = readSize(tag, offset + idLength, idLength, version === 4);
    const frameFlags = version === 2 ? 0 : tag[offset + 9];
    const bodyStart = offset + headerSize;
    offset = bodyStart + size;
    if (size <= 0 || offset > tag.length) break;
    const field = textFields[id];
    if (!field && (!includeArtwork || id !== pictureId || frontCover)) continue;
    // Compressed or encrypted frames cannot be read directly.
    if (frameFlags & (version === 3 ? 0xc0 : 0x0c)) continue;
    let frame = tag.subarray(bodyStart, offset);
    if (version === 4) {
      if (frameFlags & 0x02 || tagFlags & 0x80) frame = undoUnsynchronization(frame);
      if (frameFlags & 0x40) frame = frame.subarray(1);
      if (frameFlags & 0x01) frame = frame.subarray(4);
    } else if (version === 3 && frameFlags & 0x20) {
      frame = frame.subarray(1);
    }
    if (field) {
      if (!metadata[field]) metadata[field] = readTagText(frame);
    } else if (!frontCover) {
      const picture = readPicture(frame, version);
      if (picture && (!metadata.artwork || picture.type === 3)) {
        metadata.artwork = picture.image;
        frontCover = picture.type === 3;
      }
    }
  }
  return metadata;
}
