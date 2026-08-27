// Gmail API access via a long-lived refresh token. Used to pull Providence
// 2FA codes automatically (healthcare short codes reject VoIP numbers, so
// email is the only autonomous second factor on that portal).

interface TokenCache { accessToken: string; expiresAt: number }
const cache = new Map<string, TokenCache>();

async function accessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const hit = cache.get(refreshToken);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`gmail token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(refreshToken, { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

function extractBody(payload: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  if (payload.mimeType?.startsWith("text/") && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts as Parameters<typeof extractBody>[0][]) {
      const t = extractBody(p);
      if (t) return t;
    }
  }
  return "";
}

/**
 * Wait for a fresh 6-digit code from the given sender, sent after `sinceMs`.
 * Polls Gmail every 3s for up to timeoutMs.
 */
export async function fetchTwoFaCode(
  g: { clientId: string; clientSecret: string; refreshToken: string; fromFilter: string },
  sinceMs: number,
  timeoutMs = 90_000,
): Promise<string> {
  const tok = await accessToken(g.clientId, g.clientSecret, g.refreshToken);
  const headers = { Authorization: `Bearer ${tok}` };
  const after = new Date(sinceMs - 60_000).toISOString().slice(0, 10).replace(/-/g, "/");
  const q = `from:(${g.fromFilter}) after:${after}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`,
      { headers },
    );
    if (listRes.ok) {
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      if (list.messages?.length) {
        const id = list.messages[0].id;
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers });
        if (msgRes.ok) {
          const msg = (await msgRes.json()) as {
            internalDate?: string;
            payload?: Parameters<typeof extractBody>[0];
          };
          const sentAt = Number(msg.internalDate ?? 0);
          if (sentAt >= sinceMs - 60_000) {
            const body = extractBody(msg.payload ?? {});
            const m = body.match(/\b(\d{6})\b/);
            if (m) return m[1];
            // fall back to snippet-style subject scan
            const subj = (msg.payload as unknown as { headers?: { name: string; value: string }[] })?.headers
              ?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
            const sm = subj.match(/\b(\d{6})\b/);
            if (sm) return sm[1];
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("gmail 2fa code not received in time");
}
