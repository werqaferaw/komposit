// For tests: Premiere Pro transcript bytes and a saved project that holds them, built to the
// layout Premiere writes (worked out in 1.0 from real projects, which stay private), so the
// reader in transcripts.ts is held to it. Ported from 1.0's test/transcript.test.mjs.
import { gzipSync } from "node:zlib";

const TICKS = 254016000000n;
type Node = { k: "i64"; v: bigint } | { k: "f32"; v: number } | { k: "u32"; v: number } | { k: "str"; v: string } | { k: "vec"; v: Node[] } | { k: "tbl"; v: (Node | null)[] };

const i64 = (sec: number): Node => ({ k: "i64", v: BigInt(Math.round(sec * 1000)) * (TICKS / 1000n) });
const raw64 = (v: bigint): Node => ({ k: "i64", v });
const f32 = (v: number): Node => ({ k: "f32", v });
const u32 = (v: number): Node => ({ k: "u32", v });
const str = (v: string): Node => ({ k: "str", v });
const vec = (v: Node[]): Node => ({ k: "vec", v });
const tbl = (v: (Node | null)[]): Node => ({ k: "tbl", v });

/** A small FlatBuffer writer: tables hold scalars inline and point forward to strings,
 *  vectors and other tables (written after them, then patched). */
function build(rootTable: Node): Buffer {
  const chunks: Buffer[] = [Buffer.alloc(4)];
  let size = 4;
  const patches: [number, number][] = [];
  const put = (b: Buffer) => { const at = size; chunks.push(b); size += b.length; return at; };
  const pad = () => { if (size % 4) put(Buffer.alloc(4 - (size % 4))); };
  const pending: [number, Node][] = [[0, rootTable]];
  const sizes: Record<string, number> = { i64: 8, f32: 4, u32: 4, str: 4, vec: 4, tbl: 4 };
  function write(node: Node): number {
    pad();
    if (node.k === "str") { const s = Buffer.from(node.v, "utf8"), b = Buffer.alloc(4 + s.length + 1); b.writeUInt32LE(s.length, 0); s.copy(b, 4); return put(b); }
    if (node.k === "vec") { const b = Buffer.alloc(4 + node.v.length * 4); b.writeUInt32LE(node.v.length, 0); const at = put(b); node.v.forEach((child, i) => pending.push([at + 4 + i * 4, child])); return at; }
    if (node.k !== "tbl") throw new Error("only tables, vectors and strings stand alone");
    let tlen = 4;
    const offs = node.v.map((f) => { if (!f) return 0; const o = tlen; tlen += sizes[f.k]!; return o; });
    const vlen = 4 + offs.length * 2, vt = Buffer.alloc(vlen + (vlen % 4 ? 2 : 0));
    vt.writeUInt16LE(vlen, 0); vt.writeUInt16LE(tlen, 2); offs.forEach((o, i) => vt.writeUInt16LE(o, 4 + i * 2));
    const vAt = put(vt), t = Buffer.alloc(tlen), tAt = size;
    t.writeInt32LE(tAt - vAt, 0);
    node.v.forEach((f, i) => {
      if (!f) return;
      const o = offs[i]!;
      if (f.k === "i64") t.writeBigInt64LE(f.v, o);
      else if (f.k === "f32") t.writeFloatLE(f.v, o);
      else if (f.k === "u32") t.writeUInt32LE(f.v, o);
      else pending.push([tAt + o, f]);
    });
    put(t);
    return tAt;
  }
  while (pending.length) { const [where, node] = pending.shift()!; patches.push([where, write(node)]); }
  const buf = Buffer.concat(chunks, size);
  for (const [where, at] of patches) buf.writeUInt32LE(at - where, where);
  return buf;
}

const word = (start: number, len: number, text: string, conf = 1, pause = false) => tbl([start === 0 ? null : i64(start), i64(len), str(text), f32(conf), null, null, pause ? u32(3) : null]);
const speaker = (name: string, a: bigint, b: bigint) => tbl([str(name), tbl([raw64(a), raw64(b)])]);
const segment = (start: number, len: number, id: [bigint, bigint], words: Node[]) => tbl([start === 0 ? null : i64(start), i64(len), tbl([raw64(id[0]), raw64(id[1])]), vec(words), str("en-us")]);
const HOST: [bigint, bigint] = [11n, 12n], GUEST: [bigint, bigint] = [21n, 22n];

/** Two speakers: the host from 0 s ("What's up guys. Welcome", a pause token in it) and the
 *  guest from 4 s ("Thanks for having me."), in the source's seconds. */
export function transcriptBytes(): Buffer {
  return build(tbl([tbl([
    vec([
      segment(0, 3, HOST, [word(0, 0.4, "What's"), word(0.4, 0.2, "up"), word(0.6, 0.5, "guys.", 0.9), word(1.1, 0.8, " ", 1, true), word(2, 0.5, "Welcome", 0.75)]),
      segment(4, 2.5, GUEST, [word(4, 0.3, "Thanks"), word(4.3, 0.2, "for"), word(4.5, 0.4, "having"), word(4.9, 0.3, "me.")]),
    ]),
    str("en-us"),
    vec([speaker("Host", HOST[0], HOST[1]), speaker("Speaker 2", GUEST[0], GUEST[1])]),
  ])]));
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A saved Premiere project (gzip of XML) in which the clip `name`, whose media is `mediaPath`,
 *  is transcribed with transcriptBytes(). */
export function projectWithTranscript(name: string, mediaPath: string): Buffer {
  const data = transcriptBytes().toString("base64");
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
	<MasterClip ObjectUID="aaaa-1" ClassID="x" Version="12">
		<Clips Version="1">
			<Clip Index="0" ObjectRef="42"/>
			<Clip Index="1" ObjectRef="43"/>
			<Clip Index="2" ObjectRef="44"/>
		</Clips>
		<Name>${xmlText(name)}</Name>
	</MasterClip>
	<MasterClip ObjectUID="aaaa-2" ClassID="x" Version="12">
		<Clips Version="1">
			<Clip Index="0" ObjectRef="90"/>
		</Clips>
		<Name>silent.mp4</Name>
	</MasterClip>
	<VideoClip ObjectID="42" ClassID="x" Version="11"><Clip Version="18"><Source ObjectRef="52"/></Clip></VideoClip>
	<AudioClip ObjectID="43" ClassID="x" Version="8"><Clip Version="18"><Source ObjectRef="54"/></Clip></AudioClip>
	<TranscriptClip ObjectID="44" ClassID="x" Version="2">
		<DataClip Version="1"><Clip Version="18"><Source ObjectRef="57"/></Clip></DataClip>
		<TranscriptTextSegments ObjectRef="58"/>
	</TranscriptClip>
	<VideoClip ObjectID="90" ClassID="x" Version="11"><Clip Version="18"><Source ObjectRef="52"/></Clip></VideoClip>
	<VideoMediaSource ObjectID="52" ClassID="x" Version="2"><MediaSource Version="4"><Media ObjectURef="mmmm-1"/></MediaSource></VideoMediaSource>
	<AudioMediaSource ObjectID="54" ClassID="x" Version="2"><MediaSource Version="4"><Media ObjectURef="mmmm-1"/></MediaSource></AudioMediaSource>
	<ExternallyProvidedTranscriptDocument ObjectID="58" ClassID="x" Version="1">
		<TranscriptProvider>9a13</TranscriptProvider>
		<TranscriptData Encoding="base64" BinaryHash="h">${data}</TranscriptData>
	</ExternallyProvidedTranscriptDocument>
	<Media ObjectUID="mmmm-1" ClassID="x" Version="30">
		<FilePath>/Volumes/Old/${xmlText(name)}</FilePath>
		<Title>${xmlText(name)}</Title>
		<ActualMediaFilePath>${xmlText(mediaPath)}</ActualMediaFilePath>
	</Media>
</PremiereData>`;
  return gzipSync(Buffer.from(xml, "utf8"));
}
