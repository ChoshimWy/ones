import { test } from "node:test";
import assert from "node:assert/strict";
import { Workbench, type Store } from "../src/service.ts";

function fixture(body = '<p>正文</p><img data-uuid="image">') {
  const state = new Map<string, unknown>([
    [
      "session.ones",
      JSON.stringify({
        token: "fixture-access",
        userId: "owner",
        label: "虚构用户",
        teams: [{ id: "team", name: "团队" }],
        expiresAt: Date.now() + 600000,
      }),
    ],
  ]);
  const store: Store = {
    get: async (key) => state.get(key) ?? null,
    set: async (key, value) => {
      state.set(key, value);
    },
    delete: async (key) => {
      state.delete(key);
    },
  };
  const task = {
    uuid: "bug",
    number: 1,
    name: "虚构缺陷",
    project: { uuid: "project", name: "项目" },
    issueType: { uuid: "bug-type", name: "缺陷" },
    status: { uuid: "pending", name: "待处理" },
  };
  let infoHook: (() => Promise<void>) | undefined;
  const methods: string[] = [];
  const service = new Workbench({
    store,
    vault: {
      get: async (key) => String(state.get(key) ?? "") || null,
      set: store.set,
      delete: store.delete,
    },
    protection: async () => true,
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname;
      methods.push(init?.method ?? "GET");
      if (path.endsWith("/users/me")) return Response.json({ uuid: "owner" });
      if (path.endsWith("/items/graphql")) {
        assert.ok(!String(init?.body).includes("mutation"));
        if (String(init?.body).includes('PluginTaskPage')) {
          const payload = JSON.parse(String(init?.body));
          assert.deepEqual(payload.variables.filter, { assign_in: ['owner'], issueType_in: ['bug-type'] });
          return Response.json({ data: { buckets: [{ tasks: [task], pageInfo: { hasNextPage: false, unstable: false, endCursor: '' } }] } });
        }
        return Response.json({ data: { tasks: [task] } });
      }
      if (path.endsWith("/issue_types"))
        return Response.json({
          issue_types: [
            {
              uuid: "bug-type",
              name: "缺陷",
              built_in: true,
              type: 0,
              detail_type: 3,
              default_configs: { default_task_status_configs: [{ status_uuid: "pending" }] },
            },
          ],
        });
      if (path.endsWith("/info")) {
        await infoHook?.();
        return Response.json({
          uuid: "bug",
          summary: task.name,
          project_uuid: "project",
          issue_type_uuid: "bug-type",
          status_uuid: "pending",
          desc: "正文",
          desc_rich: body,
          server_update_stamp: 1,
        });
      }
      if (path.endsWith("/messages")) return Response.json({ messages: [], has_next: false });
      if (path.endsWith("/attachments")) return Response.json({ attachments: [], has_next: false });
      throw new Error("Unexpected fixture path");
    },
  });
  return {
    service,
    methods,
    setInfoHook(hook: () => Promise<void>) {
      infoHook = hook;
    },
  };
}

test("TC-PLUGIN-008-service: opening another detail revokes old media and logout revokes the current detail", async () => {
  const f = fixture();
  const first = await f.service.bugDetail("team", "bug");
  const second = await f.service.bugDetail("team", "bug");
  assert.notEqual(first.detailId, second.detailId);
  await assert.rejects(() => f.service.detailMedia(first.detailId, "image", 0), /详情已变化/);
  await assert.rejects(() => f.service.detailMedia(second.detailId, "unregistered", 0), /不属于/);
  await f.service.logout("ones");
  await assert.rejects(() => f.service.detailMedia(second.detailId, "image", 0), /详情已变化/);
  assert.ok(f.methods.every((method) => method === "GET" || method === "POST"));
});

test("TC-PLUGIN-008-service: a late read cannot publish a detail after close or account invalidation", async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setInfoHook(async () => {
    started();
    await waiting;
  });
  const pending = f.service.bugDetail("team", "bug");
  await entered;
  await f.service.logout("ones");
  release();
  await assert.rejects(() => pending, /身份或详情已变化/);
  await assert.rejects(() => f.service.bugDetail("team", "bug"), /登录 ONES/);
});

test("TC-PLUGIN-008-service: a stale close cannot close a newly opened detail", async () => {
  const f = fixture();
  const first = await f.service.bugDetail("team", "bug");
  const second = await f.service.bugDetail("team", "bug");
  f.service.closeDetail(first.detailId);
  assert.deepEqual(await f.service.detailComments(second.detailId, 100), {
    items: [],
    nextMax: null,
  });
  f.service.closeDetail(second.detailId);
  await assert.rejects(() => f.service.detailComments(second.detailId, 100), /详情已变化/);
});

test("TC-PLUGIN-008-service: closing a pending client view prevents its late result from creating a media lease", async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setInfoHook(async () => {
    started();
    await waiting;
  });
  const pending = f.service.bugDetail("team", "bug", undefined, "pending-view");
  await entered;
  f.service.closeDetail("pending-view");
  release();
  await assert.rejects(() => pending, /身份或详情已变化/);
});

test("TC-PLUGIN-008-service: excessively fragmented content fails before publishing a partial host tree", async () => {
  const f = fixture("<p>x</p>".repeat(2000));
  await assert.rejects(() => f.service.bugDetail("team", "bug"), /详情超出面板容量/);
});


test("repair source: complete read-only collection validates original identity and revokes on logout", async () => {
  const f = fixture('<p>完整描述</p>');
  const detail = await f.service.bugDetail('team', 'bug');
  const context = await f.service.repairContext(detail.detailId);
  assert.equal(context.task.id, 'bug');
  const source = await f.service.collectRepair(detail.detailId);
  try {
    assert.equal(source.bug.content[0]?.kind, 'text');
    assert.deepEqual(source.bug.comments, []);
    await source.validate();
    await f.service.logout('ones');
    assert.throws(source.check);
    await assert.rejects(source.validate());
    assert.ok(f.methods.every(method => method === 'GET' || method === 'POST'));
  } finally { source.dispose(); }
});


test('project follow service: authenticated candidates select by current project; logout cannot reuse previous account', async () => {
  const f = fixture();
  const result = await f.service.projectFilter('team', { id: 'local', name: '项目' }, [{ id: 'project', name: '项目' }]);
  assert.equal(result.project?.id, 'project');
  await f.service.logout('ones');
  await assert.rejects(f.service.projectFilter('team', { id: 'local', name: '项目' }, [{ id: 'project', name: '项目' }]));
});

test('repair list service: scopes all-status bugs without detail, revokes on logout and cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  const context = await f.service.repairListContext('team', controller.signal);
  const page = await context.readPage('');
  assert.equal(page.items[0]?.id, 'bug');
  assert.equal(page.nextCursor, null);
  await assert.rejects(f.service.repairListContext('other-team'));
  controller.abort();
  assert.throws(context.check);
  await assert.rejects(context.readPage(''));
  const current = await f.service.repairListContext('team');
  await f.service.logout('ones');
  assert.throws(current.check);
  await assert.rejects(current.readPage(''));
  await assert.rejects(f.service.repairListContext('team'));
});
