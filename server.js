import express from "express";
import pdf from "pdf-parse";
import fetch from "node-fetch";
import tls from "node:tls";
import https from "node:https";
import { X509Certificate } from "node:crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SERVICE_SECRET = process.env.PDF_SERVICE_SECRET || "";
const FETCH_TIMEOUT_MS = 25000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_PDF_BYTES = 6 * 1024 * 1024; // base64 fits existing 10mb JSON limit

/**
 * GET /  → per testare che il servizio risponde
 */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "PsiGo PDF Service", frosinoneBridge: "verified-aia-v1" });
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

/**
 * POST /frosinone-html
 *
 * A tightly scoped HTML bridge for the ASL Frosinone official competition
 * archive. Needed because direct Supabase egress fails during SSL handshake.
 *
 * This is NOT a general proxy: only the fixed official archive is fetched.
 * Requires the existing PDF_SERVICE_SECRET, even if /parse is unauthenticated.
 * No arbitrary URLs, no redirects, no HTML scripts executed.
 * Body: {"page":1}  (1..3)
 */
// Certificate inspection for diagnosis only: never use this connection to
// fetch a page. A real page request must always have valid TLS verification.
function inspectFrosinoneCertificate() {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host:"www.asl.fr.it",port:443,servername:"www.asl.fr.it",
      rejectUnauthorized:false,timeout:5000,
    }, () => {
      const c=socket.getPeerCertificate(true);
      resolve({
        issuer: c?.issuer?.O || c?.issuer?.CN || null,
        aia: String(c?.infoAccess?.["CA Issuers - URI"] || "").slice(0,300),
        validTo: c?.valid_to || null,
      });
      socket.end();
    });
    socket.on("error",() => resolve({error:"tls_inspection_failed"}));
    socket.on("timeout",() => {socket.destroy();resolve({error:"tls_inspection_timeout"});});
  });
}

// The ASL currently serves a leaf certificate without its DigiCert issuer.
// We fetch the issuer from the certificate AIA and verify its signature against
// a ROOT ALREADY TRUSTED by Node. This is not a TLS verification bypass.
// The resulting agent still verifies the server hostname and leaf certificate.
let validatedFrosinoneIssuer = null;
async function frosinoneVerifiedAgent() {
  if (validatedFrosinoneIssuer) {
    return new https.Agent({ ca: [...tls.rootCertificates, validatedFrosinoneIssuer] });
  }
  const peer = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "www.asl.fr.it", port: 443,
      servername: "www.asl.fr.it", rejectUnauthorized: false, timeout: 6000,
    }, () => {
      const certificate = socket.getPeerCertificate(true);
      socket.end();
      resolve(certificate);
    });
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("issuer_probe_timeout"));
    });
  });
  const aiaRaw = String(peer?.infoAccess?.["CA Issuers - URI"] || "");
  const aiaUrl = aiaRaw.match(/https?:\/\/cacerts\.digicert\.com\/[A-Za-z0-9_.-]+\.crt/i)?.[0];
  if (!aiaUrl) throw new Error("trusted_digicert_issuer_url_missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  let der;
  try {
    const response = await fetch(aiaUrl, {
      redirect: "error", signal: controller.signal,
      headers: { Accept: "application/pkix-cert,application/octet-stream" },
    });
    if (!response.ok ||
        Number(response.headers.get("content-length") || 0) > 100000) {
      throw new Error("issuer_download_failed");
    }
    der = Buffer.from(await response.arrayBuffer());
    if (der.length > 100000 || der.length < 250)
      throw new Error("issuer_certificate_invalid_size");
  } finally {
    clearTimeout(timer);
  }
  const issuer = new X509Certificate(der);
  const rootIsTrusted = tls.rootCertificates.some((pem) => {
    try {
      const root = new X509Certificate(pem);
      return root.checkIssued(issuer) && issuer.verify(root.publicKey);
    } catch { return false; }
  });
  if (!rootIsTrusted || !issuer.ca) {
    throw new Error("issuer_not_signed_by_trusted_root");
  }
  validatedFrosinoneIssuer = issuer.toString();
  return new https.Agent({ ca: [...tls.rootCertificates, validatedFrosinoneIssuer] });
}

async function fetchFrosinoneWithValidatedTls(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error?.code !== "UNABLE_TO_VERIFY_LEAF_SIGNATURE") throw error;
    // Retry ONLY after verifying the missing intermediate back to a trusted
    // public CA root, never by disabling TLS verification.
    const agent = await frosinoneVerifiedAgent();
    return await fetch(url, {...options, agent});
  }
}

app.post("/frosinone-html", async (req, res) => {
  if (!SERVICE_SECRET) {
    return res.status(503).json({ ok: false, error: "bridge_secret_not_configured" });
  }
  if (req.headers["x-psigo-secret"] !== SERVICE_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const page = req.body?.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 3 ||
      Object.keys(req.body || {}).some((key) => key !== "page")) {
    return res.status(400).json({ ok: false, error: "invalid_page" });
  }
  const url = page === 1
    ? "https://www.asl.fr.it/bandi/bandi-di-concorso/"
    : `https://www.asl.fr.it/bandi/bandi-di-concorso/pagina/${page}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchFrosinoneWithValidatedTls(url, {
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PsiGo/1.0; +https://psigo.it)",
        "Accept": "text/html,application/xhtml+xml;q=0.9",
        "Accept-Language": "it-IT,it;q=0.9",
      },
    });
    if (!response.ok) {
      return res.status(502).json({
        ok: false, error: "official_http_error", upstreamStatus: response.status,
      });
    }
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      return res.status(502).json({ ok: false, error: "unexpected_content_type" });
    }
    if (Number(response.headers.get("content-length") || "0") > 800000) {
      return res.status(502).json({ ok: false, error: "source_too_large" });
    }
    const html = await response.text();
    if (html.length > 800000 || !/bandi\s+di\s+concorso/i.test(html.replace(/<[^>]+>/g, " "))) {
      return res.status(502).json({ ok: false, error: "unexpected_listing_response" });
    }
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, url, page, html });
  } catch (err) {
    // Expose only the technical error code to authenticated consumers.
    // Never include URLs, certificates, credentials or response bodies.
    const upstreamCode = String(err?.code || err?.cause?.code || "UNKNOWN").slice(0, 45);
    console.error("[psigo-frosinone-bridge]", err?.name || "fetch_error", upstreamCode);
    const certificate = upstreamCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      ? await inspectFrosinoneCertificate() : null;
    return res.status(502).json({
      ok: false, error: err?.name === "AbortError" ? "official_timeout" : "official_fetch_failed",
      upstreamCode, certificate,
      failureStage: [
        "trusted_digicert_issuer_url_missing", "issuer_download_failed",
        "issuer_certificate_invalid_size", "issuer_not_signed_by_trusted_root",
        "issuer_probe_timeout", "unexpected_listing_response",
      ].includes(String(err?.message)) ? err.message : "other",
    });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => {
  console.log(`PsiGo PDF Service running on port ${PORT}`);
});
