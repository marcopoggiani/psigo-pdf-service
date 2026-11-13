import test from "node:test";
import assert from "node:assert/strict";
import { imageDetails, publicIp, officialImageUrl } from "../image-ocr.mjs";

function png(width=900,height=500){
  const b=Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a","hex").copy(b);
  b.writeUInt32BE(13,8);
  b.write("IHDR",12,"ascii");
  b.writeUInt32BE(width,16);
  b.writeUInt32BE(height,20);
  return b;
}
test("accepts bounded PNG metadata and rejects oversized dimensions",()=>{
  assert.equal(imageDetails(png())?.format,"png");
  assert.equal(imageDetails(png())?.width,900);
  assert.equal(imageDetails(png(9000,500)),null);
  assert.equal(imageDetails(png(6000,6000)),null);
  assert.equal(imageDetails(Buffer.alloc(300)),null);
});
test("blocks private, link-local, loopback and invalid network addresses",()=>{
  for(const ip of ["127.0.0.1","10.0.0.9","169.254.169.254",
     "172.16.0.1","192.168.1.3","100.64.0.1","::1","fe80::1"])
    assert.equal(publicIp(ip),false,ip);
  assert.equal(publicIp("8.8.8.8"),true);
});
test("official source URL must use HTTPS, same host, no token query or redirect host",()=>{
  const source="ordine_lazio_training",page="https://ordinepsicologilazio.it/corsi";
  assert.ok(officialImageUrl(source,"https://ordinepsicologilazio.it/uploads/locandina.jpg",page));
  assert.ok(officialImageUrl(source,"https://ordinepsicologilazio.it/uploads/locandina.jpg",page+"#section-123"));
  for(const url of ["http://ordinepsicologilazio.it/a.jpg",
    "https://evil.test/a.jpg","https://ordinepsicologilazio.it/a.jpg?token=x",
    "https://ordinepsicologilazio.it/a.svg",
    "https://ordinepsicologilazio.it@evil.test/a.jpg"])
    assert.equal(officialImageUrl(source,url,page),null,url);
  assert.equal(officialImageUrl("unregistered", "https://ordinepsicologilazio.it/a.jpg",page),null);
});
