/**
 * Tiny, streaming-friendly WebM (EBML) helpers.
 *
 * MediaRecorder writes WebM without a Duration, so players show "Infinity" and can't
 * seek. Instead of remuxing (ffmpeg.wasm → RAM-bound), we parse only the header,
 * inject a Duration element into Segment/Info and splice the patched prefix in front
 * of a disk-backed `file.slice()`. Nothing large is ever loaded into memory.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
const ID_BLOCK = 0xa1;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

function readId(b: Uint8Array, pos: number): Vint | null {
  if (pos >= b.length) return null;
  const len = vintLength(b[pos]);
  if (!len || len > 4 || pos + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return { value: v, length: len, unknown: false };
}

function readSize(b: Uint8Array, pos: number): Vint | null {
  if (pos >= b.length) return null;
  const len = vintLength(b[pos]);
  if (!len || pos + len > b.length) return null;
  let v = b[pos] & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value: v, length: len, unknown: allOnes };
}

function encodeSize8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return v;
}

export interface DurationPatch {
  prefix: Uint8Array;
  /** Byte offset in the original file where the remainder continues. */
  resumeAt: number;
}

/** Build a header patch that injects `durationMs` into a WebM file. Returns null if not applicable. */
export async function buildDurationPatch(file: Blob, durationMs: number): Promise<DurationPatch | null> {
  if (!(durationMs > 0)) return null;
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  let pos = 0;

  const ebml = readId(head, pos);
  if (!ebml || ebml.value !== ID_EBML) return null;
  pos += ebml.length;
  const ebmlSize = readSize(head, pos);
  if (!ebmlSize || ebmlSize.unknown) return null;
  pos += ebmlSize.length + ebmlSize.value;

  const seg = readId(head, pos);
  if (!seg || seg.value !== ID_SEGMENT) return null;
  pos += seg.length;
  const segSize = readSize(head, pos);
  if (!segSize) return null;
  // Only patch the common MediaRecorder case (unknown-size segment); otherwise sizes would need fixing.
  if (!segSize.unknown) return null;
  pos += segSize.length;

  // Walk Segment children until Info.
  while (pos < head.length) {
    const id = readId(head, pos);
    if (!id) return null;
    const size = readSize(head, pos + id.length);
    if (!size || size.unknown) return null;
    const dataStart = pos + id.length + size.length;
    const dataEnd = dataStart + size.value;
    if (id.value === ID_CLUSTER) return null;
    if (id.value === ID_INFO) {
      if (dataEnd > head.length) return null;
      let timecodeScale = 1_000_000;
      let p = dataStart;
      while (p < dataEnd) {
        const cid = readId(head, p);
        if (!cid) return null;
        const cs = readSize(head, p + cid.length);
        if (!cs) return null;
        const cdata = p + cid.length + cs.length;
        if (cid.value === ID_DURATION) return null; // already has duration
        if (cid.value === ID_TIMECODE_SCALE) timecodeScale = readUint(head, cdata, cs.value);
        p = cdata + cs.value;
      }
      const durationEl = new Uint8Array(11);
      durationEl[0] = 0x44;
      durationEl[1] = 0x89;
      durationEl[2] = 0x88; // size = 8
      new DataView(durationEl.buffer).setFloat64(3, (durationMs * 1_000_000) / timecodeScale);

      const infoContent = head.subarray(dataStart, dataEnd);
      const newSize = encodeSize8(infoContent.length + durationEl.length);
      const idBytes = head.subarray(pos, pos + id.length);
      const before = head.subarray(0, pos);

      const prefix = new Uint8Array(before.length + idBytes.length + 8 + infoContent.length + durationEl.length);
      let o = 0;
      prefix.set(before, o); o += before.length;
      prefix.set(idBytes, o); o += idBytes.length;
      prefix.set(newSize, o); o += 8;
      prefix.set(infoContent, o); o += infoContent.length;
      prefix.set(durationEl, o);
      return { prefix, resumeAt: dataEnd };
    }
    pos = dataEnd;
  }
  return null;
}

/** Returns a Blob (still disk-backed for the bulk) with the duration injected, or the original file. */
export async function withDuration(file: File, durationMs: number, type: string): Promise<Blob> {
  try {
    if (!type.includes('webm')) return file;
    const patch = await buildDurationPatch(file, durationMs);
    if (!patch) return file;
    return new Blob([patch.prefix as BlobPart, file.slice(patch.resumeAt)], { type });
  } catch {
    return file;
  }
}

/**
 * Estimate the real media duration of a (possibly truncated) MediaRecorder WebM by reading
 * the last cluster near the end of the file. Used for crash-recovered sessions.
 */
export async function probeWebmDurationMs(file: Blob): Promise<number | null> {
  const tailSize = Math.min(file.size, 8 * 1024 * 1024);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());

  // Find the last Cluster ID occurrence.
  let clusterPos = -1;
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] === 0x1f && tail[i + 1] === 0x43 && tail[i + 2] === 0xb6 && tail[i + 3] === 0x75) {
      clusterPos = i;
      break;
    }
  }
  if (clusterPos < 0) return null;

  let pos = clusterPos + 4;
  const csize = readSize(tail, pos);
  if (!csize) return null;
  pos += csize.length;
  const end = csize.unknown ? tail.length : Math.min(tail.length, pos + csize.value);

  let clusterTc: number | null = null;
  let maxRel = 0;
  const scanBlock = (p: number) => {
    const track = readSize(tail, p);
    if (!track || p + track.length + 2 > tail.length) return;
    const rel = new DataView(tail.buffer, tail.byteOffset + p + track.length, 2).getInt16(0);
    if (rel > maxRel) maxRel = rel;
  };

  while (pos < end) {
    const id = readId(tail, pos);
    if (!id) break;
    const size = readSize(tail, pos + id.length);
    if (!size) break;
    const data = pos + id.length + size.length;
    if (id.value === ID_TIMECODE && data + size.value <= tail.length) {
      clusterTc = readUint(tail, data, size.value);
    } else if (id.value === ID_SIMPLEBLOCK) {
      scanBlock(data);
    } else if (id.value === ID_BLOCKGROUP) {
      const inner = readId(tail, data);
      if (inner && inner.value === ID_BLOCK) {
        const isz = readSize(tail, data + inner.length);
        if (isz) scanBlock(data + inner.length + isz.length);
      }
    } else if (id.value === ID_CLUSTER) {
      break;
    }
    if (size.unknown) break;
    pos = data + size.value;
  }
  if (clusterTc === null) return null;
  // Assumes default TimecodeScale (1ms), which is what MediaRecorder writes.
  return clusterTc + maxRel;
}
