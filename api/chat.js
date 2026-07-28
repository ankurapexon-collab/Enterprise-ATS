// api/chat.js
// Runs on Vercel Serverless. Direct Google Gemini Free Tier + Automatic Fallback.

const DEFAULT_SYSTEM_INSTRUCTION = 
  "You are TalentTrack AI, an elite Talent Acquisition assistant. Always structure your responses cleanly, professionally, and comprehensively. Avoid raw markdown artifacts (like '#---' or '***'). Use clear numbered headers, bold sub-topics, bullet points, and clean lists. NEVER cut off or truncate answers midway — complete every response fully.";

// Priority list: Put models with guaranteed free tier quota (gemini-1.5-flash) first!
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash',
  'gemini-1.5-pro'
].filter(Boolean);

async function callGemini(modelName, apiKey, system, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { 
          parts: [{ text: (system ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` : DEFAULT_SYSTEM_INSTRUCTION) }] 
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 8192 },
      }),
    }
  );

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function callGroq(apiKey, system, prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` : DEFAULT_SYSTEM_INSTRUCTION },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 8000
    })
  });
  const data = await res.json();
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

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    res.status(500).json({
      error: 'Server missing GEMINI_API_KEY or GROQ_API_KEY in Vercel Environment Variables.'
    });
    return;
  }

  let lastError = null;

  // 1. Try Gemini Models with active Free Tier
  if (geminiKey) {
    const modelsToTry = [...new Set(MODEL_CANDIDATES)];

    for (const modelName of modelsToTry) {
      try {
        const { ok, status, data } = await callGemini(modelName, geminiKey, system, prompt);

        if (ok) {
          const candidate = data?.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text?.trim() || '';
          const finishReason = candidate?.finishReason;

          if (text) {
            res.status(200).json({ 
              text: finishReason === 'MAX_TOKENS' ? `${text}\n\n[Note: Response reached maximum token limit.]` : text,
              modelUsed: modelName 
            });
            return;
          }
        }

        // Catches status 429 (Quota Exceeded), 400, and 404, then tries next model!
        lastError = data?.error?.message || `Model "${modelName}" failed with status ${status}.`;

      } catch (err) {
        lastError = `Network error (${modelName}): ${err.message}`;
      }
    }
  }

  // 2. Fallback to Groq Free Tier (Llama 3.3 70B - 14,400 Requests/Day)
  if (groqKey) {
    try {
      const { ok, data } = await callGroq(groqKey, system, prompt);
      if (ok) {
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) {
          res.status(200).json({ text, modelUsed: 'groq/llama-3.3-70b' });
          return;
        }
      } else {
        lastError = data?.error?.message || 'Groq request failed.';
      }
    } catch (err) {
      lastError = `Groq error: ${err.message}`;
    }
  }

  res.status(502).json({
    error: `All AI requests failed. Last error: ${lastError}`
  });
}
