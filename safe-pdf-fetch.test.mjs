import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { isPublicAddress, publicPdfUrl, fetchPublicPdf } from './safe-pdf-fetch.mjs';
const lookup = async () => [{address:'93.184.216.34',family:4}];
const reply = (status, headers={}, chunks=['%PDF-1.7']) => ({status,ok:status>=200&&status<300,headers:new Map(Object.entries(headers)),body:Readable.from(chunks)});
const src='https://example.org/notice.pdf';
test('blocks non-public, special-use and mapped addresses',()=>{
  for(const ip of ['127.0.0.1','10.0.1.1','100.64.1.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','224.1.1.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});
test('rejects IP literals, encoded addresses, credentials, internal hostnames and ports',()=>{
  for(const url of ['http://localhost/a','http://2130706433/a','http://0x7f000001/a','http://[::1]/a','http://8.8.8.8/a','http://x.internal/a','http://x.home.arpa/a','https://u:p@example.org/a','https://example.org:8443/a','file:///tmp/a']) assert.throws(()=>publicPdfUrl(url));
  assert.equal(publicPdfUrl(src).href,src);
});
test('pins public DNS to socket and returns content',async()=>{
  const got=await fetchPublicPdf(src,{}, {lookup,fetchImpl:async (url,opts)=>{
    assert.equal(opts.redirect,'manual');
    await new Promise((resolve,reject)=>opts.agent.options.lookup('example.org',{all:true},(e,a)=>{if(e)return reject(e);assert.deepEqual(a,[{address:'93.184.216.34',family:4}]);resolve();}));
    return reply(200,{'content-type':'application/pdf'});
  }});
  assert.equal(got.buffer.toString(),'%PDF-1.7');
});
test('rejects mixed DNS before requesting content',async()=>{
  let called=false;
  await assert.rejects(fetchPublicPdf(src,{}, {lookup:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],fetchImpl:async()=>{called=true;}}),/pdf_dns_not_public/);
  assert.equal(called,false);
});
test('checks fresh DNS after each redirect',async()=>{
  let called=0;
  await assert.rejects(fetchPublicPdf(src,{}, {lookup:async host=>host==='example.org'?[{address:'93.184.216.34',family:4}]:[{address:'10.0.0.2',family:4}],fetchImpl:async()=>{called++;return reply(302,{location:'https://other.example.org/a.pdf'});}}),/pdf_dns_not_public/);
  assert.equal(called,1);
});
test('allows relative redirects and rejects downgrade/limit',async()=>{
  let called=0;
  const got=await fetchPublicPdf(src,{}, {lookup,fetchImpl:async()=>++called===1?reply(302,{location:'/new.pdf'}):reply(200)});
  assert.equal(got.finalUrl,'https://example.org/new.pdf');
  await assert.rejects(fetchPublicPdf(src,{}, {lookup,fetchImpl:async()=>reply(302,{location:'http://example.org/a'})}),/unsafe_pdf_redirect/);
  await assert.rejects(fetchPublicPdf(src,{}, {lookup,maxRedirects:0,fetchImpl:async()=>reply(302,{location:'/new.pdf'})}),/pdf_redirect_limit/);
});
test('limits streamed bytes even without Content-Length',async()=>{
  await assert.rejects(fetchPublicPdf(src,{}, {lookup,maxBytes:7,fetchImpl:async()=>reply(200,{},['%PDF-','1234'])}),/PDF too large/);
  await assert.rejects(fetchPublicPdf(src,{}, {lookup,maxBytes:7,fetchImpl:async()=>reply(200,{'content-length':'100'})}),/PDF too large/);
});
test('entire request timeout includes DNS',async()=>{
  await assert.rejects(fetchPublicPdf(src,{}, {lookup:()=>new Promise(()=>{}),timeoutMs:10,fetchImpl:async()=>reply(200)}),/PDF fetch timeout/);
});
