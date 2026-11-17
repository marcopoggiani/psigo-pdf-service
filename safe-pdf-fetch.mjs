// PsiGo: bounded, DNS-pinned public PDF fetch, including every redirect.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const denied4 = new BlockList();
for (const [ip, mask] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15],
  ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3],
]) denied4.addSubnet(ip, mask, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::',3,'ipv6');
const denied6 = new BlockList();
for (const [ip, mask] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) {
  denied6.addSubnet(ip, mask, 'ipv6');
}

export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !denied4.check(ip,'ipv4');
  if (family === 6) return global6.check(ip,'ipv6') && !denied6.check(ip,'ipv6');
  return false;
}

export function publicPdfUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('unsafe_pdf_url'); }
  const host = url.hostname.toLowerCase().replace(/\.$/,'');
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !host.includes('.') || isIP(host.replace(/^\[|\]$/g,'')) ||
      /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|onion|home\.arpa)$/.test(host)) {
    throw Error('unsafe_pdf_url');
  }
  url.hash = '';
  return url;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

export async function fetchPublicPdf(value, headers, {
  fetchImpl, lookup = dnsLookup, timeoutMs = 25000, maxBytes = 25*1024*1024, maxRedirects = 5,
} = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('PDF fetch timeout')),timeoutMs);
  try {
    let url = publicPdfUrl(value);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const ips = await withAbort(lookup(url.hostname,{all:true,verbatim:true}),signal);
      if (!ips.length || ips.some(({address,family}) => !isPublicAddress(address) || isIP(address)!==family)) {
        throw Error('pdf_dns_not_public');
      }
      const chosen = ips.find(x=>x.family===4) || ips[0];
      const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
      const agent = new Agent({keepAlive:false, lookup:(host,opts,cb)=>{
        if (host.toLowerCase() !== url.hostname.toLowerCase()) return cb(Error('pdf_dns_host_mismatch'));
        return opts?.all ? cb(null,[chosen]) : cb(null,chosen.address,chosen.family);
      }});
      let response;
      try {
        response = await fetchImpl(url.href,{method:'GET',headers,redirect:'manual',signal,agent});
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || hop === maxRedirects) throw Error('pdf_redirect_limit');
          const next = publicPdfUrl(new URL(location,url).href);
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw Error('unsafe_pdf_redirect');
          url = next;
          continue;
        }
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) return {ok:false,status:response.status,contentType,finalUrl:url.href};
        const length = Number(response.headers.get('content-length') || 0);
        if (!Number.isFinite(length) || length < 0 || length > maxBytes) throw Error('PDF too large');
        const chunks=[]; let size=0;
        for await (const chunk of response.body) {
          const buffer=Buffer.from(chunk); size+=buffer.length;
          if (size>maxBytes) throw Error('PDF too large');
          chunks.push(buffer);
        }
        return {ok:true,status:response.status,contentType,finalUrl:url.href,buffer:Buffer.concat(chunks,size)};
      } finally {
        response?.body?.destroy?.();
        agent.destroy();
      }
    }
    throw Error('pdf_redirect_limit');
  } finally { clearTimeout(timer); }
}
