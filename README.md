# manumit.studio - website

Everything that *is* the `manumit.studio` website: the public site shell, the
build that composes the deployable `dist/`, and the Cloudflare Worker + D1
schema behind `/api/*`. App code does not live here - each app keeps its own
folder next to this one (`../Split Task`, `../Vocabulary Expander`, and the
other apps as they arrive).

## Layout - website vs app

```
├── site/                     ← STATIC SHELL - what visitors load from manumit.studio
│   ├── index.html               home page                → /
│   ├── split-task-app/          pre-built fallback for CI deploys
│   ├── syllable-app/            pre-built fallback for CI deploys
│   ├── products/index.html      product cards            → /products/
│   ├── products/split-task/     Split Task product page  → /products/split-task/
│   ├── products/syllable/       Syllable product page    → /products/syllable/
│   ├── data/                    account and data guide   → /data/
│   │   └── delete/              credential-verified account deletion → /data/delete/
│   ├── policies/                policies index + privacy/ + eula/ + policies.css
│   ├── help/  ·  help.js        ticket form              → /help/
│   ├── admin/ ·  admin.js       ticket dashboard         → /admin/
│   ├── 404.html                 site-level 404 (Pages serves the nearest one)
│   ├── site.css  ·  nav.js      shared site styles + top tab bar
│   ├── account-deletion.css/js  website-served account deletion flow
│   ├── help-widget.js           floating "Need help?" widget (every page)
│   ├── sitemap.xml  ·  _headers SEO sitemap + Cloudflare Pages headers
│   ├── favicon.svg · icon.png   SVG tab favicon; icon.png = PNG fallback / OG image
│   └── google852649c4e1572428.html   Search Console verification (served at /)
│
├── scripts/assemble-site.mjs ← build orchestration: apps -> dist/ + shell -> dist/
├── worker.js                 ← Cloudflare Worker API backend (/api/*)
├── schema-d1.sql             ← Shared-account Cloudflare D1 schema (current source)
├── schema-d1-legacy.sql      ← Previous username-keyed schema, retained for rollback
├── schema-script.txt         ← legacy MySQL schema, reference only - not for D1
├── google852649c4e1572428.html   same verification file, kept next to the build
│
└── dist/                     ← BUILD OUTPUT - upload this to Cloudflare Pages
    ├── index.html               manumit.studio/
    ├── products/index.html      /products/
    ├── products/split-task/     the Split Task product page → /products/split-task/
    ├── products/syllable/       the Syllable product page → /products/syllable/
    ├── policies/…               /policies/
    ├── data/                    /data/
    │   └── delete/              /data/delete/
    ├── help/  ·  admin/         /help/ · /admin/
    ├── products/split-task/app/ the Split Task app → /products/split-task/app/
    └── products/syllable/app/   the Syllable app → /products/syllable/app/
```

- **Website** = this folder (`site/` shell + the build + the Worker backend).
- **Apps** = `../Split Task`, `../Vocabulary Expander`, and later the other app folders. Each app builds
  only itself, into its own `dist/products/<product>/`; the website build reads
  that output and copies it in. The Android builds therefore never receive the
  site shell, and a broken shell can never break an app build.

## Build & deploy

```sh
npm run build      # build every app, then compose dist/
npm run assemble   # compose dist/ from the apps' existing build output
```

`npm run build` does four things:

1. runs `npm run build` in every app listed in `scripts/assemble-site.mjs`
   (`APPS`) when its sibling source folder is available; otherwise it uses the
   committed fallback bundle under `site/<app>-app/`;
2. mounts each of those app folders at its `mount` path in `dist/`
   (`products/split-task/app`), so the app never occupies the product page URL;
3. clears `dist/` and copies `site/` in, file by file, skipping every app mount,
   so the shell is always the marketing pages - including each app's product
   page - and the app folders are always fresh builds.
4. stamps every shell CSS/JS `href`/`src` in the copied HTML with a content
   hash (`?v=<hash>`), so changed bytes mean a new URL and a deploy can never
   pair new HTML with a stale asset. (The manumit.studio zone serves static
   assets with a 4h browser cache, overriding `_headers`' `max-age=0`; the
   pages.dev deployment honors `_headers`.)

**Web deploy:** upload the contents of `dist/` as the Cloudflare Pages project
root, with `manumit.studio` as the custom domain. The site then serves:

```
https://manumit.studio/
https://manumit.studio/products/              ← product list
https://manumit.studio/products/split-task/   ← product page (what the card links to)
https://manumit.studio/products/split-task/app/   ← the app (login)
https://manumit.studio/products/syllable/     ← Syllable product page
https://manumit.studio/products/syllable/app/ ← Syllable app
https://manumit.studio/data/                  ← data information + account deletion
https://manumit.studio/data/delete/           ← account deletion page
https://manumit.studio/help/                  ← support tickets
https://manumit.studio/policies/              ← Privacy + Terms
```

**Backend:** `worker.js` is the single Cloudflare Worker behind the Split Task
API endpoint (all `/api/*` routes). `schema-d1.sql` defines its shared D1:
stable Manumit user IDs, login identities, product access, and product-owned
data tables. `schema-d1-legacy.sql` records the previous username-keyed layout.
The support-ticket database remains a separate binding.

When updating an app maintained in a sibling repository, refresh its committed
fallback bundle after building it: copy
`../Vocabulary Expander/dist/products/syllable/` to
`site/syllable-app/dist/products/syllable/`. The matching app entry in
`scripts/assemble-site.mjs` points CI at that fallback when the source checkout
is unavailable.

## Shared-account database cutover

The new Worker and `schema-d1.sql` target a clean D1 database; do not apply the
new schema to the old live database or deploy the new Worker against the old
schema. Keep the old D1 available until account login, Split Task sync, and the
encrypted-note key have been verified against the new database.

`scripts/prepare-split-task-import.py` prepares an SQL import from one selected
account in the CSV export. The generated SQL contains that account's legacy
credential hash and app data; keep the file private and delete it after import.
Pass `--wrapped-key-file` with the recovered `WRAP1` key, and
`--note-metadata-file` with a private CSV containing
`username,id,hidden,text_is_encrypted` from the old D1. Do not paste the key or
private account data into chat or source control. The pre-edit CSV export does
not contain the wrapped secure-notes key or hidden-note flags. Preserve the old
D1 and a logged-in device until the key and note state have been recovered and
checked.

Cutover order:

1. Create a new D1 database; do not repoint the live Worker yet.
2. Apply `schema-d1.sql` to the new database.
3. Generate and import the one-account SQL file from the pre-edit CSV export.
   The import script reports table counts without printing row contents.
4. Repoint the existing Worker's `ST-DATABASE` binding to the new D1 and deploy
   this Worker version.
5. Verify login, pull/push on the retained device, settings, categories, items,
   notes, and secure-note decryption. Confirm the wrapped key has synced before
   testing another device.
6. Keep the old D1 untouched until those checks pass; only then decide whether
   to remove test accounts or retire the old database.

## Adding the next app to the website

1. Build the app so it outputs `dist/products/<product>/` (its own
   `vite.config.js` sets `outDir`).
2. Add `{ folder: '<app folder>', product: '<product>', mount: 'products/<product>/app' }`
   to `APPS` in `scripts/assemble-site.mjs`.
3. Add the product page the card links to: `site/products/<product>/index.html`
   (policies, download, and the launch link into the app).
4. Link it: product card in `site/products/index.html`, nav dropdown in
   `site/nav.js`, URL in `site/sitemap.xml`.
5. `npm run build`.

## Notes

- Unknown web paths get `site/404.html` (site level) or the app's own
  `404.html` under `/products/<product>/` (Cloudflare Pages serves the nearest
  `404.html`).
- `site/_redirects` serves the app's pre-login deep links
  (`/products/split-task/app/login|signup|delete`) from that app's `index.html` - exact
  paths only, so assets and pages are untouched - and redirects their
  trailing-slash forms, which would otherwise resolve the app's relative asset URLs
  one directory too deep. The pre-move paths under `/products/split-task/` are
  forwarded to the app so old links keep working. Never add a rule for the bare
  app root (`/products/split-task/app`): a source without a trailing slash also
  matches the deeper app paths, and the top-most match wins, so it would swallow
  `/app/delete` and `/app/login` and land both on the login screen. Pages serves
  the bare root itself.
- Policies in `site/policies/index.html` are drafts - replace the `[...]`
  contact placeholders before going live.
- The worker's custom 404 (non-`/api` routes) links back to
  `manumit.studio/products/split-task/app/`.
- `site/products/split-task/index.html` (the product page) and
  `site/products/index.html` (the cards) are shell pages: the build copies them
  over the mounted apps and never into them.
- The site version lives in the home footer only - `Site vN` in `site/index.html`.
  Bump it with **every update**, not just every deploy, so the live build is
  identifiable at a glance and a stale page is obvious.
  (`site/admin/index.html` has its own separate counter.)
- `site/` is plain HTML/CSS/JS with no build step - editing a file there and
  running `npm run assemble` is enough to update the deploy.
