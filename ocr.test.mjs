import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ocrPdfIfNeeded } from "./ocr.mjs";

test("old callers never activate OCR", async () => {
  const result = await ocrPdfIfNeeded(Buffer.from("%PDF-"), { text:"testo ufficiale", pages:1 });
  assert.equal(result.text, "testo ufficiale");
  assert.equal(result.ocr.status, "not_requested");
});
test("PDF with embedded text skips OCR", async () => {
  const text = "Avviso ufficiale per dirigente psicologo ".repeat(5);
  const result = await ocrPdfIfNeeded(Buffer.from("%PDF-"), { text, pages:1, mode:"auto" });
  assert.equal(result.ocr.status, "not_needed");
  assert.equal(result.text, text.trim());
});
test("too many scanned pages are never partially interpreted", async () => {
  const result = await ocrPdfIfNeeded(Buffer.from("%PDF-"), { text:"", pages:7, mode:"auto" });
  assert.equal(result.ocr.status, "limits_exceeded");
  assert.equal(result.text, "");
});
test("optional image-only PDF fixture is recognized in Italian", {skip: !process.env.PSIGO_OCR_TEST_PDF}, async () => {
  const source = await readFile(process.env.PSIGO_OCR_TEST_PDF);
  const result = await ocrPdfIfNeeded(source, {text:"",pages:1,mode:"auto"});
  assert.equal(result.ocr.status, "completed");
  assert.match(result.text, /psicologo/i);
  assert.match(result.text, /novembre\s+2026/i);
});
