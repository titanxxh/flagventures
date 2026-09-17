# Flagventures · 腰旗小冒险

给家长和孩子一起使用的腰旗橄榄球教学工具，应用内名称为「Flagventures」。用动画看清每个人的跑位，停在关键帧上讲配合，再带着记住的路线去场上练习。

## 直接使用

- **在线使用**：[打开 Flagventures](https://titanxxh.github.io/flagventures/)。
- **本地使用**：下载 [Flagventures.html](dist/Flagventures.html)，双击后用 Chrome 打开。教学内容在文件内，无需安装软件、启动服务或联网。

两个版本均保留全部 **64 个教学条目**，运行不依赖 PDF 或原页图片。公开仓库和默认应用不包含原页图片。

- **中英文切换**：右上角选择中文或 English；界面与全部 64 个内置条目同步切换，保留当前播放状态，并记住语言偏好。
- **层级目录**：64 个条目按手册顺序浏览；基础路线、进攻阵型与战术、跑球战术、防守分工均可展开或收起。进攻分类内有 10 个阵型组，每组包含阵型站位和战术 1、2、3。
- **调速与讲解**：默认 2× 播放；播放按钮下方可选 0.5×、1×、2×、3×，支持进度拖动及可持续暂停的关键帧。
- **认识跑法**：悬停球员查看中英文名称，点击保留关注；支持键盘操作。
- **看懂配合**：30 套进攻战术补充全队目标、配合说明、记忆口令和提问；球员说明包含队友配合与启动时机，并可查看官网、视频出处。
- **自己加战术**：导入 YAML、预览更新、导出完整战术包，运行不依赖 PDF。

使用与保存方式见 [中文使用说明](使用说明.md)。

## 编辑教学内容

每条战术独立保存在 [content/lessons/](content/lessons/)，顺序由 [content/catalog.yaml](content/catalog.yaml) 管理。也可以下载 [新增模板](content-format/templates/new-play.yaml)，填写后直接在网页中导入。

- [内容维护说明](content/README.md)
- [文本格式与字段说明](content-format/README.md)

动画秒数是教学示意。NFL FLAG 官网与视频明确说明的相对先后、短暂等待和条件释放，分别写入对应进攻战术；条件释放需先选择教学情形再播放。资料未说明的启动先后、球权与跟防不会自动补造。每名球员的术语说明区分来源命名、形态对照与按图描述。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run build
```

测试和构建前会自动从 YAML 与目录生成完整内容包，无需原始 PDF 或原页图片。生成的内容包与预览副本不纳入版本控制；仓库保留可直接打开的主 HTML。

`npm run test:browser` 使用已安装的 Google Chrome 检查本地文件、播放与导入导出。修改源码后先运行 `npm run build`。

推送到 `main` 后，[发布工作流](.github/workflows/pages.yml)会自动运行测试、构建并部署到 GitHub Pages。仓库的 Settings → Pages → Build and deployment → Source 应选择 **GitHub Actions**。

| 目录 | 用途 |
| --- | --- |
| `app/` | 页面、场景计算与内容校验 |
| `content/` | 64 条 YAML 与目录 |
| `content-format/` | 格式定义、模板与示例 |
| `tools/` | 内容打包和单文件网页构建 |
| `tests/` | 内容、场景、导入与浏览器测试 |
| `dist/` | 可直接使用的主 HTML 与开源许可 |
