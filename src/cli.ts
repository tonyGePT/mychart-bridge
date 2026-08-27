// CLI: one-shot capability runs against any configured account.
// Usage: bun src/cli.ts <account> <capability-id> ['{"json":"args"}']
//        bun src/cli.ts list

import { loadInstances, accountKey } from "./config";
import { ensureSchema, getClient, checkStatus } from "./manager";
import { MyChartClient } from "../../openrecord/npm-package/src/client";

const instances = loadInstances();
const byOwner = new Map<string, (typeof instances)[number]>();
for (const inst of instances) byOwner.set(inst.owner, inst);

await ensureSchema();

const [account, capability, argsRaw] = process.argv.slice(2);

if (!account || account === "list") {
  const statuses = await Promise.all(instances.map((i) => checkStatus(i)));
  console.log(JSON.stringify(statuses, null, 1));
  process.exit(0);
}

const inst = byOwner.get(account) ?? instances.find((i) => accountKey(i) === account);
if (!inst) {
  console.error(`unknown account ${account}; known: ${[...byOwner.keys()].join(", ")}`);
  process.exit(1);
}

if (!capability) {
  console.error("usage: bun src/cli.ts <account> <capability-id> ['{args json}']");
  console.error("capabilities: get_profile, get_health_summary, get_medications, get_lab_results, get_messages, send_message, send_reply, request_refill, ... (see shared/capabilities.ts)");
  process.exit(1);
}

const client = await getClient(inst);
const args = argsRaw ? JSON.parse(argsRaw) : {};
const result = await client.runCapability(capability, args);
console.log(JSON.stringify(result, null, 1).slice(0, 200_000));
process.exit(0);
