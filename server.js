import express from "express";
import pdf from "pdf-parse";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SERVICE_SECRET = process.env.PDF_SERVICE_SECRET || "";

/**
 * GET /  → per testare che il servizio risponde
 */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "PsiGo PDF Service" });
});

/**
 * POST /parse
 * Body JSON: { url: "https://..." }
 * Headers: x-psigo-secret: <segreto opzionale>
 *
 * Questo è l'endpoint chiamato dalla Edge Function filter-bando-pdf-keywords.
 */
app.post("/parse", async (req, res) => {
  try {
    // 🔐 Controllo semplice di autenticazione (tra Edge Function e servizio)
    const auth = req.headers["x-psigo-secret"];
    if (SERVICE_SECRET && auth !== SERVICE_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }

    console.log("[psigo-pdf-service] Fetching PDF:", url);

    // Scarica il PDF
    const response = await fetch(url);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        "[psigo-pdf-service] Failed to fetch PDF:",
        response.status,
        errText.slice(0, 300)
      );
      return res.status(400).json({
        ok: false,
        error: `Failed to fetch PDF: HTTP ${response.status}`
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Estrai il testo con pdf-parse
    const data = await pdf(buffer);

    const text = (data.text || "")
      .replace(/\s+/g, " ")
      .trim();

    console.log(
      "[psigo-pdf-service] Extracted text length:",
      text.length,
      "pages:",
      data.numpages
    );

    return res.json({
      ok: true,
      text,
      pages: data.numpages || null,
      info: data.info || null
    });
  } catch (err) {
    console.error("[psigo-pdf-service] error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`PsiGo PDF Service running on port ${PORT}`);
});
