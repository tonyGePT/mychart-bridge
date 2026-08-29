// Thread-safe long-message delivery for the bridge.
//
// Portal constraint (myhealthchart.com, measured live 2026-08-28 — DO NOT
// re-bisect with real sends): message bodies over 500 characters are silently
// dropped — the send endpoint answers HTTP 200 with body "" and creates
// nothing. The limit is on TOTAL body length; splitting the body across
// messageBody array elements does not bypass it.
//
// Delivery strategy: chunk the message at paragraph boundaries (well under
// the limit) and deliver as ONE conversation — part 1 via send_message, parts
// 2..n via send_reply to the same conversation id. Confirmation is read-only:
// get_message_thread must contain the final part. Never probe the live portal
// to test this; user directive 2026-08-28 after live sends spammed the care
// team.

export const MAX_BODY_CHARS = 480; // headroom under the portal's 500-char drop

export function chunkMessage(text: string, max = MAX_BODY_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\n/)) {
    if (para.length > max) {
      // A single paragraph over the limit: hard-split on whitespace.
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      let rest = para;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut < max * 0.5) cut = max;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, "");
      }
      cur = rest;
      continue;
    }
    const cand = cur ? cur + "\n\n" + para : para;
    if (cand.length <= max) {
      cur = cand;
    } else {
      chunks.push(cur);
      cur = para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

type SendResult = { success?: boolean; conversationId?: string; error?: string };

export type ThreadClient = {
  runCapability: (id: string, args: Record<string, unknown>) => Promise<unknown>;
};

function parseSend(raw: unknown): SendResult {
  if (typeof raw !== "object" || raw === null || !("success" in raw)) {
    return { success: false, error: `unexpected result: ${String(raw).slice(0, 300)}` };
  }
  const r = raw as Record<string, unknown>; // shape checked above; keyed reads only
  const out: SendResult = { success: r.success === true };
  if (typeof r.conversationId === "string") out.conversationId = r.conversationId;
  if (typeof r.error === "string") out.error = r.error;
  return out;
}

const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

export type ThreadSendResult = {
  ok: boolean;
  conversationId?: string;
  parts: number;
  confirmed?: boolean;
  error?: string;
};

export async function sendMessageInThread(
  client: ThreadClient,
  opts: { recipientName?: string; topic?: string; subject: string; message: string },
): Promise<ThreadSendResult> {
  const chunks = chunkMessage(opts.message);
  const label = chunks.length > 1 ? ` (part 1 of ${chunks.length})` : "";
  const first = parseSend(await client.runCapability("send_message", {
    ...(opts.recipientName ? { recipient_name: opts.recipientName } : {}),
    ...(opts.topic ? { topic: opts.topic } : {}),
    subject: opts.subject + label,
    message: chunks[0],
  }));
  if (!first.success) {
    return { ok: false, parts: chunks.length, error: first.error ?? "send_message failed" };
  }
  if (!first.conversationId) {
    return {
      ok: false,
      parts: chunks.length,
      error: "indeterminate: portal accepted request but returned no conversation id; message may not exist — verify in Sent before retrying",
    };
  }
  const conversationId = first.conversationId;
  for (let i = 1; i < chunks.length; i++) {
    const reply = parseSend(await client.runCapability("send_reply", {
      conversation_id: conversationId,
      message: chunks[i],
    }));
    if (!reply.success) {
      return {
        ok: false,
        conversationId,
        parts: chunks.length,
        error: `part ${i + 1}/${chunks.length} failed after part 1 was delivered: ${reply.error ?? "send_reply failed"} — thread is partially delivered; do not resend part 1`,
      };
    }
  }
  // Read-only confirmation: the thread must contain the final part's tail.
  const tail = alnum(chunks[chunks.length - 1]).slice(-60);
  let confirmed = false;
  try {
    const thread = await client.runCapability("get_message_thread", { conversation_id: conversationId });
    confirmed = alnum(JSON.stringify(thread)).includes(tail);
  } catch {
    // thread read failed — report unconfirmed rather than failed
  }
  return { ok: true, conversationId, parts: chunks.length, confirmed };
}
