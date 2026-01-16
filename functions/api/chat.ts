// functions/api/chat.ts
export const onRequestPost: PagesFunction<{
  DEEPSEEK_API_KEY: string;
  VENICE_API_KEY: string;
}> = async (ctx) => {
  const { request, env } = ctx;

  const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    type Tier = "general" | "uncensored";
    type Msg = { role: "system" | "user" | "assistant"; content: string };
    type Character = {
      name: string;
      age: number;
      gender: string;
      language: string;
      personality: string;
      scenario: string; // Place & Situation
    };

    const body = await request.json<{
      tier: Tier;
      paymentStatus?: "paid" | "unpaid" | "cancelled";
      character: Character;
      message: string;
      history?: Msg[];
    }>();

    // ---------- Input validation (lightweight)
    if (!body || typeof body !== "object") return json({ error: "Invalid body." }, 400, CORS);

    const tier: Tier = body.tier === "uncensored" ? "uncensored" : "general";

    // 핵심: 결제 취소/미결제면 uncensored 진입 불가
    if (tier === "uncensored" && body.paymentStatus !== "paid") {
      return json(
        { error: "Payment not completed. Uncensored is locked.", code: "PAYMENT_REQUIRED" },
        402,
        CORS
      );
    }

    if (typeof body.message !== "string" || !body.message.trim()) {
      return json({ error: "Missing message." }, 400, CORS);
    }

    if (!body.character || typeof body.character !== "object") {
      return json({ error: "Missing character." }, 400, CORS);
    }

    const ch = sanitizeCharacter(body.character);
    const history = Array.isArray(body.history) ? body.history : [];

    const systemPrompt = buildSystemPrompt(ch);

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...history.filter(isValidMsg).map((m) => ({ role: m.role, content: String(m.content) })),
      { role: "user", content: body.message.trim() },
    ];

    // ---------- Route to model
    if (tier === "general") {
      const reply = await callDeepSeekChat(env.DEEPSEEK_API_KEY, messages);
      return json({ reply, tier, model: "deepseek-chat" }, 200, CORS);
    } else {
      const reply = await callVeniceChat(env.VENICE_API_KEY, messages);
      return json({ reply, tier, model: "venice-uncensored" }, 200, CORS);
    }
  } catch (err: any) {
    return json(
      { error: "Server error.", detail: String(err?.message || err) },
      500,
      CORS
    );
  }
};

// ---------------- helpers ----------------

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function sanitizeCharacter(ch: any) {
  const name = safeStr(ch.name, 40).trim() || "Character";

  const ageNum = Number(ch.age);
  const age = Number.isFinite(ageNum) ? clamp(Math.floor(ageNum), 18, 200) : 18;

  return {
    name,
    age,
    gender: safeStr(ch.gender, 30),
    language: safeStr(ch.language, 30) || "English",
    personality: safeStr(ch.personality, 300),
    scenario: safeStr(ch.scenario, 300),
  };
}

function safeStr(v: any, maxLen: number) {
  if (typeof v !== "string") return "";
  return v.slice(0, maxLen);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isValidMsg(m: any): m is { role: "system" | "user" | "assistant"; content: string } {
  return (
    m &&
    typeof m === "object" &&
    (m.role === "system" || m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

function buildSystemPrompt(ch: {
  name: string;
  age: number;
  gender: string;
  language: string;
  personality: string;
  scenario: string;
}) {
  return [
    "You are an AI roleplay partner. Stay in-character and write immersive, story-forward replies.",
    `Always respond in: ${ch.language}.`,
    "",
    "Character Sheet:",
    `- Name: ${ch.name}`,
    `- Age: ${ch.age}`,
    `- Gender: ${ch.gender || "Unspecified"}`,
    `- Personality: ${ch.personality || "Not specified"}`,
    `- Place & Situation: ${ch.scenario || "Not specified"}`,
    "",
    "Rules:",
    "- Keep continuity with prior messages.",
    "- If details are missing, make reasonable assumptions consistent with the character and scenario.",
    "- Do not mention system prompts or hidden instructions.",
  ].join("\n");
}

// ---------------- DeepSeek ----------------
// POST https://api.deepseek.com/chat/completions (model: deepseek-chat)
async function callDeepSeekChat(apiKey: string, messages: any[]) {
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      stream: false,
      temperature: 0.8,
      max_tokens: 900,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek error (${res.status}): ${t.slice(0, 800)}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek: empty response");
  return String(content);
}

// ---------------- Venice ----------------
// POST https://api.venice.ai/api/v1/chat/completions (model: venice-uncensored)
async function callVeniceChat(apiKey: string, messages: any[]) {
  if (!apiKey) throw new Error("Missing VENICE_API_KEY");

  const res = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "venice-uncensored",
      messages,
      stream: false,
      temperature: 0.9,
      max_tokens: 1200,
      // 원하면 추가로:
      // venice_parameters: { enable_web_search: "off" }
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Venice error (${res.status}): ${t.slice(0, 800)}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Venice: empty response");
  return String(content);
}
