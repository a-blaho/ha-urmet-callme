import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, ffmpegArgs, parseProgress, redactArgs } from "./announce.js";

test("classifyMessage plays http(s) URLs and speaks everything else", () => {
  assert.deepEqual(classifyMessage(" https://x.example/chime.mp3 "), {
    kind: "url",
    value: "https://x.example/chime.mp3",
  });
  assert.deepEqual(classifyMessage("HTTP://x/a.wav"), { kind: "url", value: "HTTP://x/a.wav" });
  // Text that merely contains a URL, or a non-http scheme, is spoken - never fetched.
  assert.equal(classifyMessage("see https://x.example now").kind, "tts");
  assert.equal(classifyMessage("file:///etc/passwd").kind, "tts");
  assert.equal(classifyMessage("Leave the parcel at the door").kind, "tts");
});

test("ffmpegArgs decodes to the call's PCM format, URL protocols only", () => {
  const a = ffmpegArgs("http://h/a.mp3", "/tmp/f.pcm", 30, "Bearer tok");
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after("-protocol_whitelist"), "http,https,tcp,tls");
  assert.equal(after("-headers"), "Authorization: Bearer tok\r\n");
  assert.equal(after("-i"), "http://h/a.mp3");
  assert.equal(after("-t"), "30");
  assert.equal(after("-ar"), "8000");
  assert.equal(after("-ac"), "1");
  assert.equal(after("-f"), "s16le");
  assert.equal(a[a.length - 1], "/tmp/f.pcm");
  // The whitelist must precede -i to apply to the input.
  assert.ok(a.indexOf("-protocol_whitelist") < a.indexOf("-i"));
  assert.ok(!ffmpegArgs("http://h/a.mp3", "/f", 30).includes("-headers"));
});

test("redactArgs never prints the auth header", () => {
  const s = redactArgs(ffmpegArgs("http://h/a.mp3", "/tmp/f.pcm", 30, "Bearer secret"));
  assert.ok(!s.includes("secret"));
  assert.ok(s.includes("<auth header>"));
});

test("parseProgress reads ffmpeg -progress blocks", () => {
  const p = parseProgress("total_size=33600\nout_time_us=2100000\nout_time_ms=2100000\nprogress=continue\n");
  assert.deepEqual(p, { totalSize: 33600, outTimeMs: 2100, end: false });
  assert.equal(parseProgress("total_size=N/A\nprogress=end\n").end, true);
  assert.equal(parseProgress("total_size=N/A\nprogress=end\n").totalSize, undefined);
});
