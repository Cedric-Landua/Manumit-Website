// Homepage network status: server reports uptime; latencies are fixed
// typical estimates rendered as an animated map. No user-triggered ping.
// Status refreshes quietly every 60 s; map animates continuously.
(function () {
  var API = (window.FE && window.FE.API_BASE) || 'https://manumit-api.landua-cedric.workers.dev';
  var HUB = { id: 'hub', label: 'Core hub', x: 140, y: 105 };
  var REGIONS = [
    { id: 'us-central', label: 'US Central', x: 158, y: 110, ms: 35 },
    { id: 'us-east', label: 'US East', x: 200, y: 100, ms: 40 },
    { id: 'us-west', label: 'US West', x: 82, y: 105, ms: 50 },
    { id: 'eu-west', label: 'Europe', x: 335, y: 92, ms: 95 },
    { id: 'sa', label: 'South America', x: 230, y: 252, ms: 120 },
    { id: 'asia', label: 'Asia Pacific', x: 505, y: 110, ms: 160 },
    { id: 'oceania', label: 'Oceania', x: 560, y: 230, ms: 185 }
  ];
  // Rough continent blobs for the dotted map (flat, Cloudflare-style).
  // [cx, cy, rx, ry] ellipses in SVG coords — dots land inside these.
  var LAND = [
    [150, 130, 105, 48], [128, 190, 60, 34], [225, 235, 42, 52],
    [330, 105, 70, 34], [345, 165, 42, 55], [505, 135, 85, 50],
    [555, 225, 45, 26], [470, 200, 40, 30]
  ];
  function colorFor(ms) { return ms < 80 ? '#2ee6a8' : ms < 140 ? '#d9a521' : '#e0655f'; }
  var RANGE_LABEL = { '24h': 'last 24h', '7d': 'last 7 days', '30d': 'last 30 days' };
  var range = '24h';
  var windowsCache = null;
  var lastLive = false;
  function setUptime(pct) {
    var upEl = document.getElementById('mm-up');
    var lbl = document.getElementById('mm-up-label');
    if (lbl) lbl.textContent = (RANGE_LABEL[range] || range) + ((pct == null && lastLive) ? ' · collecting data' : '');
    if (!upEl) return;
    if (pct == null) { upEl.textContent = '—'; upEl.style.color = ''; return; }
    upEl.textContent = pct + '%';
    upEl.style.color = pct >= 99 ? '#2ee6a8' : pct >= 95 ? '#d9a521' : '#e0655f';
  }
  function setStatus(ok, d) {
    var dot = document.getElementById('mm-live-dot');
    var txt = document.getElementById('mm-live-text');
    windowsCache = (d && d.windows) || null;
    var pct = windowsCache && windowsCache[range] ? windowsCache[range].pct
      : (d && typeof d.uptimePct === 'number' ? d.uptimePct : null);
    var state = !ok ? 'down' : (d && d.status === 'degraded') ? 'degraded' : 'up';
    lastLive = (state === 'up');
    if (dot) dot.style.background = state === 'up' ? '#2ee6a8' : state === 'degraded' ? '#d9a521' : '#e0655f';
    if (txt) txt.textContent = state === 'up' ? 'Operational'
      : state === 'degraded' ? 'Degraded, retrying' : 'Unreachable, retrying';
    setUptime(state === 'up' ? pct : null);
  }
  function renderMap() {
    // The ping stat stays on its "—" placeholder until the visitor's own zone
    // is known (updateHeadline fills it in); a US average here would mislabel
    // everyone else under a "your zone" caption.
    var dots = document.getElementById('mm-dots');
    var nodes = document.getElementById('mm-nodes');
    var links = document.getElementById('mm-links');
    var list = document.getElementById('mm-regions');
    // Dotted continents: grid of dots clipped to the LAND ellipses.
    if (dots && !dots.hasChildNodes()) {
      var html = '';
      for (var gx = 20; gx < 625; gx += 9) {
        for (var gy = 20; gy < 305; gy += 9) {
          for (var li = 0; li < LAND.length; li++) {
            var e = LAND[li];
            var dx = (gx - e[0]) / e[2], dy = (gy - e[1]) / e[3];
            if (dx * dx + dy * dy <= 1) {
              var near = false;
              for (var ri = 0; ri < REGIONS.length; ri++) {
                var rdx = gx - REGIONS[ri].x, rdy = gy - REGIONS[ri].y;
                if (rdx * rdx + rdy * rdy < 900) { near = true; break; }
              }
              html += '<circle cx="' + gx + '" cy="' + gy + '" r="1.3" class="'
                + (near ? 'mm-dot-lit' : 'mm-dot') + '"/>';
              break;
            }
          }
        }
      }
      dots.innerHTML = html;
    }
    function arc(x2, y2, lift) {
      var mx = (HUB.x + x2) / 2, my = (HUB.y + y2) / 2 - lift;
      return 'M' + HUB.x + ' ' + HUB.y + ' Q' + mx + ' ' + my + ' ' + x2 + ' ' + y2;
    }
    function iconNode(x, y, c, glyph, label) {
      var w = label ? label.length * 7.2 + 28 : 0;
      var tip = label
        ? '<g class="mm-tip"><rect x="' + (x - w / 2) + '" y="' + (y - 46) + '" width="' + w + '" height="28" rx="8" class="mm-tip-bg"/>'
          + '<text x="' + x + '" y="' + (y - 28) + '" text-anchor="middle" class="mm-tip-text">' + label + '</text></g>'
        : '';
      return '<g class="mm-node" tabindex="0"><circle cx="' + x + '" cy="' + y + '" r="9" class="mm-node-ring" style="stroke:' + c + '"/>'
        + '<circle cx="' + x + '" cy="' + y + '" r="9" fill="' + c + '" opacity="0.16" class="mm-node-fill"/>'
        + '<text x="' + x + '" y="' + (y + 3.5) + '" text-anchor="middle" font-size="9" fill="' + c + '">' + glyph + '</text>' + tip + '</g>';
    }
    if (nodes) {
      nodes.innerHTML = iconNode(HUB.x, HUB.y, '#2ee6a8', '▣', HUB.label)
        + REGIONS.map(function (r) { return iconNode(r.x, r.y, colorFor(r.ms), '●', r.label); }).join('');
    }
    if (links) {
      links.innerHTML = REGIONS.map(function (r, i) {
        var dist = Math.hypot(r.x - HUB.x, r.y - HUB.y);
        return '<path d="' + arc(r.x, r.y, 20 + dist * 0.22) + '" class="mm-link" style="animation-delay:' + (i * 0.45) + 's"/>'
          + '<circle r="3" fill="#9cf4e8" class="mm-packet" style="offset-path: path(\'' + arc(r.x, r.y, 20 + dist * 0.22) + '\'); animation-delay:' + (i * 0.45) + 's"/>';
      }).join('');
    }
    if (list) {
      list.innerHTML = REGIONS.map(function (r) {
        return '<li data-region="' + r.id + '"><span class="mm-r-dot" style="background:' + colorFor(r.ms) + '"></span>'
          + '<span>' + r.label + '</span><strong>~' + r.ms + ' ms</strong></li>';
      }).join('');
    }
  }
  // Headline follows the visitor's server-matched region (VPN changes this).
  // The matched node gets a "you are here" treatment: white pulsing ring +
  // YOU tag, distinct from the amber list highlight.
  function updateHeadline(d) {
    var id = d && d.region;
    var r = null;
    for (var i = 0; i < REGIONS.length; i++) {
      if (REGIONS[i].id === id) { r = REGIONS[i]; break; }
    }
    if (!r) return;
    var nodes = document.getElementById('mm-nodes');
    if (nodes) {
      var prev = nodes.querySelector('.mm-you');
      if (prev) prev.remove();
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'mm-you');
      g.innerHTML = '<circle cx="' + r.x + '" cy="' + r.y + '" r="13" class="mm-you-ring"/>';
      nodes.appendChild(g);
    }
    var items = document.getElementById('mm-regions');
    if (items) {
      var rows = items.getElementsByTagName('li');
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].getAttribute('data-region') === id) rows[j].classList.add('mm-active');
        else rows[j].classList.remove('mm-active');
      }
    }
  }
  function check() {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 10000);
    fetch(API + '/api/status?_ts=' + Date.now(), { cache: 'no-store', signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(to);
        if (!res.ok) throw new Error('bad status');
        return res.json();
      })
      .then(function (d) { setStatus(true, d); updateHeadline(d); })
      .catch(function () { clearTimeout(to); setStatus(false, null); });
  }
  function init() {
    if (!document.getElementById('mm-up')) return;
    renderMap();
    var btns = document.querySelectorAll('.mm-range-btn');
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener('click', function () {
        range = this.getAttribute('data-range');
        for (var k = 0; k < btns.length; k++) {
          var on = btns[k] === this;
          btns[k].classList.toggle('mm-range-on', on);
          btns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        setUptime(windowsCache && windowsCache[range] ? windowsCache[range].pct : null);
      });
    }
    check();
    setInterval(check, 3600000); // hourly: buckets are hourly, faster polling only burns D1 reads
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
