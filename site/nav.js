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
    function linkPath(link) {
      return (link.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    }

    function ensureMenuLink(menu, path, label) {
      var links = Array.prototype.slice.call(menu.querySelectorAll('a')).filter(function (link) {
        return linkPath(link) === path;
      });
      var link = links.shift();
      if (!link) {
        link = document.createElement('a');
        link.href = path + '/';
        link.textContent = label;
        menu.appendChild(link);
      }
      links.forEach(function (duplicate) { duplicate.remove(); });
    }

    var productDrop = Array.prototype.slice.call(siteNav.querySelectorAll('.nav-drop')).find(function (drop) {
      var toggle = drop.querySelector('.drop-toggle');
      return toggle && linkPath(toggle) === '/products';
    });
    var productMenu = productDrop && productDrop.querySelector('.drop-menu');
    if (productMenu) {
      ensureMenuLink(productMenu, '/products/split-task', 'Split Task');
      ensureMenuLink(productMenu, '/products/syllable', 'Syllable');
    }

    var dataLinks = Array.prototype.slice.call(siteNav.querySelectorAll('a')).filter(function (link) {
      return linkPath(link) === '/data';
    });
    var dataLink = dataLinks.shift();
    if (!dataLink) {
      dataLink = document.createElement('a');
      dataLink.href = '/data/';
      dataLink.textContent = 'Data';
    }
    dataLinks.forEach(function (duplicate) { duplicate.remove(); });
    if (/^\/data(?:\/|$)/.test(window.location.pathname)) {
      dataLink.classList.add('active');
      dataLink.setAttribute('aria-current', 'page');
    } else {
      dataLink.classList.remove('active');
      dataLink.removeAttribute('aria-current');
    }
    if (dataLink.parentNode !== siteNav) {
      var policiesDropdown = Array.prototype.slice.call(siteNav.querySelectorAll('.nav-drop')).find(function (drop) {
        var toggle = drop.querySelector('.drop-toggle');
        return toggle && linkPath(toggle) === '/policies';
      });
      if (policiesDropdown && policiesDropdown.parentNode === siteNav) siteNav.insertBefore(dataLink, policiesDropdown);
      else siteNav.appendChild(dataLink);
    }
  }

  document.querySelectorAll('.site-footer .col').forEach(function (column) {
    var heading = column.querySelector('h2');
    if (!heading || heading.textContent.trim() !== 'Products') return;
    var productLinks = Array.prototype.slice.call(column.querySelectorAll('a')).filter(function (link) {
      return (link.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/+$/, '') === '/products/syllable';
    });
    var syllableLink = productLinks.shift();
    if (!syllableLink) {
      syllableLink = document.createElement('a');
      syllableLink.href = '/products/syllable/';
      syllableLink.textContent = 'Syllable';
      column.appendChild(syllableLink);
    }
    productLinks.forEach(function (duplicate) { duplicate.remove(); });
  });

  bindToggleList('.nav-drop');
  bindThemeToggles('.theme-toggle');
})();
