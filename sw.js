// Service Worker：只快取程式本身的檔案（畫面、設定、API 層、圖示），讓 App 可以安裝、開啟更快。
// 待辦資料一律即時向雲端讀寫，這裡不會快取任何資料。
// 更新程式後，把下面的版本號加一，使用者重開兩次 App 就會套用新版。
const CACHE='todo-board-v4';
const FILES=['./','./index.html','./config.js','./api.js','./manifest.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
// 只處理同網域的程式檔：先用網路拿最新版，連不上時改用快取。
// 對 Supabase 的請求（不同網域）完全不經過這裡。
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c))}return r})
    .catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('./index.html'))));
});
