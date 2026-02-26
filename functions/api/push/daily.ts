export const onRequestPost: PagesFunction<{
  ONESIGNAL_APP_ID: string;
  ONESIGNAL_REST_API_KEY: string;
}> = async ({ request, env }) => {
  // (선택) 외부에서 아무나 호출 못 하게 간단 토큰 보호
const auth = request.headers.get("authorization") || "";
const gotToken = auth.toLowerCase().startsWith("bearer ")
  ? auth.slice(7).trim()
  : "";

const expectedToken = String(env.CRON_TOKEN || "").trim();

if (!gotToken || gotToken !== expectedToken) {
  return new Response("Unauthorized", { status: 401 });
}

  const payload = {
    app_id: env.ONESIGNAL_APP_ID,
    included_segments: ["Subscribed Users"],
    target_channel: "push",
    headings: { en: "Roleplay-chat" },
    contents: { en: "Your characters are wating for you 💬" },
    url: "https://roleplay-chat.com/",
  };

  const res = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });

};

