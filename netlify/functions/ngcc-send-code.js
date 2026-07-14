// NGCC — Send OTP login code
// Checks for active subscriber, generates 6-digit OTP, emails it via Resend.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL

const FALLBACK_SB_URL = 'https://judislfknmhofcgzyozc.supabase.co';
const SB_URL  = normalizeSupabaseUrl(process.env.SUPABASE_URL || process.env.BC_SUPA_URL);
const SB_KEYS = getSupabaseKeyCandidates();
const RS_KEY  = process.env.RESEND_API_KEY;
const RS_FROM = process.env.RESEND_FROM_EMAIL || 'NGCC <noreply@ai4businesses.org>';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return FALLBACK_SB_URL;
  if (raw.indexOf('*') >= 0) return FALLBACK_SB_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9]{20,}$/i.test(raw)) return 'https://' + raw + '.supabase.co';
  return FALLBACK_SB_URL;
}

function getSupabaseKeyCandidates() {
  return [
    process.env.SUPABASE_SERVICE_KEY,
    process.env.BC_SUPA_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_KEY
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && value.indexOf('No value set') !== 0 && !/^\*+$/.test(value));
}

function sbH(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function fetchWithAnyKey(url, options) {
  for (const key of SB_KEYS) {
    const merged = Object.assign({}, options || {});
    merged.headers = Object.assign({}, options && options.headers ? options.headers : {}, sbH(key));
    const response = await fetch(url, merged);
    if (response.status === 401) {
      const body = await response.text();
      if (body.toLowerCase().indexOf('invalid api key') >= 0) continue;
      return { response, key };
    }
    return { response, key };
  }
  return { response: null, key: '' };
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SB_URL || !SB_KEYS.length) return json({ error: 'Missing Supabase configuration' }, 500);
  if (!RS_KEY) return json({ error: 'Missing RESEND_API_KEY configuration' }, 500);

  try {
    let body;
    try { body = await req.json(); } catch(_) { return json({ error: 'Invalid request body' }, 400); }

    const email = (body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Valid email required' }, 400);
    }

    // Check for active NGCC subscriber
    const subLookup = await fetchWithAnyKey(
      `${SB_URL}/rest/v1/ngcc_subscribers?email=eq.${encodeURIComponent(email)}&status=eq.active&limit=1`,
      {}
    );
    const subRes = subLookup.response;
    const workingKey = subLookup.key;
    if (!subRes) return json({ error: 'Supabase auth key is invalid' }, 500);
    if (!subRes.ok) {
      const details = await subRes.text();
      return json({ error: 'Subscriber lookup failed', details: details.slice(0, 250) }, 502);
    }
    const subs = await subRes.json();
    if (!Array.isArray(subs) || subs.length === 0) {
      return json({ ok: false, found: false });
    }

    const code    = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Delete any existing code for this email, then insert fresh
    await fetch(
      `${SB_URL}/rest/v1/ngcc_login_codes?email=eq.${encodeURIComponent(email)}`,
      { method: 'DELETE', headers: sbH(workingKey) }
    );
    const insertRes = await fetch(`${SB_URL}/rest/v1/ngcc_login_codes`, {
      method: 'POST',
      headers: sbH(workingKey),
      body: JSON.stringify({ email, code, expires_at: expires, used: false })
    });
    if (!insertRes.ok) {
      const details = await insertRes.text();
      return json({ error: 'Could not save login code', details: details.slice(0, 250) }, 502);
    }

    // Send email via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    RS_FROM,
        to:      [email],
        subject: 'Your NGCC login code',
        html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0F2A6A;color:#fff">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:8px">National Government Contract Center</div>
          <h2 style="font-size:1.5rem;font-weight:400;margin:0 0 20px">Your login code</h2>
          <div style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">
            <div style="font-size:2.4rem;font-weight:700;letter-spacing:.4em;color:#fff">${code}</div>
            <div style="font-size:.78rem;color:rgba(255,255,255,.4);margin-top:8px">Expires in 10 minutes</div>
          </div>
          <p style="font-size:.86rem;color:rgba(255,255,255,.5);line-height:1.6">Enter this code on the NGCC login page. If you didn't request this, you can safely ignore this email.</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,.1);margin:24px 0"/>
          <p style="font-size:.72rem;color:rgba(255,255,255,.3)">National Government Contract Center &middot; Apropos Group LLC</p>
        </div>`
      })
    });
    if (!emailRes.ok) {
      const details = await emailRes.text();
      return json({ error: 'Could not send login code email', details: details.slice(0, 250) }, 502);
    }

    return json({ ok: true, found: true });
  } catch (error) {
    return json({ error: 'ngcc-send-code failed', details: String(error.message || error) }, 502);
  }
};
