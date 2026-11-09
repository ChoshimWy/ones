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

// Parse, never execute HTML. URLs and arbitrary attributes never cross the panel bridge.
export function bugContent(rich: unknown, plain: unknown): BugContent[] {
  requireThat(
    typeof rich === "string" &&
      typeof plain === "string" &&
      rich.length <= 262144 &&
      plain.length <= 262144,
    "schema",
    "Bug 正文格式无效或过大，未截断展示。",
  );
  if (!rich.trim()) return plain ? [{ kind: "text", text: plain }] : [];
  const blocks: BugContent[] = [];
  let pending = "";
  let nodes = 0;
  const flush = () => {
    if (pending.trim()) blocks.push({ kind: "text", text: pending.trim() });
    pending = "";
  };
  const visit = (node: HTMLNode, depth: number): void => {
    requireThat(++nodes <= 10000 && depth <= 80, "size", "Bug 正文结构过大，未截断展示。");
    const tag = node.tagName ?? node.nodeName;
    if (hidden.has(tag)) return;
    if (tag === "#text") {
      pending += node.value ?? "";
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
    if (tag === "br" || breaks.has(tag)) pending += "\n";
    if (tag === "li") pending += "• ";
    if (tag === "td" || tag === "th") pending += "\t";
    for (const child of node.childNodes ?? []) visit(child, depth + 1);
    if (breaks.has(tag)) pending += "\n";
  };
  visit(parseFragment(rich), 0);
  flush();
  return blocks;
}
