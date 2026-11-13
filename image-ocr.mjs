// PsiGo — authenticated, bounded OCR of official raster notices.
// Evidence only: this endpoint NEVER approves or publishes events.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fetch from "node-fetch";

export const IMAGE_SOURCE_HOSTS = Object.freeze({
  // Existing official Bandi sources: image support is evidence-only.
  inpa:["www.inpa.gov.it"],
  gazzetta_concorsi:["www.gazzetta-concorsi.it"],
  gazzetta_ufficiale:["www.gazzettaufficiale.it"],
  regione_lazio_bur:["www.regione.lazio.it"],
  ministero_giustizia:["www.giustizia.it"],
  scuola_pilota_ic_borsellino:["icborsellino.edu.it"],
  ordine_sicilia:["www.oprs.it"],
  asl_roma_1:["www.aslroma1.it"],
  sapienza_open_data:["trasparenza.uniroma1.it"],
  asl_latina:["www.ausl.latina.it"],

  ordine_marche_training:["www.ordinepsicologimarche.it"],
  ordine_piemonte_training:["ordinepsicologi.piemonte.it"],
  ordine_puglia_training:["www.psicologipuglia.it"],
  ordine_veneto_training:["www.ordinepsicologiveneto.it"],
  ordine_trentino_alto_adige_training:["www.psibz.org","psibz.org","ordinepsicologi.tn.it","www.ordinepsicologi.tn.it"],
  ordine_liguria_training:["www.ordinepsicologi-liguria.it"],
  ordine_campania_training:["www.oprc.it"],
  ordine_friuli_venezia_giulia_training:["www.ordinepsicologifvg.it"],
  ordine_lombardia_training:["www.opl.it"],
  ordine_toscana_training:["www.ordinepsicologitoscana.it"],
  ordine_umbria_training:["www.ordinepsicologiumbria.it"],
  ordine_abruzzo_training:["ordinepsicologiabruzzo.it"],
  ordine_lazio_training:["ordinepsicologilazio.it"],
  ordine_calabria_training:["www.ordinepsicologicalabria.it"],
  ordine_sardegna_training:["www.psicosardegna.it"],
  ordine_valle_aosta_training:["ordinepsicologi.vda.it"],
  ordine_emilia_romagna_training:["www.ordinepsicologier.it"],
  ordine_molise_training:["ordinepsicologimolise.it"],
});
const MAX_BYTES=8*1024*1024, MAX_PIXELS=18_000_000, MAX_SIDE=7000;
let running=false;

export function officialImageUrl(source,value,officialUrl) {
  if(!IMAGE_SOURCE_HOSTS[source] || typeof value!=="string" || value.length>1600)return null;
  try {
    const u=new URL(value),p=new URL(officialUrl);
    if(u.protocol!=="https:"||p.protocol!=="https:"||
      u.hostname!==p.hostname||!IMAGE_SOURCE_HOSTS[source].includes(u.hostname)||
      u.username||u.password||u.port||u.hash||u.search||
      p.username||p.password||p.port||
      /%2f|%5c|\\|\.\./i.test(u.pathname)||
      !/\.(png|jpe?g|webp|tiff?|bmp|gif)$/i.test(u.pathname))return null;
    return u;
  }catch{return null}
}

export function publicIp(ip) {
  const family=isIP(ip);
  if(family===4) {
    const p=ip.split(".").map(Number);
    return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||
      p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||
      p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||
      p[0]===192&&p[1]===0||p[0]===198&&(p[1]===18||p[1]===19)||
      p[0]===198&&p[1]===51&&p[2]===100||p[0]===203&&p[1]===0&&p[2]===113);
  }
  if(family===6) {
    const v=ip.toLowerCase();
    return (v.startsWith("2")||v.startsWith("3")) &&
      !v.startsWith("2001:db8:")&&!v.startsWith("2001:0db8:");
  }
  return false;
}

export function imageDetails(b) {
  if(!Buffer.isBuffer(b)||b.length<30||b.length>MAX_BYTES)return null;
  let format,w,h;
  if(b.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))) {
    format="png";w=b.readUInt32BE(16);h=b.readUInt32BE(20);
  } else if(b[0]===255&&b[1]===216) {
    format="jpeg";
    for(let p=2;p+9<b.length;) {
      if(b[p]!==255)break;
      const marker=b[p+1];
      if(marker===255){p++;continue}
      if(marker===217||marker===218)break;
      if(marker===216||marker===1||(marker>=208&&marker<=215)){p+=2;continue}
      const len=b.readUInt16BE(p+2);
      if(len<2||p+2+len>b.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
        h=b.readUInt16BE(p+5);w=b.readUInt16BE(p+7);break;
      }
      p+=2+len;
    }
  } else if(b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP"){
    format="webp";const type=b.toString("ascii",12,16);
    if(type==="VP8X"){w=1+b.readUIntLE(24,3);h=1+b.readUIntLE(27,3)}
    else if(type==="VP8 "){w=b.readUInt16LE(26)&0x3fff;h=b.readUInt16LE(28)&0x3fff}
    else if(type==="VP8L"){const x=b.readUInt32LE(21);w=1+(x&0x3fff);h=1+((x>>14)&0x3fff)}
  } else if(b.toString("ascii",0,3)==="GIF"&&["87a","89a"].includes(b.toString("ascii",3,6))){
    format="gif";w=b.readUInt16LE(6);h=b.readUInt16LE(8);
  } else if(b.toString("ascii",0,2)==="BM"){
    format="bmp";w=Math.abs(b.readInt32LE(18));h=Math.abs(b.readInt32LE(22));
  } else if(b.subarray(0,4).equals(Buffer.from("49492a00","hex"))||
    b.subarray(0,4).equals(Buffer.from("4d4d002a","hex"))){
    format="tiff";const le=b[0]===73;
    const u16=p=>le?b.readUInt16LE(p):b.readUInt16BE(p);
    const u32=p=>le?b.readUInt32LE(p):b.readUInt32BE(p);
    const offset=u32(4);
    if(offset<8||offset+2>b.length)return null;
    const count=u16(offset);
    if(count>128||offset+2+count*12>b.length)return null;
    for(let i=0;i<count;i++){
      const a=offset+2+i*12,tag=u16(a),type=u16(a+2);
      if((tag===256||tag===257)&&u32(a+4)===1&&(type===3||type===4)){
        const value=type===3?u16(a+8):u32(a+8);
        if(tag===256)w=value;else h=value;
      }
    }
  } else return null;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<180||h<180||
    w>MAX_SIDE||h>MAX_SIDE||w*h>MAX_PIXELS)return null;
  return {format,width:w,height:h,bytes:b.length};
}

async function tesseract(file,mode){
  return new Promise((resolve,reject)=>{
    const child=spawn("tesseract",[file,"stdout","-l","ita+eng","--psm",String(mode),"txt"],{
      stdio:["ignore","pipe","pipe"],env:{...process.env,OMP_THREAD_LIMIT:"1"}});
    let out="",settled=false;
    const finish=(err,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(err)reject(err);else resolve(value);
    };
    const timer=setTimeout(()=>{child.kill("SIGKILL");finish(Error("ocr_timeout"))},26000);
    child.stdout.on("data",x=>{
      out+=x.toString("utf8");
      if(out.length>160000){child.kill("SIGKILL");finish(Error("ocr_output_limit"))}
    });
    child.on("error",finish);
    child.on("close",code=>code===0?finish(null,out):finish(Error("ocr_failed")));
  });
}

export async function recognizeImage(buffer,{highQuality=false}={}){
  const meta=imageDetails(buffer);
  if(!meta)throw Error("invalid_or_oversized_raster");
  if(running)throw Error("ocr_busy");
  running=true;let dir;
  try{
    dir=await mkdtemp(join(tmpdir(),"psigo-image-"));
    const file=join(dir,"source."+meta.format);
    await writeFile(file,buffer,{mode:0o600});
    let text=(await tesseract(file,3)).trim(),pass="standard";
    if(highQuality||text.length<90){
      const alternative=(await tesseract(file,11)).trim();
      if(alternative.length>text.length){text=alternative;pass="sparse_text"}
    }
    return {ok:true,text,format:meta.format,width:meta.width,height:meta.height,
      sha256:createHash("sha256").update(buffer).digest("hex"),
      ocr:{status:text?"complete":"no_text",engine:"tesseract",pass,characters:text.length,verified:false}};
  }finally{running=false;if(dir)await rm(dir,{force:true,recursive:true})}
}

export async function fetchOfficialImage(source,imageUrl,officialUrl){
  const u=officialImageUrl(source,imageUrl,officialUrl);
  if(!u)throw Error("image_url_not_allowlisted");
  const ips=await lookup(u.hostname,{all:true,verbatim:true});
  if(!ips.length||ips.some(x=>!publicIp(x.address)))throw Error("source_dns_not_public");
  const target=ips.find(x=>x.family===4)||ips[0];
  const agent=new https.Agent({rejectUnauthorized:true,
    lookup:(_host,opts,cb)=>opts?.all ? cb(null,[{address:target.address,family:target.family}]) : cb(null,target.address,target.family)});
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),14000);
  try{
    const response=await fetch(u.href,{method:"GET",redirect:"manual",agent,
      signal:ctl.signal,headers:{Accept:"image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff",
        "User-Agent":"PsiGoOfficialOCR/1.0 (+https://psigo.it)"}});
    if(!response.ok)throw Error("image_fetch_http_"+response.status);
    const mime=(response.headers.get("content-type")||"").split(";")[0].toLowerCase();
    if(!["image/png","image/jpeg","image/webp","image/gif","image/bmp","image/tiff","application/octet-stream"].includes(mime))
      throw Error("image_invalid_mime");
    if(Number(response.headers.get("content-length")||0)>MAX_BYTES)throw Error("image_too_large");
    let size=0;const chunks=[];
    for await(const chunk of response.body){
      size+=chunk.length;
      if(size>MAX_BYTES){ctl.abort();throw Error("image_too_large")}
      chunks.push(chunk);
    }
    const buffer=Buffer.concat(chunks);
    if(!imageDetails(buffer))throw Error("invalid_or_oversized_raster");
    return {buffer,mime,bytes:size};
  }finally{clearTimeout(timer);agent.destroy()}
}