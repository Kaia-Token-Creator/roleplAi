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

function guessMimeFromFile(file: File): string {
  if (file.type && file.type.includes("/")) return file.type;
  // fallback
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // btoa는 큰 데이터에서 터질 수 있어서 chunking
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

    const fd = await request.formData();

    const image = fd.get("image");
    const promptRaw = fd.get("prompt");
    const durationRaw = fd.get("duration"); // "5" | "10" | ...
    const qualityRaw = fd.get("quality");   // "480p" 등 (프론트에서 고정)

    if (!(image instanceof File)) {
      return json({ error: "Image required (form field: image)." }, 400);
    }

    const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
    const quality = typeof qualityRaw === "string" && qualityRaw ? qualityRaw : "480p";

    // Venice 문서 기준: duration은 5s, 10s만 지원 :contentReference[oaicite:2]{index=2}
    const durNum = typeof durationRaw === "string" ? durationRaw.trim() : "5";
    const dur = durNum === "5" ? "5s" : durNum === "10" ? "10s" : null;
    if (!dur) {
      return json({
        error: "Unsupported duration for Venice video API right now. Supported: 5, 10",
        supported: [5, 10],
        received: durationRaw,
      }, 400);
    }

    // resolution은 480p 가능 :contentReference[oaicite:3]{index=3}
    const resolution = (quality === "480p" || quality === "720p" || quality === "1080p")
      ? quality
      : "480p";

    // image -> data URL 변환
    const mime = guessMimeFromFile(image);
    const ab = await image.arrayBuffer();
    const b64 = arrayBufferToBase64(ab);
    const imageDataUrl = `data:${mime};base64,${b64}`;

    const model = "grok-imagine-image-to-video";

    // 1) Queue
    const queueRes = await fetch("https://api.venice.ai/api/v1/video/queue", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: prompt || "Animate this image into a short cinematic clip.",
        duration: dur,
        image_url: imageDataUrl,
        // 원하는 경우 고정값
        aspect_ratio: "16:9",
        resolution,
        audio: false,
        // negative_prompt: "low resolution, error, worst quality, low quality, defects",
      }),
    });

    const queueText = await queueRes.text();
    if (!queueRes.ok) {
      return json({
        error: "Venice queue failed",
        status: queueRes.status,
        details: queueText,
      }, 502);
    }

    let queueJson: any;
    try { queueJson = JSON.parse(queueText); } catch { queueJson = null; }
    const queueId = queueJson?.queue_id;
    if (!queueId) {
      return json({ error: "Venice queue response missing queue_id", details: queueText }, 502);
    }

    // 2) Poll retrieve
    // 문서: 완료면 비디오 파일을 반환, 처리중이면 JSON status 반환 :contentReference[oaicite:4]{index=4}
    const maxWaitMs = 180_000; // 3분
    const pollEveryMs = 2_000;

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const r = await fetch("https://api.venice.ai/api/v1/video/retrieve", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.VENICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          queue_id: queueId,
          delete_media_on_completion: true,
        }),
      });

      const ct = r.headers.get("content-type") || "";

      // 처리중이면 JSON으로 status가 옴
      if (ct.includes("application/json")) {
        const j = await r.json().catch(() => null);

        const status = j?.status;
        if (status === "PROCESSING") {
          await sleep(pollEveryMs);
          continue;
        }

        // 다른 상태면 에러로 취급
        return json({
          error: "Venice retrieve returned JSON but not PROCESSING",
          details: j,
        }, 502);
      }

      // 완료면 비디오 파일(바이너리)이 온다고 문서에 적혀있음 :contentReference[oaicite:5]{index=5}
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return json({ error: "Venice retrieve failed", status: r.status, details: t }, 502);
      }

      const videoBuf = await r.arrayBuffer();
      const videoB64 = arrayBufferToBase64(videoBuf);

      // mime은 보통 mp4. 응답 헤더가 video/*면 그걸 사용
      const videoMime = ct.startsWith("video/") ? ct.split(";")[0] : "video/mp4";
      const videoDataUrl = `data:${videoMime};base64,${videoB64}`;

      return json({ videoUrl: videoDataUrl }, 200);
    }

    return json({ error: "Timeout waiting for video generation." }, 504);
  } catch (e: any) {
    return json({ error: "Unhandled server error", details: String(e?.message || e) }, 500);
  }
};
