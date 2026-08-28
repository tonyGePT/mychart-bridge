// One-shot: rename owner prefixes bill:* -> dad:*, lenna:* -> mom:* across
// digest_state, billing_history, and bridge_sessions. Copy-then-delete with
// ON CONFLICT DO NOTHING so it is safe against a watcher poll racing mid-run.
import postgres from "postgres";

const sql = postgres(
  "postgresql://postgres:xztOFpepYtRxWZxgvVgVDhmRXftCBknU@reseau.proxy.rlwy.net:49458/railway",
  { max: 1 },
);

const rename = (acct: string) => acct.replace("bill:", "dad:").replace("lenna:", "mom:");

// digest_state
await sql`
  INSERT INTO digest_state (account, kind, item_id, first_seen, meta)
  SELECT replace(replace(account, 'bill:', 'dad:'), 'lenna:', 'mom:'), kind, item_id, first_seen, meta
  FROM digest_state WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'
  ON CONFLICT DO NOTHING`;
const d1 = await sql`DELETE FROM digest_state WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
console.log("digest_state migrated, old rows deleted:", d1.count);

// billing_history
await sql`
  INSERT INTO billing_history (account, guarantor, amount_due, checked_at)
  SELECT replace(replace(account, 'bill:', 'dad:'), 'lenna:', 'mom:'), guarantor, amount_due, checked_at
  FROM billing_history WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'
  ON CONFLICT DO NOTHING`;
const d2 = await sql`DELETE FROM billing_history WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
console.log("billing_history migrated, old rows deleted:", d2.count);

// bridge_sessions (dynamic columns; keyed by account = owner:hostname)
const sessRows = await sql`
  SELECT * FROM bridge_sessions WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
let migrated = 0;
if (sessRows.length) {
  const cols = Object.keys(sessRows[0]);
  for (const r of sessRows) {
    const vals = cols.map((c) => (c === "account" ? rename(String(r[c])) : r[c]));
    await sql`INSERT INTO bridge_sessions (${sql(cols)}) VALUES (${vals}) ON CONFLICT DO NOTHING`;
    migrated++;
  }
}
const d3 = await sql`DELETE FROM bridge_sessions WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
console.log(`bridge_sessions migrated: ${migrated}, old rows deleted: ${d3.count}`);

const remaining = await sql`SELECT account FROM digest_state GROUP BY account`;
console.log("digest_state accounts now:", remaining.map((r) => r.account));
await sql.end({ timeout: 2 });