// Minimal, dependency-free ZIP writer (STORE / no compression).
// Enough to bundle a set of generated .md files into a single downloadable
// archive. Implements the standard local-file + central-directory layout with
// CRC-32 so the produced .zip opens in any extractor.

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Uint8Array; crc: number; offset: number };

function pushU16(arr: number[], v: number) {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(arr: number[], v: number) {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Build a ZIP blob from { path -> text content } files. */
export function buildZip(files: { path: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  const { time, date } = dosDateTime(new Date());
  let offset = 0;

  const seen = new Map<string, number>();
  for (const f of files) {
    let name = f.path.replace(/^\/+/, "");
    // De-duplicate identical paths so nothing is silently dropped.
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count > 0) {
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
    }

    const nameBytes = enc.encode(name);
    const data = enc.encode(f.content);
    const crc = crc32(data);

    const local: number[] = [];
    pushU32(local, 0x04034b50);
    pushU16(local, 20); // version needed
    pushU16(local, 0); // flags
    pushU16(local, 0); // method: store
    pushU16(local, time);
    pushU16(local, date);
    pushU32(local, crc);
    pushU32(local, data.length); // compressed size
    pushU32(local, data.length); // uncompressed size
    pushU16(local, nameBytes.length);
    pushU16(local, 0); // extra length

    const localHeader = Uint8Array.from(local);
    chunks.push(localHeader, nameBytes, data);
    entries.push({ name, data, crc, offset });
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const central: number[] = [];
    pushU32(central, 0x02014b50);
    pushU16(central, 20); // version made by
    pushU16(central, 20); // version needed
    pushU16(central, 0); // flags
    pushU16(central, 0); // method: store
    pushU16(central, time);
    pushU16(central, date);
    pushU32(central, e.crc);
    pushU32(central, e.data.length);
    pushU32(central, e.data.length);
    pushU16(central, nameBytes.length);
    pushU16(central, 0); // extra
    pushU16(central, 0); // comment
    pushU16(central, 0); // disk number
    pushU16(central, 0); // internal attrs
    pushU32(central, 0); // external attrs
    pushU32(central, e.offset);

    const header = Uint8Array.from(central);
    chunks.push(header, nameBytes);
    centralSize += header.length + nameBytes.length;
  }

  const end: number[] = [];
  pushU32(end, 0x06054b50);
  pushU16(end, 0); // disk
  pushU16(end, 0); // disk with CD
  pushU16(end, entries.length);
  pushU16(end, entries.length);
  pushU32(end, centralSize);
  pushU32(end, centralStart);
  pushU16(end, 0); // comment length
  chunks.push(Uint8Array.from(end));

  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}

export function downloadZip(name: string, files: { path: string; content: string }[]) {
  const blob = buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".zip") ? name : `${name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
