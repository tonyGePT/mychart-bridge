// digest.ts — proactive family digest watcher. Polls every configured portal
// account on an interval, diffs against Postgres-seen state, and posts new
// items to a Discord webhook. Read-only by construction: it only reports —
// real writes (messages, bookings, refills, payments) stay behind explicit
// human approval in OMP/ChatGPT.

import postgres from "postgres";
import { createHash } from "node:crypto";
import { loadInstances, accountKey, databaseUrl } from "./config";
import { getClient } from "./manager";

const sql = postgres(databaseUrl(), { max: 2, idle_timeout: 20 });

export interface DigestNote {
  account: string;
  kind: "message" | "visit_upcoming" | "visit_gone" | "visit_past" | "lab" | "imaging" | "bill" | "bill_escalation" | "bill_cleared" | "error" | "info";
  title: string;
  desc: string;
  color: number;
}

const COLORS = {
  message: 0x5865f2,      // blurple
  visit_upcoming: 0x57f287,
  visit_gone: 0xe67e22,
  visit_past: 0xfee75c,
  lab: 0x2ecc71,
  imaging: 0x2ecc71,
  bill: 0xe67e22,
  bill_escalation: 0xed4245,
  bill_cleared: 0x2ecc71,
  error: 0x95a5a6,
  info: 0x0b7285,
};

// ---------- small utils ----------
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function hashId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 20);
}

function shortHost(hostname: string): string {
  return hostname
    .replace(/^mychartwa\./, "").replace(/^mychart\./, "").replace(/^www\./, "")
    .replace(/\.providence\.org$/, "|providence").replace(/\.uwmedicine\.org$/, "|uw")
    .replace(/\.com$/, "").split("|")[0] === "providence" ? "providence"
    : hostname.includes("providence") ? "providence"
    : hostname.includes("uwmedicine") ? "uw"
    : hostname.includes("myhealthchart") ? "myhealthchart"
    : hostname;
}

function label(acct: string): string {
  const [owner, host] = acct.split(":");
  return `${owner} · ${shortHost(host ?? "")}`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- schema & seen-state ----------
export async function ensureDigestSchema(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS digest_state (
    account text NOT NULL,
    kind text NOT NULL,
    item_id text NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (account, kind, item_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS billing_history (
    account text NOT NULL,
    guarantor text NOT NULL,
    amount_due numeric NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account, guarantor, checked_at)
  )`;
}

type SeenRow = { item_id: string; first_seen: Date; meta: any };

async function seenMap(acct: string, kind: string): Promise<Map<string, SeenRow>> {
  const rows = await sql`
    SELECT item_id, first_seen, meta FROM digest_state
    WHERE account = ${acct} AND kind = ${kind}`;
  return new Map(rows.map((r: any) => [r.item_id as string, r as SeenRow]));
}

async function markSeen(acct: string, kind: string, id: string, meta: any = {}): Promise<void> {
  await sql`
    INSERT INTO digest_state (account, kind, item_id, meta)
    VALUES (${acct}, ${kind}, ${id}, ${sql.json(meta ?? {})})
    ON CONFLICT (account, kind, item_id) DO NOTHING`;
}

async function dropSeen(acct: string, kind: string, id: string): Promise<void> {
  await sql`DELETE FROM digest_state WHERE account = ${acct} AND kind = ${kind} AND item_id = ${id}`;
}

// ---------- LLM summaries (OpenRouter, falls back to raw excerpt) ----------
async function llm(prompt: string, system: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "z-ai/glm-5.3-flash",
        max_tokens: 400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const txt = j?.choices?.[0]?.message?.content;
    return typeof txt === "string" && txt.trim() ? txt.trim() : null;
  } catch {
    return null;
  }
}

// ---------- Discord delivery ----------
async function postNotes(notes: DigestNote[]): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || notes.length === 0) return;
  for (const batch of chunk(notes, 10)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Discord's edge 403s non-browser UAs on webhook posts.
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: JSON.stringify({
          username: "MyChart Digest",
          embeds: batch.map((n) => ({
            title: n.title.slice(0, 256),
            description: n.desc.slice(0, 3900) || undefined,
            color: n.color,
            footer: { text: label(n.account) },
            timestamp: new Date().toISOString(),
          })),
        }),
      });
      if (!res.ok) console.error("[digest] discord post failed", res.status, (await res.text()).slice(0, 200));
    } catch (e) {
      console.error("[digest] discord post error", e);
    }
    await sleep(1200);
  }
}

// ---------- per-feed pollers ----------
interface PollCtx { client: any; acct: string; seed: boolean; snapshot: string[]; notes: DigestNote[]; pastCsns: Set<string> }

async function pollMessages(ctx: PollCtx): Promise<void> {
  const msgs = await ctx.client.runCapability("get_messages", {});
  const convs: any[] = msgs?.conversations ?? [];
  const seen = await seenMap(ctx.acct, "message");
  let unreadTotal = 0;
  for (const c of convs) {
    const id = c.hthId ?? hashId(c.subject, c.previewText?.slice(0, 80) ?? "");
    const unread = c?.tags?.Unread === true || (c?.messages ?? []).some((m: any) => m?.isUnread);
    if (unread) unreadTotal++;
    if (!seen.has(id)) {
      const date = c?.messages?.[0]?.deliveryInstantISO ?? "";
      const author = (c?.audience ?? []).map((a: any) => a?.DisplayName ?? a?.name).filter(Boolean).join(", ") || "clinic";
      const body = stripHtml(String(c?.messages?.[0]?.body ?? c?.previewText ?? "")).slice(0, 1800);
      if (unread && !ctx.seed) {
        const summ = (await llm(
          `From: ${author}\nDate: ${date ?? "?"}\nSubject: ${c.subject ?? ""}\n\n${body}`,
          "You condense patient-portal messages for a family health digest. 1-3 short sentences: who wrote, what they want or inform, any action needed and any deadline. Plain text, no preamble.",
        )) ?? stripHtml(String(c?.previewText ?? body)).slice(0, 400);
        ctx.notes.push({
          account: ctx.acct, kind: "message", color: COLORS.message,
          title: `New message — ${c.subject ?? "(no subject)"}`,
          desc: `✉️ ${author} · ${date || "?"}\n\n${summ}`,
        });
      }
      await markSeen(ctx.acct, "message", id, { subject: c.subject, unread, date });
    }
  }
  if (ctx.seed) ctx.snapshot.push(`✉️ ${unreadTotal} unread`);
}

async function pollUpcoming(ctx: PollCtx): Promise<void> {
  const up = await ctx.client.runCapability("get_upcoming_visits", {});
  const pool: any[] = [
    ...(up?.NextNDaysVisits ?? []),
    ...(up?.LaterVisitsList ?? []),
    ...(up?.InProgressVisits ?? []),
  ];
  const seen = await seenMap(ctx.acct, "visit_upcoming");
  const currentIds = new Set<string>();
  let nextLine = "";
  for (const v of pool) {
    const id = v.CsnForECheckIn ?? v.Csn ?? hashId(String(v.PrimaryDate), String(v.VisitDescription ?? v.Description ?? ""));
    currentIds.add(id);
    if (!nextLine) nextLine = `${v.PrimaryDate ?? "?"} ${v.VisitDescription ?? v.Description ?? ""}`.trim();
    if (!seen.has(id) && !ctx.seed) {
      ctx.notes.push({
        account: ctx.acct, kind: "visit_upcoming", color: COLORS.visit_upcoming,
        title: "New upcoming appointment",
        desc: `📅 ${v.PrimaryDate ?? "?"}\n${v.VisitDescription ?? v.Description ?? v.VisitType ?? ""}`.trim(),
      });
    }
    if (!seen.has(id)) await markSeen(ctx.acct, "visit_upcoming", id, { date: v.PrimaryDate });
  }
  // Previously-seen upcoming visits that vanished: cancellation/reschedule,
  // unless the CSN simply graduated into the past-visits feed.
  for (const [id, row] of seen) {
    if (currentIds.has(id)) continue;
    await dropSeen(ctx.acct, "visit_upcoming", id);
    if (ctx.seed) continue;
    if (!ctx.pastCsns.has(id)) {
      ctx.notes.push({
        account: ctx.acct, kind: "visit_gone", color: COLORS.visit_gone,
        title: "Appointment left the schedule",
        desc: `${row.meta?.date ?? ""} — no longer in upcoming visits (cancelled, rescheduled, or completed).`,
      });
    }
  }
  if (ctx.seed && nextLine) ctx.snapshot.push(`📅 next: ${nextLine}`);
}

async function pollPastVisits(ctx: PollCtx): Promise<void> {
  const past = await ctx.client.runCapability("get_past_visits", { years_back: 1 });
  const items: any[] = [];
  const list = past?.List ?? {};
  for (const ov of Object.values(list)) {
    const arr = (ov as any)?.List ?? (Array.isArray(ov) ? ov : []);
    for (const v of arr) if (v?.Csn) items.push(v);
  }
  ctx.pastCsns = new Set(items.map((v) => String(v.Csn)));
  const seen = await seenMap(ctx.acct, "visit_past");
  for (const v of items) {
    const csn = String(v.Csn);
    if (seen.has(csn)) continue;
    const date = v.PrimaryDate ?? v.Date ?? "?";
    const desc = stripHtml(String(v.VisitDescription ?? v.Description ?? v.ChiefComplaint ?? "")).slice(0, 200);
    if (!ctx.seed) {
      // New past visit: fetch the After Visit Summary and condense it.
      let avsText = "";
      try {
        const avs = await ctx.client.runCapability("get_visit_avs", { csn });
        avsText = collectHtmlStrings(avs).slice(0, 3000);
      } catch { /* AVS optional */ }
      const summ = avsText
        ? (await llm(
            `Visit date: ${date}\nVisit: ${desc}\n\nAfter-visit summary:\n${avsText}`,
            "You condense after-visit summaries for a family health digest. 2-4 short sentences: what the visit was, key findings, new medications or orders, follow-ups or next steps. Plain text, no preamble.",
          )) ?? avsText.slice(0, 500)
        : `Visit completed ${date}${desc ? `: ${desc}` : ""} (no AVS available).`;
      ctx.notes.push({
        account: ctx.acct, kind: "visit_past", color: COLORS.visit_past,
        title: "Visit completed — summary",
        desc: `📅 ${date}${desc ? `\n${desc}` : ""}\n\n${summ}`,
      });
    }
    await markSeen(ctx.acct, "visit_past", csn, { date });
  }
}

async function pollResults(ctx: PollCtx): Promise<void> {
  for (const kind of ["lab", "imaging"] as const) {
    const cap = kind === "lab" ? "get_lab_results" : "get_imaging_results";
    let orders: any[] = [];
    try {
      const res = await ctx.client.runCapability(cap, { limit: 8 });
      orders = Array.isArray(res) ? res : (res?.results ?? []);
    } catch { continue; }
    const kindName = kind === "lab" ? "lab" : "imaging";
    const seen = await seenMap(ctx.acct, kindName);
    for (const o of orders) {
      const id = String(o?.key ?? "");
      if (!id || seen.has(id)) continue;
      const abnormal = extractAbnormal(o);
      if (!ctx.seed) {
        const when = o.resultDate ?? o.ResultDate ?? "";
        const lines = abnormal.length
          ? abnormal.slice(0, 12).map((c) =>
              `⚠ ${c.name}: ${c.value}${c.units ? " " + c.units : ""}${c.range ? ` (ref ${c.range})` : ""} [${c.flag}]`)
          : ["All components within reference ranges."];
        ctx.notes.push({
          account: ctx.acct,
          kind: kindName as any,
          color: abnormal.length ? 0xed4245 : COLORS[kindName as "lab" | "imaging"],
          title: `New ${kind} result — ${o.orderName ?? o.OrderName ?? "result"}`,
          desc: `${when ? `🗓 ${when}\n` : ""}${lines.join("\n")}`,
        });
      }
      await markSeen(ctx.acct, kindName, id, { name: o.orderName });
    }
  }
}

async function pollBilling(ctx: PollCtx): Promise<void> {
  const bills = await ctx.client.runCapability("get_billing", {});
  const items = Array.isArray(bills) ? bills : [bills];
  const seen = await seenMap(ctx.acct, "bill");
  for (const g of items) {
    const guarantor = String(g?.guarantorNumber ?? "?");
    const due = Number(g?.amountDue ?? 0);
    await sql`
      INSERT INTO billing_history (account, guarantor, amount_due)
      VALUES (${ctx.acct}, ${guarantor}, ${due})
      ON CONFLICT DO NOTHING`.catch(() => {});
    const row = seen.get(guarantor);
    const prevDue = Number(row?.meta?.amount ?? 0);
    if (due <= 0) {
      if (row && Number(row.meta?.amount ?? 0) > 0 && !ctx.seed) {
        ctx.notes.push({
          account: ctx.acct, kind: "bill_cleared", color: COLORS.bill_cleared,
          title: "Bill cleared",
          desc: `Guarantor ${guarantor} balance is now $0.00.`,
        });
      }
      if (row) await dropSeen(ctx.acct, "bill", guarantor);
      continue;
    }
    if (!row) {
      if (!ctx.seed) {
        ctx.notes.push({
          account: ctx.acct, kind: "bill", color: COLORS.bill,
          title: "New outstanding bill",
          desc: `Guarantor ${guarantor} owes $${due.toFixed(2)}.`,
        });
      }
      await markSeen(ctx.acct, "bill", guarantor, { amount: due, firstSeen: new Date().toISOString() });
      continue;
    }
    const firstSeen = row.meta?.firstSeen ? new Date(row.meta.firstSeen) : (row.first_seen ?? new Date());
    const daysOutstanding = (Date.now() - firstSeen.getTime()) / 86_400_000;
    const lastEscalated = row.meta?.lastEscalated ? new Date(row.meta.lastEscalated).getTime() : 0;
    if (Math.abs(Number(row.meta?.amount ?? 0) - due) > 0.005) {
      if (!ctx.seed) {
        ctx.notes.push({
          account: ctx.acct, kind: "bill", color: COLORS.bill,
          title: "Bill amount changed",
          desc: `Guarantor ${guarantor}: $${Number(row.meta?.amount ?? 0).toFixed(2)} → $${due.toFixed(2)}.`,
        });
      }
      await dropSeen(ctx.acct, "bill", guarantor);
      await markSeen(ctx.acct, "bill", guarantor, { amount: due, firstSeen: firstSeen.toISOString() });
    } else if (daysOutstanding > 7 && Date.now() - lastEscalated > 72 * 3600_000) {
      if (!ctx.seed) {
        ctx.notes.push({
          account: ctx.acct, kind: "bill_escalation", color: COLORS.bill_escalation,
          title: "Bill outstanding 7+ days",
          desc: `Guarantor ${guarantor} has owed $${due.toFixed(2)} for ${Math.floor(daysOutstanding)} days. If payments were made, they may not have posted — worth a portal billing check.`,
        });
      }
      await dropSeen(ctx.acct, "bill", guarantor);
      await markSeen(ctx.acct, "bill", guarantor, { amount: due, firstSeen: firstSeen.toISOString(), lastEscalated: new Date().toISOString() });
    }
  }
  if (ctx.seed) {
    const dueItems = items.filter((g) => Number(g?.amountDue ?? 0) > 0);
    if (dueItems.length) {
      ctx.snapshot.push(`💳 due: ${dueItems.map((g) => `$${Number(g.amountDue).toFixed(2)} (guar ${g.guarantorNumber})`).join(", ")}`);
    }
  }
}

// ---------- extraction helpers ----------
function collectHtmlStrings(node: any, depth = 0): string {
  if (depth > 8 || node == null) return "";
  if (typeof node === "string") return /<\w+[\s>]/.test(node) ? stripHtml(node) + " " : "";
  if (Array.isArray(node)) return node.map((n) => collectHtmlStrings(n, depth + 1)).join("");
  if (typeof node === "object") {
    let out = "";
    for (const [k, v] of Object.entries(node)) {
      if (/html|content|summary|text/i.test(k) && typeof v === "string") out += /<\w+[\s>]/.test(v) ? stripHtml(v) + " " : v + " ";
      else if (typeof v === "object" && v !== null) out += collectHtmlStrings(v, depth + 1);
    }
    return out;
  }
  return "";
}

const NORMAL_FLAGS = new Set(["", "n", "normal", "none", "false"]);
function extractAbnormal(order: any, depth = 0, out: { name: string; value: any; units: string; range: string; flag: string }[] = [], guard = new Set<any>()) {
  const node = order;
  if (!node || typeof node !== "object" || depth > 10 || guard.has(node)) return out;
  guard.add(node);
  const flag = (node as any).Flag ?? (node as any).flag ?? (node as any).AbnormalFlag ?? (node as any).abnormalFlag;
  const name = (node as any).Name ?? (node as any).name ?? (node as any).ComponentName;
  const value = (node as any).Value ?? (node as any).value ?? (node as any).ResultValue;
  const units = String((node as any).Units ?? (node as any).units ?? "");
  const range = String((node as any).ReferenceRange ?? (node as any).referenceRange ?? (node as any).Range ?? "");
  if (flag !== undefined && flag !== null && !NORMAL_FLAGS.has(String(flag).toLowerCase()) && name && value !== undefined && value !== null && value !== "") {
    out.push({ name: String(name), value, units, range, flag: String(flag) });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") extractAbnormal(v, depth + 1, out, guard);
  }
  return out;
}

// ---------- orchestration ----------
const lastErrorNotify = new Map<string, number>();

let inFlight: Promise<{ notes: DigestNote[]; errors: string[]; snapshot?: string[] }> | null = null;

/** Single-flight: a poll already running satisfies every concurrent caller
 * (interval tick + run_digest_now + boot race), so posts never duplicate. */
export function pollAllOnce(post = true): Promise<{ notes: DigestNote[]; errors: string[]; snapshot?: string[] }> {
  if (!inFlight) inFlight = doPollAllOnce(post).finally(() => { inFlight = null; });
  return inFlight;
}

async function doPollAllOnce(post = true): Promise<{ notes: DigestNote[]; errors: string[]; snapshot?: string[] }> {
  await ensureDigestSchema();
  const notes: DigestNote[] = [];
  const errors: string[] = [];
  let seededAny = false;
  const snapshot: string[] = [];

  for (const inst of loadInstances()) {
    const acct = accountKey(inst);
    try {
      const client = await getClient(inst);
      // A kind is in "seed" mode the first time we see any state for it.
      const msgSeen = await seenMap(acct, "message");
      const seed = msgSeen.size === 0;
      if (seed) seededAny = true;
      const acctSnap: string[] = [];
      const ctx: PollCtx = { client, acct, seed, snapshot: acctSnap, notes, pastCsns: new Set() };
      await pollPastVisits(ctx).catch((e) => errors.push(`${acct} past: ${errStr(e)}`));
      await pollMessages(ctx).catch((e) => errors.push(`${acct} messages: ${errStr(e)}`));
      await pollUpcoming(ctx).catch((e) => errors.push(`${acct} upcoming: ${errStr(e)}`));
      await pollResults(ctx).catch((e) => errors.push(`${acct} results: ${errStr(e)}`));
      await pollBilling(ctx).catch((e) => errors.push(`${acct} billing: ${errStr(e)}`));
      if (seed && acctSnap.length) snapshot.push(`— ${label(acct)} —`, ...acctSnap);
    } catch (e) {
      const msg = `${acct}: ${errStr(e)}`;
      errors.push(msg);
      const last = lastErrorNotify.get(acct) ?? 0;
      if (Date.now() - last > 12 * 3600_000) {
        lastErrorNotify.set(acct, Date.now());
        notes.push({
          account: acct, kind: "error", color: COLORS.error,
          title: "Account poll failed",
          desc: msg.slice(0, 500),
        });
      }
    }
  }

  if (seededAny && snapshot.length) {
    notes.unshift({
      account: "all", kind: "info", color: COLORS.info,
      title: "👀 MyChart watcher online — current snapshot",
      desc: snapshot.join("\n").slice(0, 3800),
    });
  }
  if (post && notes.length) await postNotes(notes);
  return { notes, errors, snapshot: seededAny ? snapshot : undefined };
}

function errStr(e: unknown): string {
  return String((e as any)?.message ?? e).slice(0, 200);
}

export function startWatcher(): void {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.log("[digest] DISCORD_WEBHOOK_URL not set — watcher disabled");
    return;
  }
  const mins = Math.max(5, Number(process.env.WATCH_INTERVAL_MIN ?? 20) || 20);
  console.log(`[digest] watcher enabled, interval ${mins}m`);
  setTimeout(() => {
    pollAllOnce(true)
      .then((r) => console.log(`[digest] initial poll: ${r.notes.length} notes, ${r.errors.length} errors`))
      .catch((e) => console.error("[digest] initial poll failed", e));
  }, 15_000);
  setInterval(() => {
    pollAllOnce(true)
      .then((r) => { if (r.notes.length || r.errors.length) console.log(`[digest] poll: ${r.notes.length} notes, ${r.errors.length} errors`); })
      .catch((e) => console.error("[digest] poll failed", e));
  }, mins * 60_000);
}