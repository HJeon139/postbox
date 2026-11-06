// What an image attached to a review is, read from its bytes and never its name (#780). Only the four types the app
// shows inline (INLINE_TYPES in shared/files.mjs) pass; SVG and HTML, which can carry script, never do. Only the header
// is read, with no decoding and no dependency: the signature, then the width and height. A header this can’t read is
// refused, not passed, and so is a size past REVIEW_IMAGES, so a small file can’t decode to a huge bitmap.

import { REVIEW_IMAGES } from '../shared/limits.mjs';

/** @typedef {'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'} ImageType */
/** @typedef {{ type: ImageType, width: number, height: number }} ImageInfo */
/** Why an image was refused, as the error’s code. @typedef {'not-an-image' | 'unreadable' | 'too-large'} ImageProblem */

const NOT_AN_IMAGE = 'It isn’t a PNG, JPEG, GIF or WebP image (Postbox checks its bytes, not its name).';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LABELS = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };

/** @param {ImageProblem} code  @param {string} message */
const refusal = (code, message) => Object.assign(new Error(message), { code });

/** @param {ImageType} type  @param {string} why  what’s wrong with its header */
const unreadable = (type, why) =>
  refusal('unreadable', `It starts like a ${LABELS[type]} image, but ${why}, so Postbox can’t read its size. Send a whole PNG, JPEG, GIF or WebP image.`);

/** @param {Buffer} buf  @param {number} at  @param {string} text */
const isAscii = (buf, at, text) => buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;

/**
 * The type, width and height of an image, read from its header.
 * @param {Uint8Array} bytes  the whole file
 * @returns {ImageInfo}
 * @throws {Error} with code 'not-an-image', 'unreadable' or 'too-large', and a message that names the four accepted types
 *   or the limit that failed
 */
export function imageInfo(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = readHeader(buf);
  checkSize(info);
  return info;
}

/** @param {Buffer} buf  @returns {ImageInfo} */
function readHeader(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(buf);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return readJpeg(buf);
  if (isAscii(buf, 0, 'GIF87a') || isAscii(buf, 0, 'GIF89a')) return readGif(buf);
  if (isAscii(buf, 0, 'RIFF')) return readRiff(buf);
  throw refusal('not-an-image', NOT_AN_IMAGE);
}

/** The IHDR chunk, which must come first: its length (13), its name, then the width and height. @param {Buffer} buf */
function readPng(buf) {
  if (buf.length < 24) throw unreadable('image/png', 'it ends before its IHDR chunk');
  if (buf.readUInt32BE(8) !== 13 || !isAscii(buf, 12, 'IHDR')) throw unreadable('image/png', 'its first chunk isn’t IHDR');
  return sized('image/png', buf.readUInt32BE(16), buf.readUInt32BE(20));
}

/** The logical screen descriptor, right after the signature. @param {Buffer} buf */
function readGif(buf) {
  if (buf.length < 10) throw unreadable('image/gif', 'it ends before its screen descriptor');
  return sized('image/gif', buf.readUInt16LE(6), buf.readUInt16LE(8));
}

// Markers C0–CF are start-of-frame, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
const isStartOfFrame = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
// RST0–RST7 and TEM stand alone, with no length after them.
const standsAlone = (m) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

/**
 * Walk the segments after SOI to the first start-of-frame, which must come before the scan (SOS) or the end (EOI).
 * Each segment is FF, its marker, then a big-endian length that counts itself; FF fill bytes may come between.
 * @param {Buffer} buf
 */
function readJpeg(buf) {
  let at = 2;
  while (at < buf.length) {
    if (buf[at] !== 0xff) throw unreadable('image/jpeg', 'a segment doesn’t start with a marker');
    while (buf[at] === 0xff) at++;
    if (at >= buf.length) break;
    const marker = buf[at];
    if (standsAlone(marker)) {
      at++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    if (at + 3 > buf.length) break;
    const length = buf.readUInt16BE(at + 1);
    const end = at + 1 + length;
    if (length < 2 || end > buf.length) throw unreadable('image/jpeg', 'a segment runs past the end of the file');
    if (isStartOfFrame(marker)) {
      if (length < 8) throw unreadable('image/jpeg', 'its frame header is too short');
      return sized('image/jpeg', buf.readUInt16BE(at + 6), buf.readUInt16BE(at + 4));
    }
    at = end;
  }
  throw unreadable('image/jpeg', 'it has no start-of-frame before its image data');
}

/**
 * A WebP is a RIFF file whose size field is its length less 8, then WEBP and a VP8, VP8L or VP8X chunk. Another RIFF
 * form, such as WAVE, is no image.
 * @param {Buffer} buf
 */
function readRiff(buf) {
  if (buf.length < 12 || buf.readUInt32LE(4) !== buf.length - 8) throw unreadable('image/webp', 'its RIFF size doesn’t match its length');
  if (!isAscii(buf, 8, 'WEBP')) throw refusal('not-an-image', NOT_AN_IMAGE);
  if (buf.length < 20) throw unreadable('image/webp', 'it ends before its first chunk');
  const fourcc = buf.toString('latin1', 12, 16);
  const data = 20;
  const size = buf.readUInt32LE(16);
  if (data + size > buf.length) throw unreadable('image/webp', `its ${fourcc.trim()} chunk runs past the end of the file`);
  return readWebpChunk(buf, fourcc, data, size);
}

/** @param {Buffer} buf  @param {string} fourcc  @param {number} data  where the chunk’s data starts  @param {number} size */
function readWebpChunk(buf, fourcc, data, size) {
  if (fourcc === 'VP8 ') {
    // A frame tag (3 bytes), the start code 9D 01 2A, then 14-bit width and height, each with 2 bits of scale above.
    if (size < 10 || buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a)
      throw unreadable('image/webp', 'its VP8 frame header is damaged');
    return sized('image/webp', buf.readUInt16LE(data + 6) & 0x3fff, buf.readUInt16LE(data + 8) & 0x3fff);
  }
  if (fourcc === 'VP8L') {
    // The signature 2F, then width less one and height less one, 14 bits each, from the lowest bit.
    if (size < 5 || buf[data] !== 0x2f) throw unreadable('image/webp', 'its VP8L header is damaged');
    const bits = buf.readUInt32LE(data + 1);
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (fourcc === 'VP8X') {
    // Flags and reserved bytes (4), then canvas width less one and height less one, 24 bits each.
    if (size < 10) throw unreadable('image/webp', 'its VP8X header is too short');
    return sized('image/webp', buf.readUIntLE(data + 4, 3) + 1, buf.readUIntLE(data + 7, 3) + 1);
  }
  throw unreadable('image/webp', 'its first chunk isn’t VP8, VP8L or VP8X');
}

/** A header that says 0 px has no size to show. @param {ImageType} type  @param {number} width  @param {number} height  @returns {ImageInfo} */
function sized(type, width, height) {
  if (width === 0 || height === 0) throw unreadable(type, 'its header gives no width or height');
  return { type, width, height };
}

/** @param {ImageInfo} info */
function checkSize({ width, height }) {
  const n = (x) => x.toLocaleString('en-US');
  const { reviewImageSide: side, reviewImagePixels: pixels } = REVIEW_IMAGES;
  if (width > side || height > side)
    throw refusal('too-large', `It’s ${n(width)} × ${n(height)} px, and an image can be at most ${n(side)} px on a side. Scale it down and send it again.`);
  if (width * height > pixels)
    throw refusal(
      'too-large',
      `It’s ${n(width)} × ${n(height)} px, ${n(width * height)} px in all, and an image can be at most ${n(pixels)} px. Scale it down and send it again.`,
    );
}
