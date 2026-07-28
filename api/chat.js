// api/chat.js
// High-Quota Free Tier Serverless Function (Supports Lakhs of Tokens)

const DEFAULT_SYSTEM_INSTRUCTION = 
  "You are TalentTrack AI, an elite Talent Acquisition assistant. Always structure your responses cleanly, professionally, and comprehensively. Avoid raw markdown artifacts (like '#---' or '***'). Use clear numbered headers, bold sub-topics, bullet points, and clean lists. NEVER cut off or truncate answers midway — complete every response fully.";

// 10 Lakhs TPM Free Tier Models (Google AI Studio)
const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash'
];

// High-TPD Free Models (Groq - 5 Lakhs Tokens/Day)
const GROQ_MODELS = [
  'llama-3.1-8b-instant',      // 500,000 Tokens/Day (5 Lakhs TPD)
  'llama-3.3-70b-versatile'    // Fallback model
];

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

async function callGroq(modelName, apiKey, system, prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: system ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` : DEFAULT_SYSTEM_INSTRUCTION },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 4096
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

  let { system, prompt } = req.body || {};
  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt" in request body.' });
    return;
  }

  // Safety prompt check: Prevent single prompt inputs > 35,000 chars from blowing up token limits
  if (prompt.length > 35000) {
    prompt = prompt.substring(0, 35000) + "\n\n[Note: Prompt safety-trimmed to remain within free token quotas.]";
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    res.status(500).json({
      error: 'Missing GEMINI_API_KEY or GROQ_API_KEY in Vercel Environment Variables.'
    });
    return;
  }

  let lastError = null;

  // 1. Try Gemini Models (Provides 10 Lakhs TPM Free)
  if (geminiKey) {
    for (const modelName of GEMINI_MODELS) {
      try {
        const { ok, status, data } = await callGemini(modelName, geminiKey, system, prompt);
        if (ok) {
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) {
            res.status(200).json({ text, modelUsed: modelName });
            return;
          }
        }
        lastError = data?.error?.message || `Gemini ${modelName} returned status ${status}`;
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  // 2. Try Groq Models (Provides 5 Lakhs TPD Free)
  if (groqKey) {
    for (const modelName of GROQ_MODELS) {
      try {
        const { ok, data } = await callGroq(modelName, groqKey, system, prompt);
        if (ok) {
          const text = data?.choices?.[0]?.message?.content?.trim();
          if (text) {
            res.status(200).json({ text, modelUsed: `groq/${modelName}` });
            return;
          }
        }
        lastError = data?.error?.message || `Groq ${modelName} failed`;
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  res.status(502).json({
    error: `All AI models failed or exceeded quota. Last error: ${lastError}`
  });
}
