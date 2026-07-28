// api/chat.js
// Runs on Vercel Serverless. Set OPENROUTER_API_KEY in Vercel Environment Variables.
//
// CHANGES IN THIS VERSION (fixing: slow responses, "User Safety: safe"
// garbage output, and requests that silently failed):
//
// 1. Removed 'openrouter/free' (OpenRouter's auto-router) from the default
//    list. It picks ANY currently-free model, including ones never meant for
//    open conversation — that's almost certainly what produced literal
//    moderation-classifier text like "User Safety: safe" instead of a real
//    answer, and it also sometimes lands on large, slow models. We now pin
//    to a short list of known small, fast, general-purpose instruct models
//    instead. You can still force the auto-router by setting
//    OPENROUTER_MODEL=openrouter/free in Vercel if you ever want to.
//
// 2. Added a per-attempt timeout (12s) using AbortController. Previously, if
//    one model in the fallback chain hung, the whole request chain could run
//    long enough to hit Vercel's function timeout and fail with no useful
//    error. Now a slow model is abandoned quickly and the next one is tried.
//
// 3. Trimmed max_tokens from 8192 to 2048. Long token ceilings make models
//    generate for longer even when the real answer is much shorter, which
//    was contributing to slow responses. 2048 tokens is still roughly
//    1500 words — enough for a full JD or interview kit.
//
// 4. Strengthened the system instruction to (a) forbid ever outputting a bare
//    label like "User Safety: safe" instead of a real answer, and (b) lock
//    in recruitment context so terms like "boolean search" / "boolean
//    string" are always interpreted as sourcing search strings, never as
//    the Java programming `boolean` data type — which is what caused the
//    off-topic Java-syntax essay you got from the AI Recruiter chat.
//
// Also see: vercel.json now sets maxDuration to 30s for this function
// (Vercel's Hobby plan defaults to a 10s timeout, which multiple sequential
// model fallback attempts could easily exceed on a slow free model — this
// was likely silently killing some of your requests before any error even
// reached the browser).

const MODEL_CANDIDATES = [
  process.env.OPENROUTER_MODEL, // optional manual override, e.g. openrouter/free
  'meta-llama/llama-3.2-3b-instruct:free', // small & fast — first choice for speed
  'mistralai/mistral-7b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
].filter(Boolean);

const PER_ATTEMPT_TIMEOUT_MS = 12000;

const DEFAULT_SYSTEM_INSTRUCTION =
  "You are TalentTrack AI, an expert Talent Acquisition assistant embedded in a recruiter's ATS tool. " +
  "Every question you receive is in a recruitment/hiring context, even if phrased ambiguously — for example, " +
  "'boolean search' or 'boolean string' ALWAYS means a candidate-sourcing search query (for LinkedIn, Google, or job boards), " +
  "NEVER the Java/programming boolean data type, unless the user explicitly asks about writing code. " +
  "Structure responses cleanly and professionally using numbered section headers, bold sub-topics, and bullet points — " +
  "never output raw markdown artifacts like a lone '#' or '---' line with nothing else. " +
  "Never cut off an answer midway — always complete your response fully. " +
  "Under no circumstances should you ever reply with just a bare classification label such as 'User Safety: safe', 'unsafe', or similar — " +
  "always give a complete, direct, helpful, conversational answer to what was actually asked.";

async function callOpenRouter(modelName, apiKey, system, prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);

  try {
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
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, timedOut: false };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, data: {}, timedOut: true };
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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
      const { ok, status, data, timedOut } = await callOpenRouter(modelName, apiKey, system, prompt);

      if (timedOut) {
        lastError = 'Model "' + modelName + '" did not respond within ' + (PER_ATTEMPT_TIMEOUT_MS / 1000) + 's — trying next model.';
        continue;
      }

      if (ok) {
        const choice = data?.choices?.[0];
        let text = choice?.message?.content?.trim() || '';
        const finishReason = choice?.finish_reason;

        // Defensive guard: if a model still returns a bare safety-classifier
        // label instead of a real answer, treat it as a failure and move on
        // to the next model rather than showing this to the user.
        if (/^(user safety|safety)\s*:\s*(safe|unsafe)\.?$/i.test(text)) {
          lastError = 'Model "' + modelName + '" returned a moderation label instead of an answer — trying next model.';
          continue;
        }

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
    error: 'All OpenRouter model candidates failed or timed out. Last error: ' + lastError +
      ' -- check current free models at https://openrouter.ai/models?max_price=0 and set OPENROUTER_MODEL in Vercel to one of them, then redeploy.'
  });
}
