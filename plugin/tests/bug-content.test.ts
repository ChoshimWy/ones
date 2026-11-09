import { test } from "node:test";
import assert from "node:assert/strict";
import { bugContent } from "../src/domain/bug-content.ts";

test("TC-PLUGIN-008-content: text, inline image, video and caption retain order without executable HTML", () => {
  const result = bugContent(
    '<p>步骤 &amp; 结果</p><figure><img src="https://untrusted.invalid/?token=secret" data-uuid="image-fixture" onerror="bad()"><figcaption>截图说明</figcaption></figure><video data-uuid="video-fixture" data-mime="video/mp4"><source src="file:///secret"></video><p>尾部</p>',
    "",
  );
  assert.deepEqual(
    result.map((block) => block.kind),
    ["text", "media", "text", "media", "text"],
  );
  assert.equal(result[0].kind === "text" && result[0].text, "步骤 & 结果");
  assert.equal(result[3].kind === "media" && result[3].mediaType, "video");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("onerror"));
});

test("TC-PLUGIN-008-content: scripts, frames, SVG and missing resource IDs cannot become active media", () => {
  const result = bugContent(
    '<p>正常</p><script>exfiltrate()</script><iframe src="https://bad.invalid">private</iframe><svg><script>bad()</script></svg><img src="javascript:bad()"><a href="javascript:bad()">保留链接文字</a>',
    "",
  );
  assert.ok(!result.some((block) => block.kind === "media"));
  assert.ok(!JSON.stringify(result).includes("exfiltrate"));
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(JSON.stringify(result).includes("保留链接文字"));
  assert.ok(JSON.stringify(result).includes("无法安全内嵌"));
});

test("TC-PLUGIN-008-content: plain fallback remains complete and excessive content fails instead of truncating", () => {
  const value = "完整正文\n".repeat(5000);
  assert.deepEqual(bugContent("", value), [{ kind: "text", text: value }]);
  assert.throws(() => bugContent("x".repeat(262145), ""), /过大/);
  assert.throws(() => bugContent("<div>".repeat(90) + "x" + "</div>".repeat(90), ""), /结构过大/);
});
