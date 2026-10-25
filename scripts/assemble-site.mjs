// assemble-site.mjs: composes dist/ (Cloudflare Pages root) from app builds
// (dist/products/<product>/app/) + the site shell (site/). Nothing here
// writes into an app folder. Usage: `npm run build` (apps + dist) or
// `npm run assemble` (dist only, same as --no-build).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsRoot = path.dirname(websiteRoot); // the folder holding every app folder
const siteDir = path.join(websiteRoot, 'site');
const dist = path.join(websiteRoot, 'dist');
// Pre-built Split Task app output (committed to this repo) so Cloudflare Pages
// can deploy the app even though the Split Task source lives in a sibling repo.
const APP_FALLBACK_ROOT = path.join(websiteRoot, 'site', 'split-task-app');

// Every app on manumit.studio: folder (next to Website/), product (its Vite
// outDir dist/products/<product>), mount (deploy path; app never occupies
// /products/<product>/ itself). Product card + nav + sitemap point at the
// shell product page, never straight into the app. Adding an entry here is
// the last step of "Adding the next app" in README.md.
const APPS = [
  { folder: 'Split Task', product: 'split-task', mount: 'products/split-task/app' },
  // { folder: 'Study app', product: 'study', mount: 'products/study/app' },   <- add once Study ships
];

// `npm run assemble` skips the app builds and only re-composes dist/.
const skipAppBuild = process.argv.includes('--no-build');

if (!fs.existsSync(siteDir)) {
  console.error('[assemble] site/ is missing - this is not a website checkout.');
  process.exit(1);
}

// App deploy path (entry `mount`, else /products/<product>/). Everything
// under a mount belongs to that app's build — the shell never touches it.
const appMount = (app) => app.mount || `products/${app.product}`;
const appRoot = (app) => {
  const r = path.join(appsRoot, app.folder);
  return fs.existsSync(r) ? r : APP_FALLBACK_ROOT;
};
const appBuild = (app) => path.join(appRoot(app), 'dist', 'products', app.product);
const mounts = APPS.map((app) => path.resolve(dist, appMount(app)));
const insideMount = (p) => mounts.some((m) => p === m || p.startsWith(m + path.sep));

// 1. Build + verify every app first: a failure leaves dist/ untouched.
// `--no-build` skips app builds and only re-composes dist/.
for (const app of APPS) {
  const sourceRoot = path.join(appsRoot, app.folder);
  const root = appRoot(app);
  const isFallback = !fs.existsSync(sourceRoot);

  if (!skipAppBuild && !isFallback) {
    console.log(`[assemble] building "${app.folder}" ...`);
    // Shell:true resolves npm.cmd on Windows; single string avoids DEP0190.
    const build = spawnSync('npm run build', {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
    if (build.status !== 0) {
      console.error(`[assemble] "${app.folder}" build failed (exit ${build.status}).`);
      process.exit(build.status ?? 1);
    }
  }

  if (!fs.existsSync(appBuild(app))) {
    console.error(`[assemble] missing ${appBuild(app)} - run "npm run build" in "${app.folder}" first.`);
    process.exit(1);
  }
}

// 2. Rebuild dist/ from scratch (app builds + site/ survive above, so no stale deploy leaks in).
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 3. Mount each app build at its deploy path.
// 4. Copy the shell file-by-file, skipping mounts (the shell owns the pages
//    around the apps, incl. each product page; the deeper mount keeps a copy
//    from ever clobbering a fresh app build).
for (const app of APPS) {
  const built = appBuild(app);
  if (!fs.existsSync(built)) {
    console.warn(`[assemble] no build for "${app.folder}" - not mounting ${appMount(app)}`);
    continue;
  }
  const target = path.join(dist, appMount(app));
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(appBuild(app), target, { recursive: true, force: true });
  console.log(`[assemble] ${app.folder} -> dist/${appMount(app).replace(/\\/g, '/')}`);
}

function copyShell(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (insideMount(dest)) continue; // owned by an app build
    if (entry.isDirectory()) copyShell(src, dest);
    else fs.copyFileSync(src, dest);
  }
}
copyShell(siteDir, dist);

// 5. Stamp the copied HTML's shell CSS/JS references with content hashes
//    (?v=<hash>). _headers serves these files with max-age=0, but the
//    manumit.studio custom domain sits behind a zone whose browser cache
//    serves static assets with max-age=14400 regardless of _headers (the
//    pages.dev deployment honors it), so a fresh deploy could pair new HTML
//    with a stale stylesheet for up to 4h - e.g. the human-badge markup
//    rendering full-size without its .human-badge rules. A content hash
//    changes the URL exactly when the bytes change, so a changed asset is
//    always fetched fresh - the same strategy Vite uses for app bundles
//    (which are never touched here: app mounts are skipped below).
const assetRef = /(?<![\w.-])((?:href|src)=)(["'])(\/[^"'?#\s]+\.(?:css|js))(?:\?[^"']*)?(["'])/g;
const hashCache = new Map();
const shellHtml = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (insideMount(p)) continue; // app builds ship their own hashed assets
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.html')) shellHtml.push(p);
  }
})(dist);

let stamped = 0;
for (const file of shellHtml) {
  const html = fs.readFileSync(file, 'utf8');
  const next = html.replace(assetRef, (match, attr, openQ, urlPath, closeQ) => {
    const target = path.join(dist, urlPath.slice(1));
    if (!fs.existsSync(target) || insideMount(target)) return match;
    let hash = hashCache.get(target);
    if (!hash) {
      hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 10);
      hashCache.set(target, hash);
    }
    stamped += 1;
    return `${attr}${openQ}${urlPath}?v=${hash}${closeQ}`;
  });
  if (next !== html) fs.writeFileSync(file, next);
}

const built = APPS.map((app) => `${app.product} -> ${appMount(app)}`).join(', ') || '(no apps)';
console.log(`[assemble] dist/ -> manumit.studio shell + ${built}`);
console.log(`[assemble] stamped ${stamped} asset references with content hashes`);
