import { describe, expect, it } from "vitest";
import { downmix, encodeWav, resampleLinear } from "../../src/speakers/audio";
import { entityClass, highlightField } from "../../src/speakers/highlight";
import { setState, visibleDots } from "../../src/speakers/state";
import type { Dot, Entity } from "../../src/speakers/types";

describe("WAV encoding", () => {
  it("writes the header backend/app/audio.py reads", () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(36)).toBe("data");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16); // bits
    expect(v.getUint32(40, true)).toBe(10); // 5 samples × 2 bytes
    expect(buf.byteLength).toBe(54);
  });

  it("quantises to 16 bits and clips", () => {
    const v = new DataView(encodeWav(new Float32Array([0.5, -1, 2]), 8000));
    expect(v.getInt16(44, true)).toBe(Math.floor(0.5 * 0x7fff));
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(v.getInt16(48, true)).toBe(0x7fff);
  });

  it("downmixes by averaging", () => {
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
  });

  it("resamples to the target length", () => {
    const x = new Float32Array(44100).map((_, i) => Math.sin(i / 10));
    const y = resampleLinear(x, 44100, 16000);
    expect(y.length).toBe(16000);
    expect(resampleLinear(x, 16000, 16000)).toBe(x);
  });
});

const ent = (start: number, end: number, label: string, text: string, place: string | null = null): Entity =>
  ({ field: "notes", start, end, text, label, source: "pattern", place, match: place ? "city" : null, lon: null, lat: null });

describe("entity highlighting", () => {
  it("marks entities in place and escapes everything else", () => {
    const text = "<b> born in dallas, 10 july 2015";
    const html = highlightField(text, [ent(12, 18, "LOC", "dallas", "Dallas"), ent(20, 32, "DATE", "10 july 2015")]);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain('<mark class="hl geo" title="LOC → Dallas (city)" data-label="LOC">dallas</mark>');
    expect(html).toContain('<mark class="hl time"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("&lt;b&gt; born in dallas, 10 july 2015");
  });

  it("skips overlapping or out-of-range spans rather than corrupting text", () => {
    const html = highlightField("abc", [ent(0, 2, "LOC", "ab"), ent(1, 3, "LOC", "bc"), ent(2, 9, "LOC", "x")]);
    expect(html.replace(/<[^>]+>/g, "")).toBe("abc");
  });

  it("groups labels into the GeoCRM highlight families", () => {
    expect(entityClass("LOC")).toBe("geo");
    expect(["DATE", "DURATION", "AGE_RANGE"].map(entityClass)).toEqual(["time", "time", "time"]);
    expect(entityClass("COURSE")).toBe("other");
  });
});

const dot = (id: number, native: boolean, recordings = 0, origin: "archive" | "ui" = "archive", lang = native ? "english" : "spanish"): Dot => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: { id, native_language: lang, gender: null, age: null, birthplace: null, match: "city", recordings,
                origin, speech_sample: `${lang}${id}.mp3`, native_english: native },
});

describe("dot filters", () => {
  it("filter by first language, audio and origin", () => {
    setState({ dots: [dot(1, true), dot(2, false, 1), dot(3, true, 2, "ui")] });
    const ids = (f: Parameters<typeof setState>[0]) => {
      setState(f);
      return visibleDots().map((d) => d.properties.id);
    };
    const base = { speakers: "all" as const, language: null, withAudio: false, createdHere: false };
    expect(ids({ filters: base })).toEqual([1, 2, 3]);
    expect(ids({ filters: { ...base, speakers: "native" } })).toEqual([1, 3]);
    expect(ids({ filters: { ...base, speakers: "l2" } })).toEqual([2]);
    expect(ids({ filters: { ...base, withAudio: true } })).toEqual([2, 3]);
    expect(ids({ filters: { ...base, createdHere: true } })).toEqual([3]);
    expect(ids({ filters: { ...base, language: "spanish" } })).toEqual([2]);
  });
});
