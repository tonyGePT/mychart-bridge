// Tests for sendMessageInThread / chunkMessage. All against stub clients —
// never the live portal (user directive: no probe sends).
import { describe, it, expect } from "bun:test";
import { chunkMessage, sendMessageInThread, type ThreadClient } from "./sendThread";

// Simulates the measured portal behavior: bodies over 500 chars answer 200
// with an empty conversation id and create nothing; valid sends return an id.
class FakePortal implements ThreadClient {
  thread: string[] = [];
  sent = 0;
  constructor(private dropOver = 500) {}
  async runCapability(id: string, args: Record<string, unknown>): Promise<unknown> {
    if (id === "send_message") {
      const body = String(args.message);
      if (body.length > this.dropOver) return { success: true, conversationId: "" };
      this.sent++;
      this.thread.push(body);
      return { success: true, conversationId: `CONV-${this.sent}` };
    }
    if (id === "send_reply") {
      const body = String(args.message);
      if (body.length > this.dropOver) return { success: true, conversationId: "" };
      this.thread.push(body);
      return { success: true, conversationId: args.conversation_id };
    }
    if (id === "get_message_thread") {
      return { messages: this.thread.map((b) => ({ body: b })) };
    }
    throw new Error(`unexpected capability ${id}`);
  }
}

describe("chunkMessage", () => {
  it("keeps a short message whole", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("packs paragraphs under the limit", () => {
    const text = ["a".repeat(200), "b".repeat(200), "c".repeat(200)].join("\n\n");
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(480);
  });

  it("hard-splits a single paragraph over the limit on whitespace", () => {
    const para = ("word ".repeat(400)).trim(); // ~2000 chars, no \n\n
    const chunks = chunkMessage(para);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(480);
    expect(chunks.join("").replace(/\s/g, "")).toBe(para.replace(/\s/g, ""));
  });

  it("reconstructs the original text", () => {
    const text = ["x".repeat(300), "y".repeat(300), "z".repeat(100)].join("\n\n");
    expect(chunkMessage(text).join("\n\n")).toBe(text);
  });
});

describe("sendMessageInThread", () => {
  it("sends a short message as a single part", async () => {
    const portal = new FakePortal();
    const r = await sendMessageInThread(portal, {
      recipientName: "Dr. Test", topic: "Medical Question", subject: "Hi", message: "short body",
    });
    expect(r.ok).toBe(true);
    expect(r.parts).toBe(1);
    expect(r.confirmed).toBe(true);
    expect(portal.sent).toBe(1);
  });

  it("delivers a long message as one thread with replies, confirmed by read-back", async () => {
    const portal = new FakePortal();
    const message = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n\n");
    expect(message.length).toBeGreaterThan(500);
    const r = await sendMessageInThread(portal, {
      recipientName: "Dr. Test", topic: "Medical Question", subject: "Long message", message,
    });
    expect(r.ok).toBe(true);
    expect(r.parts).toBeGreaterThan(1);
    expect(r.confirmed).toBe(true);
    // thread payload must contain every chunk exactly once (same conversation)
    const blob = portal.thread.join("|");
    for (const c of chunkMessage(message)) expect(blob).toContain(c);
    expect(portal.sent).toBe(1); // exactly one send_message; rest were replies
  });

  it("reports indeterminate when the portal silently drops the body", async () => {
    // dropOver=10: portal answers 200 with "" even for small bodies
    const portal = new FakePortal(10);
    const r = await sendMessageInThread(portal, {
      recipientName: "Dr. Test", subject: "Hi", message: "short but dropped",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("indeterminate");
  });

  it("reports partial delivery when a reply chunk fails", async () => {
    const portal = new FakePortal();
    const orig = portal.runCapability.bind(portal);
    let replies = 0;
    portal.runCapability = async (id, args) => {
      if (id === "send_reply" && ++replies === 2) {
        return { success: false, error: "boom" };
      }
      return orig(id, args);
    };
    const message = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n\n");
    const r = await sendMessageInThread(portal, { subject: "S", message });
    expect(r.ok).toBe(false);
    expect(r.conversationId).toBeDefined();
    expect(r.error).toContain("partially delivered");
    expect(r.error).toContain("do not resend part 1");
  });
});
