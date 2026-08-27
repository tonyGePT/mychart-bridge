import { JSONRPCMessageSchema, isJSONRPCRequest } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

const msg = {
  jsonrpc: "2.0", method: "tools/call",
  params: { name: "run_raw_endpoint", arguments: { account: "lenna:mychartwa.providence.org", method: "POST", path: "/api/bill-pay/GetBillPayData", body: {} } },
  id: 9,
};
const parsed = JSONRPCMessageSchema.safeParse(msg);
console.log("parse ok:", parsed.success);
if (!parsed.success) console.log(parsed.error.issues.slice(0, 4));
console.log("isRequest:", isJSONRPCRequest(parsed.success ? parsed.data : msg));
