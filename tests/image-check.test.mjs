// An image attached to a review is accepted by its bytes, never its name (#780): a PNG, JPEG, GIF or WebP header with
// a size inside REVIEW_IMAGES, read from the header alone. The headers here are built in code, the smallest each
// format allows, so no binary fixture is checked in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageInfo } from '../server/image-check.mjs';
import { REVIEW_IMAGES } from '../shared/limits.mjs';

const NOT_AN_IMAGE = /isn’t a PNG, JPEG, GIF or WebP image \(Postbox checks its bytes, not its name\)/;
const UNREADABLE = /PNG, JPEG, GIF or WebP/;

const u16be = (n) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s) => [...Buffer.from(s, 'latin1')];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG signature and IHDR chunk (8-bit RGBA), with a CRC Postbox doesn’t check. */
const png = (w, h) => Buffer.from([...PNG_SIGNATURE, ...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);

/** A JPEG segment: a marker and its big-endian length, which counts itself. */
const segment = (marker, body) => [0xff, marker, ...u16be(body.length + 2), ...body];
const APP0 = segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DHT = segment(0xc4, [0x00, ...new Array(16).fill(0)]);
const sof = (marker, w, h) => segment(marker, [8, ...u16be(h), ...u16be(w), 1, 1, 0x11, 0]);
const jpeg = (...segments) => Buffer.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);

const gif = (version, w, h) => Buffer.from([...ascii(version), ...u16le(w), ...u16le(h), 0, 0, 0, 0x3b]);

/** A RIFF file of the given form and chunks, its size field right unless one is given. */
const riff = (form, chunk, size) => {
  const body = [...ascii(form), ...chunk];
  return Buffer.from([...ascii('RIFF'), ...u32le(size ?? body.length), ...body]);
};
const chunk = (fourcc, data) => [...ascii(fourcc), ...u32le(data.length), ...data];
const vp8 = (w, h) => chunk('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)]);
const vp8l = (w, h) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return chunk('VP8L', [0x2f, ...u32le(bits), 0]);
};
const vp8x = (w, h) => chunk('VP8X', [0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);

test('a PNG is accepted with the width and height from its IHDR chunk', () => {
  assert.deepEqual(imageInfo(png(640, 480)), { type: 'image/png', width: 640, height: 480 });
});

test('a JPEG is accepted with the size from its start-of-frame, past the segments before it', () => {
  assert.deepEqual(imageInfo(jpeg(APP0, DHT, sof(0xc0, 800, 600))), { type: 'image/jpeg', width: 800, height: 600 });
  // A progressive JPEG’s frame is SOF2.
  assert.deepEqual(imageInfo(jpeg(APP0, sof(0xc2, 31, 17))), { type: 'image/jpeg', width: 31, height: 17 });
});

test('a GIF87a and a GIF89a are accepted with the size from the logical screen descriptor', () => {
  assert.deepEqual(imageInfo(gif('GIF89a', 320, 200)), { type: 'image/gif', width: 320, height: 200 });
  assert.deepEqual(imageInfo(gif('GIF87a', 1, 2)), { type: 'image/gif', width: 1, height: 2 });
});

test('a lossy WebP (VP8) is accepted with the size from its frame header', () => {
  assert.deepEqual(imageInfo(riff('WEBP', vp8(1024, 768))), { type: 'image/webp', width: 1024, height: 768 });
});

test('a lossless WebP (VP8L) is accepted with the size from its bitstream header', () => {
  assert.deepEqual(imageInfo(riff('WEBP', vp8l(300, 7000))), { type: 'image/webp', width: 300, height: 7000 });
});

test('an extended WebP (VP8X) is accepted with the canvas size', () => {
  assert.deepEqual(imageInfo(riff('WEBP', vp8x(5000, 3))), { type: 'image/webp', width: 5000, height: 3 });
});

test('an SVG is refused, as the four accepted types are named', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  assert.throws(() => imageInfo(svg), NOT_AN_IMAGE);
});

test('HTML is refused even when its name says .png, as Postbox reads its bytes', () => {
  const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
  assert.throws(() => imageInfo(html), NOT_AN_IMAGE);
  // A name, passed as a caller might, changes nothing: neither for HTML called .png, nor for a PNG called .gif.
  assert.throws(() => imageInfo(html, 'page.png'), NOT_AN_IMAGE);
  assert.deepEqual(imageInfo(png(2, 3), 'picture.gif'), { type: 'image/png', width: 2, height: 3 });
});

test('a truncated PNG signature is refused', () => {
  assert.throws(() => imageInfo(Buffer.from(PNG_SIGNATURE.slice(0, 4))), NOT_AN_IMAGE);
});

test('a PNG cut short before its IHDR size is refused, not passed', () => {
  assert.throws(() => imageInfo(png(640, 480).subarray(0, 20)), UNREADABLE);
  // A full signature followed by some chunk other than IHDR first is no PNG either.
  const noIhdr = Buffer.from([...PNG_SIGNATURE, ...u32be(13), ...ascii('IDAT'), ...new Array(17).fill(0)]);
  assert.throws(() => imageInfo(noIhdr), UNREADABLE);
});

test('a RIFF file whose size field doesn’t match its length is refused', () => {
  const ok = riff('WEBP', vp8(10, 10));
  assert.throws(() => imageInfo(riff('WEBP', vp8(10, 10), ok.length - 8 + 2)), UNREADABLE);
  // Trailing bytes after a well-formed WebP make the field wrong too.
  assert.throws(() => imageInfo(Buffer.concat([ok, Buffer.from('<script>')])), UNREADABLE);
});

test('a RIFF WAVE file is refused', () => {
  assert.throws(() => imageInfo(riff('WAVE', chunk('fmt ', new Array(16).fill(0)))), NOT_AN_IMAGE);
});

test('a JPEG with no start-of-frame is refused, not passed', () => {
  assert.throws(() => imageInfo(jpeg(APP0, DHT)), UNREADABLE);
  // Nor one whose frame header is cut off inside the buffer.
  assert.throws(() => imageInfo(Buffer.from([0xff, 0xd8, ...APP0, ...sof(0xc0, 8, 8).slice(0, 7)])), UNREADABLE);
});

test('an empty buffer is refused', () => {
  assert.throws(() => imageInfo(Buffer.alloc(0)), NOT_AN_IMAGE);
});

test('an image wider than the side limit is refused, naming its size and the limit', () => {
  assert.throws(() => imageInfo(png(8193, 1)), /8,193 × 1 px.*8,192 px/);
  assert.throws(() => imageInfo(riff('WEBP', vp8x(1, 8193))), /1 × 8,193 px.*8,192 px/);
});

test('an image over the pixel limit is refused, though each side is inside its limit', () => {
  assert.throws(() => imageInfo(png(6000, 6000)), /6,000 × 6,000 px.*33,554,432 px/);
});

test('an image at the side limit, or at the pixel limit, is accepted', () => {
  // The note’s “32 megapixels” is 32 × 2²⁰ = 33,554,432 px, which is 8,192 × 4,096: its own example, 8,192 × 4,000,
  // is accepted, and one row more than 4,096 at full width is refused.
  assert.deepEqual(imageInfo(png(8192, 4000)), { type: 'image/png', width: 8192, height: 4000 });
  assert.deepEqual(imageInfo(png(8192, 4096)), { type: 'image/png', width: 8192, height: 4096 });
  assert.throws(() => imageInfo(png(8192, 4097)), /33,562,624 px.*33,554,432 px/);
});

test('the review image limits are the ones #780 set', () => {
  assert.deepEqual(
    { ...REVIEW_IMAGES },
    { reviewImageBytes: 5 * 1024 * 1024, reviewImagesBytes: 20 * 1024 * 1024, reviewImagePixels: 32 * 1024 * 1024, reviewImageSide: 8192 },
  );
  assert.ok(Object.isFrozen(REVIEW_IMAGES));
});
