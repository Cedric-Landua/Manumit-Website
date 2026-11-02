// Nav dropdowns + theme toggles (JS-owned; never CSS :hover — it latches on
// hybrid touch laptops). Reusable: bindToggleList + bindThemeToggles.
function setPressedState(buttons, pressed) {
  var val = pressed ? 'true' : 'false';
  for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', val);
  return val;
}
function setToggleState(ddl, open) {
  ddl.classList.toggle('is-open', open);
  var toggle = ddl.querySelector('.drop-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  return open;
}
// bindToggleList(rootSel): mouse hover opens, tap toggles; outside-click /
// Escape / pageshow close. Second tap on an open toggle follows its link.
function bindToggleList(rootSel) {
  var roots = Array.prototype.slice.call(document.querySelectorAll(rootSel || '.nav-drop'));
  if (!roots.length) return;
  function closeAll(except) { roots.forEach(function (d) { if (d !== except) setToggleState(d, false); }); }
  roots.forEach(function (drop) {
    var toggle = drop.querySelector('.drop-toggle');
    if (!toggle || !drop.querySelector('.drop-menu')) return;
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    var closeTimer = null;
    drop.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(closeTimer);
      closeAll(drop);
      setToggleState(drop, true);
    });
    drop.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      closeTimer = setTimeout(function () { setToggleState(drop, false); }, 120);
    });
    toggle.addEventListener('click', function (e) {
      if (drop.classList.contains('is-open')) return; // follow link
      e.preventDefault();
      closeAll(drop);
      setToggleState(drop, true);
    });
  });
  document.addEventListener('click', function (e) {
    roots.forEach(function (d) { if (!d.contains(e.target)) setToggleState(d, false); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll(null);
  });
  window.addEventListener('pageshow', function () { closeAll(null); });
}

// Theme toggle: <head> pre-paint script sets data-theme; this wires buttons
// (localStorage `theme`, dark by default) and syncs aria-pressed.
function bindThemeToggles(btnSel) {
  var root = document.documentElement;
  function current() {
    var stored = root.getAttribute('data-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return 'dark';
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    setPressedState(document.querySelectorAll(btnSel), theme === 'dark');
    return theme;
  }
  document.querySelectorAll(btnSel).forEach(function (btn) {
    btn.addEventListener('click', function () { apply(current() === 'dark' ? 'light' : 'dark'); });
  });
  setPressedState(document.querySelectorAll(btnSel), current() === 'dark');
  return { current: current, apply: apply };
}
(function () {
  var siteNav = document.querySelector('.site-header nav');
  if (siteNav) {
    var productDropdown = siteNav.querySelector('.nav-drop .drop-menu');
    if (productDropdown && !productDropdown.querySelector('a[href="/products/syllable/"]')) {
      var syllableLink = document.createElement('a');
      syllableLink.href = '/products/syllable/';
      syllableLink.textContent = 'Syllable';
      productDropdown.appendChild(syllableLink);
    }

    if (!siteNav.querySelector('a[href="/data/"]')) {
      var dataLink = document.createElement('a');
      dataLink.href = '/data/';
      dataLink.textContent = 'Data';
      if (window.location.pathname.replace(/\/+$/, '') === '/data') {
        dataLink.className = 'active';
        dataLink.setAttribute('aria-current', 'page');
      }
      var policiesDropdown = Array.prototype.slice.call(siteNav.querySelectorAll('.nav-drop')).find(function (drop) {
        var toggle = drop.querySelector('.drop-toggle');
        return toggle && toggle.getAttribute('href') === '/policies/';
      });
      if (policiesDropdown) siteNav.insertBefore(dataLink, policiesDropdown);
      else siteNav.appendChild(dataLink);
    }
  }

  bindToggleList('.nav-drop');
  bindThemeToggles('.theme-toggle');
})();
