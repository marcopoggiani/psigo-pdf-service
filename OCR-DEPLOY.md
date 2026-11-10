# PsiGo OCR: rollout instructions

## Safety / legacy behavior
- Existing `POST /parse` requests (without `ocr`) behave as before.
- OCR is **opt-in** via JSON `{"url":"https://…/document.pdf","ocr":"auto"}`.
- Responses keep `{ok,text,pages,info,fetch}`; a new `ocr` object reports progress.
- Uses local `pdftoppm` and `tesseract` (Italian + English), no AI and no paid OCR service.
- `ocr.status="completed"` requires the entire PDF to have been processed.
- If OCR cannot complete, original PDF text is returned; incomplete OCR text is NOT returned.
- At most 6 pages and one concurrent OCR job; long PDFs remain in manual review.
- One PDF can take much longer than normal parsing; downstream callers need longer timeouts.

## Deploy on Render (must be done AFTER validating a preview)
1. Open existing Render service **psigo-pdf-service** → Settings → Source.
2. Change runtime to **Docker** and source branch to the tested commit/branch as appropriate.
3. Keep existing Render environment secrets (in particular `PDF_SERVICE_SECRET`), port, domains and service name.
4. Verify the old `POST /parse` behavior first, and test OCR on a scanned PDF.
5. Only then enable OCR in Supabase's shared reviewer by sending `ocr:"auto"`; raise its PDF timeout with care and re-test pending ASL Roma 1 before considering publication.
6. Do NOT change market listing statuses or publish solely because OCR returns text.

## Sample request
```bash
curl -X POST https://psigo-pdf-service.onrender.com/parse \
  -H 'Content-Type: application/json' \
  -H 'x-psigo-secret: YOUR_EXISTING_SECRET' \
  -d '{"url":"https://www.aslroma1.it/uploads/files/26_41_AVVISO.pdf","ocr":"auto"}'
```
Expect `ocr.status="completed"` and `text` with useful Italian words. Never log actual secrets.

## Offline test (Docker/local)
```bash
node --test ocr.test.mjs
```
Requires `pdftoppm`, `tesseract` and an image-only PDF fixture path in `PSIGO_OCR_TEST_PDF`.
