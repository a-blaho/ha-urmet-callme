import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt } from "./urmetCrypto.js";

// Same constant as urmetCrypto.ts; duplicated on purpose so a silent edit to the module's key
// breaks this test instead of decrypting real sipdata into garbage.
const STATIC_KEY = Buffer.from([
  25, 34, 242, 185, 102, 22, 241, 144, 0, 255, 255, 169, 97, 68, 79, 139, 229, 63, 246, 35, 155,
  215, 224, 116, 202, 127, 236, 71, 55, 175, 192, 232,
]);

/** Encrypt the way the app's UrmetCrypto does for small payloads: XOR with a per-blob key, then
 *  append that key masked by the static key. */
function encrypt(plain: Buffer, perKey: Buffer): Buffer {
  const body = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) body[i] = plain[i] ^ perKey[i % 32];
  const masked = Buffer.alloc(32);
  for (let j = 0; j < 32; j++) masked[j] = perKey[j] ^ STATIC_KEY[j];
  return Buffer.concat([body, masked]);
}

test("decrypt inverts the append-key framing", () => {
  const perKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));
  const plain = Buffer.from('{"sip":{"user":"cfw_1234","pass":"x"}}'.repeat(3));
  assert.deepEqual(decrypt(encrypt(plain, perKey)), plain);
});

test("decrypt handles a payload longer than one key period", () => {
  const perKey = Buffer.alloc(32, 0x5a);
  const plain = Buffer.alloc(1000, 0x33);
  assert.deepEqual(decrypt(encrypt(plain, perKey)), plain);
});

test("decrypt edge cases", () => {
  assert.equal(decrypt(Buffer.alloc(0)).length, 0);
  assert.throws(() => decrypt(Buffer.alloc(31)), /shorter than key block/);
  assert.equal(decrypt(Buffer.alloc(32)).length, 0); // key only, empty body
  assert.throws(() => decrypt(Buffer.alloc(1498752 + 32)), /embedded-key/);
});
