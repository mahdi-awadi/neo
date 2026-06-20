import PostalMime from "postal-mime";

export default {
  // Inbound: Cloudflare Email Routing delivers mail here.
  async email(message, env, ctx) {
    const parsed = await PostalMime.parse(message.raw);
    const payload = {
      from: message.from,
      fromName: parsed.from?.name || "",
      to: message.to,
      subject: parsed.subject || "",
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
      text: parsed.text || "",
      html: parsed.html || "",
    };
    const res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.GATEWAY_WORKER_SECRET}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`gateway POST /inbound/email failed: ${res.status}`);
    }
  },

  // Outbound: the gateway POSTs a reply here; we send it via the Email Service binding.
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (request.headers.get("authorization") !== `Bearer ${env.GATEWAY_WORKER_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const { to, from, subject, html, text } = await request.json();
    if (!to || !from || !subject || (!text && !html)) return new Response("missing fields", { status: 400 });
    try {
      const r = await env.EMAIL.send({ to, from, subject, html, text });
      return Response.json({ messageId: r?.messageId ?? "" });
    } catch (e) {
      return new Response(`send failed: ${e}`, { status: 502 });
    }
  },
};
