// PsiGo PDF Service: bounded offline OCR with Poppler and Tesseract.
// Does not fetch URLs, run a shell, or depend on paid third-party APIs.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_PAGES = 6;
const MAX_EXTENDED_PAGES = 14;
const MAX_SMART_PAGES = 25;
const EXTENDED_TOTAL_TIMEOUT_MS = 95000;
const SMART_TOTAL_TIMEOUT_MS = 90000;
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_TEXT = 190_000;
const MAX_OUTPUT = 300_000;
const MAX_DIMENSION = 1300;
const FAST_DIMENSION = 900;
const PROCESS_TIMEOUT_MS = 26_000;
let running = false;

function run(binary, args, { timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    const chunks = [];
    let length = 0;
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ocr_process_timeout"));
    }, timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    }
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("ocr_output_limit"));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-400);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error("ocr_process_failed:" + code + ":" + stderr.slice(0, 120)));
      else finish(null, Buffer.concat(chunks).toString("utf8"));
    });
  });
}


// Fast heuristic for discovery only: NEVER enough to authorize publication.
// Terms may occur in unrelated contexts. The publishing verifier must validate
// applicability, dates, all pages and potential corrections separately.
export function detectPsychologistEvidence(value) {
  const text = String(value || "").replace(/\s+/g, " ");
  return {
    role: /\b(?:dirigente\s+)?psicolog(?:o|a|i|he)\b/i.test(text),
    degree: /\b(?:laurea|titolo\s+di\s+studio)\b.{0,100}\b(?:psicologia|lm[\s-]*51)\b|\b(?:psicologia|lm[\s-]*51)\b.{0,60}\blaurea\b/i.test(text),
    register: /\b(?:iscrizione\s+(?:all['’]?\s*)?albo|albo\s+(?:professionale|degli?\s+psicologi)|abilitazione\s+all['’]?\s*esercizio)\b/i.test(text),
    deadline: /\b(?:scadenza|termine\s+(?:per\s+)?(?:la\s+)?presentazione\s+(?:delle?\s+)?domande|presentare\s+(?:la\s+)?domanda)\b.{0,140}(?:\b\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2}\b|\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+20\d{2}\b)/i.test(text),
  };
}
function evidenceComplete(fields) {
  return fields.role && fields.degree && fields.register && fields.deadline;
}

/**
 * OCR only when explicitly requested with {ocr:"auto"} or the separately authorized
 * {ocr:"extended"} for a maximum of 14 pages and 95 seconds.
 * {ocr:"smart"} is discovery-only (25 pages/90 seconds max), stopping when
 * all four clue categories appear, with explicit partial_evidence status.
 * Never use smart OCR as standalone proof for publication. The PDF has
 * insufficient embedded text. Never claim a partial document is verified.
 * An unsuccessful OCR returns the original pdf-parse text untouched.
 */
export async function ocrPdfIfNeeded(buffer, { text = "", pages = null, mode = "off" } = {}) {
  const embedded = String(text || "").replace(/\s+/g, " ").trim();
  const pageCount = Number(pages);
  const extended = mode === "extended";
  const smart = mode === "smart";
  if (mode !== "auto" && !extended && !smart) return { text: embedded, ocr: { status: "not_requested" } };
  const maxPages = smart ? MAX_SMART_PAGES : extended ? MAX_EXTENDED_PAGES : MAX_PAGES;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { text: embedded, ocr: { status: "invalid_page_count" } };
  }
  if (embedded.length >= Math.max(140, pageCount * 90)) {
    if (smart) return { text: embedded, ocr: { status: "discovery_embedded_text",
      complete: true, pagesProcessed: 0, pagesTotal: pageCount,
      fieldsFound: detectPsychologistEvidence(embedded) } };
    return { text: embedded, ocr: { status: "not_needed" } };
  }
  if (pageCount > maxPages || !Buffer.isBuffer(buffer) || buffer.length > MAX_INPUT) {
    return { text: embedded, ocr: { status: "limits_exceeded", pages: pageCount, maxPages } };
  }
  if (running) return { text: embedded, ocr: { status: "busy" } };
  running = true;
  let dir;
  const pageTexts = [];
  let stage = "initializing";
  const deadline = Date.now() + (smart ? SMART_TOTAL_TIMEOUT_MS : extended ? EXTENDED_TOTAL_TIMEOUT_MS : Number.POSITIVE_INFINITY);
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 1500) throw new Error("ocr_total_timeout");
    return Math.min(PROCESS_TIMEOUT_MS, remaining);
  };
  try {
    dir = await mkdtemp(join(tmpdir(), "psigo-ocr-"));
    const input = join(dir, "source.pdf");
    await writeFile(input, buffer, { mode: 0o600 });
    let earlyStopped = false;
    for (let i = 1; i <= pageCount; i++) {
      const output = join(dir, "page-" + i);
      const tuned = smart || extended;
      stage = "rasterize_page_" + i;
      await run("pdftoppm", [
        "-f", String(i), "-l", String(i), "-singlefile",
        "-scale-to", String(tuned ? FAST_DIMENSION : MAX_DIMENSION),
        "-gray", "-r", tuned ? "96" : "120", input, output,
      ], { timeoutMs: remainingTimeout() });
      const image = output + ".pgm";
      stage = "recognize_page_" + i;
      const extracted = await run("tesseract", [
        image, "stdout", "-l", tuned ? "ita" : "ita+eng",
        "--psm", tuned ? "6" : "3",
      ], { timeoutMs: remainingTimeout() });
      const normalized = extracted.replace(/\s+/g, " ").trim();
      pageTexts.push(normalized);
      if (pageTexts.join(" ").length > MAX_TEXT) throw new Error("ocr_text_limit");
      await rm(image, { force: true });
      if (smart && i < pageCount &&
          evidenceComplete(detectPsychologistEvidence([embedded, ...pageTexts].join(" ")))) {
        earlyStopped = true;
        break;
      }
    }
    const recognized = pageTexts.join(" ").replace(/\s+/g, " ").trim();
    if (!recognized || recognized.length < 40) {
      return { text: embedded, ocr: { status: "no_text_recognized", pages: pageCount } };
    }
    const merged = embedded.length < 40 ? recognized : [embedded, recognized].join(" ");
    if (merged.length > MAX_TEXT) throw new Error("ocr_text_limit");
    return {
      text: merged,
      ocr: smart
        ? { status: earlyStopped ? "discovery_partial_evidence" : "discovery_complete",
            complete: !earlyStopped, pagesTotal: pageCount, pagesProcessed: pageTexts.length,
            fieldsFound: detectPsychologistEvidence(merged), engine: "tesseract",
            languages: "ita+eng", characters: recognized.length }
        : { status: "completed", pages: pageCount, engine: "tesseract",
            languages: "ita+eng", characters: recognized.length },
    };
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "ocr_binary_unavailable" :
      String(error?.message || "ocr_failed").split(":")[0].slice(0, 80);
    if (smart) {
      const recognized = pageTexts.join(" ").replace(/\s+/g, " ").trim();
      const partial = [embedded, recognized].filter(Boolean).join(" ");
      // Discovery can resume diagnostics after timeout, but never publish
      // from an incomplete document. Preserve progress without claiming proof.
      return { text: partial, ocr: {
        status: "discovery_incomplete", reason, stage, complete: false,
        pagesTotal: pageCount, pagesProcessed: pageTexts.length,
        fieldsFound: detectPsychologistEvidence(partial),
      } };
    }
    return { text: embedded, ocr: { status: "failed", reason, stage } };
  } finally {
    running = false;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
