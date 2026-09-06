import { MediaStoredObjectInvalidError } from "./errors";
import { MEDIA_MAX_PIXELS } from "./types";

export type ImageHeader = Readonly<{ mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width: number; height: number }>;

export class StreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private offset = 0;
  private pushedBack: number[] = [];
  consumed = 0;

  constructor(stream: AsyncIterable<Uint8Array>) { this.iterator = stream[Symbol.asyncIterator](); }

  pushBack(bytes: Uint8Array): void {
    this.pushedBack = [...bytes, ...this.pushedBack];
    this.consumed -= bytes.byteLength;
  }

  async byte(): Promise<number | null> {
    if (this.pushedBack.length > 0) { this.consumed += 1; return this.pushedBack.shift() ?? null; }
    while (this.offset >= this.current.byteLength) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.current = next.value;
      this.offset = 0;
    }
    this.consumed += 1;
    return this.current[this.offset++];
  }

  async exact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const value = await this.byte();
      if (value === null) throw new MediaStoredObjectInvalidError();
      result[index] = value;
    }
    return result;
  }

  async skip(length: number, visit?: (bytes: Uint8Array) => void): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.pushedBack.length > 0) {
        const size = Math.min(remaining, this.pushedBack.length);
        const bytes = Uint8Array.from(this.pushedBack.splice(0, size));
        this.consumed += size;
        remaining -= size;
        visit?.(bytes);
        continue;
      }
      while (this.offset >= this.current.byteLength) {
        const next = await this.iterator.next();
        if (next.done) throw new MediaStoredObjectInvalidError();
        this.current = next.value;
        this.offset = 0;
      }
      const size = Math.min(remaining, this.current.byteLength - this.offset, 8_192);
      const bytes = this.current.subarray(this.offset, this.offset + size);
      this.offset += size;
      this.consumed += size;
      remaining -= size;
      visit?.(bytes);
    }
  }

  async skipUntil(value: number): Promise<boolean> {
    while (true) {
      if (this.pushedBack.length > 0) {
        if (this.pushedBack[0] === value) return true;
        this.pushedBack.shift();
        this.consumed += 1;
        continue;
      }
      while (this.offset >= this.current.byteLength) {
        const next = await this.iterator.next();
        if (next.done) return false;
        this.current = next.value;
        this.offset = 0;
      }
      const found = this.current.indexOf(value, this.offset);
      const end = found === -1 ? this.current.byteLength : found;
      this.consumed += end - this.offset;
      this.offset = end;
      if (found !== -1) return true;
    }
  }

  async end(expectedSize: number): Promise<void> {
    if (this.consumed !== expectedSize || await this.byte() !== null) throw new MediaStoredObjectInvalidError();
  }
}

function ascii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
function u16be(bytes: Uint8Array, offset = 0): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset); }
function u16le(bytes: Uint8Array, offset = 0): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true); }
function u24le(bytes: Uint8Array, offset = 0): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function u32be(bytes: Uint8Array, offset = 0): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); }
function u32le(bytes: Uint8Array, offset = 0): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }

function checked(mimeType: ImageHeader["mimeType"], width: number, height: number): ImageHeader {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MEDIA_MAX_PIXELS) throw new MediaStoredObjectInvalidError();
  return { mimeType, width, height };
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return value >>> 0;
}

async function png(reader: StreamReader, expectedSize: number): Promise<ImageHeader> {
  const signature = await reader.exact(8);
  if (!signature.every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) throw new MediaStoredObjectInvalidError();
  let dimensions: ImageHeader | null = null;
  let sawData = false;
  let first = true;
  while (true) {
    const length = u32be(await reader.exact(4));
    if (length > expectedSize) throw new MediaStoredObjectInvalidError();
    const typeBytes = await reader.exact(4);
    const type = ascii(typeBytes);
    let crc = crcUpdate(0xffffffff, typeBytes);
    if (first && (type !== "IHDR" || length !== 13)) throw new MediaStoredObjectInvalidError();
    first = false;
    if (type === "IHDR") {
      if (dimensions || length !== 13) throw new MediaStoredObjectInvalidError();
      const data = await reader.exact(13);
      crc = crcUpdate(crc, data);
      if (data[8] === 0 || data[10] !== 0 || data[11] !== 0 || data[12] > 1) throw new MediaStoredObjectInvalidError();
      dimensions = checked("image/png", u32be(data), u32be(data, 4));
    } else {
      if (type === "IDAT") sawData = sawData || length > 0;
      await reader.skip(length, (bytes) => { crc = crcUpdate(crc, bytes); });
    }
    const storedCrc = u32be(await reader.exact(4));
    if (((crc ^ 0xffffffff) >>> 0) !== storedCrc) throw new MediaStoredObjectInvalidError();
    if (type === "IEND") {
      if (length !== 0 || !dimensions || !sawData) throw new MediaStoredObjectInvalidError();
      await reader.end(expectedSize);
      return dimensions;
    }
  }
}

const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
async function jpeg(reader: StreamReader, expectedSize: number): Promise<ImageHeader> {
  const soi = await reader.exact(2);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) throw new MediaStoredObjectInvalidError();
  let dimensions: ImageHeader | null = null;
  let inScan = false;
  let sawScan = false;
  let sawScanData = false;
  while (true) {
    if (inScan) {
      const before = reader.consumed;
      if (!await reader.skipUntil(0xff)) throw new MediaStoredObjectInvalidError();
      sawScanData = sawScanData || reader.consumed > before;
    }
    const prefix = await reader.byte();
    if (prefix === null) throw new MediaStoredObjectInvalidError();
    if (inScan && prefix !== 0xff) continue;
    if (prefix !== 0xff) throw new MediaStoredObjectInvalidError();
    let marker = await reader.byte();
    while (marker === 0xff) marker = await reader.byte();
    if (marker === null) throw new MediaStoredObjectInvalidError();
    if (inScan && marker === 0x00) { sawScanData = true; continue; }
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || !sawScanData) throw new MediaStoredObjectInvalidError();
      await reader.end(expectedSize);
      return dimensions;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const length = u16be(await reader.exact(2));
    if (length < 2) throw new MediaStoredObjectInvalidError();
    const payloadLength = length - 2;
    if (sofMarkers.has(marker)) {
      if (payloadLength < 9) throw new MediaStoredObjectInvalidError();
      const header = await reader.exact(6);
      if (payloadLength !== 6 + 3 * header[5]) throw new MediaStoredObjectInvalidError();
      dimensions = checked("image/jpeg", u16be(header, 3), u16be(header, 1));
      await reader.skip(payloadLength - 6);
    } else if (marker === 0xda) {
      if (!dimensions || payloadLength < 6) throw new MediaStoredObjectInvalidError();
      const header = await reader.exact(1);
      if (payloadLength !== 1 + 2 * header[0] + 3) throw new MediaStoredObjectInvalidError();
      await reader.skip(payloadLength - 1);
      sawScan = true;
    } else {
      await reader.skip(payloadLength);
    }
    inScan = marker === 0xda;
  }
}

async function gifSubBlocks(reader: StreamReader): Promise<void> {
  while (true) {
    const length = await reader.byte();
    if (length === null) throw new MediaStoredObjectInvalidError();
    if (length === 0) return;
    await reader.skip(length);
  }
}

async function gif(reader: StreamReader, expectedSize: number): Promise<ImageHeader> {
  const header = await reader.exact(13);
  if (!["GIF87a", "GIF89a"].includes(ascii(header.subarray(0, 6)))) throw new MediaStoredObjectInvalidError();
  const dimensions = checked("image/gif", u16le(header, 6), u16le(header, 8));
  if ((header[10] & 0x80) !== 0) await reader.skip(3 * (2 ** ((header[10] & 0x07) + 1)));
  let sawImage = false;
  while (true) {
    const block = await reader.byte();
    if (block === null) throw new MediaStoredObjectInvalidError();
    if (block === 0x3b) {
      if (!sawImage) throw new MediaStoredObjectInvalidError();
      await reader.end(expectedSize);
      return dimensions;
    }
    if (block === 0x21) {
      if (await reader.byte() === null) throw new MediaStoredObjectInvalidError();
      await gifSubBlocks(reader);
      continue;
    }
    if (block !== 0x2c) throw new MediaStoredObjectInvalidError();
    const descriptor = await reader.exact(9);
    if (u16le(descriptor, 4) <= 0 || u16le(descriptor, 6) <= 0) throw new MediaStoredObjectInvalidError();
    if ((descriptor[8] & 0x80) !== 0) await reader.skip(3 * (2 ** ((descriptor[8] & 0x07) + 1)));
    const codeSize = await reader.byte();
    if (codeSize === null || codeSize < 2 || codeSize > 12) throw new MediaStoredObjectInvalidError();
    await gifSubBlocks(reader);
    sawImage = true;
  }
}

async function webp(reader: StreamReader, expectedSize: number): Promise<ImageHeader> {
  const header = await reader.exact(12);
  if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WEBP" || u32le(header, 4) + 8 !== expectedSize) throw new MediaStoredObjectInvalidError();
  let dimensions: ImageHeader | null = null;
  let sawImageData = false;
  let animated = false;
  while (reader.consumed < expectedSize) {
    const chunkHeader = await reader.exact(8);
    const kind = ascii(chunkHeader.subarray(0, 4));
    const length = u32le(chunkHeader, 4);
    if (length > expectedSize - reader.consumed) throw new MediaStoredObjectInvalidError();
    if (kind === "VP8X") {
      if (length !== 10) throw new MediaStoredObjectInvalidError();
      const data = await reader.exact(10);
      animated = (data[0] & 0x02) !== 0;
      dimensions = checked("image/webp", 1 + u24le(data, 4), 1 + u24le(data, 7));
    } else if (kind === "ANMF") {
      if (!animated || !dimensions || length < 30) throw new MediaStoredObjectInvalidError();
      const frame = await reader.exact(16);
      const frameWidth = 1 + u24le(frame, 6);
      const frameHeight = 1 + u24le(frame, 9);
      if (2 * u24le(frame) + frameWidth > dimensions.width || 2 * u24le(frame, 3) + frameHeight > dimensions.height || (frame[15] & 0xfc) !== 0) throw new MediaStoredObjectInvalidError();
      let remaining = length - 16;
      while (remaining > 0) {
        if (remaining < 8) throw new MediaStoredObjectInvalidError();
        const nested = await reader.exact(8);
        const nestedKind = ascii(nested.subarray(0, 4));
        const nestedLength = u32le(nested, 4);
        const padded = nestedLength + (nestedLength % 2);
        if (padded > remaining - 8) throw new MediaStoredObjectInvalidError();
        if (nestedKind === "VP8L") {
          if (nestedLength < 5) throw new MediaStoredObjectInvalidError();
          const data = await reader.exact(5);
          if (data[0] !== 0x2f) throw new MediaStoredObjectInvalidError();
          await reader.skip(nestedLength - 5);
          sawImageData = true;
        } else if (nestedKind === "VP8 ") {
          if (nestedLength < 10) throw new MediaStoredObjectInvalidError();
          const data = await reader.exact(10);
          if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new MediaStoredObjectInvalidError();
          await reader.skip(nestedLength - 10);
          sawImageData = true;
        } else {
          await reader.skip(nestedLength);
        }
        if (nestedLength % 2 === 1) await reader.skip(1);
        remaining -= 8 + padded;
      }
    } else if (kind === "VP8L") {
      if (length < 5) throw new MediaStoredObjectInvalidError();
      const data = await reader.exact(5);
      if (data[0] !== 0x2f) throw new MediaStoredObjectInvalidError();
      const bits = u32le(data, 1);
      dimensions = checked("image/webp", 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      sawImageData = true;
      await reader.skip(length - 5);
    } else if (kind === "VP8 ") {
      if (length < 10) throw new MediaStoredObjectInvalidError();
      const data = await reader.exact(10);
      if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new MediaStoredObjectInvalidError();
      dimensions = checked("image/webp", u16le(data, 6) & 0x3fff, u16le(data, 8) & 0x3fff);
      sawImageData = true;
      await reader.skip(length - 10);
    } else {
      await reader.skip(length);
    }
    if (length % 2 === 1) await reader.skip(1);
  }
  if (!dimensions || !sawImageData) throw new MediaStoredObjectInvalidError();
  await reader.end(expectedSize);
  return dimensions;
}

export async function validateRasterImage(stream: AsyncIterable<Uint8Array>, expectedSize: number): Promise<ImageHeader> {
  const reader = new StreamReader(stream);
  const prefix = await reader.exact(Math.min(12, expectedSize));
  reader.pushBack(prefix);
  if (prefix.length >= 8 && prefix[0] === 0x89 && ascii(prefix.subarray(1, 4)) === "PNG") return png(reader, expectedSize);
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xd8) return jpeg(reader, expectedSize);
  if (prefix.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(prefix.subarray(0, 6)))) return gif(reader, expectedSize);
  if (prefix.length >= 12 && ascii(prefix.subarray(0, 4)) === "RIFF" && ascii(prefix.subarray(8, 12)) === "WEBP") return webp(reader, expectedSize);
  throw new MediaStoredObjectInvalidError();
}

export async function identifyAttachmentMime(stream: AsyncIterable<Uint8Array>, expectedSize: number): Promise<"application/pdf" | "application/octet-stream"> {
  let total = 0;
  const prefix: number[] = [];
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > expectedSize) throw new MediaStoredObjectInvalidError();
    for (let index = 0; index < chunk.byteLength && prefix.length < 5; index += 1) prefix.push(chunk[index]);
  }
  if (total !== expectedSize) throw new MediaStoredObjectInvalidError();
  return ascii(Uint8Array.from(prefix)) === "%PDF-" ? "application/pdf" : "application/octet-stream";
}
