// Nav dropdowns are JS-owned; CSS :hover latches on hybrid touch laptops.
function setToggleState(ddl, open) {
  ddl.classList.toggle('is-open', open);
  var toggle = ddl.querySelector('.drop-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) positionMenu(ddl);
  return open;
}

// Flip a nav dropdown upward when it would run off the bottom edge of the
// viewport (mirrors the app's CustomSelect flip-up behaviour).
function positionMenu(ddl) {
  var menu = ddl.querySelector('.drop-menu');
  if (!menu) return;
  menu.classList.remove('flip-up');
  menu.style.top = ''; menu.style.bottom = ''; menu.style.margin = '';
  // Force layout so getBoundingClientRect reflects the open state.
  menu.offsetHeight;
  var toggle = ddl.querySelector('.drop-toggle');
  var trect = toggle ? toggle.getBoundingClientRect() : null;
  var viewport = window.innerHeight || document.documentElement.clientHeight;
  var spaceBelow = viewport - (trect ? trect.bottom : menu.getBoundingClientRect().top) - 8;
  var menuHeight = menu.getBoundingClientRect().height;
  if (spaceBelow < menuHeight) {
    menu.classList.add('flip-up');
    menu.style.bottom = '100%';
    menu.style.margin = '0 0 8px 0';
  } else {
    menu.style.top = '100%';
    menu.style.margin = '8px 0 0 0';
  }
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

(function () {
  function linkPath(link) {
    return (link.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  }

  var siteNav = document.querySelector('.site-header nav');
  if (siteNav) {
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
      return linkPath(link) === '/products/syllable';
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
})();
