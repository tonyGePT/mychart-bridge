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
 * Delete a Gmail message by id. Used to purge consumed 2FA code emails —
 * one-time codes must not linger in the inbox. Never fatal: by the time this
 * runs the code is already extracted, so failures are logged and dropped.
 */
export async function deleteMessage(
  g: { clientId: string; clientSecret: string; refreshToken: string },
  id: string,
): Promise<boolean> {
  try {
    const tok = await accessToken(g.clientId, g.clientSecret, g.refreshToken);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      console.error("[gmail] delete failed", res.status, (await res.text()).slice(0, 150));
      return false;
    }
    console.log("[gmail] deleted 2fa email", id);
    return true;
  } catch (e) {
    console.error("[gmail] delete error", e);
    return false;
  }
}

/**
 * Best-effort cleanup: delete code emails from the 2FA sender older than
 * 10 minutes. Dead one-time codes have no value, and stale emails would
 * otherwise accumulate in the inbox forever.
 */
async function purgeStale(
  g: { clientId: string; clientSecret: string; refreshToken: string; fromFilter: string },
): Promise<void> {
  try {
    const tok = await accessToken(g.clientId, g.clientSecret, g.refreshToken);
    const cutoff = Date.now() - 10 * 60_000;
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent(`from:(${g.fromFilter})`)}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) return;
    const list = (await res.json()) as { messages?: { id: string }[] };
    for (const m of list.messages ?? []) {
      const full = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!full.ok) continue;
      const j = (await full.json()) as { internalDate?: string };
      if (Number(j.internalDate ?? 0) < cutoff) await deleteMessage(g, m.id);
    }
  } catch (e) {
    console.error("[gmail] stale purge error", e);
  }
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
  void purgeStale(g);
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
            if (m) { void deleteMessage(g, id); return m[1]; }
            // fall back to snippet-style subject scan
            const subj = (msg.payload as unknown as { headers?: { name: string; value: string }[] })?.headers
              ?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
            const sm = subj.match(/\b(\d{6})\b/);
            if (sm) { void deleteMessage(g, id); return sm[1]; }
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("gmail 2fa code not received in time");
}
