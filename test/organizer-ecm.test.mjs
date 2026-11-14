import test from "node:test";
import assert from "node:assert/strict";
import { officialOrganizerPdfUrl, ORGANIZER_ECM_HOSTS } from "../organizer-pdf.mjs";
import { officialImageUrl } from "../image-ocr.mjs";

const ref="https://www.psicologilombardia.it/formazione/master-di-esempio";
const pdf="https://www.psicologilombardia.it/_userdata/formazione/allegati/programma.pdf";

test("strict organizer PDF accepts only same-origin approved hosts",()=>{
  assert.equal(officialOrganizerPdfUrl(pdf,ref)?.href,pdf);
  assert.equal(officialOrganizerPdfUrl("https://evil.example.com/programma.pdf",ref),null);
  assert.equal(officialOrganizerPdfUrl("https://127.0.0.1/x.pdf",ref),null);
  assert.equal(officialOrganizerPdfUrl("https://www.uniateneo.it/formazione/a.pdf",ref),null);
  assert.equal(officialOrganizerPdfUrl(pdf+"?next=http://127.0.0.1",ref),null);
  assert.equal(officialOrganizerPdfUrl("http://www.psicologilombardia.it/programma.pdf",ref),null);
  assert.equal(officialOrganizerPdfUrl("https://www.psicologilombardia.it/login",ref),null);
  assert.equal(officialOrganizerPdfUrl("https://www.psicologilombardia.it/a%2fb.pdf",ref),null);
  assert.equal(officialOrganizerPdfUrl(pdf,"https://evil.example.com/a"),null);
});

test("organizer image source uses same host and approved domain",()=>{
  const img="https://www.psicologilombardia.it/_userdata/corso/locandina.png";
  assert.equal(officialImageUrl("organizer_ecm_training",img,ref)?.href,img);
  assert.equal(officialImageUrl("organizer_ecm_training","https://evil.example.com/a.png",ref),null);
  assert.equal(officialImageUrl("ordine_liguria_training",img,ref),null);
  assert.equal(officialImageUrl("organizer_ecm_training",img+"?redirect=x",ref),null);
});

test("allowlisted hostnames limited to a fixed approved set",()=>{
  assert.equal(ORGANIZER_ECM_HOSTS.length,10);
  assert.ok(!ORGANIZER_ECM_HOSTS.some(x=>x.startsWith("127.")||x.includes("*")));
});
