self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d={};try{d=e.data.json()}catch(x){try{d={body:e.data.text()}}catch(y){}}
  const urgent=!!d.urgent;
  e.waitUntil(self.registration.showNotification(d.title||'Карта тривог',{
    body:d.body||'',tag:d.tag||'alert',renotify:true,requireInteraction:urgent,
    vibrate:urgent?[500,200,500,200,500]:[200],icon:'icon-192.png',badge:'icon-192.png',silent:false
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>l.length?l[0].focus():self.clients.openWindow('./')));
});
