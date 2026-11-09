import { test } from "node:test";
import assert from "node:assert/strict";
import { BugDetailsReader } from "../src/adapters/bug-details.ts";

const task = {
  id: "bug-fixture",
  number: 1,
  name: "虚构缺陷",
  project: { id: "project", name: "项目" },
  issueType: { id: "bug-type", name: "缺陷" },
  status: { id: "pending", name: "待处理" },
};
const info = {
  uuid: task.id,
  summary: task.name,
  project_uuid: "project",
  issue_type_uuid: "bug-type",
  status_uuid: "pending",
  desc: "完整正文",
  desc_rich: "<p>完整正文</p>",
  server_update_stamp: 100,
};
const message = (uuid: string, time: number, type = "discussion") => ({
  uuid,
  send_time: time,
  type,
  ref_id: type === "system" ? "project" : task.id,
  ref_type: type === "system" ? "project" : "task",
  from_name: "虚构评论者",
  text: "评论全文",
  rich_text: "<p>评论全文</p>",
});

test("TC-PLUGIN-008-read: detail body, comments and attachments use only scoped read endpoints", async () => {
  const paths: string[] = [];
  const client = new BugDetailsReader("/team/fixture", async (path) => {
    paths.push(path);
    return path.endsWith("/info")
      ? info
      : path.includes("/messages")
        ? { messages: [message("comment", 100), message("event", 90, "system")], has_next: false }
        : {
            attachments: [
              {
                uuid: "image",
                ref_id: task.id,
                ref_type: "task",
                name: "截图.png",
                mime: "image/png",
                size: 123,
                create_time: 90,
              },
            ],
            has_next: false,
          };
  });
  const result = await client.content(task);
  assert.deepEqual(result.content, [{ kind: "text", text: "完整正文" }]);
  assert.equal((await client.comments(task.id)).items[0].author, "虚构评论者");
  assert.equal((await client.attachments(task.id)).items[0].name, "截图.png");
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.startsWith("/team/fixture/task/bug-fixture/")));
});

test("TC-PLUGIN-008-read: timestamp pagination is inclusive and lack of progress fails closed", async () => {
  const paths: string[] = [];
  let payload = { messages: [message("one", 100), message("two", 90)], has_next: true };
  const client = new BugDetailsReader("/team/fixture", async (path) => {
    paths.push(path);
    return payload;
  });
  assert.equal((await client.comments(task.id)).nextMax, 90);
  payload = { messages: [message("two", 90), message("three", 80)], has_next: true };
  assert.equal((await client.comments(task.id, 90)).nextMax, 80);
  assert.ok(paths[1].endsWith("&max=90"));
  await assert.rejects(() => client.comments(task.id, 80), /范围|推进/);
  payload = { messages: [message("same", 80)], has_next: true };
  await assert.rejects(() => client.comments(task.id, 80), /未推进/);
});

test("TC-PLUGIN-008-read: mismatched identities, unknown message types and malformed bodies never appear as empty success", async () => {
  const client = new BugDetailsReader("/team/fixture", async () => ({
    ...info,
    uuid: "another-bug",
  }));
  await assert.rejects(() => client.content(task), /身份或内容/);
  const wrong = new BugDetailsReader("/team/fixture", async () => ({
    messages: [{ ...message("comment", 100), ref_id: "another-bug" }],
    has_next: false,
  }));
  await assert.rejects(() => wrong.comments(task.id), /所属 Bug/);
  const unknown = new BugDetailsReader("/team/fixture", async () => ({
    messages: [message("comment", 100, "unknown")],
    has_next: false,
  }));
  await assert.rejects(() => unknown.comments(task.id), /未知消息/);
  const empty = new BugDetailsReader("/team/fixture", async () => ({ ...info, desc_rich: null }));
  await assert.rejects(() => empty.content(task), /内容缺失/);
});
