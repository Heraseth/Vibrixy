export const config = {
  runtime: 'edge',
};

const RATE_LIMIT = new Map();
const FREE_LIMIT = 5;

function getIP(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000; // 24 hours
  const entry = RATE_LIMIT.get(ip);

  if (!entry || now - entry.start > windowMs) {
    RATE_LIMIT.set(ip, { count: 1, start: now });
    return false;
  }

  if (entry.count >= FREE_LIMIT) return true;

  entry.count++;
  return false;
}

export default async function handler(request) {
  // Only allow POST
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': 'https://vibrixy.com',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  };

  const ip = getIP(request);

  if (isRateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: 'Daily limit reached. Upgrade to Pro for unlimited builds.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { prompt, currentHtml } = body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Prompt is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (prompt.length > 1000) {
    return new Response(JSON.stringify({ error: 'Prompt too long (max 1000 chars)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const systemPrompt = `You are an expert frontend developer. Generate a single complete self-contained HTML file.

Requirements:
- Dark background (#08080f), accent colors #8b5cf6 (purple) and #06d6a0 (teal)
- Use system-ui font — no external font imports
- No external CDN dependencies — all JS and CSS must be inline
- Fully functional JavaScript
- Mobile responsive
- Beautiful, modern, polished design
- Today's date: ${new Date().toISOString().split('T')[0]}

Output ONLY the raw HTML starting with <!DOCTYPE html>. No markdown, no backticks, no explanation.`;

  // If currentHtml is provided, this is an edit/iteration request
  const messages = currentHtml
    ? [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Here is the current HTML:\n\n' + currentHtml },
        { role: 'assistant', content: 'I have reviewed the current HTML.' },
        { role: 'user', content: 'Now apply this change: ' + prompt.trim() },
      ]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Build: ' + prompt.trim() },
      ];

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vibrixy.com',
        'X-Title': 'Vibrixy',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3-coder-480b-a35b:free',
        messages,
        max_tokens: 8192,
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err?.error?.message || 'AI service error' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Stream the response directly back to the client
    return new Response(upstream.body, { headers });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Failed to reach AI service' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
