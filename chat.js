// api/chat.js
// Runs on Vercel Serverless. Set GEMINI_API_KEY in Vercel Environment Variables.

const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-flash-latest'
].filter(Boolean);

async function callGemini(modelName, apiKey, system, prompt, includeThinkingConfig) {
  const defaultSystemInstruction = 
    "You are TalentTrack AI, an elite Talent Acquisition assistant. Always structure your responses cleanly, professionally, and comprehensively. Avoid raw markdown artifacts (like '#---' or '***'). Use clear numbered headers, bold sub-topics, bullet points, and clean lists. NEVER cut off or truncate answers midway — complete every response fully.";

  const generationConfig = { 
    temperature: 0.5, 
    maxOutputTokens: 8192 
  };

  if (includeThinkingConfig) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { 
          parts: [{ text: (system ? `${system}\n\n${defaultSystemInstruction}` : defaultSystemInstruction) }] 
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    }
  );

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function tryModel(modelName, apiKey, system, prompt) {
  let result = await callGemini(modelName, apiKey, system, prompt, true);
  if (!result.ok && result.status === 400 && /thinking/i.test(result.data?.error?.message || '')) {
    result = await callGemini(modelName, apiKey, system, prompt, false);
  }
  return result;
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server missing GEMINI_API_KEY in Vercel Environment Variables.'
    });
    return;
  }

  let lastError = null;
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const { ok, status, data } = await tryModel(modelName, apiKey, system, prompt);

      if (ok) {
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text?.trim() || '';
        const finishReason = candidate?.finishReason;

        if (text && finishReason !== 'MAX_TOKENS') {
          res.status(200).json({ text, modelUsed: modelName });
          return;
        }

        if (text && finishReason === 'MAX_TOKENS') {
          res.status(200).json({
            text: text + '\n\n[Note: Response reached maximum token limit.]',
            modelUsed: modelName
          });
          return;
        }

        lastError = `Model "${modelName}" returned no text (finish reason: ${finishReason || 'unknown'}).`;
        continue;
      }

      if (status === 404 || status === 400) {
        lastError = data?.error?.message || `Model "${modelName}" unavailable (status ${status}).`;
        continue;
      }

      res.status(status).json({ error: data?.error?.message || `Gemini request failed with status ${status}` });
      return;

    } catch (err) {
      lastError = `Network error contacting Gemini (${modelName}): ${err.message}`;
    }
  }

  res.status(502).json({
    error: `All Gemini model requests failed. Last error: ${lastError}`
  });
}