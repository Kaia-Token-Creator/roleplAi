// functions/api/video.ts
export interface Env {
  VENICE_API_KEY: string;
}

function withCors(headers: HeadersInit = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCors({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

function isDataUrlImage(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s.trim());
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export const onRequestOptions = async () => {
  return new Response(null, { status: 204, headers: withCors() });
};

type VeniceQueueResponse = { queue_id?: string } & Record<string, any>;
type VeniceRetrieveJson = { status?: string; video_url?: string; media_url?: string } & Record<string, any>;

function isProcessingStatus(s: unknown) {
  const v = String(s || "").toUpperCase();
  return (
    v === "PROCESSING" ||
    v === "QUEUED" ||
    v === "PENDING" ||
    v === "STARTING" ||
    v === "RUNNING" ||
    v === "IN_PROGRESS"
  );
}

function isTerminalErrorStatus(s: unknown) {
  const v = String(s || "").toUpperCase();
  return v === "FAILED" || v === "ERROR" || v === "CANCELED" || v === "CANCELLED";
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;

    if (!env.VENICE_API_KEY) {
      return json({ error: "Missing VENICE_API_KEY in environment secrets." }, 500);
    }

    const body = await request.json().catch(() => null);

    // ✅ 이 엔드포인트는 2가지 모드 지원:
    // (A) { image, duration, prompt, quality } -> queue 만들고 완료까지 시도
    // (B) { queue_id } -> 해당 queue_id로 retrieve만 시도 (프론트 폴링용)
    const queueIdFromClient = body?.queue_id;

    // ⚠️ 모델명은 계정/문서에 따라 다를 수 있음.
    // 실제로는 /api/v1/models?type=video 에서 가능한 모델을 확인하는 게 가장 확실.
    const model = "grok-imagine-image-to-video";

    const resolution =
      body?.quality === "480p" || body?.quality === "720p" || body?.quality === "1080p"
        ? body.quality
        : "480p";

    // -----------------------------
    // (B) Poll-only mode
    // -----------------------------
    if (typeof queueIdFromClient === "string" && queueIdFromClient.trim()) {
      const queueId = queueIdFromClient.trim();
      return await retrieveUntilDone({
        env,
        model,
        queueId,
        maxWaitMs: 25_000,
        pollEveryMs: 2_000,
      });
    }

    // -----------------------------
    // (A) Queue + try wait
    // -----------------------------
    const image = body?.image; // data URL string
    const durationRaw = body?.duration; // 5 | 10
    const promptRaw = body?.prompt;

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

    const durNum =
      typeof durationRaw === "number"
        ? String(durationRaw)
        : typeof durationRaw === "string"
          ? durationRaw.trim()
          : "5";

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
        image_url: image,
        aspect_ratio: "16:9",
        resolution,
        audio: false,
      }),
    });

    const queueText = await queueRes.text().catch(() => "");
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

    let queueJson: VeniceQueueResponse | null = null;
    try {
      queueJson = JSON.parse(queueText);
    } catch {
      queueJson = null;
    }

    const queueId = queueJson?.queue_id;
    if (!queueId) {
      return json({ error: "Venice queue response missing queue_id", details: queueText }, 502);
    }

    // 2) Try retrieve while keeping the request (짧게만)
    return await retrieveUntilDone({
      env,
      model,
      queueId,
      maxWaitMs: 25_000,
      pollEveryMs: 2_000,
    });
  } catch (e: any) {
    return json({ error: "Unhandled server error", details: String(e?.message || e) }, 500);
  }
};

async function retrieveUntilDone(opts: {
  env: Env;
  model: string;
  queueId: string;
  maxWaitMs: number;
  pollEveryMs: number;
}) {
  const { env, model, queueId, maxWaitMs, pollEveryMs } = opts;

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

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json(
        { error: "Venice retrieve failed", status: r.status, details: t, queue_id: queueId },
        502
      );
    }

    const ct = (r.headers.get("content-type") || "").toLowerCase();

    // 1) JSON이면 상태 응답일 가능성
    if (ct.includes("application/json")) {
      const j = (await r.json().catch(() => null)) as VeniceRetrieveJson | null;
      const status = j?.status;

      if (isProcessingStatus(status)) {
        await sleep(pollEveryMs);
        continue;
      }

      const maybeUrl = j?.video_url || j?.media_url;
      if (typeof maybeUrl === "string" && maybeUrl.startsWith("http")) {
        // ✅ URL을 주는 타입이면 그대로 반환 (프론트가 URL 재생 가능)
        return json({ videoUrl: maybeUrl, queue_id: queueId, status: status || "DONE" }, 200);
      }

      if (isTerminalErrorStatus(status)) {
        return json({ error: "Venice reported terminal failure", queue_id: queueId, details: j }, 502);
      }

      return json(
        { error: "Venice retrieve returned unexpected JSON", queue_id: queueId, details: j },
        502
      );
    }

    // 2) JSON이 아니면: ✅ 여기서부터가 '교체'된 부분
    //    기존 base64 변환/데이터URL 반환은 502(응답크기/메모리) 원인이 되기 쉬움
    //    -> 비디오 바이너리를 그대로 스트리밍으로 프론트에 전달
    const videoMime = ct.startsWith("video/") ? ct.split(";")[0] : "video/mp4";

    return new Response(r.body, {
      status: 200,
      headers: withCors({
        "Content-Type": videoMime || "video/mp4",
        "Cache-Control": "no-store",
      }),
    });
  }

  // 아직이면 202로 queue_id 반환 (프론트 폴링 유도)
  return json(
    { status: "PROCESSING", queue_id: queueId, message: "Still generating. Poll with {queue_id}." },
    202
  );
}
