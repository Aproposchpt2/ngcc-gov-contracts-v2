// NGCC — Verify OTP login code → return session
// Validates the 6-digit code, marks it used, returns a session object.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const FALLBACK_SB_URL = 'https://judislfknmhofcgzyozc.supabase.co';
const SB_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL || process.env.BC_SUPA_URL);
const SB_KEY = chooseSupabaseKey();

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

function chooseSupabaseKey() {
  const candidates = [
    process.env.SUPABASE_SERVICE_KEY,
    process.env.BC_SUPA_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_KEY
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && value.indexOf('No value set') !== 0 && !/^\*+$/.test(value));
  return candidates.find((value) => value.length > 40) || candidates[0] || '';
}

function sbH() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SB_URL || !SB_KEY) return json({ error: 'Missing Supabase configuration' }, 500);

  let body;
  try { body = await req.json(); } catch(_) { return json({ error: 'Invalid request body' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  const code  = (body.code  || '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return json({ error: 'Email and 6-digit code required' }, 400);
  }

  // Fetch the OTP record
  const codeRes = await fetch(
    `${SB_URL}/rest/v1/ngcc_login_codes?email=eq.${encodeURIComponent(email)}&code=eq.${code}&used=eq.false&order=expires_at.desc&limit=1`,
    { headers: sbH() }
  );
  const codes = await codeRes.json();

  if (!Array.isArray(codes) || codes.length === 0) {
    return json({ ok: false, error: 'Invalid or expired code. Please request a new one.' }, 401);
  }

  const record = codes[0];
  if (new Date(record.expires_at) < new Date()) {
    return json({ ok: false, error: 'Code has expired. Please request a new one.' }, 401);
  }

  // Mark code as used
  await fetch(
    `${SB_URL}/rest/v1/ngcc_login_codes?email=eq.${encodeURIComponent(email)}&code=eq.${code}`,
    { method: 'PATCH', headers: sbH(), body: JSON.stringify({ used: true }) }
  );

  // Fetch subscriber profile
  const subRes = await fetch(
    `${SB_URL}/rest/v1/ngcc_subscribers?email=eq.${encodeURIComponent(email)}&limit=1`,
    { headers: sbH() }
  );
  const subs = await subRes.json();
  const sub  = Array.isArray(subs) ? subs[0] : {};

  const session = {
    email,
    business_name: sub.entity_name || sub.business_name || '',
    entity_name:   sub.entity_name || '',
    uei:           sub.uei || '',
    naics_codes:   sub.naics_codes || [],
    keywords:      sub.keywords || [],
    tier:          sub.tier || 'discovery',
    stripe_customer_id: sub.stripe_customer_id || '',
    signed_in_at:  new Date().toISOString(),
  };

  return json({ ok: true, session });
};
