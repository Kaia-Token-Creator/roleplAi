// functions/api/video.ts
// Cloudflare Pages Functions

type QueueBody = {
  action: "queue";
  duration?: "5s" | "10s";
  imageDataUrl: string;
  prompt?: string;
};

type RetrieveBody = {
  action: "retrieve";
  model: string;
  queue_id: string;
};

function cors(origin?: string) {
  // same-origin이면 사실 없어도 되지만, preflight/환경차로 405 나는 거 방지용
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function pickDuration(v: any): "5s" | "10s" {
  return v === "10s" ? "10s" : "5s";
}

function isDataUrl(s: any): s is string {
  return typeof s === "string" && s.startsWith("data:");
}

// ✅ OPTIONS preflight 대응 (없으면 405 뜨는 경우 많음)
export const onRequestOptions: PagesFunction = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;
  return new Response(null, { status: 204, headers: cors(origin) });
};

export const onRequestPost: PagesFunction = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;

  let body: any;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors(origin) });
  }

  const apiKey = (ctx.env as any)?.VENICE_API_KEY;
  if (!apiKey) {
    return json({ error: "Missing VENICE_API_KEY" }, { status: 500, headers: cors(origin) });
  }

  const baseURL = "https://api.venice.ai/api/v1";
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // ---------------------------
    // action: queue
    // ---------------------------
    if (body.action === "queue") {
      const b = body as QueueBody;
      const duration = pickDuration(b.duration);

      if (!isDataUrl(b.imageDataUrl)) {
        return json({ error: "imageDataUrl must be a data: URL" }, { status: 400, headers: cors(origin) });
      }

      // Venice image-to-video 모델 (docs 예시)
      const model = "wan-2.5-preview-image-to-video";

      const userPrompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
      const prompt =
        userPrompt.length > 0
          ? userPrompt.slice(0, 2500)
          : "Animate this image into a short cinematic video. Smooth camera motion, natural movement.";

      const payload = {
        model,
        prompt,
        duration,                 // "5s" | "10s"
        image_url: b.imageDataUrl, // data URL OK
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
        negative_prompt: "low resolution, error, worst quality, low quality, defects",
      };

      const r = await fetch(`${baseURL}/video/queue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({} as any));
if (!r.ok) {
  // Venice는 보통 { code, message } 형태로 에러를 줌
  const errMsg =
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.detail === "string" && data.detail) ||
    "Queue failed";

  return json(
    {
      error: errMsg,
      code: data?.code || null,
      status: r.status,
      venice: data, // 원본 그대로 내려주기
    },
    { status: r.status, headers: cors(origin) }
  );
}


      // expected: { model, queue_id }
      return json({ model: data.model, queue_id: data.queue_id }, { status: 200, headers: cors(origin) });
    }

    // ---------------------------
    // action: retrieve
    // ---------------------------
    if (body.action === "retrieve") {
      const b = body as RetrieveBody;

      if (!b.model || typeof b.model !== "string") {
        return json({ error: "Missing model" }, { status: 400, headers: cors(origin) });
      }
      if (!b.queue_id || typeof b.queue_id !== "string") {
        return json({ error: "Missing queue_id" }, { status: 400, headers: cors(origin) });
      }

      const payload = {
        model: b.model,
        queue_id: b.queue_id,
        delete_media_on_completion: true,
      };

      const r = await fetch(`${baseURL}/video/retrieve`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const ct = (r.headers.get("content-type") || "").toLowerCase();

      // JSON이면 그대로 전달 (PROCESSING 등)
      if (ct.includes("application/json")) {
        const data = await r.json().catch(() => ({} as any));
if (!r.ok) {
  // Venice는 보통 { code, message } 형태로 에러를 줌
  const errMsg =
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.detail === "string" && data.detail) ||
    "Queue failed";

  return json(
    {
      error: errMsg,
      code: data?.code || null,
      status: r.status,
      venice: data, // 원본 그대로 내려주기
    },
    { status: r.status, headers: cors(origin) }
  );
}

        return json(data, { status: 200, headers: cors(origin) });
      }

      // 완료되면 바이너리(mp4 등)일 수 있음 → base64로 감싸서 프론트에 전달
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return json({ error: "Retrieve failed (non-json)", detail: txt }, { status: r.status, headers: cors(origin) });
      }

      const ab = await r.arrayBuffer();
      const mime = ct && ct.includes("/") ? ct : "video/mp4";

      // Cloudflare 환경에선 Buffer가 없을 수 있어 직접 b64 변환
      const bytes = new Uint8Array(ab);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);

      return json(
        { status: "COMPLETED", video: { mime, b64 } },
        { status: 200, headers: cors(origin) }
      );
    }

    return json({ error: "Unknown action. Use 'queue' or 'retrieve'." }, { status: 400, headers: cors(origin) });
  } catch (e: any) {
    return json({ error: "Server error", detail: String(e?.message || e) }, { status: 500, headers: cors(origin) });
  }
};

