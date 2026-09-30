/**
 * gil.js: low-level .gil container + protobuf wire-format layer.
 *
 * A .gil file is:
 *   u32be totalLen                  (= file size - 4)
 *   u32be 0x00000001, u32be verA    (verA observed as 806; kept verbatim)
 *   u32be 0x00000002, u32be payloadLen
 *   payload[payloadLen]             (a protobuf message, "Level")
 *   suffix bytes                    (observed as u32be 0x679; kept verbatim)
 *
 * The payload is protobuf wire format. Fields are kept with their original
 * encoded value bytes so that untouched data round-trips byte-for-byte,
 * including non-canonical varint encodings and unknown fields.
 *
 * Field representation:
 *   { num, wire, raw }
 *     wire 0 (varint): raw = the encoded varint bytes
 *     wire 1 (64-bit): raw = 8 value bytes
 *     wire 5 (32-bit): raw = 4 value bytes
 *     wire 2 (len):    raw = content bytes (no key/length prefix)
 */
'use strict';

// ---------------------------------------------------------------- varints

/** Read a varint at pos; returns {lo: Number (if < 2^53), big: BigInt, len}. */
export function readVarint(buf, pos) {
  let big = 0n;
  let shift = 0n;
  let len = 0;
  for (;;) {
    if (pos + len >= buf.length) throw new Error('Truncated varint');
    const b = buf[pos + len];
    big |= BigInt(b & 0x7f) << shift;
    len++;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (len > 10) throw new Error('Varint too long');
  }
  const lo = big <= 9007199254740991n ? Number(big) : NaN;
  return { lo, big, len };
}

/** Encode a non-negative integer (Number or BigInt) as a canonical varint. */
export function encodeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.round(value));
  if (v < 0n) v &= 0xffffffffffffffffn; // two's complement 64-bit
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- messages

/**
 * Parse a protobuf message into a field list.
 * Throws if the bytes are not a valid message.
 */
export function parseMessage(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos += key.len;
    const num = Number(key.big >> 3n);
    const wire = Number(key.big & 7n);
    if (num === 0) throw new Error('Field number 0');
    let raw;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      raw = buf.subarray(pos, pos + v.len);
      pos += v.len;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('Truncated fixed64');
      raw = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('Truncated fixed32');
      raw = buf.subarray(pos, pos + 4);
      pos += 4;
    } else if (wire === 2) {
      const l = readVarint(buf, pos);
      pos += l.len;
      const n = Number(l.big);
      if (pos + n > buf.length) throw new Error('Truncated length-delimited field');
      raw = buf.subarray(pos, pos + n);
      pos += n;
    } else {
      throw new Error('Unsupported wire type ' + wire);
    }
    fields.push({ num, wire, raw });
  }
  return fields;
}

/** Serialize a field list back into message bytes. */
export function encodeMessage(fields) {
  const parts = [];
  let total = 0;
  for (const f of fields) {
    const key = encodeVarint((BigInt(f.num) << 3n) | BigInt(f.wire));
    parts.push(key);
    total += key.length;
    if (f.wire === 2) {
      const len = encodeVarint(f.raw.length);
      parts.push(len);
      total += len.length;
    }
    parts.push(f.raw);
    total += f.raw.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ------------------------------------------------------------ field helpers

export function varintField(num, value) {
  return { num, wire: 0, raw: encodeVarint(value) };
}
export function msgField(num, fieldsOrBytes) {
  const raw = fieldsOrBytes instanceof Uint8Array ? fieldsOrBytes : encodeMessage(fieldsOrBytes);
  return { num, wire: 2, raw };
}
export function bytesField(num, bytes) {
  return { num, wire: 2, raw: bytes || new Uint8Array(0) };
}
export function stringField(num, s) {
  return { num, wire: 2, raw: new TextEncoder().encode(s) };
}
export function f32Field(num, value) {
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setFloat32(0, value, true);
  return { num, wire: 5, raw };
}

/** Numeric value of a varint field (NaN if > 2^53). */
export function fieldVarint(f) {
  return readVarint(f.raw, 0).lo;
}
export function fieldVarintBig(f) {
  return readVarint(f.raw, 0).big;
}
export function fieldF32(f) {
  return new DataView(f.raw.buffer, f.raw.byteOffset, 4).getFloat32(0, true);
}
export function fieldString(f) {
  return new TextDecoder().decode(f.raw);
}

/** First field with the given number, or undefined. */
export function getField(fields, num) {
  return fields.find((f) => f.num === num);
}
/** All fields with the given number. */
export function getFields(fields, num) {
  return fields.filter((f) => f.num === num);
}

/** Decode a packed repeated varint payload into an array of Numbers. */
export function decodePackedVarints(raw) {
  const out = [];
  let pos = 0;
  while (pos < raw.length) {
    const v = readVarint(raw, pos);
    out.push(v.lo);
    pos += v.len;
  }
  return out;
}

/** Encode Numbers as a packed repeated varint payload. */
export function encodePackedVarints(values) {
  const parts = values.map((v) => encodeVarint(v));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- container

/**
 * Parse the .gil container. Returns:
 *   { head: Uint8Array (bytes 4..payloadStart-4, i.e. the section words before
 *     the payload length), payload: Uint8Array, suffix: Uint8Array, verA }
 * Throws with a descriptive message when the container is malformed.
 */
export function parseGilContainer(bytes) {
  if (bytes.length < 24) throw new Error('File too small to be a .gil level');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalLen = dv.getUint32(0);
  if (totalLen !== bytes.length - 4) {
    throw new Error(
      `Container length mismatch (header says ${totalLen}, file has ${bytes.length - 4}); ` +
        'the file may be truncated or not a .gil level'
    );
  }
  const tag1 = dv.getUint32(4);
  const verA = dv.getUint32(8);
  const tag2 = dv.getUint32(12);
  const payloadLen = dv.getUint32(16);
  if (tag1 !== 1 || tag2 !== 2) {
    throw new Error(`Unrecognized .gil section layout (tags ${tag1}, ${tag2}); unsupported version`);
  }
  if (20 + payloadLen > bytes.length) {
    throw new Error('Payload length exceeds file size; the file may be corrupted');
  }
  return {
    head: bytes.slice(4, 16), // {1, verA, 2} words, kept verbatim
    payload: bytes.subarray(20, 20 + payloadLen),
    suffix: bytes.slice(20 + payloadLen), // kept verbatim
    verA,
  };
}

/** Rebuild a .gil file from container parts and (possibly new) payload bytes. */
export function buildGilContainer(head, payload, suffix) {
  const total = head.length + 4 + payload.length + suffix.length;
  const out = new Uint8Array(4 + total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  out.set(head, 4);
  dv.setUint32(4 + head.length, payload.length);
  out.set(payload, 8 + head.length);
  out.set(suffix, 8 + head.length + payload.length);
  return out;
}
