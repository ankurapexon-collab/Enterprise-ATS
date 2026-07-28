// api/chat.js
// 5-Provider Free AI Gateway: Gemini + Cerebras + Groq + Mistral + OpenRouter

const DEFAULT_SYSTEM_INSTRUCTION = `You are TalentTrack AI, an elite Senior Talent Acquisition Partner and HR Architect.

CRITICAL ANALYTICAL TASK DIRECTIVE FOR JOB DESCRIPTION GENERATION:
1. DEEP INPUT ANALYSIS: Carefully analyze ALL provided user inputs—especially "Core Responsibilities", "Technical Skills", "Job Title", and custom requirements.
2. TAILORED GENERATION: Do NOT generate a generic template JD. The generated Job Description MUST be uniquely built around, tailored to, and centered on the user's specific inputs.
3. EXPAND & SYNTHESIZE: Take every user-provided technical skill and core responsibility, analyze its real-world application for the role, and expand it into professional, clear, impactful, and actionable bullet points.
4. ZERO OMISSION: You are STRICTLY FORBIDDEN from ignoring, omitting, or replacing any user-supplied skill, tool, framework, or responsibility with generic defaults.

FORMATTING & RESPONSE RULES:
- Structure responses cleanly with clear bold headers, bullet points, and clean lists.
- Avoid raw markdown artifacts (like '#---' or '***').
- NEVER cut off or truncate answers midway — complete every response fully.`;

// Tier 1: Gemini Direct (10 Lakhs Tokens/Min Free)
const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash',
  'gemini-1.5-pro'
];

// Tier 2: Cerebras Inference (10 Lakhs Tokens/Day Free - Ultra Fast 2000+ tok/s)
const CEREBRAS_MODELS = [
  'llama3.1-8b',
  'llama3.3-70b'
];

// Tier 3: Groq Direct (5 Lakhs Tokens/Day Free)
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'llama-3.3-70b-versatile'
];

// Tier 4: Mistral AI (Free Experimental Tier)
const MISTRAL_MODELS = [
  'mistral-small-latest',
  'open-mistral-7b',
  'mistral-medium-latest'
];

// Tier 5: OpenRouter Free Models
const OPENROUTER_FREE_MODELS = [
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'deepseek/deepseek-r1:free',
  'mistralai/mistral-7b-instruct:free'
];

// Smart Input Aggregator
function buildComprehensivePrompt(body) {
  if (!body || typeof body !== 'object') return '';

  let basePrompt = body.prompt || body.userPrompt || body.message || '';
  let extraParts = [];

  const jobTitle = body.jobTitle || body.title || body.role;
  if (jobTitle && !basePrompt.toLowerCase().includes(String(jobTitle).toLowerCase())) {
    extraParts.push(`### TARGET JOB TITLE:\n${jobTitle}`);
  }

  const responsibilities = body.coreResponsibilities || body.responsibilities || body.duties || body.core_responsibilities;
  if (responsibilities && !basePrompt.includes(String(responsibilities))) {
    extraParts.push(`### USER-PROVIDED CORE RESPONSIBILITIES (ANALYZE & EXPAND THESE IN DETAIL):\n${responsibilities}`);
  }

  const skills = body.technicalSkills || body.skills || body.techSkills || body.requirements || body.technical_skills;
  if (skills && !basePrompt.includes(String(skills))) {
    extraParts.push(`### USER-PROVIDED TECHNICAL SKILLS (ANALYZE & INTEGRATE ALL OF THESE):\n${skills}`);
  }

  const nestedData = body.formData || body.inputs || body.data;
  if (nestedData && typeof nestedData === 'object') {
    for (const [key, value] of Object.entries(nestedData)) {
      if (value && !basePrompt.includes(String(value))) {
        extraParts.push(`### USER-PROVIDED ${key.toUpperCase()}:\n${value}`);
      }
    }
  }

  if (!basePrompt && extraParts.length === 0) {
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' && key !== 'system' && value.trim()) {
        extraParts.push(`### ${key.toUpperCase()}:\n${value}`);
      }
    }
  }

  let finalPrompt = basePrompt;
  if (extraParts.length > 0) {
    finalPrompt = basePrompt 
      ? `${basePrompt}\n\n${extraParts.join('\n\n')}` 
      : extraParts.join('\n\n');
  }

  finalPrompt += `\n\n[ANALYTICAL MANDATE: Perform a detailed analysis of the Core Responsibilities and Technical Skills provided above. Expand them professionally and generate a complete Job Description strictly centered around these analyzed inputs.]`;

  return finalPrompt;
}

// Provider 1: Gemini API
async function callGemini(modelName, apiKey, system, prompt) {
  const combinedSystem = system ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` : DEFAULT_SYSTEM_INSTRUCTION;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: combinedSystem }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    }
  );
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Universal OpenAI-compatible Caller (Cerebras, Groq, Mistral, OpenRouter)
async function callOpenAICompatible(endpoint, modelName, apiKey, system, prompt, extraHeaders = {}) {
  const combinedSystem = system ? `${system}\n\n${DEFAULT_SYSTEM_INSTRUCTION}` : DEFAULT_SYSTEM_INSTRUCTION;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: combinedSystem },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
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

  let prompt = buildComprehensivePrompt(req.body || {});
  const system = req.body?.system || '';

  if (!prompt || prompt.trim().length === 0) {
    res.status(400).json({ error: 'Missing prompt or input data in request body.' });
    return;
  }

  if (prompt.length > 35000) {
    prompt = prompt.substring(0, 35000) + "\n\n[Note: Input safety-trimmed to fit free token limits.]";
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!geminiKey && !cerebrasKey && !groqKey && !mistralKey && !openrouterKey) {
    res.status(500).json({
      error: 'Missing API Keys. Please set GEMINI_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, or OPENROUTER_API_KEY in Vercel Environment Variables.'
    });
    return;
  }

  let lastError = null;

  // 1. Provider 1: Gemini Direct
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

  // 2. Provider 2: Cerebras Inference (Ultra Fast)
  if (cerebrasKey) {
    for (const modelName of CEREBRAS_MODELS) {
      try {
        const { ok, data } = await callOpenAICompatible(
          'https://api.cerebras.ai/v1/chat/completions',
          modelName,
          cerebrasKey,
          system,
          prompt
        );
        if (ok) {
          const text = data?.choices?.[0]?.message?.content?.trim();
          if (text) {
            res.status(200).json({ text, modelUsed: `cerebras/${modelName}` });
            return;
          }
        }
        lastError = data?.error?.message || `Cerebras ${modelName} failed`;
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  // 3. Provider 3: Groq Direct
  if (groqKey) {
    for (const modelName of GROQ_MODELS) {
      try {
        const { ok, data } = await callOpenAICompatible(
          'https://api.groq.com/openai/v1/chat/completions',
          modelName,
          groqKey,
          system,
          prompt
        );
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

  // 4. Provider 4: Mistral AI
  if (mistralKey) {
    for (const modelName of MISTRAL_MODELS) {
      try {
        const { ok, data } = await callOpenAICompatible(
          'https://api.mistral.ai/v1/chat/completions',
          modelName,
          mistralKey,
          system,
          prompt
        );
        if (ok) {
          const text = data?.choices?.[0]?.message?.content?.trim();
          if (text) {
            res.status(200).json({ text, modelUsed: `mistral/${modelName}` });
            return;
          }
        }
        lastError = data?.error?.message || `Mistral ${modelName} failed`;
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  // 5. Provider 5: OpenRouter Free Models
  if (openrouterKey) {
    for (const modelName of OPENROUTER_FREE_MODELS) {
      try {
        const { ok, data } = await callOpenAICompatible(
          'https://openrouter.ai/api/v1/chat/completions',
          modelName,
          openrouterKey,
          system,
          prompt,
          { 'HTTP-Referer': 'https://vercel.com', 'X-Title': 'TalentTrack AI' }
        );
        if (ok) {
          const text = data?.choices?.[0]?.message?.content?.trim();
          if (text) {
            res.status(200).json({ text, modelUsed: `openrouter/${modelName}` });
            return;
          }
        }
        lastError = data?.error?.message || `OpenRouter ${modelName} failed`;
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  res.status(502).json({
    error: `All 5 AI providers failed or exceeded quota. Last error: ${lastError}`
  });
}
