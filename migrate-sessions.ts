// One-shot fixup: bridge_sessions owner rename (bill:* -> dad:*, lenna:* -> mom:*).
// digest_state and billing_history were already migrated by migrate-owners.ts.
import postgres from "postgres";

const sql = postgres(
  "postgresql://postgres:xztOFpepYtRxWZxgvVgVDhmRXftCBknU@reseau.proxy.rlwy.net:49458/railway",
  { max: 1 },
);

const rename = (acct: string) => acct.replace("bill:", "dad:").replace("lenna:", "mom:");

const rows = await sql`
  SELECT account, serialized, passkey FROM bridge_sessions
  WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
console.log("old-key sessions to migrate:", rows.length);
for (const r of rows) {
  await sql`
    INSERT INTO bridge_sessions (account, serialized, passkey, updated_at)
    VALUES (${rename(r.account)}, ${r.serialized}, ${r.passkey ?? null}, now())
    ON CONFLICT (account) DO NOTHING`;
}
const d = await sql`DELETE FROM bridge_sessions WHERE account LIKE 'bill:%' OR account LIKE 'lenna:%'`;
console.log("old rows deleted:", d.count);

const remaining = await sql`SELECT account FROM bridge_sessions GROUP BY account`;
console.log("sessions now:", remaining.map((r) => r.account));
await sql.end({ timeout: 2 });