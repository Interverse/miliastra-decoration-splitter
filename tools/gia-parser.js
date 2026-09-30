// .gia file parser, the read-side counterpart of engine/gia/gia-writer.js.
// Parses a .gia AssetBundle into flat decoration records ready to hand back
// to splitIntoModels() + buildGia(). Dependency-free; runs in browsers and Node.
//
// Public API:
//   parseGia(bytes: Uint8Array) -> {
//     exportName, engineVersion, exportTag,
//     collision,        // true if any object has collision enabled
//     autoAssemble,     // dynamic objects + a class-9 node graph present
//     objects: [{ name, guid, position, zoom, collision, dynamic, decorationGuids }],
//     decorations: [{
//       kind, modelId, name, guid,
//       position: {x,y,z},     // 0.1 m units, object offset baked in
//       rotationDeg: {x,y,z},
//       scale: {x,y,z},
//       color: 0xRRGGBB, alpha: 0..255,
//       ownerIndex, ownerName, ownerGuid,
//     }],
//   }

const KIND_BY_MODEL_ID = {
  20001925: 'triangle',
  20002125: 'triangle', // legacy v1 triangle (kept via modelId passthrough)
  10009001: 'square',
  10009003: 'plane',
  10009002: 'sphere',
  10009008: 'cylinder',
  10009004: 'prism',
  10009009: 'cone',
};

// ---------- low-level protobuf reader ----------

function readVarint(b, o) {
  // returns [BigInt value, next offset]
  let v = 0n, s = 0n, x;
  do { x = b[o++]; v |= BigInt(x & 127) << s; s += 7n; } while (x & 128);
  return [v, o];
}

const toNum = (v) => Number(v);

// signed interpretation: the writer encodes negatives as 2^64 complement
function toSigned(v) {
  return v > 0x7fffffffffffffffn ? Number(v - 0x10000000000000000n) : Number(v);
}

// Walk every field of a length-delimited message body, invoking
// cb(field, wire, value) where value is a BigInt (wire 0), a Uint8Array
// subarray (wire 2), or a float (wire 5).
function walk(b, cb) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o < b.length) {
    let key; [key, o] = readVarint(b, o);
    const field = toNum(key >> 3n), wire = toNum(key & 7n);
    if (wire === 0) {
      let v; [v, o] = readVarint(b, o);
      cb(field, wire, v);
    } else if (wire === 2) {
      let len; [len, o] = readVarint(b, o);
      const n = toNum(len);
      cb(field, wire, b.subarray(o, o + n));
      o += n;
    } else if (wire === 5) {
      cb(field, wire, dv.getFloat32(o, true));
      o += 4;
    } else if (wire === 1) {
      cb(field, wire, dv.getFloat64(o, true));
      o += 8;
    } else {
      throw new Error(`Unsupported wire type ${wire} at offset ${o}`);
    }
  }
}

const utf8 = new TextDecoder();

function readVec3(body) {
  const v = { x: 0, y: 0, z: 0 };
  walk(body, (f, w, val) => {
    if (w !== 5) return;
    if (f === 1) v.x = val; else if (f === 2) v.y = val; else if (f === 3) v.z = val;
  });
  return v;
}

function readPackedVarints(body) {
  const out = [];
  let o = 0;
  while (o < body.length) {
    let v; [v, o] = readVarint(body, o);
    out.push(toNum(v));
  }
  return out;
}

// identity message {2:classDomain, 3:?, 4:guid}
function readIdentity(body) {
  const id = {};
  walk(body, (f, w, v) => {
    if (w !== 0) return;
    if (f === 2) id.classDomain = toNum(v);
    else if (f === 4) id.guid = toNum(v);
  });
  return id;
}

// ---------- entry parsers ----------

function parseObjectEntry(entryBody) {
  const obj = {
    name: '', guid: 0, decorationGuids: [], graphGuid: null,
    position: { x: 0, y: 0, z: 0 }, zoom: { x: 0.1, y: 0.1, z: 0.1 },
    collision: true, dynamic: false,
  };
  walk(entryBody, (f, w, v) => {
    if (f === 1 && w === 2) obj.guid = readIdentity(v).guid ?? 0;
    else if (f === 2 && w === 2) {
      const ref = readIdentity(v);
      if (ref.classDomain === 5) obj.graphGuid = ref.guid;
      else if (ref.guid != null) obj.decorationGuids.push(ref.guid);
    } else if (f === 3 && w === 2) obj.name = utf8.decode(v);
    else if (f === 11 && w === 2) {
      walk(v, (pf, pw, pv) => {
        if (pf !== 1 || pw !== 2) return; // prefab body
        walk(pv, (bf, bw, bv) => {
          if (bw !== 2) return;
          if (bf === 6) parseObjectComponent6(bv, obj);
          else if (bf === 7) parseObjectComponent7(bv, obj);
        });
      });
    }
  });
  return obj;
}

function parseObjectComponent6(compBody, obj) {
  let type = 0;
  const bodies = [];
  walk(compBody, (f, w, v) => {
    if (f === 1 && w === 0) type = toNum(v);
    else if (w === 2) bodies.push([f, v]);
  });
  for (const [f, body] of bodies) {
    if (type === 1 && f === 11) {
      // static flag: {1:name, 2:1} static; dynamic prefabs omit 2:1
      let hasStaticFlag = false;
      walk(body, (nf, nw, nv) => { if (nf === 2 && nw === 0 && toNum(nv) === 1) hasStaticFlag = true; });
      obj.dynamic = !hasStaticFlag;
    } else if (type === 40 && f === 50) {
      walk(body, (nf, nw, nv) => {
        if (nf === 501 && nw === 2) obj.decorationGuids = readPackedVarints(nv);
      });
    }
  }
}

function parseObjectComponent7(compBody, obj) {
  let type = 0;
  const bodies = [];
  walk(compBody, (f, w, v) => {
    if (f === 1 && w === 0) type = toNum(v);
    else if (w === 2) bodies.push([f, v]);
  });
  for (const [f, body] of bodies) {
    if (type === 1 && f === 11) {
      // transform: 1 = position (meters), 3 = zoom
      walk(body, (nf, nw, nv) => {
        if (nw !== 2) return;
        if (nf === 1) obj.position = readVec3(nv);
        else if (nf === 3) obj.zoom = readVec3(nv);
      });
    } else if (type === 5 && f === 15) {
      // collision: {1:1, 2:1} enabled, empty body disabled
      obj.collision = body.length > 0;
    }
  }
}

function parseDecorationEntry(entryBody) {
  const dec = {
    kind: 'triangle', modelId: null, name: '', guid: 0, parentGuid: null,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    color: 0xffffff, alpha: 255,
  };
  walk(entryBody, (f, w, v) => {
    if (f === 1 && w === 2) dec.guid = readIdentity(v).guid ?? 0;
    else if (f === 3 && w === 2) dec.name = utf8.decode(v);
    else if (f === 21 && w === 2) {
      walk(v, (pf, pw, pv) => {
        if (pf !== 1 || pw !== 2) return; // decoration body
        walk(pv, (bf, bw, bv) => {
          if (bf === 2 && bw === 0) {
            dec.modelId = toNum(bv);
            dec.kind = KIND_BY_MODEL_ID[dec.modelId] ?? 'unknown';
          } else if (bf === 4 && bw === 2) parseDecorationComponent4(bv, dec);
          else if (bf === 5 && bw === 2) parseDecorationComponent5(bv, dec);
        });
      });
    }
  });
  return dec;
}

function parseDecorationComponent4(compBody, dec) {
  let type = 0;
  const bodies = [];
  walk(compBody, (f, w, v) => {
    if (f === 1 && w === 0) type = toNum(v);
    else if (w === 2) bodies.push([f, v]);
  });
  for (const [f, body] of bodies) {
    if (type === 40 && f === 50) {
      walk(body, (nf, nw, nv) => {
        if (nf === 502 && nw === 0) dec.parentGuid = toNum(nv);
      });
    }
  }
}

function parseDecorationComponent5(compBody, dec) {
  let type = 0;
  const bodies = [];
  walk(compBody, (f, w, v) => {
    if (f === 1 && w === 0) type = toNum(v);
    else if (w === 2) bodies.push([f, v]);
  });
  for (const [f, body] of bodies) {
    if (type === 1 && f === 11) {
      // transform: 1 = position (0.1 m units), 2 = rotationDeg, 3 = scale
      walk(body, (nf, nw, nv) => {
        if (nw !== 2) return;
        if (nf === 1) dec.position = readVec3(nv);
        else if (nf === 2) dec.rotationDeg = readVec3(nv);
        else if (nf === 3) dec.scale = readVec3(nv);
      });
    } else if (type === 22 && f === 32) {
      // color: field 3 = ARGB varint, field 5 = RGB varint
      walk(body, (nf, nw, nv) => {
        if (nw !== 0) return;
        if (nf === 3) {
          const argb = v64(nv);
          dec.alpha = Number((argb >> 24n) & 0xffn);
          dec.color = Number(argb & 0xffffffn);
        } else if (nf === 5 && dec.color === 0xffffff) {
          dec.color = toNum(nv) & 0xffffff;
        }
      });
    }
  }
}

const v64 = (v) => BigInt.asUintN(64, v);

// ---------- top level ----------

export function parseGia(bytes) {
  if (bytes.length < 24) throw new Error('File too small to be a .gia');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic1 = dv.getUint32(4, false);
  const magic2 = dv.getUint32(8, false);
  const magic3 = dv.getUint32(12, false);
  if (magic1 !== 1 || magic2 !== 806 || magic3 !== 3) {
    throw new Error(`Not a .gia file (header magic ${magic1}/${magic2}/${magic3}, expected 1/806/3)`);
  }
  const payloadLen = dv.getUint32(16, false);
  if (20 + payloadLen > bytes.length) throw new Error('Corrupt .gia: payload length exceeds file size');
  // ALWAYS slice by payloadLen; parsing to end-of-file breaks on the trailer
  const payload = bytes.subarray(20, 20 + payloadLen);

  const objects = [];
  const decorations = [];
  let graphCount = 0;
  let exportTag = '', engineVersion = '';

  walk(payload, (f, w, v) => {
    if (f === 1 && w === 2) {
      objects.push(parseObjectEntry(v));
    } else if (f === 2 && w === 2) {
      // classify by entry field 5: 28 = decoration, 9 = node graph
      let cls = 0;
      walk(v, (ef, ew, ev) => { if (ef === 5 && ew === 0) cls = toNum(ev); });
      if (cls === 28) decorations.push(parseDecorationEntry(v));
      else if (cls === 9) graphCount++;
    } else if (f === 3 && w === 2) exportTag = utf8.decode(v);
    else if (f === 5 && w === 2) engineVersion = utf8.decode(v);
  });

  // export tag: {UID}-{unixTime}-{FILE_ID}-\{Name}.gia
  let exportName = '';
  const m = exportTag.match(/\\(.+)\.gia$/);
  if (m) exportName = m[1];

  // owner lookup + bake each object's world offset/zoom into its decorations,
  // so records are object-independent and ready for splitIntoModels()
  const objByGuid = new Map(objects.map((o, i) => [o.guid, { o, i }]));
  const out = [];
  for (const dec of decorations) {
    const owner = dec.parentGuid != null ? objByGuid.get(dec.parentGuid) : undefined;
    const rec = { ...dec, ownerIndex: owner?.i ?? -1, ownerName: owner?.o.name ?? '', ownerGuid: dec.parentGuid };
    if (owner) {
      const { position: op, zoom } = owner.o;
      // world meters = objPos + decPos * zoom; re-expressed in the writer's
      // default frame (object at origin, zoom 0.1): pos' = pos*(zoom/0.1) + objPos*10
      const fx = zoom.x / 0.1, fy = zoom.y / 0.1, fz = zoom.z / 0.1;
      rec.position = {
        x: rec.position.x * fx + op.x * 10,
        y: rec.position.y * fy + op.y * 10,
        z: rec.position.z * fz + op.z * 10,
      };
      if (Math.abs(fx - 1) > 1e-4 || Math.abs(fy - 1) > 1e-4 || Math.abs(fz - 1) > 1e-4) {
        rec.scale = { x: rec.scale.x * fx, y: rec.scale.y * fy, z: rec.scale.z * fz };
      }
    }
    out.push(rec);
  }

  return {
    exportName, exportTag, engineVersion,
    collision: objects.some((o) => o.collision),
    autoAssemble: graphCount > 0 && objects.some((o) => o.dynamic),
    objects,
    decorations: out,
  };
}

export { KIND_BY_MODEL_ID };
export default { parseGia, KIND_BY_MODEL_ID };
