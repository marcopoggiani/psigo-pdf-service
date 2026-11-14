// PsiGo: URL-scoped, DNS-pinned download for course PDFs on approved
// organizer websites. This strict path is opt-in and does not change the
// existing /parse behavior used by other services.
import { lookup } from "node:dns/promises";
import https from "node:https";
import fetch from "node-fetch";
import { publicIp } from "./image-ocr.mjs";

export const ORGANIZER_ECM_HOSTS = Object.freeze([
  "psicologilombardia.it", "www.psicologilombardia.it",
  "uniateneo.it", "www.uniateneo.it",
  "nicolettagava.it", "www.nicolettagava.it",
  "istitutomindfulness.it", "www.istitutomindfulness.it",
  "psyeventi.it", "www.psyeventi.it",
]);

const MAX_BYTES = 8 * 1024 * 1024;
const HOSTS = new Set(ORGANIZER_ECM_HOSTS);

export function officialOrganizerPdfUrl(source, referer) {
  if(typeof source!=="string" || typeof referer!=="string"
    || source.length>1150 || referer.length>1100) return null;
  try {
    const url=new URL(source),page=new URL(referer);
    if(url.protocol!=="https:" || page.protocol!=="https:"
      || url.hostname!==page.hostname || !HOSTS.has(url.hostname)
      || url.username || url.password || page.username || page.password
      || url.port || page.port || url.search || url.hash
      || page.search || page.hash
      || /(?:%2f|%5c|\\|\.\.)/i.test(url.pathname)
      || !/\.pdf$/i.test(url.pathname)
      || page.pathname.length<9) return null;
    return url;
  } catch { return null; }
}

export async function downloadOfficialOrganizerPdf(source,referer) {
  const url=officialOrganizerPdfUrl(source,referer);
  if(!url) throw Error("organizer_pdf_url_not_allowlisted");
  const ips=await lookup(url.hostname,{all:true,verbatim:true});
  if(!ips.length || ips.some(x=>!publicIp(x.address)))
    throw Error("organizer_pdf_dns_not_public");
  const address=ips.find(x=>x.family===4)||ips[0];
  const agent=new https.Agent({rejectUnauthorized:true,
    lookup:(_host,opts,cb)=>opts?.all
      ?cb(null,[{address:address.address,family:address.family}])
      :cb(null,address.address,address.family)
  });
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(url.href,{method:"GET",redirect:"manual",
      agent,signal:controller.signal,headers:{
        Accept:"application/pdf,application/octet-stream",
        "User-Agent":"PsiGoOfficialCalendar/1.0 (+https://psigo.it)",
        Referer:referer,
      }});
    // Redirects must be rejected even when their destination looks safe.
    if(!response.ok || (response.status>=300&&response.status<400))
      throw Error("organizer_pdf_http_"+response.status);
    const mime=(response.headers.get("content-type")||"").toLowerCase();
    if(!/(?:application\/pdf|application\/octet-stream)/i.test(mime))
      throw Error("organizer_pdf_invalid_mime");
    const length=Number(response.headers.get("content-length")||0);
    if(!Number.isFinite(length) || length>MAX_BYTES)
      throw Error("organizer_pdf_too_large");
    const chunks=[];let size=0;
    for await(const chunk of response.body) {
      const b=Buffer.from(chunk);
      size+=b.length;
      if(size>MAX_BYTES)throw Error("organizer_pdf_stream_too_large");
      chunks.push(b);
    }
    const buffer=Buffer.concat(chunks,size);
    if(buffer.length<5 || buffer.subarray(0,5).toString("ascii")!=="%PDF-")
      throw Error("organizer_pdf_invalid_magic");
    return {buffer,contentType:mime,finalUrl:url.href,fetchMode:"verified_organizer_pdf"};
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}
