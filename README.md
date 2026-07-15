# AI HOT 朗读器

在 [AI HOT](https://aihot.virxact.com) 网页上悬浮播放条，朗读**当前页**的标题 / 摘要 / 全文（详情页）/ **AI 日报**。

- 列表仍看网页，插件**不重复铺内容**
- 默认 Microsoft Edge 神经网络语音（晓晓等），失败时系统中文语音兜底
- 可选本地 Node 服务 `server.mjs`（音质稳定时的备用合成通道）

> 仅适配 `aihot.virxact.com`，不是通用网页朗读器。

## 功能

| 页面 | 支持 |
|------|------|
| 全部动态 / 精选 | ✅ 读页面卡片标题+摘要 |
| AI 日报 `/daily` | ✅ 官方日报 API + 栏目朗读 |
| 详情页 `/items/...` | ✅ 可选全文 |
| 换声音 / 语速 / 内容模式 | ✅ 正在播时会用新设置重念当前条 |
| 音量 | ✅ 实时调节 |

## 安装（浏览器扩展 · 推荐）

### 1. 下载

- 打开 [Releases](https://github.com/shiguang666118/aihot-reader/releases) 下载最新  
  `aihot-reader-extension-v*.zip`  
- 或克隆本仓库，使用目录：`extension/`

### 2. 加载到 Chrome / Edge

1. 解压 zip（得到含 `manifest.json` 的文件夹）
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 打开 **开发者模式**
4. **加载已解压的扩展程序** → 选中该文件夹
5. 打开 https://aihot.virxact.com/all 或 `/daily`，**刷新页面**
6. 右下角出现 **「AI HOT 朗读」**

详细说明见 [`extension/给别人安装.txt`](extension/给别人安装.txt)（打包时生成）与 [`怎么给别人用.md`](怎么给别人用.md)。

### 使用

1. 在网页上点某条资讯（会高亮）
2. 点悬浮条 **▶**，或 **「从本页播」** 连续听
3. 音色：晓晓 / 云希 / 云扬 等；内容：标题+摘要 / 仅摘要 / 全文

### 权限说明

扩展会访问：

- `https://aihot.virxact.com/*` — 拉资讯 / 日报
- `https://speech.platform.bing.com/*` — Edge 神经网络语音
- （可选）`http://127.0.0.1:8765/*` — 本地朗读服务

本地仅用 `chrome.storage` 保存音色、语速等偏好，不上传账号密码。

## 可选：本地网页版 / TTS 服务

需要 Node.js 18+：

```bash
cd aihot-reader
npm install
node server.mjs
```

浏览器打开：http://127.0.0.1:8765  

扩展在直连微软 TTS 失败时，会尝试走该本地服务再合成。

## 目录结构

```
aihot-reader/
├── extension/          # Chrome / Edge 扩展（主交付物）
│   ├── manifest.json
│   ├── content.js      # 页内悬浮条 + DOM/日报抽取
│   ├── background.js   # TTS 合成
│   ├── edge-tts-classic.js
│   └── ...
├── public/             # 本地网页版 UI
├── server.mjs          # 本地 API 代理 + TTS
├── package.json
└── 怎么给别人用.md
```

## 已知限制

- 安装方式为「开发者模式加载」；上架 Chrome 网上应用店需另走审核
- Edge 神经网络接口非官方商用 API，偶发失败时会退回系统语音
- 请勿将本工具描述为「微软官方合作产品」

## 版本

当前扩展版本见 `extension/manifest.json` 的 `version` 字段。

## License

MIT — 见 [LICENSE](LICENSE)
