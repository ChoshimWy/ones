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
  assert.deepEqual(bugContent("", value), [{ kind: "text", text: value.trimEnd() }]);
  assert.throws(() => bugContent("x".repeat(262145), ""), /过大/);
  assert.throws(() => bugContent("<div>".repeat(90) + "x" + "</div>".repeat(90), ""), /结构过大/);
});

/// 嵌套块与编辑器空段只保留段落间隔，不删步骤、结果或只有标题的段落。
test("content spacing: nested paragraphs, br and blank NBSP lines collapse without rewriting headings", () => {
  const result = bugContent('<div><p>步骤：</p><div><p>1. 打开页面<br>2. 切换列表</p></div><p><br></p><p>&nbsp; \t</p><div><p>结果：</p></div><div><br><br></div><p>仍显示旧数据</p><p><br></p><p>期望：</p><p>显示最新数据</p></div>', '');
  assert.deepEqual(result, [{kind:'text',text:'步骤：\n\n1. 打开页面\n2. 切换列表\n\n结果：\n\n仍显示旧数据\n\n期望：\n\n显示最新数据'}]);
});
/// 普通 plain 统一行尾；缩进、行内空格、单换行不动，显式代码围栏保守保留。
test('content spacing: plain CRLF and whitespace lines normalize while indentation and fenced code remain',()=>{
  assert.deepEqual(bugContent('', ' \r\n\u00a0\r\n步骤：\r\n  1. 打开\r\n\t2. 切换\r\n \t\u00a0\r\n\r\n\r\n期望：保持  行内空格\r\n \u00a0'),[{kind:'text',text:'步骤：\n  1. 打开\n\t2. 切换\n\n期望：保持  行内空格'}]);
  assert.deepEqual(bugContent('', '\n\u00a0 \t\n'),[]);
  const fenced='```text\n  one\n\n\n  two\n```';
  assert.deepEqual(bugContent('',fenced),[{kind:'text',text:fenced}]);
});
/// 富文本代码空白按节点语义保留，普通列表条目不被合并成一行。
test('content spacing: pre code whitespace and inline-code boundaries stay intact beside lists',()=>{
  const result=bugContent('<p>步骤</p><ul><li>第一项</li><li>第二项</li></ul><pre><code>  one\n\n\n\t two  </code></pre><p>值 <code> a  b </code> 不变</p>', '');
  assert.deepEqual(result,[{kind:'text',text:'步骤\n\n• 第一项\n\n• 第二项\n\n  one\n\n\n\t two  \n\n值  a  b  不变'}]);
});
/// 媒体切块前后独立归一化，但媒体顺序与安全拒绝保持。
test('content spacing: image video order and controlled resources survive empty surrounding paragraphs',()=>{
  const result=bugContent('<p>前文</p><p><br><br></p><img data-uuid="image"><p>&nbsp;</p><p>图片说明</p><video data-uuid="video"></video><div><br><p>后文</p><br></div><img src="https://bad.invalid/?token=secret">','');
  assert.deepEqual(result.map(x=>x.kind),['text','media','text','media','text','text']);
  assert.equal(result[0].kind==='text'&&result[0].text,'前文');assert.equal(result[2].kind==='text'&&result[2].text,'图片说明');assert.equal(result[4].kind==='text'&&result[4].text,'后文');
  assert.equal(result[1].kind==='media'&&result[1].resourceId,'image');assert.equal(result[3].kind==='media'&&result[3].resourceId,'video');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(result[5].kind==='text'&&result[5].text.includes('缺少受控资源标识'));
});
