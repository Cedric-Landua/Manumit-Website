// Homepage previews: simplified quick-add parser and flashcard flip. Fully local.
(function () {
  function init() {
    var input = document.getElementById('mm-try-input'), go = document.getElementById('mm-try-go'), out = document.getElementById('mm-try-out');
    if (input && go && out) {
      var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      function parse(t) {
        var s = t.trim(), day = 'Today', time = '';
        var tm = s.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
        if (tm) { time = tm[1] + ':' + (tm[2] || '00') + ' ' + tm[3].toUpperCase(); s = s.replace(tm[0], ' '); }
        var now = new Date(), d = null;
        if (/\btomorrow\b/i.test(s)) { d = new Date(now.getTime() + 864e5); s = s.replace(/\btomorrow\b/i, ' '); }
        else if (/\btoday\b/i.test(s)) { s = s.replace(/\btoday\b/i, ' '); }
        else { for (var i = 0; i < 7; i++) { var r = new RegExp('\\b' + days[i] + '\\b', 'i'); if (r.test(s)) { d = new Date(now); d.setDate(now.getDate() + ((i - now.getDay() + 7) % 7 || 7)); s = s.replace(r, ' '); break; } } }
        if (d) day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        s = s.replace(/\s+/g, ' ').trim();
        return { title: s ? s.charAt(0).toUpperCase() + s.slice(1) : '', day: day, time: time };
      }
      function run() {
        var p = parse(input.value);
        out.textContent = '';
        if (!p.title) return;
        [['Task', p.title], ['Day', p.day], ['Time', p.time || 'No time set']].forEach(function (r) {
          var li = document.createElement('li'), b = document.createElement('b'), v = document.createElement('span');
          b.textContent = r[0]; v.textContent = r[1]; li.appendChild(b); li.appendChild(v); out.appendChild(li);
        });
      }
      go.addEventListener('click', run);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
      run();
    }
    var flip = document.getElementById('mm-flip');
    if (flip) flip.addEventListener('click', function () {
      var on = flip.getAttribute('aria-pressed') !== 'true';
      flip.setAttribute('aria-pressed', on ? 'true' : 'false');
      flip.querySelector('.mm-flip-front').hidden = on;
      flip.querySelector('.mm-flip-back').hidden = !on;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
