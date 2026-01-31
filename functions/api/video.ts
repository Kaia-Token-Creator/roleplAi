// functions/api/video.ts
export interface Env {
  VENICE_API_KEY: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 필요하면 CORS 열기 (동일 도메인이면 없어도 됨)
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isDataUrlImage(s: unknown): s is string {
  if (typeof s !== "string") return false;
  // data:image/png;base64,....
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s.trim());
}

export const onRequestOptions = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;

    if (!env.VENICE_API_KEY) {
      return json({ error: "Missing VENICE_API_KEY in environment secrets." }, 500);
    }

    // ✅ 프론트가 JSON으로 보내므로 json()으로 받기
    const body = await request.json().catch(() => null);

    const image = body?.image;           // data URL string
    const durationRaw = body?.duration;  // 5 | 10 (number or string)
    const promptRaw = body?.prompt;      // optional
    const qualityRaw = body?.quality;    // optional: "480p" | "720p" | "1080p"

    if (!isDataUrlImage(image)) {
      return json(
        {
          error: "Image required as data URL (e.g. data:image/png;base64,...)",
          receivedType: typeof image,
        },
        400
      );
    }

    const prompt =
      typeof promptRaw === "string" && promptRaw.trim()
        ? promptRaw.trim()
        : "Animate this image into a short cinematic clip.";

    const durNum = typeof durationRaw === "number"
      ? String(durationRaw)
      : typeof durationRaw === "string"
        ? durationRaw.trim()
        : "5";

    // Venice 문서 기준: duration은 5s, 10s만
    const dur = durNum === "5" ? "5s" : durNum === "10" ? "10s" : null;
    if (!dur) {
      return json(
        {
          error: "Unsupported duration. Supported: 5, 10",
          supported: [5, 10],
          received: durationRaw,
        },
        400
      );
    }

    const quality =
      typeof qualityRaw === "string" && qualityRaw ? qualityRaw : "480p";

    const resolution =
      quality === "480p" || quality === "720p" || quality === "1080p"
        ? quality
        : "480p";

    const model = "grok-imagine-image-to-video";

    // 1) Queue
    const queueRes = await fetch("https://api.venice.ai/api/v1/video/queue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        duration: dur,
        image_url: image, // ✅ data URL 그대로 전달
        aspect_ratio: "16:9",
        resolution,
        audio: false,
      }),
    });

    const queueText = await queueRes.text();
    if (!queueRes.ok) {
      return json(
        {
          error: "Venice queue failed",
          status: queueRes.status,
          details: queueText,
        },
        502
      );
    }

    let queueJson: any;
    try {
      queueJson = JSON.parse(queueText);
    } catch {
      queueJson = null;
    }

    const queueId = queueJson?.queue_id;
    if (!queueId) {
      return json(
        { error: "Venice queue response missing queue_id", details: queueText },
        502
      );
    }

    // 2) Poll retrieve
    const maxWaitMs = 180_000; // 3분
    const pollEveryMs = 2_000;

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const r = await fetch("https://api.venice.ai/api/v1/video/retrieve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.VENICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          queue_id: queueId,
          delete_media_on_completion: true,
        }),
      });

      const ct = r.headers.get("content-type") || "";

      // 처리중이면 JSON status
      if (ct.includes("application/json")) {
        const j = await r.json().catch(() => null);
        const status = j?.status;

        if (status === "PROCESSING") {
          await sleep(pollEveryMs);
          continue;
        }

        return json(
          {
            error: "Venice retrieve returned JSON but not PROCESSING",
            details: j,
          },
          502
        );
      }

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return json(
          { error: "Venice retrieve failed", status: r.status, details: t },
          502
        );
      }

      // 완료면 video binary
      const videoBuf = await r.arrayBuffer();
      const videoB64 = arrayBufferToBase64(videoBuf);

      const videoMime = ct.startsWith("video/") ? ct.split(";")[0] : "video/mp4";
      const videoDataUrl = `data:${videoMime};base64,${videoB64}`;

      return json({ videoUrl: videoDataUrl }, 200);
    }

    return json({ error: "Timeout waiting for video generation." }, 504);
  } catch (e: any) {
    return json(
      { error: "Unhandled server error", details: String(e?.message || e) },
      500
    );
  }
};
