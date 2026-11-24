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
 */
function uptimeBucket(d) {
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
const UPTIME_MAX_SPAN = 30 * 24;
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
const UPTIME_MIN_SPAN = 15;
const UPTIME_MIN_COVERAGE = 0.9;
function qualifyWindow(u) {
  const observed = u.windowMin >= UPTIME_MIN_SPAN
    && u.samples >= Math.floor(u.windowMin * UPTIME_MIN_COVERAGE);
  return { pct: observed ? u.pct : null, samples: u.samples, windowMin: u.windowMin };
}
const STATUS_CACHE_TTL_MS = 30 * 60 * 1000;
let statusCache = { body: null, at: 0 };

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

  await ensureSchemaCached(db);

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

  const pushTargets = await db.prepare(`
    SELECT DISTINCT user_id FROM split_task_items
    WHERE ${ROLLING_TASK_WHERE}
  `).all();

  const pushResult = await db.prepare(`
    UPDATE split_task_items
    SET item_date = date(item_date, '+1 day')
    WHERE ${ROLLING_TASK_WHERE}
  `).run();

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

function timingSafeEqual(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function normUsername(v) {
  const u = String(v || '').trim().toLowerCase();
  return /^[a-z0-9_-]{3,32}$/.test(u) ? u : '';
}

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

function normHash(v) {
  const h = String(v || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

async function checkUserPassword(db, username, password_hash) {
  const row = await findUser(db, username);
  return !!row && timingSafeEqual(row.password_hash, password_hash);
}

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

async function ticketDb(env) {
  const db = env['ST-TICKETS'];
  await ensureTicketsTable(db);
  return db;
}

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
  const escapeHtmlLocal = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const body = `Hi there,\n\nThank you for submitting ${article} ${typeLabel} ticket, ${followUp}\n\nYour ticket id: ${ticketId}\nOriginal ticket entry: ${ticketText}\n\nIf you need to add anything, email to freeerapps.dev@gmail.com.\n\n- Free-er Apps`;

  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;">',
    '<p>Hi there,</p>',
    `<p>Thank you for submitting ${article} <strong>${escapeHtmlLocal(typeLabel)}</strong> ticket, ${escapeHtmlLocal(followUp)}</p>`,
    `<p>Your ticket id: ${escapeHtmlLocal(ticketId)}<br>Original ticket entry: ${escapeHtmlLocal(ticketText).replace(/\r?\n/g, '<br>')}</p>`,
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

// ─── OAuth 2.1 + MCP Authorization + Split Task MCP Server ─────────────────

function bytesToBase64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlToBytes(b64url) {
  let b64 = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function strToBase64url(str) {
  return bytesToBase64url(new TextEncoder().encode(String(str)));
}

function base64urlToStr(b64url) {
  return new TextDecoder().decode(base64urlToBytes(b64url));
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signOAuthPayload(payloadObj, secret) {
  const signingSecret = String(secret || "").trim();
  const headerB64 = strToBase64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = strToBase64url(JSON.stringify(payloadObj));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(headerB64 + "." + payloadB64)
  );
  return headerB64 + "." + payloadB64 + "." + bytesToBase64url(sigBuffer);
}

async function verifyOAuthPayload(token, secret) {
  const signingSecret = String(secret || "").trim();
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed_parts" };
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = headerB64 + "." + payloadB64;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sig = base64urlToBytes(signatureB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(signingInput)
    );
    if (!valid) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch (e) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlToStr(payloadB64));
  } catch (e) {
    return { ok: false, reason: "malformed_payload" };
  }
  if (!payload || !payload.exp) {
    return { ok: false, reason: "missing_code" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now >= payload.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

function makeAuthCodePayload(sub, username, redirect_uri, code_challenge, code_challenge_method) {
  return {
    type: "code",
    sub,
    username,
    redirect_uri: redirect_uri || null,
    code_challenge: code_challenge || null,
    code_challenge_method: code_challenge_method || null,
    exp: Math.floor(Date.now() / 1000) + 5 * 60,
  };
}

function makeAccessTokenPayload(sub, username) {
  return {
    type: "access",
    sub,
    username,
    scope: "mcp",
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  };
}

function makeRefreshTokenPayload(sub, username) {
  return {
    type: "refresh",
    sub,
    username,
    scope: "mcp",
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
  };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAuthorizeForm(params, error) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = params;
  const hidden = [
    ["client_id", client_id],
    ["redirect_uri", redirect_uri],
    ["state", state],
    ["code_challenge", code_challenge],
    ["code_challenge_method", code_challenge_method],
    ["scope", scope],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join("\n      ");
  const errHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign in to Split Task</title>
<style>
  body { margin: 0; height: 100vh; background: #1a2133; color: #f5f6fa; font-family: 'Inter', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 380px; width: 90%; padding: 32px; border-radius: 16px; background: #232c45; box-shadow: 0 4px 18px rgba(0,0,0,.4); text-align: center; }
  h1 { font-size: 24px; margin: 0 0 8px; color: #4a6cf7; }
  p { font-size: 15px; line-height: 1.55; margin: 0 0 20px; color: #b9c0d4; }
  .error { color: #ff6b6b; font-size: 13px; margin-bottom: 16px; text-align: center; }
  form { display: flex; flex-direction: column; gap: 12px; text-align: left; }
  label { font-size: 13px; color: #b9c0d4; display: block; margin-bottom: 4px; }
  input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #3a4563; background: #1a2133; color: #f5f6fa; font-size: 14px; box-sizing: border-box; }
  button { width: 100%; padding: 10px; border-radius: 8px; border: none; background: #4a6cf7; color: #fff; font-weight: 700; font-size: 15px; cursor: pointer; margin-top: 6px; }
  button:hover { background: #5a7cf7; }
</style></head>
<body>
  <div class="card">
    <h1>Split Task</h1>
    <p>Sign in to authorize the MCP connection</p>
    ${errHtml}
    <form method="post">
      ${hidden}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

async function handleOAuthRequest(request, env, url, corsHeaders, jsonResponse) {
  const oauthOrigin = url.origin;

  if ((url.pathname === "/.well-known/oauth-protected-resource" ||
       url.pathname === "/.well-known/oauth-protected-resource/mcp") &&
      request.method === "GET") {
    return jsonResponse({
      resource: oauthOrigin + "/mcp",
      authorization_servers: [oauthOrigin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  }

  if ((url.pathname === "/.well-known/oauth-authorization-server" ||
       url.pathname === "/.well-known/openid-configuration") &&
      request.method === "GET") {
    return jsonResponse({
      issuer: oauthOrigin,
      authorization_endpoint: oauthOrigin + "/oauth/authorize",
      token_endpoint: oauthOrigin + "/oauth/token",
      registration_endpoint: oauthOrigin + "/oauth/register",
      revocation_endpoint: oauthOrigin + "/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
    });
  }

  if (url.pathname === "/oauth/register" && request.method === "POST") {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 1048576) return jsonResponse({ error: "Payload too large" }, 413);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const { client_name, redirect_uris, token_endpoint_auth_method } = body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return jsonResponse({ error: "redirect_uris must be a non-empty array" }, 400);
    }
    for (const uri of redirect_uris) {
      try {
        const u = new URL(uri);
        const ok = u.protocol === "https:" ||
          (u.protocol === "http:" && u.hostname === "localhost");
        if (!ok) {
          return jsonResponse({ error: "redirect_uris must be HTTPS or http://localhost" }, 400);
        }
      } catch {
        return jsonResponse({ error: "Invalid redirect_uri: " + uri }, 400);
      }
    }
    const authMethod = token_endpoint_auth_method && token_endpoint_auth_method !== "none"
      ? token_endpoint_auth_method
      : "none";
    const resp = {
      client_id: crypto.randomUUID(),
      client_name: client_name || null,
      redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
    };
    if (authMethod !== "none") {
      resp.client_secret = crypto.randomUUID();
    }
    console.log("[oauth/register] client registered:", resp.client_id, "auth_method:", authMethod);
    return jsonResponse(resp, 201);
  }

  if (url.pathname === "/oauth/authorize" && request.method === "GET") {
    const params = {
      client_id: url.searchParams.get("client_id") || undefined,
      redirect_uri: url.searchParams.get("redirect_uri") || undefined,
      state: url.searchParams.get("state") || undefined,
      code_challenge: url.searchParams.get("code_challenge") || undefined,
      code_challenge_method: url.searchParams.get("code_challenge_method") || undefined,
      scope: url.searchParams.get("scope") || undefined,
    };
    return new Response(renderAuthorizeForm(params, null), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (url.pathname === "/oauth/authorize" && request.method === "POST") {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 1048576) return jsonResponse({ error: "Payload too large" }, 413);
    let form;
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        form = await request.json();
      } else {
        const text = await request.text();
        form = Object.fromEntries(new URLSearchParams(text));
      }
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }

    const username = form?.username;
    const password = form?.password;
    const client_id = url.searchParams.get("client_id") || form?.client_id;
    const redirect_uri = url.searchParams.get("redirect_uri") || form?.redirect_uri;
    const state = url.searchParams.get("state") || form?.state;
    const code_challenge = url.searchParams.get("code_challenge") || form?.code_challenge;
    const code_challenge_method = url.searchParams.get("code_challenge_method") || form?.code_challenge_method;
    const scope = url.searchParams.get("scope") || form?.scope;

    const oauthParams = { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope };

    if (!username || !password) {
      return new Response(renderAuthorizeForm(oauthParams, "Username and password are required"), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const db = env["ST-DATABASE"];
    const passwordHash = await sha256Hex(String(password));
    if (!db || !(await checkUserPassword(db, String(username), passwordHash))) {
      console.log("[oauth/authorize] invalid credentials for username:", String(username));
      return new Response(renderAuthorizeForm(oauthParams, "Invalid username or password"), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const account = await findUser(db, String(username));
    if (!account) {
      return new Response(renderAuthorizeForm(oauthParams, "Invalid username or password"), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const codePayload = makeAuthCodePayload(
      account.user_id,
      account.username,
      redirect_uri,
      code_challenge,
      code_challenge_method
    );
    const code = await signOAuthPayload(codePayload, env.MCP_API_KEY);
    console.log("[oauth/authorize] auth code issued for user:", account.username);

    const redirectUrl = new URL(redirect_uri || "/");
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl.toString(), ...corsHeaders },
    });
  }

  if (url.pathname === "/oauth/token" && request.method === "POST") {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 1048576) return jsonResponse({ error: "Payload too large" }, 413);
    let body;
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        body = await request.json();
      } else {
        const text = await request.text();
        body = Object.fromEntries(new URLSearchParams(text));
      }
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }

    let clientId = body?.client_id;
    let clientSecret = body?.client_secret;
    if ((!clientId || !clientSecret) && request.headers.get("authorization")) {
      const auth = request.headers.get("authorization") || "";
      const basicMatch = /^Basic\s+(.+)$/i.exec(auth);
      if (basicMatch) {
        try {
          const decoded = new TextDecoder().decode(base64urlToBytes(basicMatch[1]));
          const colon = decoded.indexOf(":");
          if (colon !== -1) {
            if (!clientId) clientId = decodeURIComponent(decoded.slice(0, colon));
            if (!clientSecret) clientSecret = decodeURIComponent(decoded.slice(colon + 1));
          }
        } catch { /* ignore malformed basic auth */ }
      }
    }

    const { grant_type, code, redirect_uri, code_verifier, refresh_token } = body || {};
    const normalizeUri = (u) => String(u || "").replace(/\/$/, "");

    if (grant_type === "refresh_token") {
      if (!refresh_token) {
        return jsonResponse({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
      }
      const result = await verifyOAuthPayload(refresh_token, env.MCP_API_KEY);
      if (!result.ok || !result.payload || result.payload.type !== "refresh") {
        console.log("[oauth/token] invalid refresh_token:", result.reason);
        return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
      }
      const payload = result.payload;
      const access_token = await signOAuthPayload(makeAccessTokenPayload(payload.sub, payload.username), env.MCP_API_KEY);
      const new_refresh_token = await signOAuthPayload(makeRefreshTokenPayload(payload.sub, payload.username), env.MCP_API_KEY);
      console.log("[oauth/token] refresh_token grant ok for user:", payload.username);
      return jsonResponse({
        access_token,
        refresh_token: new_refresh_token,
        token_type: "Bearer",
        expires_in: 2592000,
        scope: "mcp",
      });
    }

    if (grant_type !== "authorization_code") {
      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }
    if (!code) {
      return jsonResponse({ error: "invalid_request", error_description: "code is required" }, 400);
    }

    const result = await verifyOAuthPayload(code, env.MCP_API_KEY);
    if (!result.ok || !result.payload || result.payload.type !== "code") {
      console.log("[oauth/token] invalid auth code:", result.reason);
      return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }, 400);
    }
    const payload = result.payload;

    const codeUri = normalizeUri(payload.redirect_uri);
    const reqUri = normalizeUri(redirect_uri);
    if (codeUri && reqUri && codeUri !== reqUri) {
      console.log("[oauth/token] redirect_uri mismatch:", codeUri, "!==", reqUri);
      return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }

    if (payload.code_challenge) {
      if (!code_verifier) {
        return jsonResponse({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
      }
      const digestBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(String(code_verifier))
      );
      const challenge = bytesToBase64url(digestBuf);
      if (challenge !== payload.code_challenge) {
        console.log("[oauth/token] code_verifier mismatch");
        return jsonResponse({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
      }
    }

    const access_token = await signOAuthPayload(makeAccessTokenPayload(payload.sub, payload.username), env.MCP_API_KEY);
    const new_refresh_token = await signOAuthPayload(makeRefreshTokenPayload(payload.sub, payload.username), env.MCP_API_KEY);
    console.log("[oauth/token] authorization_code grant ok for user:", payload.username);
    return jsonResponse({
      access_token,
      refresh_token: new_refresh_token,
      token_type: "Bearer",
      expires_in: 2592000,
      scope: "mcp",
    });
  }

  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
    return jsonResponse({ revoked: true }, 200);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function resolveTargetUserFromDb(db, username) {
  const u = normUsername(username);
  if (!u) return null;
  return findUser(db, u);
}

async function verifyMcpAuth(request, env) {
  const expected = env.MCP_API_KEY;
  const auth = request.headers.get("authorization") || "";
  const bearerToken = (auth.startsWith("Bearer ") || auth.startsWith("bearer "))
    ? auth.slice(7).trim()
    : "";

  if (bearerToken && expected && typeof expected === "string") {
    try {
      const result = await verifyOAuthPayload(bearerToken, expected);
      if (result.ok && result.payload && result.payload.type === "access") {
        return {
          ok: true,
          type: "oauth",
          user_id: result.payload.sub,
          username: result.payload.username,
        };
      }
    } catch { /* fall through to legacy */ }
  }

  if (expected && typeof expected === "string") {
    let provided = "";
    if (bearerToken) {
      provided = bearerToken;
    } else {
      try {
        provided = new URL(request.url).searchParams.get("key") || "";
      } catch { provided = ""; }
    }
    if (provided && timingSafeEqual(provided, String(expected).trim())) {
      return { ok: true, type: "legacy" };
    }
  }

  return { ok: false };
}

async function resolveMcpUserId(env, mcpAuth, usernameArg) {
  const db = env["ST-DATABASE"];
  if (!db) throw new Error("D1 binding ST-DATABASE is not configured");

  if (usernameArg && String(usernameArg).trim()) {
    const account = await resolveTargetUserFromDb(db, String(usernameArg).trim());
    if (!account) throw new Error(`Unknown target user: ${usernameArg}`);
    return account.user_id;
  }

  if (mcpAuth?.type === "oauth" && mcpAuth.user_id) {
    return mcpAuth.user_id;
  }

  const fallbackUsername = String(env.DEFAULT_TARGET_USERNAME || "").trim();
  const account = await resolveTargetUserFromDb(db, fallbackUsername);
  if (!account) throw new Error(`Unknown target user: ${fallbackUsername || "(none)"}`);
  return account.user_id;
}

async function bumpSyncVersion(db, userId) {
  try {
    await db
      .prepare(
        `INSERT INTO split_task_sync_versions (user_id, version)
         VALUES (?, 1)
         ON CONFLICT(user_id) DO UPDATE SET version = version + 1`
      )
      .bind(userId)
      .run();
  } catch (e) {
    console.warn("[mcp] sync version bump skipped:", e?.message || e);
  }
}

async function createTaskFromAgent(env, payload, explicitUserId = null) {
  const db = env["ST-DATABASE"];
  if (!db) throw new Error("D1 binding ST-DATABASE is not configured");

  const title = String(payload.title || "").trim();
  const date = String(payload.date || "").trim();
  const dueDate = String(payload.due_date || "").trim();
  const deadline = String(payload.deadline || "").trim();
  const categoryId = String(payload.category_id || "").trim() || "default";
  const url = String(payload.url || "").trim();
  const notes = String(payload.notes || "").trim();
  const shouldDedupe = payload.dedupe !== undefined ? Boolean(payload.dedupe) : true;

  if (!title) throw new Error("title is required");

  let userId = explicitUserId;
  if (!userId) {
    const username =
      String(payload.username || "").trim() ||
      String(env.DEFAULT_TARGET_USERNAME || "").trim();
    const account = await resolveTargetUserFromDb(db, username);
    if (!account) throw new Error(`Unknown target user: ${username || "(none)"}`);
    userId = account.user_id;
  }

  const today = new Date().toISOString().slice(0, 10);
  const itemDate = date || today;
  const effectiveDueDate = dueDate || itemDate;
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  if (shouldDedupe) {
    const conditions = ["title = ?"];
    const params = [userId, title];
    if (url) {
      conditions.push("notes LIKE ?");
      params.push(`%Source: ${url}%`);
    }
    const existing = await db
      .prepare(
        `SELECT id FROM split_task_items WHERE user_id = ? AND (${conditions.join(" OR ")}) LIMIT 1`
      )
      .bind(...params)
      .first();
    if (existing) {
      return { inserted: false, id: existing.id, reason: "duplicate" };
    }
  }

  const urlLine = url ? `\nSource: ${url}` : "";
  const notesText = [notes, urlLine].filter(Boolean).join("\n").trim() || null;

  await db
    .prepare(
      `INSERT INTO split_task_items (
        id, user_id, type, title, category_id, item_date, due_date, deadline,
        done, notes, updated_at
      ) VALUES (?, ?, 'task', ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      id,
      userId,
      title,
      categoryId,
      itemDate,
      effectiveDueDate,
      deadline || null,
      notesText,
      nowIso
    )
    .run();

  await bumpSyncVersion(db, userId);
  return { inserted: true, id };
}

async function handleAgentIngest(request, env, jsonResponse) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.some((it) => !it || typeof it !== "object")) {
    return jsonResponse({ error: "Expected an item object or array of items" }, 400);
  }

  const results = [];
  const errors = [];
  for (const item of items) {
    try {
      results.push(await createTaskFromAgent(env, item));
    } catch (e) {
      errors.push({ item, error: String(e?.message || e) });
    }
  }

  const allFailed = errors.length === items.length;
  return jsonResponse(
    {
      success: !allFailed,
      inserted: results.filter((r) => r.inserted).length,
      duplicates: results.filter((r) => !r.inserted).length,
      results,
      errors: errors.length ? errors : undefined,
    },
    allFailed ? 400 : 200
  );
}

const MCP_TOOLS = [
  {
    name: "read_tasks",
    description: "Read tasks from Split Task. Optional filters: date_from, date_to, category_id, include_done (default false).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        date_to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        category_id: { type: "string", description: "Filter by category ID" },
        include_done: { type: "boolean", description: "Include completed tasks (default false)" },
        username: { type: "string", description: "Optional target username" },
      },
    },
  },
  {
    name: "read_events",
    description: "Read calendar events from Split Task. Optional filters: date_from, date_to, category_id.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        date_to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        category_id: { type: "string", description: "Filter by category ID" },
        username: { type: "string", description: "Optional target username" },
      },
    },
  },
  {
    name: "read_all",
    description: "Read tasks, calendar events, and categories together from Split Task (excludes private notes; use read_notes separately if needed).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        date_to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        category_id: { type: "string", description: "Filter by category ID" },
        include_done: { type: "boolean", description: "Include completed tasks (default false)" },
        username: { type: "string", description: "Optional target username" },
      },
    },
  },
  {
    name: "read_notes",
    description: "Read user notes from Split Task. IMPORTANT: Notes may contain private personal content—always ask the user for explicit confirmation before calling this tool unless they just directly asked to read their notes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        category_id: { type: "string", description: "Optional category ID filter" },
        include_hidden: { type: "boolean", description: "Include hidden notes (default false)" },
        username: { type: "string", description: "Optional target username" },
      },
    },
  },
  {
    name: "add_task",
    description: "Add a new task to Split Task.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        date: { type: "string", description: "Scheduled date in YYYY-MM-DD format (defaults to today)" },
        due_date: { type: "string", description: "Due date in YYYY-MM-DD format" },
        deadline: { type: "string", description: "Optional deadline string" },
        category_id: { type: "string", description: "Category ID (defaults to 'default')" },
        notes: { type: "string", description: "Optional notes" },
        url: { type: "string", description: "Optional reference URL" },
        dedupe: { type: "boolean", description: "Skip insert if identical title/URL exists (default false)" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["title"],
    },
  },
  {
    name: "add_upcoming_opportunity",
    description: "Add an upcoming opportunity, hackathon, or application deadline to Split Task (automatically deduplicates by title or URL).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the hackathon, program, or opportunity" },
        date: { type: "string", description: "Target or deadline date in YYYY-MM-DD format" },
        url: { type: "string", description: "Link to the opportunity" },
        notes: { type: "string", description: "Details, eligibility, or description" },
        category_id: { type: "string", description: "Optional category ID (defaults to 'default')" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["title"],
    },
  },
  {
    name: "edit_task",
    description: "Edit an existing task in Split Task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        title: { type: "string", description: "Updated title" },
        date: { type: "string", description: "Updated scheduled date YYYY-MM-DD" },
        due_date: { type: "string", description: "Updated due date YYYY-MM-DD" },
        deadline: { type: "string", description: "Updated deadline" },
        category_id: { type: "string", description: "Updated category ID" },
        done: { type: "boolean", description: "Completion status" },
        notes: { type: "string", description: "Updated notes" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_event",
    description: "Add a new calendar event to Split Task.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Event date in YYYY-MM-DD format" },
        start_time: { type: "string", description: "Start time in HH:MM format (24h)" },
        end_time: { type: "string", description: "End time in HH:MM format (24h)" },
        location: { type: "string", description: "Optional location" },
        category_id: { type: "string", description: "Category ID (defaults to 'default')" },
        notes: { type: "string", description: "Optional notes" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "edit_event",
    description: "Edit an existing calendar event in Split Task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Event ID" },
        title: { type: "string", description: "Updated title" },
        date: { type: "string", description: "Updated event date YYYY-MM-DD" },
        start_time: { type: "string", description: "Updated start time HH:MM" },
        end_time: { type: "string", description: "Updated end time HH:MM" },
        location: { type: "string", description: "Updated location" },
        category_id: { type: "string", description: "Updated category ID" },
        notes: { type: "string", description: "Updated notes" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_note",
    description: "Create a new note in Split Task.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Note text content" },
        category_id: { type: "string", description: "Optional category ID" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["text"],
    },
  },
  {
    name: "edit_note",
    description: "Edit an existing unencrypted note in Split Task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note ID" },
        text: { type: "string", description: "Updated note text" },
        category_id: { type: "string", description: "Updated category ID (or null)" },
        hidden: { type: "boolean", description: "Whether note is hidden" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_category",
    description: "Create a new category in Split Task.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Category name" },
        color: { type: "string", description: "Hex color code (default '#344271')" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["name"],
    },
  },
  {
    name: "edit_category",
    description: "Edit an existing category's name or color in Split Task.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        name: { type: "string", description: "Updated category name" },
        color: { type: "string", description: "Updated hex color code" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_category",
    description: "Delete a custom category in Split Task and reassign its tasks/events to 'default'. Cannot delete 'default'.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID to delete" },
        username: { type: "string", description: "Optional target username" },
      },
      required: ["id"],
    },
  },
];

async function executeMcpTool(name, rawArgs, env, mcpAuth) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const db = env["ST-DATABASE"];
  if (!db) throw new Error("D1 binding ST-DATABASE is not configured");
  const userId = await resolveMcpUserId(env, mcpAuth, args.username);
  const nowIso = new Date().toISOString();

  if (name === "read_tasks") {
    let sql = "SELECT id, title, category_id, item_date, due_date, deadline, done, finished_at, notes, updated_at FROM split_task_items WHERE user_id = ? AND type = 'task'";
    const binds = [userId];
    if (args.date_from) { sql += " AND item_date >= ?"; binds.push(String(args.date_from)); }
    if (args.date_to) { sql += " AND item_date <= ?"; binds.push(String(args.date_to)); }
    if (args.category_id) { sql += " AND category_id = ?"; binds.push(String(args.category_id)); }
    if (!args.include_done) { sql += " AND done = 0"; }
    sql += " ORDER BY item_date ASC, updated_at DESC LIMIT 200";
    const rows = await db.prepare(sql).bind(...binds).all();
    return { tasks: rows.results || [] };
  }

  if (name === "read_events") {
    let sql = "SELECT id, title, category_id, item_date, start_time, end_time, location, notes, recurrence, updated_at FROM split_task_items WHERE user_id = ? AND type = 'event'";
    const binds = [userId];
    if (args.date_from) { sql += " AND item_date >= ?"; binds.push(String(args.date_from)); }
    if (args.date_to) { sql += " AND item_date <= ?"; binds.push(String(args.date_to)); }
    if (args.category_id) { sql += " AND category_id = ?"; binds.push(String(args.category_id)); }
    sql += " ORDER BY item_date ASC, start_time ASC LIMIT 200";
    const rows = await db.prepare(sql).bind(...binds).all();
    return { events: rows.results || [] };
  }

  if (name === "read_all") {
    let taskSql = "SELECT id, title, category_id, item_date, due_date, deadline, done, notes FROM split_task_items WHERE user_id = ? AND type = 'task'";
    const taskBinds = [userId];
    if (args.date_from) { taskSql += " AND item_date >= ?"; taskBinds.push(String(args.date_from)); }
    if (args.date_to) { taskSql += " AND item_date <= ?"; taskBinds.push(String(args.date_to)); }
    if (args.category_id) { taskSql += " AND category_id = ?"; taskBinds.push(String(args.category_id)); }
    if (!args.include_done) { taskSql += " AND done = 0"; }
    taskSql += " ORDER BY item_date ASC LIMIT 150";

    let eventSql = "SELECT id, title, category_id, item_date, start_time, end_time, location, notes FROM split_task_items WHERE user_id = ? AND type = 'event'";
    const eventBinds = [userId];
    if (args.date_from) { eventSql += " AND item_date >= ?"; eventBinds.push(String(args.date_from)); }
    if (args.date_to) { eventSql += " AND item_date <= ?"; eventBinds.push(String(args.date_to)); }
    if (args.category_id) { eventSql += " AND category_id = ?"; eventBinds.push(String(args.category_id)); }
    eventSql += " ORDER BY item_date ASC, start_time ASC LIMIT 150";

    const [tRes, eRes, cRes] = await db.batch([
      db.prepare(taskSql).bind(...taskBinds),
      db.prepare(eventSql).bind(...eventBinds),
      db.prepare("SELECT id, name, color FROM split_task_categories WHERE user_id = ?").bind(userId),
    ]);
    return {
      tasks: tRes?.results || [],
      events: eRes?.results || [],
      categories: cRes?.results || [],
    };
  }

  if (name === "read_notes") {
    await ensureNotesOrderColumn(db);
    let sql = "SELECT id, text, category_id, created_at, updated_at, hidden, text_is_encrypted, sort_order FROM split_task_notes WHERE user_id = ?";
    const binds = [userId];
    if (args.category_id) { sql += " AND category_id = ?"; binds.push(String(args.category_id)); }
    if (!args.include_hidden) { sql += " AND COALESCE(hidden, 0) = 0"; }
    sql += " ORDER BY sort_order ASC, created_at DESC LIMIT 100";
    const rows = await db.prepare(sql).bind(...binds).all();
    const notes = (rows.results || []).map((n) => ({
      ...n,
      text: Number(n.text_is_encrypted) === 1 ? "[Encrypted note — view in Split Task app]" : n.text,
    }));
    return { notes };
  }

  if (name === "add_task") {
    return createTaskFromAgent(env, { ...args, dedupe: args.dedupe === true }, userId);
  }

  if (name === "add_upcoming_opportunity") {
    return createTaskFromAgent(env, { ...args, dedupe: true }, userId);
  }

  if (name === "edit_task") {
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required");
    const existing = await db.prepare("SELECT id FROM split_task_items WHERE id = ? AND user_id = ? AND type = 'task'").bind(id, userId).first();
    if (!existing) return { updated: false, reason: "not_found" };

    const sets = [];
    const binds = [];
    if (args.title !== undefined) { sets.push("title = ?"); binds.push(String(args.title).trim()); }
    if (args.date !== undefined) { sets.push("item_date = ?"); binds.push(String(args.date).trim()); }
    if (args.due_date !== undefined) { sets.push("due_date = ?"); binds.push(args.due_date ? String(args.due_date).trim() : null); }
    if (args.deadline !== undefined) { sets.push("deadline = ?"); binds.push(args.deadline ? String(args.deadline).trim() : null); }
    if (args.category_id !== undefined) { sets.push("category_id = ?"); binds.push(String(args.category_id).trim() || "default"); }
    if (args.notes !== undefined) { sets.push("notes = ?"); binds.push(args.notes === null ? null : String(args.notes)); }
    if (args.done !== undefined) {
      const isDone = Boolean(args.done);
      sets.push("done = ?");
      binds.push(isDone ? 1 : 0);
      sets.push("finished_at = ?");
      binds.push(isDone ? nowIso : null);
    }
    sets.push("updated_at = ?");
    binds.push(nowIso, id, userId);

    await db.prepare(`UPDATE split_task_items SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND type = 'task'`).bind(...binds).run();
    await bumpSyncVersion(db, userId);
    return { updated: true, id };
  }

  if (name === "add_event") {
    const title = String(args.title || "").trim();
    const itemDate = String(args.date || "").trim();
    if (!title || !itemDate) throw new Error("title and date are required");
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO split_task_items (
        id, user_id, type, title, category_id, item_date, done,
        start_time, end_time, location, notes, updated_at
      ) VALUES (?, ?, 'event', ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).bind(
      id,
      userId,
      title,
      String(args.category_id || "").trim() || "default",
      itemDate,
      args.start_time ? String(args.start_time).trim() : null,
      args.end_time ? String(args.end_time).trim() : null,
      args.location ? String(args.location).trim() : null,
      args.notes ? String(args.notes).trim() : null,
      nowIso
    ).run();
    await bumpSyncVersion(db, userId);
    return { inserted: true, id };
  }

  if (name === "edit_event") {
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required");
    const existing = await db.prepare("SELECT id FROM split_task_items WHERE id = ? AND user_id = ? AND type = 'event'").bind(id, userId).first();
    if (!existing) return { updated: false, reason: "not_found" };

    const sets = [];
    const binds = [];
    if (args.title !== undefined) { sets.push("title = ?"); binds.push(String(args.title).trim()); }
    if (args.date !== undefined) { sets.push("item_date = ?"); binds.push(String(args.date).trim()); }
    if (args.start_time !== undefined) { sets.push("start_time = ?"); binds.push(args.start_time ? String(args.start_time).trim() : null); }
    if (args.end_time !== undefined) { sets.push("end_time = ?"); binds.push(args.end_time ? String(args.end_time).trim() : null); }
    if (args.location !== undefined) { sets.push("location = ?"); binds.push(args.location ? String(args.location).trim() : null); }
    if (args.category_id !== undefined) { sets.push("category_id = ?"); binds.push(String(args.category_id).trim() || "default"); }
    if (args.notes !== undefined) { sets.push("notes = ?"); binds.push(args.notes === null ? null : String(args.notes)); }
    sets.push("updated_at = ?");
    binds.push(nowIso, id, userId);

    await db.prepare(`UPDATE split_task_items SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND type = 'event'`).bind(...binds).run();
    await bumpSyncVersion(db, userId);
    return { updated: true, id };
  }

  if (name === "add_note") {
    const text = String(args.text || "").trim();
    if (!text) throw new Error("text is required");
    await ensureNotesOrderColumn(db);
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO split_task_notes (
        id, user_id, text, category_id, created_at, updated_at, hidden, text_is_encrypted, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
    `).bind(
      id,
      userId,
      text,
      args.category_id ? String(args.category_id).trim() : null,
      nowIso,
      nowIso
    ).run();
    await bumpSyncVersion(db, userId);
    return { inserted: true, id };
  }

  if (name === "edit_note") {
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required");
    const existing = await db.prepare("SELECT id, text_is_encrypted FROM split_task_notes WHERE id = ? AND user_id = ?").bind(id, userId).first();
    if (!existing) return { updated: false, reason: "not_found" };
    if (Number(existing.text_is_encrypted) === 1) {
      throw new Error("Cannot edit an encrypted note via MCP");
    }

    const sets = [];
    const binds = [];
    if (args.text !== undefined) { sets.push("text = ?"); binds.push(String(args.text)); }
    if (args.category_id !== undefined) { sets.push("category_id = ?"); binds.push(args.category_id ? String(args.category_id).trim() : null); }
    if (args.hidden !== undefined) { sets.push("hidden = ?"); binds.push(args.hidden ? 1 : 0); }
    sets.push("updated_at = ?");
    binds.push(nowIso, id, userId);

    await db.prepare(`UPDATE split_task_notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    await bumpSyncVersion(db, userId);
    return { updated: true, id };
  }

  if (name === "add_category") {
    const catName = String(args.name || "").trim();
    if (!catName) throw new Error("name is required");
    const color = /^#[0-9a-fA-F]{6}$/.test(String(args.color || "").trim())
      ? String(args.color).trim()
      : "#344271";
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO split_task_categories (id, user_id, name, color, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, userId, catName, color, nowIso).run();
    await bumpSyncVersion(db, userId);
    return { inserted: true, id, name: catName, color };
  }

  if (name === "edit_category") {
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required");
    const existing = await db.prepare("SELECT id FROM split_task_categories WHERE id = ? AND user_id = ?").bind(id, userId).first();
    if (!existing) return { updated: false, reason: "not_found" };

    const sets = [];
    const binds = [];
    if (args.name !== undefined) { sets.push("name = ?"); binds.push(String(args.name).trim()); }
    if (args.color !== undefined) {
      const color = /^#[0-9a-fA-F]{6}$/.test(String(args.color).trim())
        ? String(args.color).trim()
        : "#344271";
      sets.push("color = ?");
      binds.push(color);
    }
    sets.push("updated_at = ?");
    binds.push(nowIso, id, userId);

    await db.prepare(`UPDATE split_task_categories SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    await bumpSyncVersion(db, userId);
    return { updated: true, id };
  }

  if (name === "delete_category") {
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required");
    if (id === "default") throw new Error("Cannot delete the 'default' category");
    const existing = await db.prepare("SELECT id FROM split_task_categories WHERE id = ? AND user_id = ?").bind(id, userId).first();
    if (!existing) return { deleted: false, reason: "not_found" };

    await db.batch([
      db.prepare("UPDATE split_task_items SET category_id = 'default', updated_at = ? WHERE user_id = ? AND category_id = ?").bind(nowIso, userId, id),
      db.prepare("UPDATE split_task_notes SET category_id = NULL, updated_at = ? WHERE user_id = ? AND category_id = ?").bind(nowIso, userId, id),
      db.prepare("DELETE FROM split_task_categories WHERE id = ? AND user_id = ?").bind(id, userId),
    ]);
    await bumpSyncVersion(db, userId);
    return { deleted: true, id };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcpRequest(request, env, corsHeaders, jsonResponse) {
  const url = new URL(request.url);
  const mcpAuth = await verifyMcpAuth(request, env);
  if (!mcpAuth.ok) {
    return new Response(null, {
      status: 401,
      headers: {
        ...corsHeaders,
        "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  if (request.method === "GET") {
    return new Response(": connected\n\n", {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (rpc.id === undefined || rpc.id === null) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();
  const mcpJson = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Mcp-Session-Id": sessionId,
      },
    });

  const rpcOk = (result) => mcpJson({ jsonrpc: "2.0", id: rpc.id, result });
  const rpcErr = (code, message) => mcpJson({ jsonrpc: "2.0", id: rpc.id, error: { code, message } });

  if (rpc.method === "initialize") {
    return rpcOk({
      protocolVersion: rpc.params?.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "manumit-mcp", version: "1.1.0" },
      instructions: "Manage Split Task tasks, calendar events, notes, and categories. Ask confirmation before calling read_notes.",
    });
  }

  if (rpc.method === "ping") {
    return rpcOk({});
  }

  if (rpc.method === "tools/list") {
    return rpcOk({ tools: MCP_TOOLS });
  }

  if (rpc.method === "tools/call") {
    const toolName = rpc.params?.name;
    const toolDef = MCP_TOOLS.find((t) => t.name === toolName);
    if (!toolDef) {
      return rpcErr(-32601, `Unknown tool: ${toolName}`);
    }
    try {
      const result = await executeMcpTool(toolName, rpc.params?.arguments || {}, env, mcpAuth);
      return rpcOk({
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (err) {
      return rpcOk({
        isError: true,
        content: [{ type: "text", text: String(err?.message || err) }],
      });
    }
  }

  return rpcErr(-32601, `Method not found: ${rpc.method}`);
}

export default {
  async fetch(request, env, ctx) {
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
      'https://localhost',
    ];
    const isLocalOrigin = /^https?:\/\/localhost(:\d+)?$/.test(origin);
    const isPagesPreview = /^https:\/\/[a-z0-9-]+\.freeerapps\.pages\.dev$/.test(origin);
    const allowOrigin = (ALLOWED_ORIGINS.includes(origin) || isLocalOrigin || isPagesPreview)
      ? origin : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'ETag, Mcp-Session-Id',
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
          'Cache-Control': 'no-store',
        },
      });

    // ─── MCP & OAuth 2.1 Routes ──────────────────────────────────────────
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcpRequest(request, env, corsHeaders, jsonResponse);
    }

    if (url.pathname === "/api/agent/ingest" && request.method === "POST") {
      if (!(await verifyMcpAuth(request, env)).ok)
        return jsonResponse({ error: "Unauthorized" }, 401);
      return handleAgentIngest(request, env, jsonResponse);
    }

    if (url.pathname.startsWith("/.well-known/oauth-") ||
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname.startsWith("/oauth/")) {
      return handleOAuthRequest(request, env, url, corsHeaders, jsonResponse);
    }

    // ─── GET /api/status ─────────────────────────────────────────────────
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
        if (!windows['24h']) windows['24h'] = qualifyWindow(await readUptime(db, 24));
        const body = { status: 'operational', uptimePct: windows['24h'].pct, windows };
        statusCache = { body, at: nowMs };
        return jsonResponse({ ...body, ...geo, t: nowMs, cached: false });
      } catch (e) {
        return jsonResponse({ status: 'degraded', uptimePct: null, ...geo, t: Date.now() });
      }
    }

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
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const loginDb = env['ST-DATABASE'];
        const ADMIN_USERNAME = 'Admin';
        const ADMIN_PASSWORD_HASH = env.ADMIN_PASSWORD_HASH || '0618b1322273460801603e546d012d7d912f80ad71cbfbc08a73e2cce02b2ffb';
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

          if (Date.now() - lastSweepAttempt > SWEEP_THROTTLE_MS) {
            lastSweepAttempt = Date.now();
            try { await runDailySweep(env); } catch (err) { console.error('[sweep] lazy sweep failed:', err); }
          }

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

          const stmts = [
            syncDb.prepare('SELECT * FROM split_task_settings WHERE user_id = ?').bind(userId),
            syncDb.prepare('SELECT * FROM split_task_categories WHERE user_id = ?').bind(userId),
            syncDb.prepare('SELECT * FROM split_task_items WHERE user_id = ?').bind(userId),
            syncDb.prepare('SELECT * FROM split_task_notes WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC, id ASC').bind(userId),
          ];
          let settings = null, categories = [], items = [], notes = [];
          try {
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
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        try {
          const pushDb = env['ST-DATABASE'];
          const len = Number(request.headers.get('content-length') || 0);
          if (len > 1048576) return jsonResponse({ error: 'Payload too large' }, 413);
          let body;
          try {
            body = await request.json();
          } catch (err) {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
          }
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
          const bool01 = (v) => (v === false || v === 0 ? 0 : 1);

          if (settings) {
            const hasThemeLevel = settings.theme_level !== undefined
              && settings.theme_level !== null && settings.theme_level !== '';
            const themeLevel = hasThemeLevel
              ? Math.min(4, Math.max(0, Math.round(Number(settings.theme_level)) || 0))
              : (settings.is_dim_mode ? 1 : (settings.is_dark_mode ? 0 : 4));

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

          const CHUNK = 25;
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
        if (email) ctx?.waitUntil?.(sendTicketConfirmation(env, email, id, type, message).catch(() => {}));
        return jsonResponse({ success: true, id });
      }

      // ─── GET /api/tickets ────────────────────────────────────────────────
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

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runDailySweep(env).catch(err => console.error('[sweep] cron sweep failed:', err))
    );
    if (env['ST-DATABASE']) {
      ctx.waitUntil(recordUptimeTick(env['ST-DATABASE']));
    }
  },
};