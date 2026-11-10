import { parseFragment, type HTMLNode } from "../vendor/parse5.mjs";
import { requireThat } from "./model.ts";

export type BugContent =
  | { kind: "text"; text: string }
  | { kind: "media"; resourceId: string; mediaType: "image" | "video"; label: string };
const hidden = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "head",
]);
const breaks = new Set([
  "p",
  "div",
  "section",
  "article",
  "figure",
  "figcaption",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/// 普通文本最多保留一个空行；保留非空行前的缩进，不改写步骤或标题。
function normalSpacing(value: string, first: boolean, last: boolean): string {
  let text = value.replace(/\r\n?/g, "\n");
  // 只清理独立空白行，行内空格及代码边界旁的空格不受影响。
  if (text.includes("\n") || (first && last)) text = text.replace(/(^|\n)[^\S\n]*(?=\n|$)/g, "$1");
  text = text.replace(/\n{3,}/g, "\n\n");
  if (first) text = text.replace(/^(?:[^\S\n]*\n)+/, "");
  if (last) text = text.replace(/(?:\n[^\S\n]*)+$/, "").replace(/[^\S\n]+$/, "");
  return text;
}

/// 解析而不执行 HTML；普通段落统一空白，pre/code 内文本保持原样。
/// 受控媒体标识是唯一资源入口；URL 与任意属性不跨越面板桥。
export function bugContent(rich: unknown, plain: unknown): BugContent[] {
  requireThat(
    typeof rich === "string" &&
      typeof plain === "string" &&
      rich.length <= 262144 &&
      plain.length <= 262144,
    "schema",
    "Bug 正文格式无效或过大，未截断展示。",
  );
  if (!rich.trim()) {
    // 纯文本没有 HTML 语义；出现 Markdown 代码围栏时保守保留全文，避免改动代码空白。
    const text = /^[ \t]*(`{3,}|~{3,})/m.test(plain) ? plain : normalSpacing(plain, true, true);
    return text ? [{ kind: "text", text }] : [];
  }
  const blocks: BugContent[] = [];
  let pending: { text: string; preserve: boolean }[] = [];
  /// 相邻普通片段合并后处理，避免按 DOM 节点重复归一化或破坏行内间隔。
  const append = (text: string, preserve = false) => {
    const prior = pending.at(-1);
    if (prior?.preserve === preserve) prior.text += text;
    else pending.push({ text, preserve });
  };
  let nodes = 0;
  /// 媒体边界发布文本；保护片段不参与普通空白压缩。
  const flush = () => {
    const text = pending.map((part, index) => part.preserve ? part.text : normalSpacing(part.text, index === 0, index === pending.length - 1)).join("");
    if (text.trim() || pending.some(part => part.preserve)) blocks.push({ kind: "text", text });
    pending = [];
  };
  /// 代码上下文只保留文本与显式换行，继续服从节点预算和媒体安全规则。
  const visit = (node: HTMLNode, depth: number, preserve = false): void => {
    requireThat(++nodes <= 10000 && depth <= 80, "size", "Bug 正文结构过大，未截断展示。");
    const tag = node.tagName ?? node.nodeName;
    if (hidden.has(tag)) return;
    if (tag === "#text") {
      append(node.value ?? "", preserve);
      return;
    }
    const attrs = new Map(node.attrs?.map((attr) => [attr.name, attr.value]));
    const mime = attrs.get("data-mime") ?? "";
    const media =
      tag === "img" || tag === "video" || (/^(image|video)\//.test(mime) && attrs.has("data-uuid"));
    if (media) {
      flush();
      const resourceId = attrs.get("data-uuid") ?? "";
      const mediaType = tag === "video" || mime.startsWith("video/") ? "video" : "image";
      if (/^[A-Za-z0-9_-]{1,100}$/.test(resourceId))
        blocks.push({
          kind: "media",
          resourceId,
          mediaType,
          label: attrs.get("alt") || (mediaType === "video" ? "Bug 视频" : "Bug 图片"),
        });
      else
        blocks.push({
          kind: "text",
          text: "[此媒体缺少受控资源标识，无法安全内嵌；请在原单查看。]",
        });
      return;
    }
    if (tag === "br") append("\n", preserve);
    else if (!preserve && breaks.has(tag)) append("\n");
    if (!preserve && tag === "li") append("• ");
    if (!preserve && (tag === "td" || tag === "th")) append("\t");
    for (const child of node.childNodes ?? []) visit(child, depth + 1, preserve || tag === "pre" || tag === "code");
    if (!preserve && breaks.has(tag)) append("\n");
  };
  visit(parseFragment(rich), 0);
  flush();
  return blocks;
}
