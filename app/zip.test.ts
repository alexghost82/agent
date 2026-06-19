import { describe, it, expect } from "vitest";
import { buildZip } from "./zip";

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

// Decode as latin1 so byte-for-byte signatures/filenames survive (no UTF-8 collapse).
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

describe("buildZip", () => {
  it("produces a Blob with a valid local-file header and EOCD record", async () => {
    const blob = buildZip([{ path: "a.md", content: "hello" }]);
    expect(blob.type).toBe("application/zip");

    const bytes = await bytesOf(blob);
    // Local file header signature: PK\x03\x04
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // End of central directory signature: PK\x05\x06 (last 22 bytes, no comment).
    const eocd = bytes.subarray(bytes.length - 22);
    expect([eocd[0], eocd[1], eocd[2], eocd[3]]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    // Total-entries field in the EOCD should be 1.
    expect(u16(eocd, 10)).toBe(1);
  });

  it("records every file once with the central-directory count matching", async () => {
    const bytes = await bytesOf(
      buildZip([
        { path: "one.md", content: "1" },
        { path: "two.md", content: "2" },
        { path: "three.md", content: "3" }
      ])
    );
    const eocd = bytes.subarray(bytes.length - 22);
    expect(u16(eocd, 8)).toBe(3); // entries on this disk
    expect(u16(eocd, 10)).toBe(3); // total entries
  });

  it("de-duplicates identical paths instead of silently dropping them", async () => {
    const text = latin1(
      await bytesOf(
        buildZip([
          { path: "dup.md", content: "first" },
          { path: "dup.md", content: "second" }
        ])
      )
    );
    // First keeps its name; the collision is renamed with a -1 suffix.
    expect(text).toContain("dup.md");
    expect(text).toContain("dup-1.md");
  });

  it("strips leading slashes from stored paths", async () => {
    const text = latin1(await bytesOf(buildZip([{ path: "/nested/file.md", content: "x" }])));
    expect(text).toContain("nested/file.md");
    expect(text).not.toContain("/nested/file.md");
  });
});
