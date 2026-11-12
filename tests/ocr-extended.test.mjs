import test from "node:test";
import assert from "node:assert/strict";
import { ocrPdfIfNeeded } from "../ocr.mjs";

const mockPdf = Buffer.from("%PDF-mock", "utf8");

test("standard OCR safely refuses a 13-page document", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 13, mode: "auto" });
  assert.equal(result.ocr.status, "limits_exceeded");
  assert.equal(result.ocr.maxPages, 6);
  assert.equal(result.text, "");
});

test("extended OCR still refuses documents over 14 pages", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 15, mode: "extended" });
  assert.equal(result.ocr.status, "limits_exceeded");
  assert.equal(result.ocr.maxPages, 14);
  assert.equal(result.text, "");
});

test("extended OCR preserves trustworthy embedded text without OCR processes", async () => {
  const embedded = "Laurea in psicologia e iscrizione all'albo. ".repeat(50);
  const result = await ocrPdfIfNeeded(mockPdf, { text: embedded, pages: 13, mode: "extended" });
  assert.equal(result.ocr.status, "not_needed");
  assert.equal(result.text, embedded.trim());
});

test("without requested OCR, default behavior remains unchanged", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 13, mode: "off" });
  assert.equal(result.ocr.status, "not_requested");
});
