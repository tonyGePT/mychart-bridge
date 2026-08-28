// Instance + env configuration for the bridge.
// INSTANCES_JSON: array of { owner, hostname, username, password, passkey?, totpSecret? }
// GMAIL_* credentials enable fully-automatic email 2FA (Providence).

export interface InstanceConfig {
  owner: string;           // "dad" | "mom"
  hostname: string;
  username: string;
  password: string;
  passkey?: {
    credentialId: string;
    privateKey: string;
    rpId: string;
    userHandle: string;
    signCount: number;
  };
  totpSecret?: string;
  gmail?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    fromFilter: string;    // e.g. "donotreplymychart@providence.org"
  };
}

export function loadInstances(): InstanceConfig[] {
  const raw = process.env.INSTANCES_JSON;
  if (!raw) throw new Error("INSTANCES_JSON env var is required");
  const arr = JSON.parse(raw) as InstanceConfig[];
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("INSTANCES_JSON must be a non-empty array");
  // Attach gmail creds from global env when per-instance absent
  const gcId = process.env.GMAIL_CLIENT_ID;
  const gcSec = process.env.GMAIL_CLIENT_SECRET;
  const grt = process.env.GMAIL_REFRESH_TOKEN;
  const gfilter = process.env.GMAIL_FROM_FILTER;
  if (gcId && gcSec && grt) {
    for (const inst of arr) {
      if (!inst.passkey && !inst.totpSecret && !inst.gmail) {
        inst.gmail = { clientId: gcId, clientSecret: gcSec, refreshToken: grt, fromFilter: gfilter || "" };
      }
    }
  }
  return arr;
}

export function accountKey(inst: InstanceConfig): string {
  return `${inst.owner}:${inst.hostname}`;
}

export function bridgeApiKey(): string {
  const k = process.env.BRIDGE_API_KEY;
  if (!k) throw new Error("BRIDGE_API_KEY env var is required");
  return k;
}

export function databaseUrl(): string {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL env var is required");
  return u;
}
