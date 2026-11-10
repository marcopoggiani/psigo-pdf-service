// PsiGo PDF Service: bounded offline OCR with Poppler and Tesseract.
// Does not fetch URLs, run a shell, or depend on paid third-party APIs.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_PAGES = 6;
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_TEXT = 190_000;
const MAX_OUTPUT = 300_000;
const MAX_DIMENSION = 1700;
const PROCESS_TIMEOUT_MS = 20_000;
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

/**
 * OCR only when explicitly requested with {ocr:"auto"} and the PDF has
 * insufficient embedded text. Never claim a partial document is verified.
 * An unsuccessful OCR returns the original pdf-parse text untouched.
 */
export async function ocrPdfIfNeeded(buffer, { text = "", pages = null, mode = "off" } = {}) {
  const embedded = String(text || "").replace(/\s+/g, " ").trim();
  const pageCount = Number(pages);
  if (mode !== "auto") return { text: embedded, ocr: { status: "not_requested" } };
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { text: embedded, ocr: { status: "invalid_page_count" } };
  }
  if (embedded.length >= Math.max(140, pageCount * 90)) {
    return { text: embedded, ocr: { status: "not_needed" } };
  }
  if (pageCount > MAX_PAGES || !Buffer.isBuffer(buffer) || buffer.length > MAX_INPUT) {
    return { text: embedded, ocr: { status: "limits_exceeded", pages: pageCount, maxPages: MAX_PAGES } };
  }
  if (running) return { text: embedded, ocr: { status: "busy" } };
  running = true;
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "psigo-ocr-"));
    const input = join(dir, "source.pdf");
    await writeFile(input, buffer, { mode: 0o600 });
    const pageTexts = [];
    for (let i = 1; i <= pageCount; i++) {
      const output = join(dir, "page-" + i);
      await run("pdftoppm", [
        "-f", String(i), "-l", String(i), "-singlefile",
        "-scale-to", String(MAX_DIMENSION), "-png", "-r", "140", input, output,
      ]);
      const png = output + ".png";
      const extracted = await run("tesseract", [png, "stdout", "-l", "ita+eng", "--psm", "3"], {
        timeoutMs: PROCESS_TIMEOUT_MS,
      });
      const normalized = extracted.replace(/\s+/g, " ").trim();
      pageTexts.push(normalized);
      if (pageTexts.join(" ").length > MAX_TEXT) throw new Error("ocr_text_limit");
      await rm(png, { force: true });
    }
    const recognized = pageTexts.join(" ").replace(/\s+/g, " ").trim();
    if (!recognized || recognized.length < 40) {
      return { text: embedded, ocr: { status: "no_text_recognized", pages: pageCount } };
    }
    const merged = embedded.length < 40 ? recognized : [embedded, recognized].join(" ");
    if (merged.length > MAX_TEXT) throw new Error("ocr_text_limit");
    return {
      text: merged,
      ocr: { status: "completed", pages: pageCount, engine: "tesseract",
        languages: "ita+eng", characters: recognized.length },
    };
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "ocr_binary_unavailable" :
      String(error?.message || "ocr_failed").split(":")[0].slice(0, 80);
    return { text: embedded, ocr: { status: "failed", reason } };
  } finally {
    running = false;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
