// Safari on macOS puts a plate behind the dark square tab icon, so only that
// browser gets the bare glowing ring.
// iPadOS Safari reports a Macintosh UA too; touch points tell it apart.
(function () {
  var ua = navigator.userAgent;
  var macSafari = /Macintosh/.test(ua) && /Safari\//.test(ua) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(ua) && !navigator.maxTouchPoints;
  if (!macSafari) return;
  // Safari's pick between svg / png / ico varies by version and cache state,
  // so swap every tab icon candidate.
  var ring = { svg: 'favicon-ring.svg', png: 'favicon-ring-96.png', ico: 'favicon-ring.ico' };
  var links = document.querySelectorAll('link[rel~="icon"]');
  for (var i = 0; i < links.length; i++) {
    var ext = (links[i].getAttribute('href').match(/\.(svg|png|ico)$/) || [])[1];
    if (ext) links[i].href = '/static/favicon/' + ring[ext];
  }
})();
