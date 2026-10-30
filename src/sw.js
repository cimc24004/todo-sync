/* API・認証・個人データはキャッシュしない。静的UIのみオフライン対応。 */
const CACHE='michi-static-v1';const FILES=['./','./index.html','./style.css','./renderer.js','./config.js','./sync-core.js','./drive-sync.js','./data-adapter.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('michi-static-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const url=new URL(e.request.url);const assets=new Set(FILES.map(f=>new URL(f,self.registration.scope).href));if(e.request.method!=='GET'||url.origin!==location.origin||url.search||!assets.has(url.href))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;}).catch(()=>caches.match(e.request)));});
