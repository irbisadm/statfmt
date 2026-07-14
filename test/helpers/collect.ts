import { Writer } from "../../src/writer.js";

/** Create a Writer that accumulates output into an in-memory buffer. */
export function collectingWriter(): { writer: Writer; getBytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  const writer = new Writer();
  writer.setDataWriter((data: Uint8Array) => {
    chunks.push(data.slice());
    return data.length;
  });
  return {
    writer,
    getBytes: () => {
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
  };
}
