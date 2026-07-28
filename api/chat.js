// api/chat.js
// Runs on Vercel Serverless. Set OPENROUTER_API_KEY in Vercel Environment Variables.
//
// Uses OpenRouter (openrouter.ai) instead of Gemini/OpenAI. Why: OpenRouter's
// :free models require no credit card and are rate-limited rather than
// billing-limited, which avoids both the OpenAI "exceeded quota" error and
// the Gemini "limit: 0 for free tier" region/project error you hit.
//
// Get a key at https://openrouter.ai/keys (sign up with email or GitHub,
// no card needed), then in Vercel: Project Settings > Environment Variables
// > add OPENROUTER_API_KEY, then redeploy.
//
// Model resilience: 'openrouter/free' is OpenRouter's own auto-router - it
// picks whichever free model is currently available, so we're not pinned to
// one model name that can get retired (which is exactly what broke the
// Gemini version twice). OPENROUTER_MODEL lets you pin a specific model if
// you ever want to, without touching this file again.

const MODEL_CANDIDATES = [
  process.env.OPENROUTER_MODEL, // optional manual override
  'openrouter/free',            // OpenRouter's auto-router across current free models
  'meta-llama/llama-3.2-3b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
].filter(Boolean);

const DEFAULT_SYSTEM_INSTRUCTION =
  "You are TalentTrack AI, an elite Talent Acquisition assistant. Always structure your responses cleanly, professionally, and comprehensively, using clear numbered section headers, bold sub-topics, and bullet points -- never raw markdown artifacts like stray '#' or '---' lines on their own. Never cut off or truncate an answer midway -- complete every response fully.";

async function callOpenRouter(modelName, apiKey, system, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://talenttrack.local',
      'X-Title': 'TalentTrack ATS',
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: system ? (system + '\n\n' + DEFAULT_SYSTEM_INSTRUCTION) : DEFAULT_SYSTEM_INSTRUCTION },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 3000,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const { system, prompt } = req.body || {};
  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt" in request body.' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing OPENROUTER_API_KEY. In Vercel: Project Settings > Environment Variables > add OPENROUTER_API_KEY, then redeploy.'
    });
    return;
  }

  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const { ok, status, data } = await callOpenRouter(modelName, apiKey, system, prompt);

      if (ok) {
        const choice = data?.choices?.[0];
        const text = choice?.message?.content?.trim() || '';
        const finishReason = choice?.finish_reason;

        if (text && finishReason !== 'length') {
          res.status(200).json({ text, modelUsed: modelName });
          return;
        }
        if (text && finishReason === 'length') {
          res.status(200).json({
            text: text + '\n\n[Note: response reached the maximum length limit and may be cut short.]',
            modelUsed: modelName,
          });
          return;
        }
        lastError = 'Model "' + modelName + '" returned no text.';
        continue;
      }

      if (status === 401) {
        res.status(401).json({ error: 'OpenRouter rejected this API key (401). Double-check OPENROUTER_API_KEY in Vercel -- copy it fresh from openrouter.ai/keys.' });
        return;
      }

      if (status === 429) {
        res.status(429).json({ error: 'OpenRouter free-tier rate limit reached (per-minute or daily cap). Wait a minute and try again, or add a small OpenRouter credit top-up to raise your daily limit.' });
        return;
      }

      if (status === 404 || status === 400) {
        lastError = data?.error?.message || ('Model "' + modelName + '" unavailable (status ' + status + ').');
        continue;
      }

      res.status(status).json({ error: data?.error?.message || ('OpenRouter request failed with status ' + status) });
      return;

    } catch (err) {
      lastError = 'Network error contacting OpenRouter (' + modelName + '): ' + err.message;
    }
  }

  res.status(502).json({
    error: 'All OpenRouter model candidates failed. Last error: ' + lastError +
      ' -- check current free models at https://openrouter.ai/models?max_price=0 and set OPENROUTER_MODEL in Vercel to one of them, then redeploy.'
  });
}
