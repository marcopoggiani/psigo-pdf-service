import test from "node:test";
import assert from "node:assert/strict";
import { ocrPdfIfNeeded, detectPsychologistEvidence } from "../ocr.mjs";

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

test("smart OCR refuses unbounded documents even when scanning for evidence", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 26, mode: "smart" });
  assert.equal(result.ocr.status, "limits_exceeded");
  assert.equal(result.ocr.maxPages, 25);
});

test("smart discovery marks embedded text separately from complete verification", async () => {
  const embedded = "Psicologo. Laurea magistrale in psicologia. Iscrizione all'albo professionale. Scadenza 19/11/2026. ".repeat(25);
  const result = await ocrPdfIfNeeded(mockPdf, { text: embedded, pages: 13, mode: "smart" });
  assert.equal(result.ocr.status, "discovery_embedded_text");
  assert.equal(result.ocr.complete, true);
  assert.equal(result.ocr.fieldsFound.role, true);
  assert.equal(result.ocr.fieldsFound.degree, true);
  assert.equal(result.ocr.fieldsFound.register, true);
  assert.equal(result.ocr.fieldsFound.deadline, true);
});

test("smart detector does not invent a deadline or professional qualifications", () => {
  const fields = detectPsychologistEvidence("Concorso per psicologo, scadenza da comunicare.");
  assert.equal(fields.role, true);
  assert.equal(fields.deadline, false);
  assert.equal(fields.degree, false);
  assert.equal(fields.register, false);
});

test("chunk OCR rejects a page index outside the document", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 13, mode: "chunk", startPage: 14 });
  assert.equal(result.ocr.status, "invalid_chunk_range");
});

test("chunk OCR refuses more than two pages per call", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 13, mode: "chunk", startPage: 1, pageLimit: 3 });
  assert.equal(result.ocr.status, "invalid_chunk_range");
});

test("chunk OCR rejects documents over thirty pages", async () => {
  const result = await ocrPdfIfNeeded(mockPdf, { text: "", pages: 31, mode: "chunk", startPage: 1, pageLimit: 2 });
  assert.equal(result.ocr.status, "limits_exceeded");
  assert.equal(result.ocr.maxPages, 30);
});
