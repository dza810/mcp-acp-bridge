import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../SessionStore.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe("set / get / has", () => {
    it("stores and retrieves a session", () => {
      store.set("s1", "acp-uuid-1");
      const entry = store.get("s1");
      expect(entry?.acpSessionId).toBe("acp-uuid-1");
    });

    it("has() returns true after set", () => {
      store.set("s1", "acp-uuid-1");
      expect(store.has("s1")).toBe(true);
    });

    it("has() returns false for unknown id", () => {
      expect(store.has("unknown")).toBe(false);
    });

    it("get() returns undefined for unknown id", () => {
      expect(store.get("unknown")).toBeUndefined();
    });

    it("createdAt is set on insertion", () => {
      const before = new Date();
      store.set("s1", "acp-uuid-1");
      const after = new Date();
      const entry = store.get("s1")!;
      expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(entry.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("overwrite replaces acpSessionId and resets createdAt", () => {
      store.set("s1", "acp-uuid-1");
      store.set("s1", "acp-uuid-2");
      expect(store.get("s1")?.acpSessionId).toBe("acp-uuid-2");
    });
  });

  describe("delete", () => {
    it("returns true when deleting existing session", () => {
      store.set("s1", "acp-uuid-1");
      expect(store.delete("s1")).toBe(true);
    });

    it("returns false when deleting non-existent session", () => {
      expect(store.delete("unknown")).toBe(false);
    });

    it("get() returns undefined after delete", () => {
      store.set("s1", "acp-uuid-1");
      store.delete("s1");
      expect(store.get("s1")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all sessions", () => {
      store.set("s1", "acp-1");
      store.set("s2", "acp-2");
      const list = store.list();
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["s1", "s2"]);
    });

    it("does not include deleted sessions", () => {
      store.set("s1", "acp-1");
      store.set("s2", "acp-2");
      store.delete("s1");
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0].sessionId).toBe("s2");
    });
  });
});
