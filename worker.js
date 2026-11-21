/**
 * Daily maintenance (retention + deadline push). Shared by cron + lazy sweep
 * on GET /api/sync. Once-per-day guard in app_state (UTC).
 */
/**
 * Self-check uptime (homepage "Live from the edge" card).
 * Every /api/* request cheaply records a 1-hour heartbeat bucket in
 * app_state (uptime:<YYYY-MM-DD-HH> = 1). GET /api/status reads the last
 * 24h of buckets: uptimePct = hit buckets / expected buckets, plus a live
 * `status` from whether THIS request succeeded.
 *
 * A bucket only proves the worker answered some request that hour; an
 * empty hour is ambiguous (idle vs down). On a low-traffic site sparse
 * buckets measure traffic, not uptime (periodic manual connections showed
 * ~33% while the worker never went down), so a window's pct is only
 * published when nearly every hour of it was observed — true hourly
 * coverage comes from the `0 * * * *` cron tick in scheduled() below.
 * Under-observed windows report pct: null → the homepage shows
 * "— · collecting data" instead of a false low number.
 */
function uptimeBucket(d) {
  // Hourly buckets: 24 writes/reads per day max (was per-minute = 1440+).
  const p = (n) => String(n).padStart(2, '0');
  return `uptime:${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
}
async function recordUptimeTick(db) {
  try {
    const now = new Date();
    await db.batch([
      db.prepare(
        "INSERT INTO app_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING"
      ).bind(uptimeBucket(now)),
      db.prepare(
        "INSERT INTO app_state (key, value) VALUES ('uptime:since', ?) ON CONFLICT(key) DO NOTHING"
      ).bind(now.toISOString()),
    ]);
  } catch (e) { /* uptime must never break traffic */ }
}
const UPTIME_WINDOWS = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 };
const UPTIME_MAX_SPAN = 30 * 24; // 30d of hourly buckets (was: 1y/all of minutes = 500k+ reads)
// Windowed read: hits = buckets present in [start, now], expected = hours
// in that span that have actually elapsed since tracking began. Counting
// forward from `since` (not probing a fixed window back) means a sparse or
// fresh tracker can never divide a big hit count by a tiny elapsed span —
// the >100% bug class is structurally impossible, no clamp needed.
async function readUptime(db, windowHours) {
  const now = Date.now();
  let sinceMs = null;
  try {
    const sinceRow = await db.prepare("SELECT value FROM app_state WHERE key = 'uptime:since'").first();
    if (sinceRow && sinceRow.value) sinceMs = Date.parse(sinceRow.value);
  } catch (e) { /* default below */ }
  if (!sinceMs || Number.isNaN(sinceMs)) sinceMs = now;
  if (sinceMs > now) sinceMs = now;
  const elapsedSinceStart = Math.max(1, Math.floor((now - sinceMs) / 3600000) + 1);
  const span = Math.min(windowHours > 0 ? windowHours : elapsedSinceStart, elapsedSinceStart, UPTIME_MAX_SPAN);
  const startMs = now - (span - 1) * 3600000;
  let hits = 0;
  // D1 caps bound variables (~100); chunk the lookup.
  for (let off = 0; off < span; off += 90) {
    const slice = [];
    for (let m = off; m < Math.min(off + 90, span); m++) {
      slice.push(uptimeBucket(new Date(startMs + m * 3600000)));
    }
    const rows = await db.prepare(
      `SELECT key FROM app_state WHERE key IN (${slice.map(() => '?').join(',')})`
    ).bind(...slice).all();
    hits += (rows.results || []).length;
  }
  const pct = Math.round((Math.min(hits, span) / span) * 1000) / 10;
  return { pct, samples: hits, windowMin: span };
}
// Publish bar for a window's pct. Sparse organic traffic sits far below
// this (an hour with no request reads as "down" even when it wasn't);
// hourly cron coverage stays above it through real outages, so
// genuine dips still display. Min span keeps an hours-old tracker from
// flashing 100%.
const UPTIME_MIN_SPAN = 15;
const UPTIME_MIN_COVERAGE = 0.9;
function qualifyWindow(u) {
  const observed = u.windowMin >= UPTIME_MIN_SPAN
    && u.samples >= Math.floor(u.windowMin * UPTIME_MIN_COVERAGE);
  return { pct: observed ? u.pct : null, samples: u.samples, windowMin: u.windowMin };
}
// In-isolate status cache: window reads cost ~10 D1 queries, but buckets only
// change hourly — recomputing per request burned rows for identical answers.
const STATUS_CACHE_TTL_MS = 30 * 60 * 1000;
let statusCache = { body: null, at: 0 };
/**
 * Visitor → nearest estimate region from Cloudflare geo (no third-party
 * lookup). US edge colos split by coast; everywhere else falls back to
 * continent. Missing geo (local dev) → us-central.
 */
function visitorRegion(cf) {
  cf = cf || {};
  const colo = String(cf.colo || '').toUpperCase();
  if (/^(IAD|EWR|JFK|MIA|ATL|BOS|DCA|PHL|CLT|TPA|ORF|RIC|BWI|PIT|RDU)$/.test(colo)) return 'us-east';
  if (/^(LAX|SFO|SJC|SEA|PDX|SAN|LAS|PHX|DEN|SLC|ABQ)$/.test(colo)) return 'us-west';
  if (/^(DFW|ORD|IAH|MSP|DTW|STL|MCI|AUS|HOU|SAT|OKC|MEM|NSH|CMH|IND|CVG|OMA|DSM|LIT)$/.test(colo)) return 'us-central';
  const cc = String(cf.country || '').toUpperCase();
  if (cc === 'US' || cc === 'CA' || cc === 'MX') return 'us-central';
  switch (cf.continent) {
    case 'EU': case 'AF': return 'eu-west';
    case 'SA': return 'sa';
    case 'AS': return 'asia';
    case 'OC': return 'oceania';
    case 'NA': return 'us-east';
    default: return 'us-central';
  }
}
/**
 * Idempotent upkeep for operational state and the Split Task sync counter.
 * Product tables and indexes are installed by an explicit schema migration.
 */
const SCHEMA_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
let schemaCheckedAt = 0;
let notesOrderCheckedAt = 0;
const SWEEP_THROTTLE_MS = 4 * 3600 * 1000;
let lastSweepAttempt = 0;
async function ensureNotesOrderColumn(db) {
  if (Date.now() - notesOrderCheckedAt < SCHEMA_CHECK_TTL_MS) return;
  try {
    await db.prepare('ALTER TABLE split_task_notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0').run();
  } catch (err) {
    if (!/duplicate column|already exists/i.test(err?.message || '')) throw err;
  }
  notesOrderCheckedAt = Date.now();
}

async function ensureSchemaCached(db) {
  if (Date.now() - schemaCheckedAt < SCHEMA_CHECK_TTL_MS) return;
  await ensureSchema(db);
  schemaCheckedAt = Date.now();
}
async function ensureSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS split_task_sync_versions (user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL DEFAULT 0)'),
    db.prepare("INSERT INTO products (key, name) VALUES ('vocabulary-expander', 'Vocabulary Expander') ON CONFLICT(key) DO NOTHING"),
    db.prepare('CREATE TABLE IF NOT EXISTS vocabulary_expander_progress (user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, progress_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'),
  ]);
}

/**
 * Which incomplete tasks from before today roll forward one day on this sweep.
 * Today's tasks remain scheduled for today until the next day's sweep.
 *
 * A task with no due date has nothing to stop at, and one that has not reached
 * its due date yet still has runway - both always roll. Past the due date it is
 * the user's "Push back past due date" setting (task_deadline_push_enabled) that
 * decides: on = keep rolling forever, off = park it on the due date so the app
 * can flag it red as priority.
 *
 * Recurring occurrences (recurrence_id IS NOT NULL) never roll: each one
 * belongs to its scheduled day, and the client's generator already drops past
 * occurrences and materializes the window ahead. Rolling one forward would
 * stack it onto a day that already has that series' own occurrence - a
 * double-booking (e.g. Monday's missed "Gym" landing on top of Tuesday's "Gym").
 */
const ROLLING_TASK_WHERE = `
      type = 'task'
      AND done = 0
      AND recurrence_id IS NULL
      AND item_date < date('now')
      AND (
        due_date IS NULL
        OR item_date < due_date
        OR COALESCE((SELECT task_deadline_push_enabled FROM split_task_settings s WHERE s.user_id = split_task_items.user_id), 1) != 0
      )
`;

async function runDailySweep(env) {
  const db = env['ST-DATABASE'];
  const today = new Date().toISOString().slice(0, 10);

  // Schema upkeep first; the day must not be claimed on failure.
  await ensureSchemaCached(db);

  // Atomically claim today; changes===0 → another isolate already swept.
  const claim = await db.prepare(`
    INSERT INTO app_state (key, value) VALUES ('last_sweep', ?1)
    ON CONFLICT(key) DO UPDATE SET value = ?1
    WHERE app_state.value != ?1
  `).bind(today).run();
  if (claim.meta.changes === 0) return { skipped: true };

  const cleanup = await db.prepare(`
    DELETE FROM split_task_items
    WHERE (user_id, id) IN (
      SELECT i.user_id, i.id
      FROM split_task_items i
      JOIN split_task_settings s ON s.user_id = i.user_id
      WHERE s.delete_after_days > 0
        AND i.item_date < date('now', '-' || s.delete_after_days || ' days')
    )
  `).run();

  // Capture affected account IDs first (UPDATE can't report them): bump versions
  // after so devices re-pull the moved dates.
  const pushTargets = await db.prepare(`
    SELECT DISTINCT user_id FROM split_task_items
    WHERE ${ROLLING_TASK_WHERE}
  `).all();

  const pushResult = await db.prepare(`
    UPDATE split_task_items
    SET item_date = date(item_date, '+1 day')
    WHERE ${ROLLING_TASK_WHERE}
  `).run();

  // Without the bump, sweep edits sit server-side until the user pushes: pulls
  // compare against the sync counter, which POST /api/sync also advances.
  let notified = 0;
  for (const row of (pushTargets.results || [])) {
    try {
      await db.prepare(`
        INSERT INTO split_task_sync_versions (user_id, version) VALUES (?, 1)
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1
      `).bind(row.user_id).run();
      notified += 1;
    } catch (err) {
      console.warn('[sweep] version bump skipped:', err?.message || err);
    }
  }

  const result = {
    deleted: cleanup.meta.changes,
    pushed: pushResult.meta.changes,
    notified,
  };
  console.log(`[sweep] removed ${result.deleted} old items, moved ${result.pushed} incomplete tasks forward by one day, nudged ${result.notified} users to re-pull`);

  // Space hygiene: resolved tickets >1yr drop; hourly uptime buckets keep 30d
  // (~8.7k rows/yr otherwise, forever); stale rate-limit windows drop.
  // NOTE: tickets live in ST-TICKETS, everything else in ST-DATABASE — never mix.
  try {
    const tdb = await ticketDb(env);
    await tdb.prepare(
      "DELETE FROM support_tickets WHERE status = 'resolved' AND created_at < datetime('now', '-365 days')"
    ).run();
  } catch (e) { console.warn('[sweep] ticket prune skipped:', e?.message || e); }
  try {
    const cutoff = new Date(Date.now());
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    const p2 = (n) => String(n).padStart(2, '0');
    const cutoffKey = `uptime:${cutoff.getUTCFullYear()}-${p2(cutoff.getUTCMonth() + 1)}-${p2(cutoff.getUTCDate())}-${p2(cutoff.getUTCHours())}`;
    await db.prepare(
      "DELETE FROM app_state WHERE key LIKE 'uptime:%' AND key < ?"
    ).bind(cutoffKey).run();
    await db.prepare("DELETE FROM app_state WHERE key LIKE 'rl:%'").run();
  } catch (e) { console.warn('[sweep] state prune skipped:', e?.message || e); }
  return result;
}

/** Lazy support_tickets table (same pattern as app_state): endpoints work pre-migration. */
async function ensureTicketsTable(ticketsDb) {
  await ticketsDb.prepare(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      username TEXT,
      email TEXT,
      type TEXT,
      message TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  // Older DBs lack email; the ALTER no-ops ("duplicate column") once applied.
  try {
    await ticketsDb.prepare('ALTER TABLE support_tickets ADD COLUMN email TEXT').run();
  } catch (err) {
    if (!/duplicate column|already exists/i.test(err?.message || '')) throw err;
  }
}

async function ensureVocabularyAnswerReviewsTable(ticketsDb) {
  await ticketsDb.prepare(`
    CREATE TABLE IF NOT EXISTS vocabulary_answer_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      word_id TEXT NOT NULL,
      word TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await ticketsDb.prepare(`
    CREATE INDEX IF NOT EXISTS idx_vocabulary_answer_reviews_word
    ON vocabulary_answer_reviews (word_id, created_at)
  `).run();
}

// Constant-time string compare (login / sync-auth: no early-exit tells).
function timingSafeEqual(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** Normalize + validate a public username (3-32, a-z0-9_-).
 * Case-insensitive: "Cedric" and "cedric" are the same account — always
 * lowercased here and stored as the login identity's normalized identifier. */
function normUsername(v) {
  const u = String(v || '').trim().toLowerCase();
  return /^[a-z0-9_-]{3,32}$/.test(u) ? u : '';
}

/** Find a Split Task login identity; returns the stable user ID and public username. */
async function findUser(db, username) {
  const u = String(username || '').trim();
  if (!u) return null;
  return db.prepare(
    `SELECT u.id AS user_id, i.identifier AS username,
            i.credential_hash AS password_hash
     FROM user_identities i
     JOIN users u ON u.id = i.user_id
     JOIN user_products up ON up.user_id = u.id
     WHERE i.provider = 'username_password'
       AND i.normalized_identifier = ?
       AND u.status = 'active'
       AND up.product_key = 'split-task'
       AND up.status = 'active'`
  ).bind(u.trim().toLowerCase()).first();
}

/** Normalize a 64-hex client password hash (SHA-256 of the password). */
function normHash(v) {
  const h = String(v || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

/** Verify username + client hash against the resolved identity. */
async function checkUserPassword(db, username, password_hash) {
  const row = await findUser(db, username);
  return !!row && timingSafeEqual(row.password_hash, password_hash);
}

/** Sliding-window rate limit in app_state: key -> {count, reset}. Fail-open. */
async function checkRateLimit(db, key, limit, windowMs) {
  const now = Date.now();
  try {
    const row = await db.prepare(
      'SELECT value FROM app_state WHERE key = ?'
    ).bind(`rl:${key}`).first();
    let st = null;
    try { st = row && row.value ? JSON.parse(row.value) : null; } catch { st = null; }
    if (!st || typeof st.reset !== 'number' || st.reset <= now) {
      st = { count: 1, reset: now + windowMs };
      await db.prepare(
        "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(`rl:${key}`, JSON.stringify(st)).run();
      return { ok: true, retryAfter: 0 };
    }
    if (st.count >= limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((st.reset - now) / 1000)) };
    }
    st.count += 1;
    await db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(`rl:${key}`, JSON.stringify(st)).run();
    return { ok: true, retryAfter: 0 };
  } catch { return { ok: true, retryAfter: 0 }; }
}

function rateLimitedResponse(retryAfter, corsHeaders) {
  return new Response(JSON.stringify({ error: 'Rate limited, try again shortly' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter || 60),
      ...(corsHeaders || {}),
    },
  });
}

/**
 * Admin bearer check for ticket read/mutate endpoints. The dashboard stores
 * the /api/admin/login token in sessionStorage and sends it as
 * `Authorization: Bearer <token>` (see site/admin.js). Tokens are
 * SHA-256(ADMIN_USERNAME + ':' + ADMIN_PASSWORD_HASH) so they verify
 * statelessly without a session table. Fail-closed: no token => 401.
 */
async function checkAdminAuth(request, env) {
  try {
    const ADMIN_USERNAME = 'Admin';
    const ADMIN_PASSWORD_HASH = env.ADMIN_PASSWORD_HASH || '0618b1322273460801603e546d012d7d912f80ad71cbfbc08a73e2cce02b2ffb';
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!/^[0-9a-f]{64}$/i.test(token)) return false;
    const enc = new TextEncoder();
    const data = enc.encode(ADMIN_USERNAME + ':' + ADMIN_PASSWORD_HASH);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const expected = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqual(token.toLowerCase(), expected);
  } catch { return false; }
}

// Ticket DB with the table ensured (replaces 2-line ensure boilerplate).
async function ticketDb(env) {
  const db = env['ST-TICKETS'];
  await ensureTicketsTable(db);
  return db;
}

/** Ticket confirmation email via Resend. No-ops without RESEND_API_KEY so submission never breaks. */
async function sendTicketConfirmation(env, email, ticketId, type, message) {
  if (!email || !env.RESEND_API_KEY) return false;

  const LABELS = { support: 'customer support', bug: 'bug report' };
  const FOLLOW_UPS = {
    support: 'I will respond when available to help you sort this out.',
    bug: 'I will fix that mistake, make sure to look out for site and app patches!',
  };
  const typeLabel = LABELS[type] || 'other';
  const followUp = FOLLOW_UPS[type] || "I'll look into it further.";

  const ticketText = typeof message === 'string' ? message : '';
  const article = /^[aeiou]/i.test(typeLabel) ? 'an' : 'a';
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const body = `Hi there,\n\nThank you for submitting ${article} ${typeLabel} ticket, ${followUp}\n\nYour ticket id: ${ticketId}\nOriginal ticket entry: ${ticketText}\n\nIf you need to add anything, email to freeerapps.dev@gmail.com.\n\n- Free-er Apps`;

  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;">',
    '<p>Hi there,</p>',
    `<p>Thank you for submitting ${article} <strong>${escapeHtml(typeLabel)}</strong> ticket, ${escapeHtml(followUp)}</p>`,
    `<p>Your ticket id: ${escapeHtml(ticketId)}<br>Original ticket entry: ${escapeHtml(ticketText).replace(/\r?\n/g, '<br>')}</p>`,
    '<p>If you need to add anything, email to <a href="mailto:freeerapps.dev@gmail.com">freeerapps.dev@gmail.com</a>.</p>',
    '<p>- Free-er Apps</p>',
    '</div>',
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Free-er Apps <no-reply@manumit.studio>',
        to: [email],
        subject: `We received your ${typeLabel} (${ticketId})`,
        text: body,
        html,
      }),
    });

    if (!res.ok) {
      console.error('[tickets] Resend email failed:', await res.json());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[tickets] confirmation email error:', err);
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Allowlisted CORS: sync clients are manumit.studio (+ app origins);
    // wildcard * would let any site drive credentialed sync endpoints.
    const origin = request.headers.get('origin') || '';
    const ALLOWED_ORIGINS = [
      'https://manumit.studio',
      'https://www.manumit.studio',
      'https://freeerapps.com',
      'https://www.freeerapps.com',
      'https://freeerapps.pages.dev',
      'capacitor://localhost',
      'ionic://localhost',
      'http://localhost',
      'https://localhost', // Capacitor Android (server.androidScheme: https)
    ];
    // Native shells / local dev have no real host: match localhost on either
    // scheme, any port (Vite :5173, Capacitor https://localhost). Exact host
    // only — a startsWith check would also admit localhost.evil.com.
    const isLocalOrigin = /^https?:\/\/localhost(:\d+)?$/.test(origin);
    // Cloudflare Pages preview deployments get unique subdomains (e.g.
    // f81cb833.freeerapps.pages.dev) — allow all of them.
    const isPagesPreview = /^https:\/\/[a-z0-9-]+\.freeerapps\.pages\.dev$/.test(origin);
    const allowOrigin = (ALLOWED_ORIGINS.includes(origin) || isLocalOrigin || isPagesPreview)
      ? origin : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
      });
    }

    const url = new URL(request.url);

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          // Per-user payloads are never cacheable (browser/CDN/proxy) — one
          // user's snapshot must never serve another. Freshness lives in the
          // client's no-store + version conditional pull, not HTTP caches.
          'Cache-Control': 'no-store',
        },
      });

    // ─── GET /api/status ─────────────────────────────────────────────────
    // Self-check uptime: ticks an hourly heartbeat bucket (this request is
    // the ping — if the worker answers, it was up this hour), then reports
    // { status:'operational', uptimePct, samples, windowMin } from D1.
    // Window reads are cached in-isolate (TTL below): buckets only change
    // hourly, so recomputing 3 windows per request just burns D1 rows.
    // Default = 24h only (was: 24h+7d+30d ≈ 12 reads/request). Pass
    // ?windows=7d,30d for the full set (admin/range buttons).
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const db = env['ST-DATABASE'];
      const region = visitorRegion(request.cf);
      const geo = { region, country: (request.cf && request.cf.country) || null };
      if (!db) return jsonResponse({ status: 'unknown', uptimePct: null, ...geo }, 200);
      try {
        await db.prepare(
          'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)'
        ).run();
        await recordUptimeTick(db);
        const nowMs = Date.now();
        if (statusCache.body && (nowMs - statusCache.at) < STATUS_CACHE_TTL_MS) {
          return jsonResponse({ ...statusCache.body, ...geo, t: nowMs, cached: true });
        }
        // One small window per request would take months to fill 30d on a
        // quiet site; instead compute every window now (all share the same
        // buckets, so extra reads are cheap IN-lookups, no extra writes).
        // qualifyWindow gates each window on ITS OWN coverage — the old
        // "last 15 minutes look continuous" check was satisfied by any
        // active visitor (including this page's 60s refresh) and then let
        // diluted whole-day numbers through.
        //
        // Slim default: 24h only (≈4 reads). ?windows=7d,30d opts into the
        // full set — saves ~70% status reads on the homepage's hourly ping.
        const wantParam = (url.searchParams.get('windows') || '').toLowerCase();
        const want = new Set(
          wantParam.split(',').map(s => s.trim()).filter(s => UPTIME_WINDOWS[s])
        );
        if (want.size === 0) want.add('24h');
        const windows = {};
        for (const [name, hours] of Object.entries(UPTIME_WINDOWS)) {
          if (!want.has(name)) continue;
          windows[name] = qualifyWindow(await readUptime(db, hours));
        }
        // Backfill the legacy shape: uptimePct always reflects 24h.
        if (!windows['24h']) windows['24h'] = qualifyWindow(await readUptime(db, 24));
        const body = { status: 'operational', uptimePct: windows['24h'].pct, windows };
        statusCache = { body, at: nowMs };
        return jsonResponse({ ...body, ...geo, t: nowMs, cached: false });
      } catch (e) {
        return jsonResponse({ status: 'degraded', uptimePct: null, ...geo, t: Date.now() });
      }
    }

    // Heartbeat tick: cron + /api/status only. Every-/api/*-request ticks
    // added one write per request for zero coverage gain once buckets went
    // hourly — the hourly cron already covers quiet hours.

    // DEBUG: visible bindings. Disabled in production: leaks binding names.
    if (url.pathname === '/api/debug') {
      if (env.ENVIRONMENT === 'production')
        return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse({
        hasDB: typeof env['ST-DATABASE'] !== 'undefined',
      });
    }

    try {
      // ─── POST /api/register ─────────────────────────────────────────────
      if (url.pathname === '/api/register' && request.method === 'POST') {
        const raw = await request.json();
        const username = normUsername(raw?.username);
        const password_hash = normHash(raw?.password_hash);
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Valid username + password hash required' }, 400);
        }
        // Pre-check keeps the raw D1 unique error off the client; the catch
        // covers two simultaneous signups for the same name.
        // Case-insensitive: Cedric can't register if cedric exists.
        const taken = () => jsonResponse({ error: 'That username is already taken. Please choose another one.' }, 409);
        const existing = await findUser(env['ST-DATABASE'], username);
        if (existing) return taken();
        const userId = crypto.randomUUID();
        try {
          await env['ST-DATABASE'].batch([
            env['ST-DATABASE'].prepare('INSERT INTO users (id) VALUES (?)').bind(userId),
            env['ST-DATABASE'].prepare(`
              INSERT INTO user_identities (
                id, user_id, provider, identifier, normalized_identifier,
                credential_hash, credential_scheme
              ) VALUES (?, ?, 'username_password', ?, ?, ?, 'sha256-client-v1')
            `).bind(crypto.randomUUID(), userId, username, username, password_hash),
            env['ST-DATABASE'].prepare(
              "INSERT INTO user_products (user_id, product_key) VALUES (?, 'split-task')"
            ).bind(userId),
            env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_categories (id, user_id, name, color)
              VALUES ('default', ?, 'Default', '#344271')
            `).bind(userId),
            env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_settings (
                user_id, color_palette, task_notifications, event_notifications,
                task_deadline_push_enabled, completion_sounds, confetti_enabled
              ) VALUES (?, '["#344271"]', '[]', '[]', 1, 1, 1)
            `).bind(userId),
          ]);
        } catch (err) {
          if (/UNIQUE constraint failed:\s*user_identities\.(provider,\s*)?normalized_identifier/i.test(err?.message || '')) {
            return taken();
          }
          throw err;
        }
        return jsonResponse({ success: true, message: 'User registered' }, 201);
      }

      // ─── POST /api/admin/login ─────────────────────────────────────────
      // Dashboard login: client sends SHA-256(password_hash); compared to the
      // secret so plaintext never appears in source. Set ADMIN_PASSWORD_HASH
      // as a Worker secret; the in-source value below is a dev fallback only.
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const loginDb = env['ST-DATABASE'];
        const ADMIN_USERNAME = 'Admin';
        const ADMIN_PASSWORD_HASH = env.ADMIN_PASSWORD_HASH || '0618b1322273460801603e546d012d7d912f80ad71cbfbc08a73e2cce02b2ffb';
        // SHA-256 of the configured admin password.
        const ip = request.headers.get('cf-connecting-ip') || 'ip';
        const rl = await checkRateLimit(loginDb, `admin-login:${ip}`, 10, 600000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);
        const { username, password_hash } = await request.json();
        if (username !== ADMIN_USERNAME || !timingSafeEqual(password_hash, ADMIN_PASSWORD_HASH)) {
          return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        const enc = new TextEncoder();
        const data = enc.encode(ADMIN_USERNAME + ':' + ADMIN_PASSWORD_HASH);
        const hashBuf = await crypto.subtle.digest('SHA-256', data);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        const token = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
        return jsonResponse({ success: true, token: token, username: ADMIN_USERNAME });
      }

      // ─── POST /api/login ────────────────────────────────────────────────
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const loginDb = env['ST-DATABASE'];
        const ip = request.headers.get('cf-connecting-ip') || 'ip';
        const rl = await checkRateLimit(loginDb, `login:${ip}`, 20, 600000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);
        const raw = await request.json();
        const username = normUsername(raw?.username);
        const password_hash = normHash(raw?.password_hash);
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Username and password hash required' }, 400);
        }
        if (!(await checkUserPassword(loginDb, username, password_hash))) {
          return jsonResponse({ error: 'Invalid username or password' }, 401);
        }
        return jsonResponse({ success: true, username });
      }

      // ─── POST /api/account/username ─────────────────────────────────────
      // Rename the shared login identity without changing its stable user ID,
      // which keeps all product data and memberships attached to the account.
      if (url.pathname === '/api/account/username' && request.method === 'POST') {
        const accountDb = env['ST-DATABASE'];
        const ip = request.headers.get('cf-connecting-ip') || 'ip';
        const rl = await checkRateLimit(accountDb, `username-change:${ip}`, 10, 600000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);

        let raw;
        try {
          raw = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        const username = normUsername(raw?.username);
        const newUsername = normUsername(raw?.new_username);
        const password_hash = normHash(raw?.password_hash);
        const secureNotesWrappedKey = raw?.secure_notes_wrapped_key;
        if (!username || !newUsername || !password_hash) {
          return jsonResponse({ error: 'Valid current username, new username, and password required' }, 400);
        }
        if (secureNotesWrappedKey !== undefined
          && (typeof secureNotesWrappedKey !== 'string'
            || !/^WRAP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secureNotesWrappedKey)
            || secureNotesWrappedKey.length > 2048)) {
          return jsonResponse({ error: 'Invalid secure notes key' }, 400);
        }

        const account = await findUser(accountDb, username);
        if (!account || !timingSafeEqual(account.password_hash, password_hash)) {
          return jsonResponse({ error: 'Invalid username or password' }, 401);
        }
        if (newUsername === username) {
          const version = await accountDb.prepare(
            'SELECT version FROM split_task_sync_versions WHERE user_id = ?'
          ).bind(account.user_id).first();
          return jsonResponse({ success: true, username, version: Number(version?.version) || 0 });
        }

        const identityOwner = await accountDb.prepare(`
          SELECT user_id FROM user_identities
          WHERE provider = 'username_password' AND normalized_identifier = ?
        `).bind(newUsername).first();
        if (identityOwner && identityOwner.user_id !== account.user_id) {
          return jsonResponse({ error: 'That username is already taken. Please choose another one.' }, 409);
        }

        await ensureSchemaCached(accountDb);
        const settings = await accountDb.prepare(
          'SELECT secure_notes_wrapped_key FROM split_task_settings WHERE user_id = ?'
        ).bind(account.user_id).first();
        if (settings?.secure_notes_wrapped_key && !secureNotesWrappedKey) {
          return jsonResponse({ error: 'To preserve your Split Task secure notes, change your username from the Split Task app.' }, 409);
        }

        try {
          const statements = [
            accountDb.prepare(`
              UPDATE user_identities
              SET identifier = ?, normalized_identifier = ?
              WHERE user_id = ? AND provider = 'username_password'
            `).bind(newUsername, newUsername, account.user_id),
          ];
          if (secureNotesWrappedKey) {
            statements.push(settings
              ? accountDb.prepare(`
                UPDATE split_task_settings SET secure_notes_wrapped_key = ?
                WHERE user_id = ?
              `).bind(secureNotesWrappedKey, account.user_id)
              : accountDb.prepare(`
                INSERT INTO split_task_settings (user_id, secure_notes_wrapped_key)
                VALUES (?, ?)
              `).bind(account.user_id, secureNotesWrappedKey));
          }
          statements.push(accountDb.prepare(`
            INSERT INTO split_task_sync_versions (user_id, version) VALUES (?, 1)
            ON CONFLICT(user_id) DO UPDATE SET version = version + 1
          `).bind(account.user_id));
          await accountDb.batch(statements);
        } catch (err) {
          if (/UNIQUE constraint failed/i.test(err?.message || '')
            && /user_identities\.(provider|normalized_identifier)/i.test(err?.message || '')) {
            return jsonResponse({ error: 'That username is already taken. Please choose another one.' }, 409);
          }
          throw err;
        }

        const version = await accountDb.prepare(
          'SELECT version FROM split_task_sync_versions WHERE user_id = ?'
        ).bind(account.user_id).first();
        return jsonResponse({ success: true, username: newUsername, version: Number(version?.version) || 0 });
      }

      // ─── POST /api/delete-product-data ──────────────────────────────────
      // Remove one product's cloud data without deleting the Manumit account.
      if (url.pathname === '/api/delete-product-data' && request.method === 'POST') {
        const delDb = env['ST-DATABASE'];
        let rawDel;
        try {
          rawDel = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        const username = normUsername(rawDel?.username);
        const password_hash = normHash(rawDel?.password_hash);
        const productKey = rawDel?.product_key;
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        }
        if (productKey !== 'split-task' && productKey !== 'vocabulary-expander') {
          return jsonResponse({ error: 'Unsupported product' }, 400);
        }

        const ip = request.headers.get('cf-connecting-ip') || 'ip';
        const rl = await checkRateLimit(delDb, `delete-product-data:${ip}`, 10, 600000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);
        if (!(await checkUserPassword(delDb, username, password_hash))) {
          return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        }

        const account = await findUser(delDb, username);
        if (!account) return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        await ensureSchemaCached(delDb);
        const statements = productKey === 'split-task'
          ? [
            'DELETE FROM split_task_items WHERE user_id = ?',
            'DELETE FROM split_task_notes WHERE user_id = ?',
            'DELETE FROM split_task_categories WHERE user_id = ?',
            'DELETE FROM split_task_settings WHERE user_id = ?',
            'DELETE FROM split_task_sync_versions WHERE user_id = ?',
          ]
          : ['DELETE FROM vocabulary_expander_progress WHERE user_id = ?'];
        await delDb.batch(statements.map(sql => delDb.prepare(sql).bind(account.user_id)));

        return jsonResponse({ success: true, message: 'Product data deleted successfully' });
      }

      // ─── POST /api/delete-account ───────────────────────────────────────
      if (url.pathname === '/api/delete-account' && request.method === 'POST') {
        const delDb = env['ST-DATABASE'];
        const rawDel = await request.json();
        const username = normUsername(rawDel?.username);
        const password_hash = normHash(rawDel?.password_hash);
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        }

        // 1. Verify credentials first
        if (!(await checkUserPassword(delDb, username, password_hash))) {
          return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        }

        const account = await findUser(delDb, username);
        if (!account) return jsonResponse({ error: 'Unauthorized request or invalid credentials' }, 401);
        await delDb.prepare('DELETE FROM users WHERE id = ?').bind(account.user_id).run();

        return jsonResponse({ success: true, message: 'Account deleted successfully' });
      }

      // ─── Vocabulary Expander cloud progress ────────────────────────────
      if (url.pathname === '/api/vocabulary-sync' && request.method === 'GET') {
        const syncDb = env['ST-DATABASE'];
        const username = normUsername(url.searchParams.get('username'));
        const password_hash = normHash(url.searchParams.get('password_hash'));
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Username and password hash required' }, 400);
        }
        await ensureSchemaCached(syncDb);
        const account = await findUser(syncDb, username);
        if (!account || !timingSafeEqual(account.password_hash, password_hash)) {
          return jsonResponse({ error: 'Invalid username or password' }, 401);
        }
        await syncDb.prepare(
          "INSERT INTO user_products (user_id, product_key) VALUES (?, 'vocabulary-expander') ON CONFLICT(user_id, product_key) DO NOTHING"
        ).bind(account.user_id).run();
        const row = await syncDb.prepare(
          'SELECT progress_json, updated_at FROM vocabulary_expander_progress WHERE user_id = ?'
        ).bind(account.user_id).first();
        let progress = null;
        if (row) {
          try {
            progress = JSON.parse(row.progress_json);
          } catch (error) {
            console.error('[vocabulary-sync] stored progress is invalid JSON:', error?.message || error);
            return jsonResponse({ error: 'Saved vocabulary progress could not be read' }, 500);
          }
        }
        return jsonResponse({ progress, updated_at: row?.updated_at || null });
      }

      if (url.pathname === '/api/vocabulary-sync' && request.method === 'POST') {
        const syncDb = env['ST-DATABASE'];
        const contentLength = Number(request.headers.get('content-length') || 0);
        if (contentLength > 262144) return jsonResponse({ error: 'Progress payload too large' }, 413);
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        const username = normUsername(body?.username);
        const password_hash = normHash(body?.password_hash);
        const progress = body?.progress;
        if (!username || !password_hash) {
          return jsonResponse({ error: 'Username and password hash required' }, 400);
        }
        if (!progress || typeof progress !== 'object' || Array.isArray(progress)
          || !progress.scores || typeof progress.scores !== 'object' || Array.isArray(progress.scores)
          || !Array.isArray(progress.encountered) || typeof progress.placementComplete !== 'boolean') {
          return jsonResponse({ error: 'Invalid vocabulary progress' }, 400);
        }
        const progressJson = JSON.stringify(progress);
        if (new TextEncoder().encode(progressJson).byteLength > 262144) {
          return jsonResponse({ error: 'Progress payload too large' }, 413);
        }
        const rateLimit = await checkRateLimit(
          syncDb,
          `vocabulary-sync:${username}:${request.headers.get('cf-connecting-ip') || 'ip'}`,
          60,
          60000,
        );
        if (!rateLimit.ok) return rateLimitedResponse(rateLimit.retryAfter, corsHeaders);
        await ensureSchemaCached(syncDb);
        const account = await findUser(syncDb, username);
        if (!account || !timingSafeEqual(account.password_hash, password_hash)) {
          return jsonResponse({ error: 'Invalid username or password' }, 401);
        }
        await syncDb.batch([
          syncDb.prepare(
            "INSERT INTO user_products (user_id, product_key) VALUES (?, 'vocabulary-expander') ON CONFLICT(user_id, product_key) DO NOTHING"
          ).bind(account.user_id),
          syncDb.prepare(`
            INSERT INTO vocabulary_expander_progress (user_id, progress_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              progress_json = excluded.progress_json,
              updated_at = excluded.updated_at
          `).bind(account.user_id, progressJson, new Date().toISOString()),
        ]);
        const row = await syncDb.prepare(
          'SELECT updated_at FROM vocabulary_expander_progress WHERE user_id = ?'
        ).bind(account.user_id).first();
        return jsonResponse({ success: true, updated_at: row?.updated_at || null });
      }

      // ─── GET /api/sync ──────────────────────────────────────────────────
      // Whole-route guard: any unexpected throw becomes a 400 with a message,
      // never an opaque 500 (see POST /api/sync note).
      if (url.pathname === '/api/sync' && request.method === 'GET') {
        try {
        const syncDb = env['ST-DATABASE'];
        const username = normUsername(url.searchParams.get('username'));
        if (!username) return jsonResponse({ error: 'Missing username parameter' }, 400);
        const password_hash = normHash(
          url.searchParams.get('password_hash') || url.searchParams.get('passwordHash')
        );
        if (!password_hash) {
          return jsonResponse({ error: 'password_hash is required (please update the app)' }, 401);
        }
        const account = await findUser(syncDb, username);
        if (!account || !timingSafeEqual(account.password_hash, password_hash)) {
          return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        const userId = account.user_id;
        await ensureNotesOrderColumn(syncDb);

        // Lazy daily sweep; guarded so it can never break/slow the sync.
        // Throttled: the hourly cron owns the sweep (was: claim-write EVERY poll).
        if (Date.now() - lastSweepAttempt > SWEEP_THROTTLE_MS) {
          lastSweepAttempt = Date.now();
          try { await runDailySweep(env); } catch (err) { console.error('[sweep] lazy sweep failed:', err); }
        }

        // Conditional pull: client sends its version; a match answers
        // { unchanged:true } (two point lookups, zero row reads).
        // Never cache per-user snapshots in a shared cache (edge/CDN/KV) —
        // the version counter above already IS the cache.
        const clientVersion = url.searchParams.get('version');
        let serverVersion = null;
        try {
          const row = await syncDb
            .prepare('SELECT version FROM split_task_sync_versions WHERE user_id = ?')
            .bind(userId).first();
          if (row) serverVersion = Number(row.version) || 0;
        } catch { serverVersion = null; }

        if (clientVersion !== null && clientVersion !== '' && serverVersion !== null
            && Number(clientVersion) === serverVersion) {
          // ETag/304: same bytes, zero egress/CPU to serialize. Client keeps
          // treating this exactly like { unchanged:true }.
          const etag = `W/"v${serverVersion}"`;
          if (request.headers.get('if-none-match') === etag) {
            return new Response(null, { status: 304, headers: { 'ETag': etag, ...corsHeaders } });
          }
          const unchangedBody = JSON.stringify({ unchanged: true, version: serverVersion });
          return new Response(unchangedBody, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'ETag': etag, ...corsHeaders },
          });
        }

        // One batch round-trip instead of 4 concurrent reads: same rows, fewer
        // round-trips. Per-result errors degrade per-table (empty for THAT
        // table only) — the client merge treats each table independently, so a
        // failed table never clobbers the tables that did read.
        const stmts = [
          syncDb.prepare('SELECT * FROM split_task_settings WHERE user_id = ?').bind(userId),
          syncDb.prepare('SELECT * FROM split_task_categories WHERE user_id = ?').bind(userId),
          syncDb.prepare('SELECT * FROM split_task_items WHERE user_id = ?').bind(userId),
          syncDb.prepare('SELECT * FROM split_task_notes WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC, id ASC').bind(userId),
        ];
        let settings = null, categories = [], items = [], notes = [];
        try {
          // db.batch() resolves to plain result objects (NOT statement
          // handles): read .results / .results[0] directly. Calling
          // .first()/.all() on them throws — which is exactly the "0 items
          // but rows exist" outage (each per-table catch swallowed to empty).
          const [sRes, cRes, iRes, nRes] = await syncDb.batch(stmts);
          try { settings = (sRes?.results?.[0]) || null; }
          catch (err) { console.warn('[sync] settings read failed, defaulting null:', err?.message || err); }
          try { categories = cRes?.results || []; }
          catch (err) { console.warn('[sync] categories read failed, defaulting empty:', err?.message || err); }
          try { items = iRes?.results || []; }
          catch (err) { console.warn('[sync] items read failed, defaulting empty:', err?.message || err); }
          try { notes = nRes?.results || []; }
          catch (err) { console.warn('[sync] notes read failed, defaulting empty:', err?.message || err); }
        } catch (err) {
          // Whole batch rejected (missing table pre-migration, transient D1
          // error): fall back to per-table reads so one bad table can't fail
          // the whole sync with a 500.
          console.warn('[sync] batched pull fell back:', err?.message || err);
          const readRows = async (sql) => {
            try { return (await syncDb.prepare(sql).bind(userId).all()).results || []; }
            catch (e) { console.warn('[sync] table read failed, defaulting empty:', sql, e?.message || e); return []; }
          };
          const readOne = async (sql) => {
            try { return (await syncDb.prepare(sql).bind(userId).first()) || null; }
            catch (e) { console.warn('[sync] settings read failed, defaulting null:', e?.message || e); return null; }
          };
          settings = await readOne('SELECT * FROM split_task_settings WHERE user_id = ?');
          categories = await readRows('SELECT * FROM split_task_categories WHERE user_id = ?');
          items = await readRows('SELECT * FROM split_task_items WHERE user_id = ?');
          notes = await readRows('SELECT * FROM split_task_notes WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC, id ASC');
        }
        return jsonResponse({
          settings,
          categories,
          items,
          notes,
          version: serverVersion,
        });
        } catch (err) {
          console.error('[sync] pull failed:', err?.stack || err?.message || err);
          return jsonResponse({ error: 'Sync pull failed: ' + (err?.message || 'unknown') }, 400);
        }
      }

      // ─── POST /api/sync ─────────────────────────────────────────────────
      // NOTE: the ENTIRE body is wrapped in try/catch → 500s become 400s with
      // a message. An uncaught throw here is what strands clients in
      // "Waiting to sync" with an opaque 500 and endless retries.
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        try {
        const pushDb = env['ST-DATABASE'];
        // Body cap: never JSON-parse an unbounded push in an isolate.
        const len = Number(request.headers.get('content-length') || 0);
        if (len > 1048576) return jsonResponse({ error: 'Payload too large' }, 413);
        let body;
        try {
          body = await request.json();
        } catch (err) {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        // Per-user rate limit (~30 pushes/min): fail-open so traffic never breaks.
        const rlKey = `sync:${normUsername(body?.username) || 'anon'}:${request.headers.get('cf-connecting-ip') || 'ip'}`;
        const rl = await checkRateLimit(pushDb, rlKey, 30, 60000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);
        const username = normUsername(body?.username);
        const password_hash = normHash(body?.password_hash || body?.passwordHash);
        const { settings, categories, items, notes } = body || {};
        if (!username) return jsonResponse({ error: 'Missing username' }, 400);
        if (!password_hash) return jsonResponse({ error: 'password_hash is required (please update the app)' }, 401);
        const account = await findUser(pushDb, username);
        if (!account || !timingSafeEqual(account.password_hash, password_hash)) {
          return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        const userId = account.user_id;
        await ensureNotesOrderColumn(pushDb);
        // Per-user quotas: one abusive account can't fill the 500MB D1.
        if (Array.isArray(items) && items.length > 2000)
          return jsonResponse({ error: 'Too many items (max 2000)' }, 413);
        if (Array.isArray(notes) && notes.length > 500)
          return jsonResponse({ error: 'Too many notes (max 500)' }, 413);
        if (Array.isArray(categories) && categories.length > 200)
          return jsonResponse({ error: 'Too many categories (max 200)' }, 413);
        if (Array.isArray(notes)) {
          for (const n of notes) {
            if (n && typeof n.text === 'string' && n.text.length > 20000)
              return jsonResponse({ error: 'Note too large (max 20k chars)' }, 413);
          }
        }
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it && typeof it.title === 'string' && it.title.length > 500)
              return jsonResponse({ error: 'Item title too long (max 500)' }, 413);
          }
        }
        // 0/1 normalizer: absent → 1 (feature on), explicit false/0 → 0.
        const bool01 = (v) => (v === false || v === 0 ? 0 : 1);

        if (settings) {
          // Older clients send no theme_level: derive from the legacy pair so
          // their dark/light choice survives instead of resetting to dark.
          const hasThemeLevel = settings.theme_level !== undefined
            && settings.theme_level !== null && settings.theme_level !== '';
          const themeLevel = hasThemeLevel
            ? Math.min(4, Math.max(0, Math.round(Number(settings.theme_level)) || 0))
            : (settings.is_dim_mode ? 1 : (settings.is_dark_mode ? 0 : 4));

          // app_font allow-list (mirrors fonts.js — keep identical incl. the
          // 'Default' sentinel). CSS-injected, never raw HTML, but clamped.
          const APP_FONT_LABELS = [
            'Default',
            'Inter', 'System', 'Manrope', 'Roboto', 'Open Sans', 'Poppins', 'Montserrat', 'Lato',
            'Helvetica', 'Arial', 'Verdana', 'Trebuchet MS', 'Futura',
            'Georgia', 'Playfair Display', 'Lora', 'Merriweather', 'Baskerville', 'EB Garamond',
            'Times New Roman', 'Garamond', 'Palatino',
            'Fira Code', 'JetBrains Mono', 'Space Mono', 'Courier New', 'Mono',
            'Bebas Neue', 'Pacifico', 'Great Vibes', 'Comic Sans MS',
          ];

          await env['ST-DATABASE'].prepare(`
            INSERT INTO split_task_settings (
              user_id, light_color, dark_color, color_palette, is_dark_mode, is_dim_mode, theme_level,
              enable_animations, confetti_enabled, completion_sounds,
              popup_overlay_enabled, page_transitions_enabled, smooth_dropdowns_enabled, deletion_fade_enabled, split_view_shift_enabled, button_feedback_enabled,
              split_task_page, calendar_days, week_calendar_days, week_start, day_start,
              day_end, timeline_increment, task_creation_increment, future_recurrences, use_military_time,
              task_notifications, event_notifications, quick_add_only, split_ratio,
              delete_after_days, task_deadline_push_enabled, app_font, secure_notes_wrapped_key, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?
            )
            ON CONFLICT(user_id) DO UPDATE SET
              light_color = excluded.light_color,
              dark_color = excluded.dark_color,
              color_palette = excluded.color_palette,
              is_dark_mode = excluded.is_dark_mode,
              is_dim_mode = excluded.is_dim_mode,
              theme_level = excluded.theme_level,
              enable_animations = excluded.enable_animations,
              confetti_enabled = excluded.confetti_enabled,
              completion_sounds = excluded.completion_sounds,
              popup_overlay_enabled = excluded.popup_overlay_enabled,
              page_transitions_enabled = excluded.page_transitions_enabled,
              smooth_dropdowns_enabled = excluded.smooth_dropdowns_enabled,
              deletion_fade_enabled = excluded.deletion_fade_enabled,
              split_view_shift_enabled = excluded.split_view_shift_enabled,
              button_feedback_enabled = excluded.button_feedback_enabled,
              split_task_page = excluded.split_task_page,
              calendar_days = excluded.calendar_days,
              week_calendar_days = excluded.week_calendar_days,
              week_start = excluded.week_start,
              day_start = excluded.day_start,
              day_end = excluded.day_end,
              timeline_increment = excluded.timeline_increment,
              task_creation_increment = excluded.task_creation_increment,
              future_recurrences = excluded.future_recurrences,
              use_military_time = excluded.use_military_time,
              task_notifications = excluded.task_notifications,
              event_notifications = excluded.event_notifications,
              quick_add_only = excluded.quick_add_only,
              split_ratio = excluded.split_ratio,
              delete_after_days = excluded.delete_after_days,
              task_deadline_push_enabled = excluded.task_deadline_push_enabled,
              app_font = excluded.app_font,
              secure_notes_wrapped_key = excluded.secure_notes_wrapped_key,
              updated_at = excluded.updated_at
          `).bind(
            userId,
            settings.light_color || '#344271',
            // NULL = "use light_color" (schema contract). This used to coerce a
            // missing dark color to '#999999', which showed up as a grey accent
            // on every later pull while dark mode was active.
            settings.dark_color ?? null,
            typeof settings.color_palette === 'string' ? settings.color_palette : JSON.stringify(settings.color_palette || []),
            settings.is_dark_mode ? 1 : 0,
            settings.is_dim_mode === undefined ? 0 : (settings.is_dim_mode ? 1 : 0),
            themeLevel,
            settings.enable_animations ? 1 : 0,
            bool01(settings.confetti_enabled),
            bool01(settings.completion_sounds),
            bool01(settings.popup_overlay_enabled),
            bool01(settings.page_transitions_enabled),
            bool01(settings.smooth_dropdowns_enabled),
            bool01(settings.deletion_fade_enabled),
            bool01(settings.split_view_shift_enabled),
            bool01(settings.button_feedback_enabled),
            settings.split_task_page !== 0 ? 1 : 0,
            [1, 3, 5, 7].includes(Number(settings.calendar_days)) ? Number(settings.calendar_days) : 1,
            (settings.week_calendar_days === undefined || settings.week_calendar_days === null)
              ? 7 : Number(settings.week_calendar_days),
            settings.week_start || 0,
            settings.day_start || '07:00',
            settings.day_end || '20:00',
            settings.timeline_increment || 15,
            settings.task_creation_increment || 15,
            Number(settings.future_recurrences) === 1 ? 1 : 2,
            settings.use_military_time ? 1 : 0,
            typeof settings.task_notifications === 'string' ? settings.task_notifications : JSON.stringify(settings.task_notifications || []),
            typeof settings.event_notifications === 'string' ? settings.event_notifications : JSON.stringify(settings.event_notifications || []),
            settings.quick_add_only ? 1 : 0,
            settings.split_ratio || 0.5,
            settings.delete_after_days || 30,
            bool01(settings.task_deadline_push_enabled),
            APP_FONT_LABELS.includes(settings.app_font) ? settings.app_font : 'Inter',
            settings.secure_notes_wrapped_key ?? null,
            settings.updated_at || new Date().toISOString(),
          ).run();
        }

        // Full-set replacement: the pushed list is the source of truth, so
        // anything absent was deleted on that device. Writes go through
        // db.batch() (chunked): one round-trip per table instead of N.
        const CHUNK = 25; // D1 batch-friendly; keeps each batch well under limits
        const chunked = (stmts) => {
          const out = [];
          for (let i = 0; i < stmts.length; i += CHUNK) out.push(stmts.slice(i, i + CHUNK));
          return out;
        };
        if (Array.isArray(categories)) {
          const stmts = [
            env['ST-DATABASE'].prepare('DELETE FROM split_task_categories WHERE user_id = ?').bind(userId),
          ];
          const nowIso = new Date().toISOString();
          for (const cat of categories) {
            stmts.push(env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_categories (id, user_id, name, color, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                updated_at = excluded.updated_at
            `).bind(cat.id, userId, cat.name, cat.color, cat.updated_at || nowIso));
          }
          for (const batch of chunked(stmts)) await env['ST-DATABASE'].batch(batch);
        }

        if (Array.isArray(items)) {
          const stmts = [
            env['ST-DATABASE'].prepare('DELETE FROM split_task_items WHERE user_id = ?').bind(userId),
          ];
          const nowIso = new Date().toISOString();
          for (const item of items) {
            stmts.push(env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_items (
                id, user_id, type, title, category_id, item_date, done, finished_at, notes,
                deadline, due_date, start_time, end_time, location, recurrence, recurrence_id, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                type = excluded.type,
                title = excluded.title,
                category_id = excluded.category_id,
                item_date = excluded.item_date,
                done = excluded.done,
                finished_at = excluded.finished_at,
                notes = excluded.notes,
                deadline = excluded.deadline,
                due_date = excluded.due_date,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                location = excluded.location,
                recurrence = excluded.recurrence,
                recurrence_id = excluded.recurrence_id,
                updated_at = excluded.updated_at
            `).bind(
              item.id, userId, item.type || 'task', item.title,
              item.category_id || 'default', item.item_date,
              item.done ? 1 : 0, item.finished_at || null, item.notes || null,
              item.deadline || null, item.due_date || null, item.start_time || null,
              item.end_time || null, item.location || null,
              typeof item.recurrence === 'string' ? item.recurrence : JSON.stringify(item.recurrence || {}),
              item.recurrence_id || null,
              item.updated_at || nowIso,
            ));
          }
          for (const batch of chunked(stmts)) await env['ST-DATABASE'].batch(batch);
        }

        if (Array.isArray(notes)) {
          const stmts = [
            env['ST-DATABASE'].prepare('DELETE FROM split_task_notes WHERE user_id = ?').bind(userId),
          ];
          const nowIso = new Date().toISOString();
          for (const [noteIndex, note] of notes.entries()) {
            if (!note || typeof note.id === 'undefined' || note.id === null) continue;
            stmts.push(env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_notes (
                id, user_id, text, category_id, created_at, updated_at, hidden, text_is_encrypted, sort_order
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                text = excluded.text,
                category_id = excluded.category_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                hidden = excluded.hidden,
                text_is_encrypted = excluded.text_is_encrypted,
                sort_order = excluded.sort_order
            `).bind(
              String(note.id), userId, String(note.text ?? ''),
              note.category_id ?? null,
              note.created_at || nowIso,
              note.updated_at || nowIso,
              note.hidden === 1 || note.hidden === '1' ? 1 : 0,
              note.text_is_encrypted === 1 || note.text_is_encrypted === '1' ? 1 : 0,
              Number.isInteger(note.sort_order) ? note.sort_order : noteIndex,
            ));
          }
          for (const batch of chunked(stmts)) await env['ST-DATABASE'].batch(batch);
        }

        // Bump the counter LAST (after rows land) so other devices re-fetch. A
        // missing table only costs full snapshots — never fail the push.
        if (settings || Array.isArray(categories) || Array.isArray(items) || Array.isArray(notes)) {
          try {
            await env['ST-DATABASE'].prepare(`
              INSERT INTO split_task_sync_versions (user_id, version) VALUES (?, 1)
              ON CONFLICT(user_id) DO UPDATE SET version = version + 1
            `).bind(userId).run();
          } catch (err) {
            console.warn('[sync] version bump skipped:', err?.message || err);
          }
        }

        return jsonResponse({ success: true, message: 'Sync complete' });
        } catch (err) {
          // Fail LOUD but structured: 400 + message instead of an opaque 500
          // that the client retries forever ("Waiting to sync").
          console.error('[sync] push failed:', err?.stack || err?.message || err);
          return jsonResponse({ error: 'Sync failed: ' + (err?.message || 'unknown') }, 400);
        }
      }

      // ─── POST /api/vocabulary-answer-reviews ────────────────────────────
      if (url.pathname === '/api/vocabulary-answer-reviews' && request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse({ error: 'Invalid request body' }, 400);
        }

        const username = normUsername(body.username);
        const passwordHash = normHash(body.password_hash);
        if (!username || !passwordHash) {
          return jsonResponse({ error: 'Sign in is required to submit an answer for review' }, 401);
        }
        const user = await findUser(env['ST-DATABASE'], username);
        if (!user || !timingSafeEqual(user.password_hash, passwordHash)) {
          return jsonResponse({ error: 'Sign in is required to submit an answer for review' }, 401);
        }

        const rl = await checkRateLimit(
          env['ST-DATABASE'],
          `vocabulary-answer-review:${user.user_id}`,
          20,
          3600000,
        );
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);

        const wordId = typeof body.word_id === 'string' ? body.word_id.trim() : '';
        const word = typeof body.word === 'string' ? body.word.trim() : '';
        const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(wordId) || !word || word.length > 100) {
          return jsonResponse({ error: 'A valid vocabulary word is required' }, 400);
        }
        if (!answer || answer.length > 1000) {
          return jsonResponse({ error: 'Answer must be between 1 and 1000 characters' }, 400);
        }

        const ticketsDb = await ticketDb(env);
        await ensureVocabularyAnswerReviewsTable(ticketsDb);
        const id = crypto.randomUUID();
        await ticketsDb.prepare(`
          INSERT INTO vocabulary_answer_reviews (id, user_id, word_id, word, answer)
          VALUES (?, ?, ?, ?, ?)
        `).bind(id, user.user_id, wordId, word, answer).run();
        return jsonResponse({ success: true, id }, 201);
      }

      // ─── POST /api/tickets ───────────────────────────────────────────────
      if (url.pathname === '/api/tickets' && request.method === 'POST') {
        // 5 tickets/hr/IP: stops spam floods filling ST-TICKETS.
        // NOTE: rate window lives in ST-DATABASE (app_state), tickets in ST-TICKETS.
        const ip = request.headers.get('cf-connecting-ip') || 'ip';
        const rl = await checkRateLimit(env['ST-DATABASE'], `tickets:${ip}`, 5, 3600000);
        if (!rl.ok) return rateLimitedResponse(rl.retryAfter, corsHeaders);
        const body = await request.json();
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const type = str(body.type);
        const message = str(body.message);
        const username = str(body.username) || null;
        const email = str(body.email).toLowerCase() || null;
        if (!['support', 'bug', 'other'].includes(type)) {
          return jsonResponse({ error: 'Type must be one of: support, bug, other' }, 400);
        }
        if (!message) {
          return jsonResponse({ error: 'Message is required' }, 400);
        }
        if (message.length > 5000) {
          return jsonResponse({ error: 'Message is too long (max 5000 characters)' }, 400);
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return jsonResponse({ error: 'Invalid email address' }, 400);
        }
        const ticketsDb = await ticketDb(env);
        const id = crypto.randomUUID();
        await ticketsDb.prepare('INSERT INTO support_tickets (id, username, email, type, message) VALUES (?, ?, ?, ?, ?)')
          .bind(id, username, email, type, message).run();
        // Fire-and-forget confirmation; never blocks/fails the ticket.
        if (email) ctx?.waitUntil?.(sendTicketConfirmation(env, email, id, type, message).catch(() => {}));
        return jsonResponse({ success: true, id });
      }

      // ─── GET /api/tickets ────────────────────────────────────────────────
      // Admin-only: requires Bearer <admin token> (open reads leaked all tickets).
      if (url.pathname === '/api/tickets' && request.method === 'GET') {
        if (!(await checkAdminAuth(request, env)))
          return jsonResponse({ error: 'Unauthorized' }, 401);
        const tickets = await (await ticketDb(env)).prepare(
          'SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 100'
        ).all();
        return jsonResponse({ tickets: tickets.results || [] });
      }

      // ─── POST /api/tickets/status ────────────────────────────────────────
      if (url.pathname === '/api/tickets/status' && request.method === 'POST') {
        if (!(await checkAdminAuth(request, env)))
          return jsonResponse({ error: 'Unauthorized' }, 401);
        const { id, status } = await request.json();
        if (!id) return jsonResponse({ error: 'Ticket id required' }, 400);
        if (!['open', 'resolved'].includes(status)) {
          return jsonResponse({ error: 'Status must be one of: open, resolved' }, 400);
        }
        const result = await (await ticketDb(env)).prepare('UPDATE support_tickets SET status = ? WHERE id = ?')
          .bind(status, id).run();
        if (!result.meta.changes) {
          return jsonResponse({ error: 'Ticket not found' }, 404);
        }
        return jsonResponse({ success: true });
      }

      // ─── DELETE /api/tickets ─────────────────────────────────────────────
      if (url.pathname === '/api/tickets' && request.method === 'DELETE') {
        if (!(await checkAdminAuth(request, env)))
          return jsonResponse({ error: 'Unauthorized' }, 401);
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'Ticket id required' }, 400);
        const result = await (await ticketDb(env)).prepare('DELETE FROM support_tickets WHERE id = ?').bind(id).run();
        if (!result.meta.changes) {
          return jsonResponse({ error: 'Ticket not found' }, 404);
        }
        return jsonResponse({ success: true });
      }

      // ── Custom 404 ───────────────────────────────────────────────────────
      // /api/* → JSON error; anything else (browser at the worker URL) → page.
      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: 'Endpoint not found' }, 404);
      }

      const notFoundPage = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>404 - Split Task</title>
    <style>
      html, body { margin: 0; height: 100%; background: #1a2133; color: #f5f6fa; font-family: 'Inter', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; }
      .card { max-width: 380px; padding: 32px; border-radius: 16px; background: #232c45; box-shadow: 0 4px 18px rgba(0,0,0,.4); text-align: center; }
      h1 { font-size: 56px; margin: 0 0 8px; color: #4a6cf7; }
      p { font-size: 15px; line-height: 1.55; margin: 0 0 20px; color: #b9c0d4; }
      a { display: inline-block; margin-top: 8px; background: #4a6cf7; color: #fff; font-weight: 700; border: 0; border-radius: 10px; padding: 10px 20px; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>404</h1>
      <p>That page doesn’t exist here. The Split Task API only serves /api/* routes. Everything else is a dead end.</p>
      <a href="https://manumit.studio/products/split-task/app/">Go to Split Task</a>
    </div>
  </body>
</html>`;
      return new Response(notFoundPage, {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });

    } catch (err) {
      // Never leak D1 internals (e.g. "D1_ERROR: UNIQUE constraint failed").
      // Duplicate usernames → friendly 409; other D1 errors → generic 500.
      const msg = err?.message || 'Something went wrong. Please try again.';
      if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg) && /users\.username/i.test(msg)) {
        return jsonResponse({ error: 'That username is already taken. Please choose another one.' }, 409);
      }
      if (/D1_ERROR/i.test(msg)) {
        console.error('[worker] D1 error:', msg);
        return jsonResponse({ error: 'Something went wrong. Please try again.' }, 500);
      }
      return jsonResponse({ error: msg }, 500);
    }
  },

  /**
   * Daily retention sweep (Cloudflare Cron Trigger, e.g. "0 0 * * *" in
   * wrangler.toml). Optional: the lazy sweep in GET /api/sync covers it.
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runDailySweep(env).catch(err => console.error('[sweep] cron sweep failed:', err))
    );
    // Uptime heartbeat for cron ticks too. A `0 * * * *` (hourly) trigger in
    // the dashboard is what gives low-traffic sites true hourly coverage —
    // without it, /api/status reports "— · collecting data" (qualifyWindow).
    if (env['ST-DATABASE']) {
      ctx.waitUntil(recordUptimeTick(env['ST-DATABASE']));
    }
  },
};
