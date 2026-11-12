import { randomUUID } from "node:crypto";
import { ONES, Transport } from "./http.ts";
import { id, record, requireThat, text } from "../domain/model.ts";

export type MediaChunk = {
  mime: string;
  total: number;
  offset: number;
  data: string;
  next: number | null;
};
const CHUNK = 512 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_CACHE = 64 * 1024 * 1024;
const allowedMimes = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]);
function matchesSignature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  if (mime === "image/png")
    return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mime === "video/mp4") return ascii(4, 8) === "ftyp";
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

// Memory-only, scoped to one opened detail. No URLs, headers or filenames cross this interface.
export class BugMediaStore {
  readonly detailId = randomUUID();
  private readonly allowed = new Set<string>();
  private readonly cache = new Map<string, { mime: string; bytes: Buffer }>();
  private readonly pending = new Map<string, Promise<{ mime: string; bytes: Buffer }>>();
  private readonly controller = new AbortController();
  private readonly expiresAt = Date.now() + 10 * 60 * 1000;
  private reserved = 0;
  constructor(
    private readonly transport: Transport,
    private readonly team: string,
    private readonly token: string,
  ) {
    id(team);
  }
  allow(resources: Iterable<string>): void {
    for (const resource of resources) this.allowed.add(id(resource));
  }
  dispose(): void {
    this.controller.abort();
    this.allowed.clear();
    this.cache.clear();
  }
  private valid(detailId: string, resource: string): void {
    requireThat(
      detailId === this.detailId && !this.controller.signal.aborted && Date.now() < this.expiresAt,
      "stale",
      "详情已关闭或过期，请重新打开。",
    );
    requireThat(this.allowed.has(id(resource)), "scope", "媒体不属于已读取的 Bug 详情。");
  }
  // Agent handoff treats downloads as opaque files, never browser-renderable data.
  async readAttachment(detailId: string, resource: string, offset: number, signal?: AbortSignal): Promise<MediaChunk> {
    return this.readChunk(detailId, resource, offset, false, signal);
  }
  async read(detailId: string, resource: string, offset: number, signal?: AbortSignal): Promise<MediaChunk> {
    return this.readChunk(detailId, resource, offset, true, signal);
  }
  private async readChunk(
    detailId: string,
    resource: string,
    offset: number,
    preview: boolean,
    signal?: AbortSignal,
  ): Promise<MediaChunk> {
    this.valid(detailId, resource);
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset % CHUNK === 0,
      "input",
      "媒体分块位置无效。",
    );
    let value = this.cache.get(resource);
    if (!value) {
      requireThat(offset === 0, "stale", "媒体缓存已释放，请重新加载。");
      let pending = this.pending.get(resource);
      if (!pending) {
        requireThat(this.pending.size < 2, "busy", "同时加载的媒体过多，请稍后重试。");
        pending = this.download(resource, preview, signal);
        this.pending.set(resource, pending);
      }
      try {
        value = await pending;
      } finally {
        this.pending.delete(resource);
      }
    }
    this.valid(detailId, resource);
    requireThat(
      !signal?.aborted && offset < value.bytes.length,
      "cancelled",
      "媒体读取已取消或分块超出范围。",
    );
    if (preview) {
      requireThat(allowedMimes.has(value.mime), "media", "此媒体格式暂不支持内嵌。");
      requireThat(matchesSignature(value.bytes, value.mime), "media", "媒体文件签名不匹配。");
    }
    const end = Math.min(offset + CHUNK, value.bytes.length);
    return {
      mime: value.mime,
      total: value.bytes.length,
      offset,
      data: value.bytes.subarray(offset, end).toString("base64"),
      next: end === value.bytes.length ? null : end,
    };
  }
  private async download(
    resource: string,
    preview: boolean,
    signal?: AbortSignal,
  ): Promise<{ mime: string; bytes: Buffer }> {
    const abort = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const value = record(
      await this.transport.json(
        `/project/api/project/team/${this.team}/res/attachment/${resource}`,
        { headers: { Authorization: `Bearer ${this.token}` }, signal: abort },
      ),
    );
    requireThat(value.uuid === resource, "identity", "媒体资源身份不匹配。");
    const mime = text(value.mime, 100).toLowerCase();
    if (preview) requireThat(allowedMimes.has(mime), "media", "此媒体格式暂不支持内嵌。");
    requireThat(
      Number.isSafeInteger(value.size) && Number(value.size) > 0 && Number(value.size) <= MAX_FILE,
      "size",
      "媒体超过 32 MiB 上限或大小无效，请在原单查看。",
    );
    const size = Number(value.size);
    let used = [...this.cache.values()].reduce((sum, item) => sum + item.bytes.length, 0);
    while (this.cache.size && used + this.reserved + size > MAX_CACHE) {
      const first = this.cache.keys().next().value!;
      used -= this.cache.get(first)!.bytes.length;
      this.cache.delete(first);
    }
    requireThat(used + this.reserved + size <= MAX_CACHE, "size", "媒体内存预算不足，请稍后重试。");
    const url = new URL(text(value.url, 16000), ONES);
    requireThat(
      url.origin === ONES &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname.startsWith("/api/project/"),
      "origin",
      "媒体来源不在已验证的 ONES 资源路径，已停止读取。",
    );
    this.reserved += size;
    try {
      // Resource URL is signed; never forward the account's bearer token to it.
      const response = await this.transport.response(url.pathname + url.search, { signal: abort });
      requireThat(
        response.ok && response.status === 200,
        "media",
        "媒体读取失败或发生重定向，请重新打开详情。",
      );
      const receivedMime = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      requireThat(
        receivedMime === mime || receivedMime === "application/octet-stream",
        "media",
        "媒体 MIME 与资源元数据不匹配。",
      );
      const reader = response.body?.getReader();
      requireThat(reader, "media", "媒体响应为空。");
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          count += chunk.value.byteLength;
          requireThat(count <= size && !abort.aborted, "size", "媒体超过声明大小或加载已取消。");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      requireThat(
        count === size,
        "media",
        "媒体字节数或文件签名不匹配。",
      );
      this.valid(this.detailId, resource);
      const result = { mime, bytes };
      this.cache.set(resource, result);
      return result;
    } finally {
      this.reserved -= size;
    }
  }
}
