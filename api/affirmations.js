// ============================================================================
//  /api/affirmations.js   — Vercel Serverless Function
// ----------------------------------------------------------------------------
//  This runs ON THE SERVER. Your ANTHROPIC_API_KEY lives here as an environment
//  variable and is NEVER sent to the browser. The app calls this endpoint;
//  this endpoint calls Claude.
//
//  SETUP (one time):
//   1. Put this file at:  /api/affirmations.js  in your project
//   2. In Vercel dashboard → your project → Settings → Environment Variables,
//      add:   ANTHROPIC_API_KEY = sk-ant-...   (your real key)
//   3. Deploy. Your app can now POST to /api/affirmations
//
//  COST CONTROL: uses Claude Haiku 4.5 (fast + cheap). A tiny in-memory cache
//  means identical thoughts in the same warm instance don't re-call the API.
// ============================================================================

const MODEL = 'claude-haiku-4-5';

// very small in-memory cache (resets when the function goes cold; that's fine —
// it just trims cost during bursts of traffic from a viral video)
const cache = new Map();
const CACHE_MAX = 500;

export default async function handler(req, res) {
  // ---- CORS so your app (on a different domain) can call this ----
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain in production
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { thought } = req.body || {};

    // ---- guardrails ----
    if (!thought || typeof thought !== 'string') {
      return res.status(400).json({ error: 'Missing thought' });
    }
    const clean = thought.trim().slice(0, 120); // cap length to control tokens & abuse
    if (clean.length < 2) {
      return res.status(400).json({ error: 'Too short' });
    }

    // ---- cache hit ----
    const key = clean.toLowerCase();
    if (cache.has(key)) {
      return res.status(200).json({ affirmations: cache.get(key), cached: true });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // never leak details; app will fall back to its built-in pools
      return res.status(500).json({ error: 'Server not configured' });
    }

    // ---- the prompt: tuned to YOUR voice and the ladder structure ----
    const system =
`You write short, powerful affirmations that answer a person's negative thought.
VOICE: grounded, a little warrior-like and divine, never cheesy or clinical. Think "a god would never kneel," "I have faced tougher things," "smile, this adversity is chiseling the statue." Calm strength, not hype.
RULES:
- Return EXACTLY 6 affirmations.
- Each is a first-person "I" statement, under 9 words, no period needed.
- They should directly answer THIS person's specific thought, escalating from a gentle counter to quiet power, ending near pure being (e.g. "I am").
- No emojis, no quotes, no numbering, no preamble.
- If the thought signals self-hatred, be gentler and warmer first.
- Output ONLY a JSON array of 6 strings. Nothing else.`;

    const userMsg = `The person released this heavy thought: "${clean}". Write their 6 affirmations.`;

    const anthRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!anthRes.ok) {
      return res.status(502).json({ error: 'Upstream error' });
    }

    const data = await anthRes.json();
    const text = (data.content || [])
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    // ---- parse the JSON array Claude returns; be forgiving ----
    let affirmations;
    try {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      affirmations = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      // if parsing fails, split lines as a fallback
      affirmations = text.split('\n').map(s => s.replace(/^[-•\d."]\s*/, '').replace(/"$/, '').trim()).filter(Boolean);
    }

    affirmations = (affirmations || [])
      .filter(s => typeof s === 'string' && s.length > 0)
      .slice(0, 6);

    if (affirmations.length < 3) {
      return res.status(502).json({ error: 'Bad generation' });
    }

    // ---- cache it ----
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, affirmations);

    return res.status(200).json({ affirmations, cached: false });

  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
}
