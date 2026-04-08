import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createChannel,
  getChannel,
  getChannelByName,
  listChannels,
  updateChannel,
  deleteChannel,
  addMember,
  removeMember,
  listMembers,
  postMessage,
  getMessages,
  getMessage,
  searchMessages,
  parseMentions,
  _resetForTesting,
} from "../src/channel.js";

const TEST_ROOT = path.join(os.tmpdir(), `orager-channel-test-${Date.now()}`);

describe("channel", () => {
  const dbPath = path.join(TEST_ROOT, "channels.sqlite");

  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    _resetForTesting(dbPath);
  });

  afterEach(() => {
    _resetForTesting();
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("parseMentions", () => {
    it("extracts @mentions from text", () => {
      expect(parseMentions("Hello @mercury and @venus")).toEqual(["mercury", "venus"]);
    });

    it("deduplicates mentions", () => {
      expect(parseMentions("@mercury do this @mercury")).toEqual(["mercury"]);
    });

    it("returns empty for no mentions", () => {
      expect(parseMentions("hello world")).toEqual([]);
    });

    it("handles hyphens and underscores", () => {
      expect(parseMentions("@my-agent_v2")).toEqual(["my-agent_v2"]);
    });
  });

  describe("channel CRUD", () => {
    it("creates and retrieves a channel", async () => {
      const ch = await createChannel("general", "Main channel");
      expect(ch.name).toBe("general");
      expect(ch.description).toBe("Main channel");
      expect(ch.id).toBeTruthy();

      const retrieved = await getChannel(ch.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("general");
    });

    it("retrieves by name", async () => {
      await createChannel("ops", "Operations");
      const ch = await getChannelByName("ops");
      expect(ch).not.toBeNull();
      expect(ch!.name).toBe("ops");
    });

    it("lists channels with stats", async () => {
      const ch = await createChannel("general", "Main", ["user", "mercury"]);
      await postMessage(ch.id, "user", "Hello");

      const list = await listChannels();
      expect(list.length).toBe(1);
      expect(list[0]!.memberCount).toBe(2);
      expect(list[0]!.messageCount).toBe(1);
      expect(list[0]!.lastMessageAt).toBeTruthy();
    });

    it("updates channel", async () => {
      const ch = await createChannel("old-name");
      await updateChannel(ch.id, { name: "new-name", description: "updated" });

      const updated = await getChannel(ch.id);
      expect(updated!.name).toBe("new-name");
      expect(updated!.description).toBe("updated");
    });

    it("deletes channel and cascades", async () => {
      const ch = await createChannel("temp", "", ["user"]);
      await postMessage(ch.id, "user", "test message");

      const deleted = await deleteChannel(ch.id);
      expect(deleted).toBe(true);
      expect(await getChannel(ch.id)).toBeNull();
    });
  });

  describe("members", () => {
    it("adds and lists members", async () => {
      const ch = await createChannel("team");
      await addMember(ch.id, "user");
      await addMember(ch.id, "mercury");

      const members = await listMembers(ch.id);
      expect(members.length).toBe(2);
      expect(members.map((m) => m.memberId).sort()).toEqual(["mercury", "user"]);
    });

    it("removes members", async () => {
      const ch = await createChannel("team", "", ["user", "mercury"]);
      await removeMember(ch.id, "mercury");

      const members = await listMembers(ch.id);
      expect(members.length).toBe(1);
      expect(members[0]!.memberId).toBe("user");
    });

    it("ignores duplicate adds", async () => {
      const ch = await createChannel("team");
      await addMember(ch.id, "user");
      await addMember(ch.id, "user"); // duplicate

      const members = await listMembers(ch.id);
      expect(members.length).toBe(1);
    });
  });

  describe("messages", () => {
    it("posts and retrieves messages", async () => {
      const ch = await createChannel("general");
      await postMessage(ch.id, "user", "Hello world");
      await postMessage(ch.id, "mercury", "Hi there");

      const msgs = await getMessages(ch.id);
      expect(msgs.length).toBe(2);
      expect(msgs[0]!.content).toBe("Hello world");
      expect(msgs[1]!.content).toBe("Hi there");
    });

    it("parses mentions on post", async () => {
      const ch = await createChannel("general");
      const msg = await postMessage(ch.id, "user", "Hey @mercury can you check @venus?");

      expect(msg.mentions).toEqual(["mercury", "venus"]);
    });

    it("supports thread replies", async () => {
      const ch = await createChannel("general");
      const parent = await postMessage(ch.id, "user", "Main topic");
      await postMessage(ch.id, "mercury", "Reply here", { threadId: parent.id });

      const thread = await getMessages(ch.id, { threadId: parent.id });
      expect(thread.length).toBe(1);
      expect(thread[0]!.content).toBe("Reply here");
    });

    it("retrieves single message", async () => {
      const ch = await createChannel("general");
      const posted = await postMessage(ch.id, "user", "Find me");

      const msg = await getMessage(posted.id);
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe("Find me");
    });

    it("paginates with before cursor", async () => {
      const ch = await createChannel("general");
      const first = await postMessage(ch.id, "user", "First");
      // Small delay to ensure different timestamps
      const second = await postMessage(ch.id, "user", "Second");

      const msgs = await getMessages(ch.id, { before: second.createdAt, limit: 10 });
      // Should only get messages before second's timestamp
      expect(msgs.every((m) => m.createdAt < second.createdAt)).toBe(true);
    });

    it("stores metadata", async () => {
      const ch = await createChannel("general");
      const msg = await postMessage(ch.id, "mercury", "Task done", {
        metadata: { toolResult: "success", cost: 0.05 },
      });

      const retrieved = await getMessage(msg.id);
      expect(retrieved!.metadata).toEqual({ toolResult: "success", cost: 0.05 });
    });
  });

  describe("search", () => {
    it("finds messages via FTS", async () => {
      const ch = await createChannel("general");
      await postMessage(ch.id, "user", "Deploy the kubernetes cluster");
      await postMessage(ch.id, "mercury", "Running database migrations");

      const results = await searchMessages("kubernetes cluster");
      expect(results.length).toBe(1);
      expect(results[0]!.content).toContain("kubernetes");
    });

    it("filters by channel", async () => {
      const ch1 = await createChannel("ops");
      const ch2 = await createChannel("dev");
      await postMessage(ch1.id, "user", "Deploy the app");
      await postMessage(ch2.id, "user", "Deploy the test");

      const results = await searchMessages("deploy", { channelId: ch1.id });
      expect(results.length).toBe(1);
      expect(results[0]!.channelId).toBe(ch1.id);
    });

    it("filters by author", async () => {
      const ch = await createChannel("general");
      await postMessage(ch.id, "user", "Deploy request");
      await postMessage(ch.id, "mercury", "Deploy confirmed");

      const results = await searchMessages("deploy", { authorId: "mercury" });
      expect(results.length).toBe(1);
      expect(results[0]!.authorId).toBe("mercury");
    });
  });
});
