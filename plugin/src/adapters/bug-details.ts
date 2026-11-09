import { bugContent, type BugContent } from "../domain/bug-content.ts";
import { id, record, requireThat, text, type Task } from "../domain/model.ts";

export type Discussion = { id: string; author: string; sentAt: number; content: BugContent[] };
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
};
export type DetailPage<T> = { items: T[]; nextMax: number | null };
export type BugDetail = {
  task: Task;
  content: BugContent[];
  updatedAt: number;
  comments: DetailPage<Discussion>;
  attachments: DetailPage<Attachment>;
};
export function assertDetailFits(value: BugDetail): void {
  const contents = [value.content, ...value.comments.items.map((item) => item.content)];
  let nodes = 100 + value.comments.items.length * 4 + value.attachments.items.length * 6;
  for (const content of contents)
    for (const block of content) {
      nodes +=
        block.kind === "media"
          ? 1
          : 1 +
            block.text
              .split(/\n+/)
              .reduce((count, line) => count + 2 * Math.ceil(line.length / 11999), 0);
    }
  // Reserve room for the host tree's node overhead and surrounding panel, not just the API DTO.
  requireThat(
    nodes <= 3500 && Buffer.byteLength(JSON.stringify(value)) + nodes * 256 <= 400000,
    "size",
    "详情超出面板容量，未截断；请在原单查看。",
  );
}
export type ReadJSON = (path: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
function integer(value: unknown): number {
  requireThat(
    Number.isSafeInteger(value) && Number(value) >= 0,
    "schema",
    "详情时间或计数字段无效。",
  );
  return value as number;
}
function body(value: unknown): string {
  requireThat(typeof value === "string", "schema", "正文内容缺失，不能当作空内容。");
  return value;
}
function page<T>(
  payload: Record<string, unknown>,
  key: "messages" | "attachments",
  stamp: "send_time" | "create_time",
  before: number | undefined,
  parse: (item: Record<string, unknown>) => T | null,
): DetailPage<T> {
  const rows = payload[key];
  requireThat(
    Array.isArray(rows) && typeof payload.has_next === "boolean",
    "partial",
    "详情分页信息不完整。",
  );
  const records = rows.map(record);
  requireThat(
    new Set(records.map((item) => id(item.uuid))).size === records.length,
    "partial",
    "详情分页有重复记录。",
  );
  const times = records.map((item) => integer(item[stamp]));
  requireThat(
    !before || times.every((time) => time <= before),
    "partial",
    "详情分页超出请求范围。",
  );
  const nextMax = payload.has_next ? Math.min(...times) : null;
  requireThat(
    nextMax === null ||
      (times.length > 0 && nextMax > 0 && (before === undefined || nextMax < before)),
    "partial",
    "详情分页未推进，不能标记为全部加载。",
  );
  const result = { items: records.map(parse).filter((item): item is T => item !== null), nextMax };
  requireThat(
    Buffer.byteLength(JSON.stringify(result)) <= 200000,
    "size",
    "此页正文超过面板传输上限，未截断；请在原单查看。",
  );
  return result;
}
export class BugDetailsReader {
  constructor(
    private readonly base: string,
    private readonly get: ReadJSON,
  ) {}
  private path(taskId: string, part: string, before?: number): string {
    if (before !== undefined)
      requireThat(Number.isSafeInteger(before) && before > 0, "input", "详情分页参数无效。");
    return `${this.base}/task/${id(taskId)}/${part}?count=20${before === undefined ? "" : `&max=${before}`}`;
  }
  async content(
    task: Task,
    signal?: AbortSignal,
  ): Promise<{ content: BugContent[]; updatedAt: number }> {
    const value = await this.get(`${this.base}/task/${id(task.id)}/info`, signal);
    requireThat(
      value.uuid === task.id &&
        value.project_uuid === task.project.id &&
        value.issue_type_uuid === task.issueType.id &&
        value.status_uuid === task.status.id &&
        value.summary === task.name,
      "stale",
      "Bug 身份或内容已变化，请重新打开详情。",
    );
    return {
      content: bugContent(body(value.desc_rich), body(value.desc)),
      updatedAt: integer(value.server_update_stamp),
    };
  }
  async comments(
    taskId: string,
    before?: number,
    signal?: AbortSignal,
  ): Promise<DetailPage<Discussion>> {
    const data = await this.get(this.path(taskId, "messages", before), signal);
    return page(data, "messages", "send_time", before, (row) => {
      if (row.type === "system") return null;
      requireThat(
        row.ref_id === taskId && row.ref_type === "task",
        "identity",
        "评论所属 Bug 不匹配。",
      );
      requireThat(row.type === "discussion", "schema", "发现未知消息类型，不能声称评论完整。");
      return {
        id: id(row.uuid),
        author:
          typeof row.from_name === "string" && row.from_name ? text(row.from_name, 2000) : "用户",
        sentAt: integer(row.send_time),
        content: bugContent(row.rich_text ?? "", body(row.text)),
      };
    });
  }
  async attachments(
    taskId: string,
    before?: number,
    signal?: AbortSignal,
  ): Promise<DetailPage<Attachment>> {
    const data = await this.get(this.path(taskId, "attachments", before), signal);
    return page(data, "attachments", "create_time", before, (row) => {
      requireThat(
        row.ref_id === taskId && row.ref_type === "task",
        "identity",
        "附件所属 Bug 不匹配。",
      );
      return {
        id: id(row.uuid),
        name: text(row.name, 2000),
        mime: text(row.mime, 150),
        size: integer(row.size),
        createdAt: integer(row.create_time),
      };
    });
  }
}
