# 内置源码与许可证

- `parse5.mjs`：parse5 7.3.0 / entities 6.0.1 的离线打包解析器；对应 `parse5-LICENSE.txt`、`entities-LICENSE.txt`。
- `image-header.ts`：逐字复制官方 Orca v1.4.254（`b33b1920c1483711c6602740d9f1169977802606`）的 `src/shared/plugins/images/plugin-image-format.ts`。MIT 许可证见 `orca-LICENSE.txt`。用于插件自身的 PNG/JPEG/WebP 格式及尺寸检查，不依赖宿主扩展。

无运行时下载、远程脚本或源码自动更新。
