import { fetchOfficialImage, recognizeImage } from "./image-ocr.mjs";
import express from "express";
import pdf from "pdf-parse";
import fetch from "node-fetch";
import tls from "node:tls";
import https from "node:https";
import { X509Certificate, createHash } from "node:crypto";
import { ocrPdfIfNeeded } from "./ocr.mjs";

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
  res.json({ ok: true, service: "PsiGo PDF Service", frosinoneBridge: "verified-aia-v1", hospitalBridge: "fixed-official-v1" });
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
 *   ocr?: "off" | "auto" // opt-in; existing calls remain unchanged
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

    const { url, referer = "", pdf_base64, ocr = "off", startPage = 1, pageLimit = 2, quality = "standard" } = req.body || {};
    if (ocr !== "off" && ocr !== "auto" && ocr !== "extended" && ocr !== "smart" && ocr !== "chunk") {
      return res.status(400).json({ ok: false, error: "Invalid OCR mode" });
    }
    // Extended full-document OCR is an explicitly authenticated opt-in.
    // The default mode remains capped at six pages.
    if ((ocr === "extended" || ocr === "smart" || ocr === "chunk") && (!SERVICE_SECRET || req.headers["x-psigo-secret"] !== SERVICE_SECRET)) {
      return res.status(403).json({ ok: false, error: "Extended or smart OCR requires service authentication" });
    }
    if (ocr === "chunk" && (!Number.isInteger(startPage) || startPage < 1 ||
        !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 2 ||
        !["standard", "high"].includes(quality) || (quality === "high" && pageLimit !== 1))) {
      return res.status(400).json({ok:false,error:"Invalid OCR chunk pagination"});
    }
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

    const embeddedText = (data.text || "")
      .replace(/\s+/g, " ")
      .trim();
    const ocrStarted = Date.now();
    const extracted = await ocrPdfIfNeeded(downloaded.buffer, {
      text: embeddedText,
      pages: data.numpages || null,
      mode: ocr,
      startPage,
      pageLimit,
      quality,
    });
    if (ocr === "auto" || ocr === "extended" || ocr === "smart" || ocr === "chunk") {
      console.log("[psigo-pdf-service] OCR status:", extracted.ocr.status,
        "reason:", extracted.ocr.reason || "none",
        "elapsedMs:", Date.now() - ocrStarted);
    }
    const text = extracted.text;

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
      ocr: extracted.ocr,
      ...(ocr === "chunk" ? { pdfSha256: createHash("sha256").update(downloaded.buffer).digest("hex") } : {}),
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
 * Body: {"page":1} (1..3) OR {"slug":"official-article-slug"}.
 * A slug is restricted to exactly one official article under the archive.
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
let validatedFrosinoneIssuers = null;
async function frosinoneVerifiedAgent() {
  if (validatedFrosinoneIssuers) {
    return new https.Agent({ca: [...tls.rootCertificates, ...validatedFrosinoneIssuers]});
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

  const trustedRoots = tls.rootCertificates.map((pem) => new X509Certificate(pem));
  let current = new X509Certificate(peer.raw);
  let accessInfo = String(peer?.infoAccess?.["CA Issuers - URI"] || "");
  const issuers = [];
  let chainTrusted = false;
  // An origin may omit MULTIPLE intermediate certificates. Stop after
  // a strictly bounded chain, and require a cryptographic path to a
  // root already in Node's built-in trusted root store.
  for (let depth = 0; depth < 4; depth++) {
    const aiaUrl = accessInfo.match(/https?:\/\/cacerts\.digicert\.com\/[A-Za-z0-9_.-]+\.crt/i)?.[0];
    if (!aiaUrl) throw new Error("trusted_digicert_issuer_url_missing");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let der;
    try {
      const response = await fetch(aiaUrl, {
        redirect: "error", signal: controller.signal,
        headers: {Accept: "application/pkix-cert,application/octet-stream"},
      });
      if (!response.ok || Number(response.headers.get("content-length") || 0) > 100000)
        throw new Error("issuer_download_failed");
      der = Buffer.from(await response.arrayBuffer());
      if (der.length < 250 || der.length > 100000)
        throw new Error("issuer_certificate_invalid_size");
    } finally {
      clearTimeout(timer);
    }
    const issuer = new X509Certificate(der);
    if (!issuer.ca || !current.checkIssued(issuer) ||
        !current.verify(issuer.publicKey)) {
      throw new Error("issuer_signature_chain_invalid");
    }
    issuers.push(issuer.toString());
    chainTrusted = trustedRoots.some((root) =>
      issuer.checkIssued(root) && issuer.verify(root.publicKey));
    if (chainTrusted) break;
    current = issuer;
    accessInfo = issuer.infoAccess || "";
  }
  if (!chainTrusted) throw new Error("issuer_not_signed_by_trusted_root");
  validatedFrosinoneIssuers = issuers;
  return new https.Agent({ca: [...tls.rootCertificates, ...issuers]});
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
  const slug = req.body?.slug;
  const hasSlug = slug !== undefined;
  const page = req.body?.page ?? (hasSlug ? null : 1);
  if (hasSlug
    ? (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
       slug.length > 280 || Object.keys(req.body || {}).some((k) => k !== "slug"))
    : (!Number.isInteger(page) || page < 1 || page > 3 ||
       Object.keys(req.body || {}).some((k) => k !== "page"))) {
    return res.status(400).json({ ok: false, error: "invalid_listing_or_detail" });
  }
  const root = "https://www.asl.fr.it/bandi/bandi-di-concorso/";
  const url = hasSlug ? root + slug + "/"
    : page === 1 ? root : root + "pagina/" + page + "/";
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
    const plain = html.replace(/<[^>]+>/g, " ");
    if (html.length > 800000 || !/bandi\s+di\s+concorso/i.test(plain)) {
      return res.status(502).json({ ok: false, error: "unexpected_listing_response" });
    }
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, url, page, slug: hasSlug ? slug : null, html });
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


/**
 * POST /rieti-html
 * Fixed official ASL Rieti HTML listings. NOT a generic URL fetcher.
 * Body: {"section":"concorsi"|"concorsi_2026"|"avvisi"}.
 * Protected by the pre-existing PDF_SERVICE_SECRET.
 * This route never disables TLS verification, never follows redirects,
 * does not accept arbitrary URLs and never modifies external data.
 */
const RIETI_OFFICIAL_ROUTES = Object.freeze({
  concorsi: "https://asl.rieti.it/bandi-e-concorsi/avvisi-e-concorsi/",
  concorsi_2026: "https://www.asl.rieti.it/bandi-e-concorsi/avvisi-e-concorsi/concorsi-e-selezioni-2026/",
  avvisi: "https://asl.rieti.it/bandi-e-concorsi/avvisi/",
});
app.post("/rieti-html", async (req, res) => {
  if (!SERVICE_SECRET) {
    return res.status(503).json({ok:false,error:"bridge_secret_not_configured"});
  }
  if (req.headers["x-psigo-secret"] !== SERVICE_SECRET) {
    return res.status(401).json({ok:false,error:"Unauthorized"});
  }
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).length !== 1 || typeof data.section !== "string" ||
      !Object.hasOwn(RIETI_OFFICIAL_ROUTES,data.section)) {
    return res.status(400).json({ok:false,error:"invalid_section"});
  }
  const section=data.section;
  const source=RIETI_OFFICIAL_ROUTES[section];
  const path=new URL(source).pathname;
  const origins=["https://asl.rieti.it","https://www.asl.rieti.it"];
  const controllers=origins.map(()=>new AbortController());
  const timer=setTimeout(()=>controllers.forEach(x=>x.abort()),13000);
  try {
    const attempt=async (origin,index) => {
      const response=await fetch(origin+path,{
        method:"GET",redirect:"error",signal:controllers[index].signal,
        headers:{
          "User-Agent":"Mozilla/5.0 (compatible; PsiGo/1.0; +https://psigo.it)",
          "Accept":"text/html,application/xhtml+xml;q=0.9",
          "Accept-Language":"it-IT,it;q=0.9",
        },
      });
      if(!response.ok)throw new Error("official_http_"+response.status);
      const type=response.headers.get("content-type")||"";
      if(!/text\/html|application\/xhtml\+xml/i.test(type))
        throw new Error("unexpected_content_type");
      if(Number(response.headers.get("content-length")||"0")>800000)
        throw new Error("source_too_large");
      const html=await response.text();
      if(html.length>800000 ||
         !/Bandi\s*(?:e|&amp;|&#038;)\s*Concorsi|Concorsi\s*e\s*selezioni/i.test(html))
        throw new Error("unexpected_listing_response");
      const count=(html.match(/<details\b[^>]*class=["'][^"']*\be-n-accordion-item\b/gi)||[]).length;
      if(count<1)throw new Error("no_accordion_records");
      return {html,count,origin};
    };
    // Try both public, official hosts concurrently; never follow redirects.
    const result=await Promise.any(origins.map(attempt));
    controllers.forEach(x=>x.abort());
    res.set("Cache-Control","no-store");
    return res.json({ok:true,section,html:result.html,
      accordionCount:result.count,origin:result.origin});
  }catch(err){
    const failures=Array.isArray(err?.errors)?err.errors:[err];
    const reason=failures.map(x=>String(x?.code||x?.cause?.code||x?.message||"UNKNOWN")
      .replace(/[^a-zA-Z0-9_]/g,"_").slice(0,60)).slice(0,2);
    console.error("[psigo-rieti-bridge]",reason);
    return res.status(502).json({
      ok:false,error:"official_fetch_failed",upstreamCodes:reason,
    });
  }finally{clearTimeout(timer)}
});

/**
 * POST /lazio-hospital-html
 * Fixed institution-only HTML bridge for PsiGo hospitals whose HTTPS portals
 * may be inaccessible from Supabase. No dynamic hosts, no arbitrary URLs.
 * SECURITY: pre-existing x-psigo-secret required; HTTPS validation intact.
 * Body: {"source":"umberto1"|"santandrea","page":1|2|3}.
 * This DOES NOT authorize importing/publishing any notice.
 */
const HOSPITAL_HTML_ROOTS = Object.freeze({
  umberto1: "https://www.policlinicoumberto1.it/bandi-di-concorso/",
  santandrea: "https://concorsi.ospedalesantandrea.it/",
});
// Diagnostic only: inspect a fixed official TLS peer, without requesting
// website content or accepting arbitrary hosts. Never used for validation.
async function inspectHospitalCertificate(source) {
  const host=new URL(HOSPITAL_HTML_ROOTS[source]).hostname;
  return new Promise(resolve => {
    const socket=tls.connect({host,port:443,servername:host,
      rejectUnauthorized:false,timeout:4500},()=>{
      const cert=socket.getPeerCertificate(true);
      resolve({
        issuer:String(cert?.issuer?.O||cert?.issuer?.CN||"").slice(0,85),
        aia:String(cert?.infoAccess?.["CA Issuers - URI"]||"").slice(0,300),
        validTo:String(cert?.valid_to||"").slice(0,60),
      });
      socket.end();
    });
    socket.on("error",()=>resolve({error:"peer_inspection_failed"}));
    socket.on("timeout",()=>{socket.destroy();resolve({error:"peer_inspection_timeout"})});
  });
}

// Recover only demonstrably missing intermediates from trusted CA hosts.
// Each certificate's signature must chain to a Node built-in trusted root;
// this NEVER switches off TLS verification for HTTP content requests.
const HOSPITAL_CA_HOSTS = new Set([
  "secure.globalsign.com",
  "cacert.actalis.it",
]);
const hospitalVerifiedAgents = new Map();
async function hospitalVerifiedAgent(source) {
  if (hospitalVerifiedAgents.has(source)) return hospitalVerifiedAgents.get(source);
  const host=new URL(HOSPITAL_HTML_ROOTS[source]).hostname;
  const peer=await new Promise((resolve,reject)=>{
    const socket=tls.connect({host,port:443,servername:host,
      rejectUnauthorized:false,timeout:5000},()=>{
      const cert=socket.getPeerCertificate(true);
      socket.end();resolve(cert);
    });
    socket.on("error",reject);
    socket.on("timeout",()=>{socket.destroy();reject(Error("hospital_issuer_probe_timeout"))});
  });
  if(!peer?.raw)throw Error("hospital_certificate_unavailable");
  const roots=tls.rootCertificates.map(pem=>new X509Certificate(pem));
  const issuers=[];
  let child=new X509Certificate(peer.raw);
  let accessInfo=String(peer.infoAccess?.["CA Issuers - URI"]||"");
  let trusted=false;
  for(let depth=0;depth<4;depth++){
    const raw=accessInfo.match(/https?:\/\/[^\s<>;,]+/i)?.[0];
    if(!raw)throw Error("hospital_issuer_url_missing");
    const issuerUrl=new URL(raw);
    if(!["https:","http:"].includes(issuerUrl.protocol) ||
      !HOSPITAL_CA_HOSTS.has(issuerUrl.hostname) ||
      issuerUrl.username || issuerUrl.password || issuerUrl.port ||
      issuerUrl.pathname.length<2 || issuerUrl.pathname.length>250 || issuerUrl.hash)
      throw Error("hospital_issuer_url_not_allowlisted");
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),6500);
    let certificateData;
    try{
      const r=await fetch(issuerUrl.href,{
        method:"GET",redirect:"error",signal:ctl.signal,
        headers:{Accept:"application/pkix-cert,application/octet-stream,*/*;q=0.1"}
      });
      if(!r.ok || Number(r.headers.get("content-length")||0)>100000)
        throw Error("hospital_issuer_download_failed");
      certificateData=Buffer.from(await r.arrayBuffer());
      if(certificateData.length<250||certificateData.length>100000)
        throw Error("hospital_issuer_invalid_length");
    }finally{clearTimeout(timer)}
    const issuer=new X509Certificate(certificateData);
    if(!issuer.ca || !child.checkIssued(issuer) ||
       !child.verify(issuer.publicKey))
      throw Error("hospital_issuer_signature_mismatch");
    const now=Date.now();
    if(Date.parse(issuer.validFrom)>now || Date.parse(issuer.validTo)<now)
      throw Error("hospital_issuer_expired");
    issuers.push(issuer.toString());
    trusted=roots.some(root=>
      (issuer.fingerprint256===root.fingerprint256) ||
      (issuer.checkIssued(root) && issuer.verify(root.publicKey)));
    if(trusted)break;
    child=issuer;
    accessInfo=String(issuer.infoAccess||"");
  }
  if(!trusted)throw Error("hospital_issuer_not_trusted");
  const agent=new https.Agent({ca:[...tls.rootCertificates,...issuers],
    rejectUnauthorized:true});
  hospitalVerifiedAgents.set(source,agent);
  return agent;
}
async function fetchVerifiedHospitalHtml(url,source,options) {
  try{return await fetch(url,options)}
  catch(e){
    if(String(e?.code||e?.cause?.code)!=="UNABLE_TO_VERIFY_LEAF_SIGNATURE")throw e;
    const agent=await hospitalVerifiedAgent(source);
    return fetch(url,{...options,agent});
  }
}

app.post("/lazio-hospital-html", async (req, res) => {
  if (!SERVICE_SECRET) {
    return res.status(503).json({ ok:false, error:"bridge_secret_not_configured" });
  }
  if (req.headers["x-psigo-secret"] !== SERVICE_SECRET) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }
  const body=req.body;
  const detail=typeof body?.detailPath==="string";
  if(!body || typeof body!=="object" || Array.isArray(body) ||
     !Object.hasOwn(HOSPITAL_HTML_ROOTS,body.source) ||
     Object.keys(body).some(k=>!["source","page","detailPath"].includes(k)) ||
     (detail && body.page!==undefined) ||
     (!detail && (!Number.isInteger(body.page)||body.page<1||body.page>3))) {
    return res.status(400).json({ok:false,error:"invalid_hospital_request"});
  }
  const {source}=body;
  const page=detail?null:body.page;
  const root=HOSPITAL_HTML_ROOTS[source];
  let pageUrl;
  if(detail){
    const path=body.detailPath;
    const ok=source==="umberto1"
      ? /^\/bando-concorso\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(path)&&path.length<470
      : /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(path)&&path.length<350;
    if(!ok)return res.status(400).json({ok:false,error:"invalid_hospital_detail_path"});
    pageUrl=new URL(path,new URL(root).origin).href;
  }else{
    pageUrl=source==="umberto1"
      ? root+(page===1?"":"?pagenumber="+page)
      : root+(page===1?"":"?page="+page);
  }
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetchVerifiedHospitalHtml(pageUrl,source,{
      method:"GET",redirect:"error",signal:controller.signal,
      headers:{
        "User-Agent":"Mozilla/5.0 (compatible; PsiGo/1.0; +https://psigo.it)",
        Accept:"text/html,application/xhtml+xml;q=0.9",
        "Accept-Language":"it-IT,it;q=0.9",
      },
    });
    if (!response.ok) return res.status(502).json({
      ok:false,error:"official_http_error",upstreamStatus:response.status
    });
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type")||""))
      return res.status(502).json({ok:false,error:"unexpected_content_type"});
    if(Number(response.headers.get("content-length")||"0")>1100000)
      return res.status(502).json({ok:false,error:"source_too_large"});
    const html=await response.text();
    if(html.length>1100000 || !/<html\b/i.test(html) ||
      (!detail && source==="umberto1" && !/Bandi di concorso|Atti relativi ai Bandi di concorso/i.test(html)) ||
      (!detail && source==="santandrea" && !/Concorsi e Selezioni|Concorsi e selezioni/i.test(html)))
      return res.status(502).json({ok:false,error:"unexpected_official_response"});
    res.set("Cache-Control","no-store");
    return res.json({ok:true,source,page,detailPath:detail?body.detailPath:null,url:pageUrl,html});
  } catch(err) {
    const reason=String(err?.code||err?.cause?.code||err?.message||err?.name||"UNKNOWN")
      .replace(/[^A-Za-z0-9_]/g,"_").slice(0,50);
    console.error("[psigo-hospital-html]",source,page,reason);
    return res.status(502).json({ok:false,error:"official_fetch_failed",upstreamCode:reason,
      certificate:reason==="UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? await inspectHospitalCertificate(source) : null});
  } finally {
    clearTimeout(timeout);
  }
});

// Dedicated fixed-host municipal source bridge. This is NOT a generic proxy.
// It allows only Roma Capitale official list and BEC detail pages.
app.post("/lazio-municipal-html",async (req,res)=>{
  if(!SERVICE_SECRET)return res.status(503).json({ok:false,error:"bridge_secret_missing"});
  if(req.headers["x-psigo-secret"]!==SERVICE_SECRET)
    return res.status(401).json({ok:false,error:"Unauthorized"});
  const b=req.body;
  if(!b||typeof b!=="object"||Array.isArray(b)||
     Object.keys(b).some(k=>!["source","contentId","page"].includes(k))||
     b.source!=="roma_capitale"||
     (b.contentId!==undefined&&!/^BEC\d{5,12}$/.test(b.contentId))||
     (b.contentId!==undefined&&b.page!==undefined)||
     (b.page!==undefined&&(!Number.isInteger(b.page)||b.page<1||b.page>3)))
    return res.status(400).json({ok:false,error:"municipal_request_invalid"});
  const officialUrl=b.contentId
   ? "https://www.comune.roma.it/web/it/bando-concorso.page?contentId="+b.contentId
   : "https://www.comune.roma.it/web/it/bandi-e-concorsi.page?"+(b.page&&b.page>1?"pagina="+b.page+"&":"")+"tipo=selezioni";
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),15000);
  try{
    const resp=await fetch(officialUrl,{
      redirect:"error",signal:ctl.signal,
      headers:{"User-Agent":"Mozilla/5.0 (compatible; PsiGoOfficialCollector/1.0; +https://psigo.it)",
       "Accept":"text/html,application/xhtml+xml;q=0.9",
       "Accept-Language":"it-IT,it;q=0.9"}
    });
    if(!resp.ok)return res.status(502).json({ok:false,error:"official_http_"+resp.status});
    if(!/text\/html/i.test(resp.headers.get("content-type")||""))
      return res.status(502).json({ok:false,error:"unexpected_municipal_type"});
    if(Number(resp.headers.get("content-length")||0)>520000)
      return res.status(502).json({ok:false,error:"municipal_html_too_large"});
    const html=await resp.text();
    if(html.length>520000||!/<html\b/i.test(html)||
       (!b.contentId&&!html.includes("Faccette-results"))||
       (b.contentId&&!html.includes(b.contentId)))
      return res.status(502).json({ok:false,error:"unrecognized_municipal_html"});
    res.set("Cache-Control","no-store");
    return res.json({ok:true,source:"roma_capitale",contentId:b.contentId||null,
      url:officialUrl,page:b.contentId?null:(b.page||1),html});
  }catch(e){
    const code=String(e?.cause?.code||e?.code||e?.name||"unknown")
      .replace(/[^a-zA-Z0-9_]/g,"").slice(0,45);
    return res.status(502).json({ok:false,error:"municipal_fetch_failed",upstreamCode:code});
  }finally{clearTimeout(timer)}
});

// Official-source discovery only. No arbitrary URL input, no publication.
// The handlers share SERVICE_SECRET and never disable TLS verification.
const MUNICIPAL_DISCOVERY_URLS=Object.freeze({
  comune_viterbo:"https://comune.viterbo.it/novita/?tipo=avvisi",
  comune_latina:"https://servizi.comune.latina.it/ServiziOnLine/AmministrazioneTrasparente/AmministrazioneTrasparente?idsezioneam=70",
  comune_rieti:"https://www.comune.rieti.it/",
});
app.post("/lazio-municipal-discovery",async(req,res)=>{
 if(!SERVICE_SECRET)return res.status(503).json({ok:false,error:"bridge_secret_missing"});
 if(req.headers["x-psigo-secret"]!==SERVICE_SECRET)
  return res.status(401).json({ok:false,error:"Unauthorized"});
 const b=req.body;
 if(!b||typeof b!=="object"||Array.isArray(b)||
    Object.keys(b).some(k=>k!=="source")||
    !Object.hasOwn(MUNICIPAL_DISCOVERY_URLS,b.source))
  return res.status(400).json({ok:false,error:"unknown_official_source"});
 const url=MUNICIPAL_DISCOVERY_URLS[b.source];
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),16000);
 try{
  const resp=await fetch(url,{
   redirect:"error",signal:ctl.signal,
   headers:{"User-Agent":"Mozilla/5.0 (compatible; PsiGoOfficialCollector/1.0; +https://psigo.it)",
    "Accept":"text/html,application/xhtml+xml;q=0.9","Accept-Language":"it-IT,it;q=0.9"}
  });
  if(!resp.ok)return res.status(502).json({ok:false,source:b.source,error:"official_http_"+resp.status});
  if(!/text\/html/i.test(resp.headers.get("content-type")||""))
   return res.status(502).json({ok:false,source:b.source,error:"unrecognized_type"});
  if(Number(resp.headers.get("content-length")||0)>760000)
   return res.status(502).json({ok:false,source:b.source,error:"too_large"});
  const html=await resp.text();
  if(html.length>760000||!/<html\b/i.test(html))
   return res.status(502).json({ok:false,source:b.source,error:"invalid_html"});
  res.set("Cache-Control","no-store");
  return res.json({ok:true,source:b.source,url,html});
 }catch(e){
  const code=String(e?.cause?.code||e?.code||e?.name||"unknown")
   .replace(/[^A-Za-z0-9_]/g,"").slice(0,44);
  return res.status(502).json({ok:false,source:b.source,error:"official_fetch_failed",upstreamCode:code});
 }finally{clearTimeout(timer)}
});


// Official raster notice OCR: never a generic image proxy or publication service.
app.post("/parse-image", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!SERVICE_SECRET) return res.status(503).json({ok:false,error:"image_ocr_secret_missing"});
  if (req.headers["x-psigo-secret"] !== SERVICE_SECRET)
    return res.status(401).json({ok:false,error:"Unauthorized"});
  const b = req.body;
  if (!b || typeof b!=="object" || Array.isArray(b) ||
      Object.keys(b).some(k=>!["source","url","officialUrl","highQuality"].includes(k)) ||
      typeof b.source!=="string" || typeof b.url!=="string" ||
      typeof b.officialUrl!=="string" ||
      (b.highQuality!==undefined && typeof b.highQuality!=="boolean"))
    return res.status(400).json({ok:false,error:"invalid_image_request"});
  try {
    const fetched=await fetchOfficialImage(b.source,b.url,b.officialUrl);
    const result=await recognizeImage(fetched.buffer,{highQuality:b.highQuality===true});
    return res.json({...result,fetch:{bytes:fetched.bytes,mime:fetched.mime},source:b.source});
  } catch(e) {
    const error=String(e?.message||"image_ocr_failed");
    const code=/not_allowlisted|invalid_image_request/.test(error)?400:
      /ocr_busy/.test(error)?429:/ocr_timeout/.test(error)?504:502;
    console.error("[psigo-image-ocr]",error.replace(/[^a-z0-9_]/gi,"_").slice(0,80));
    return res.status(code).json({ok:false,error:error.slice(0,90)});
  }
});

app.listen(PORT, () => {
  console.log(`PsiGo PDF Service running on port ${PORT}`);
});
