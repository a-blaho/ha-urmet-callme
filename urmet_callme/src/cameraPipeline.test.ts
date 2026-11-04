import assert from "node:assert/strict";
import { test } from "node:test";
import { listenControl } from "./cameraPipeline.js";

test("listenControl binds 127.0.0.1 on an ephemeral port and serves the handler", async () => {
  const { server, port } = await listenControl(async (req, res) => {
    res.writeHead(200).end(`hit ${req.url}`);
  }, "test endpoint");
  try {
    assert.ok(port > 0);
    const res = await fetch(`http://127.0.0.1:${port}/call?cam=1`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hit /call?cam=1");
  } finally {
    server.close();
  }
});

test("a throwing handler answers 500 instead of leaving the request open or crashing", async () => {
  const { server, port } = await listenControl(async () => {
    throw new Error("boom");
  }, "test endpoint");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hangup`);
    assert.equal(res.status, 500);
  } finally {
    server.close();
  }
});
