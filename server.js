import express from "express";
import pdf from "pdf-parse";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SERVICE_SECRET = process.env.PDF_SERVICE_SECRET || "";
const FETCH_TIMEOUT_MS = 25000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024; // safe cap for trusted base64 input

/**
 * GET /  → per testare che il servizio risponde
 */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "PsiGo PDF Service" });
});

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function browserHeaders(url, referer = "") {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Accept: "application/pdf,application/octet-stream;q=0.9,text/html;q=0.8,*/*;q=0.7",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  if (referer && isHttpUrl(referer)) {
    headers.Referer = referer;
  } else {
    try {
      const parsed = new URL(url);
      if (/web\.spaggiari\.eu$/i.test(parsed.hostname)) {
        headers.Referer = "https://web.spaggiari.eu/";
      }
    } catch {
      // Nessun referer automatico per URL non validi.
    }
  }

  return headers;
}

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadPdf(url, referer = "") {
  const attempts = [];

  const firstHeaders = browserHeaders(url, referer);
  attempts.push({ name: "browser_headers", headers: firstHeaders });

  try {
    const parsed = new URL(url);
    if (/web\.spaggiari\.eu$/i.test(parsed.hostname)) {
      const schoolReferer = referer || "https://www.cria.edu.it/";
      const schoolHeaders = browserHeaders(url, schoolReferer);
      if (schoolHeaders.Referer !== firstHeaders.Referer) {
        attempts.push({ name: "school_referer", headers: schoolHeaders });
      }
    }
  } catch {
    // L'URL è già stato validato prima di arrivare qui.
  }

  let lastStatus = null;
  let lastBody = "";

  for (const attempt of attempts) {
    console.log(
      "[psigo-pdf-service] Fetch attempt:",
      attempt.name,
      "referer:",
      attempt.headers.Referer || "none"
    );

    const response = await fetchWithTimeout(url, attempt.headers);
    lastStatus = response.status;

    if (!response.ok) {
      lastBody = await response.text().catch(() => "");
      console.error(
        "[psigo-pdf-service] Failed fetch attempt:",
        attempt.name,
        response.status,
        lastBody.slice(0, 300)
      );
      continue;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_PDF_BYTES) {
      throw new Error(`PDF too large: ${contentLength} bytes`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_PDF_BYTES) {
      throw new Error(`PDF too large: ${arrayBuffer.byteLength} bytes`);
    }

    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "";
    const looksLikePdf = buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";

    if (!looksLikePdf) {
      const preview = buffer.subarray(0, 300).toString("utf8");
      console.error(
        "[psigo-pdf-service] Response is not a PDF:",
        contentType,
        preview
      );
      lastBody = preview;
      continue;
    }

    return {
      buffer,
      contentType,
      finalUrl: response.url || url,
      fetchMode: attempt.name,
    };
  }

  const statusLabel = lastStatus ? `HTTP ${lastStatus}` : "no response";
  const detail = lastBody ? ` - ${lastBody.slice(0, 160)}` : "";
  throw new Error(`Failed to fetch PDF: ${statusLabel}${detail}`);
}

/**
 * POST /parse
 * Body JSON: {
 *   url: "https://...",
 *   referer?: "https://pagina-che-contiene-il-link/..."
 *   pdf_base64?: string // alternative when the source blocks Render egress
 * }
 * Headers: x-psigo-secret: <segreto opzionale>
 *
 * Endpoint usato dalle Edge Function di PsiGo per leggere PDF da URL.
 */
app.post("/parse", async (req, res) => {
  try {
    const auth = req.headers["x-psigo-secret"];
    if (SERVICE_SECRET && auth !== SERVICE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { url, referer = "", pdf_base64 } = req.body || {};
    const hasInline = pdf_base64 !== undefined && pdf_base64 !== null;
    if (hasInline && !SERVICE_SECRET) {
      return res.status(503).json({ ok: false, error: "Inline PDF requires PDF_SERVICE_SECRET" });
    }
    if (hasInline && (url !== undefined || referer !== "")) {
      return res.status(400).json({ ok: false, error: "Choose either url or pdf_base64" });
    }
    if (!hasInline && (!url || typeof url !== "string" || !isHttpUrl(url))) {
      return res.status(400).json({ ok: false, error: "Missing or invalid url" });
    }
    if (!hasInline && referer && (typeof referer !== "string" || !isHttpUrl(referer))) {
      return res.status(400).json({ ok: false, error: "Invalid referer" });
    }
    let downloaded;
    if (hasInline) {
      if (typeof pdf_base64 !== "string" ||
          pdf_base64.length > Math.ceil(MAX_INLINE_PDF_BYTES * 4 / 3) + 8 ||
          pdf_base64.length < 16 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf_base64)) {
        return res.status(400).json({ ok: false, error: "Invalid or oversized inline PDF" });
      }
      const buffer = Buffer.from(pdf_base64, "base64");
      if (buffer.length < 5 || buffer.length > MAX_INLINE_PDF_BYTES ||
          buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return res.status(400).json({ ok: false, error: "Inline payload is not a valid PDF" });
      }
      downloaded = { buffer, contentType: "application/pdf", finalUrl: null, fetchMode: "trusted_inline_base64" };
    } else {
      console.log("[psigo-pdf-service] Fetching PDF:", url);
      downloaded = await downloadPdf(url, referer);
    }

    const data = await pdf(downloaded.buffer);

    const text = (data.text || "")
      .replace(/\s+/g, " ")
      .trim();

    console.log(
      "[psigo-pdf-service] Extracted text length:",
      text.length,
      "pages:",
      data.numpages,
      "fetchMode:",
      downloaded.fetchMode
    );

    return res.json({
      ok: true,
      text,
      pages: data.numpages || null,
      info: data.info || null,
      fetch: {
        mode: downloaded.fetchMode,
        contentType: downloaded.contentType || null,
        finalUrl: downloaded.finalUrl || null,
      },
    });
  } catch (err) {
    console.error("[psigo-pdf-service] error:", err);
    const message = err?.name === "AbortError"
      ? `PDF fetch timeout after ${FETCH_TIMEOUT_MS} ms`
      : err?.message || String(err);

    return res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`PsiGo PDF Service running on port ${PORT}`);
});
