// api/chat.js
// Runs on Vercel Serverless. Smart Input Aggregator & Analytical JD Generator.

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

const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash'
];

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile'
];

// Smart Input Aggregator: Extracts form fields even if frontend sends separate JSON keys
function buildComprehensivePrompt(body) {
  if (!body || typeof body !== 'object') return '';

  let basePrompt = body.prompt || body.userPrompt || body.message || '';
  let extraParts = [];

  // Extract Job Title
  const jobTitle = body.jobTitle || body.title || body.role;
  if (jobTitle && !basePrompt.toLowerCase().includes(String(jobTitle).toLowerCase())) {
    extraParts.push(`### TARGET JOB TITLE:\n${jobTitle}`);
  }

  // Extract Core Responsibilities
  const responsibilities = body.coreResponsibilities || body.responsibilities || body.duties || body.core_responsibilities;
  if (responsibilities && !basePrompt.includes(String(responsibilities))) {
    extraParts.push(`### USER-PROVIDED CORE RESPONSIBILITIES (ANALYZE & EXPAND THESE IN DETAIL):\n${responsibilities}`);
  }

  // Extract Technical Skills
  const skills = body.technicalSkills || body.skills || body.techSkills || body.requirements || body.technical_skills;
  if (skills && !basePrompt.includes(String(skills))) {
    extraParts.push(`### USER-PROVIDED TECHNICAL SKILLS (ANALYZE & INTEGRATE ALL OF THESE):\n${skills}`);
  }

  // Handle nested objects like body.formData or body.inputs
  const nestedData = body.formData || body.inputs || body.data;
  if (nestedData && typeof nestedData === 'object') {
    for (const [key, value] of Object.entries(nestedData)) {
      if (value && !basePrompt.includes(String(value))) {
        extraParts.push(`### USER-PROVIDED ${key.toUpperCase()}:\n${value}`);
      }
    }
  }

  // Fallback: If no known keys, concatenate all string values in body
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
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
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

  // Automatically aggregate prompt from any structure sent by frontend
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
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    res.status(500).json({
      error: 'Server missing GEMINI_API_KEY or GROQ_API_KEY in Vercel Environment Variables.'
    });
    return;
  }

  let lastError = null;

  // 1. Call Gemini Models (10 Lakhs Free Tokens/Minute)
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
    error: `All AI requests failed. Last error: ${lastError}`
  });
}
