import test from "node:test";
import assert from "node:assert/strict";

import { cleanForWake, extractWakeCommand } from "../src/wake-word.js";

test("strict wake variants still work", () => {
  assert.equal(extractWakeCommand("การ์ด"), "");
  assert.equal(extractWakeCommand("การด ตอนนี้กี่โมง"), "ตอนนี้กี่โมง");
  assert.equal(extractWakeCommand("ก๊าด เปิดเพลง"), "เปิดเพลง");
  assert.equal(extractWakeCommand("hey guard, hello"), "hello");
});

test("ordinary Thai speech no longer false-triggers Guard", () => {
  assert.equal(extractWakeCommand("คาดว่าจะไปพรุ่งนี้"), null);
  assert.equal(extractWakeCommand("ผมเอาการ์ดเกมมา"), null);
  assert.equal(extractWakeCommand("การ์ดเกม"), null);
  assert.equal(extractWakeCommand("guardian เปิดประตู"), null);
  assert.equal(extractWakeCommand("อากาศดีจัง"), null);
});

test("leading STT noise and short fillers are handled", () => {
  assert.equal(cleanForWake("[เสียงเพลง]  การ์ด"), "การ์ด");
  assert.equal(extractWakeCommand("เอ่อ การ์ด ช่วยหน่อย"), "ช่วยหน่อย");
});

test("Thai commands still wake when STT removes the word boundary", () => {
  assert.equal(extractWakeCommand("การ์ดปิดไมค์ทุกคน"), "ปิดไมค์ทุกคน");
  assert.equal(extractWakeCommand("กาดช่วยสร้างห้องชื่อเกม"), "ช่วยสร้างห้องชื่อเกม");
  assert.equal(extractWakeCommand("การ์ดวันนี้วันอะไร"), "วันนี้วันอะไร");

  // Keep noun compounds quiet: prefix matching alone is not a wake call.
  assert.equal(extractWakeCommand("การ์ดเกมใบนี้หายาก"), null);
  assert.equal(extractWakeCommand("การ์ดจอรุ่นนี้แรง"), null);
});
