// api/chat.js
// Runs on Vercel Serverless. Enhanced with Strict User-Input Fidelity for JD Generator.

const DEFAULT_SYSTEM_INSTRUCTION = `You are TalentTrack AI, an elite Talent Acquisition assistant.

CRITICAL INSTRUCTION FOR ALL GENERATIONS (Job Descriptions, Resumes, Interview Questions):
1. STRICT USER-INPUT FIDELITY: You MUST explicitly incorporate, prioritize, and weave ALL user-provided details—especially "Core Responsibilities", "Technical Skills", "Key Requirements", and custom notes—directly into your output.
2. DO NOT OVERWRITE: NEVER replace, omit, or overwrite user-specified skills, tools, frameworks, or responsibilities with generic template defaults.
3. EXPLICIT INTEGRATION: If the user provides specific technical skills (e.g., Python, AWS, React, Docker) or specific core responsibilities, create prominent dedicated bullet points and sections incorporating EVERY SINGLE specified skill and responsibility.

FORMATTING & RESPONSE RULES:
- Structure responses cleanly, professionally, and comprehensively.
- Avoid raw markdown artifacts (like '#---' or '***'). Use clean bold headers, bullet points, and clean lists.
- NEVER cut off or truncate answers midway — complete every response fully.`;

const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash'
];

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile'
];

async function callGemini(modelName, apiKey, system, prompt) {
  const combinedSystem = system 
    ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` 
    : DEFAULT_SYSTEM_INSTRUCTION;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { 
          parts: [{ text: combinedSystem }] 
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    }
  );
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function callGroq(modelName, apiKey, system, prompt) {
  const combinedSystem = system 
    ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` 
    : DEFAULT_SYSTEM_INSTRUCTION;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: combinedSystem },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
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

  // Force-highlight input fields if JD generator prompt contains responsibilities or technical skills
  const lowerPrompt = prompt.toLowerCase();
  if (lowerPrompt.includes('core responsibilities') || lowerPrompt.includes('technical skills') || lowerPrompt.includes('responsibilities')) {
    prompt = `${prompt}\n\n[SYSTEM DIRECTIVE: Ensure EVERY Core Responsibility and Technical Skill specified above is explicitly included as dedicated bullet points in the generated Job Description.]`;
  }

  if (prompt.length > 35000) {
    prompt = prompt.substring(0, 35000) + "\n\n[Note: Prompt safety-trimmed to fit free token limits.]";
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

  // 1. Try Gemini Models (10 Lakhs Free Tokens/Minute)
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

  // 2. Fallback to Groq Models
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
