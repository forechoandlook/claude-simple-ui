# 轻量级前后端开发原则
以本项目为例，记录一套在**不引入框架/构建工具复杂度**的前提下完成真实应用的方式。

## 核心立场
> 复杂度是敌人。能不引入的依赖就不引入，能不构建的步骤就不构建。
框架、打包工具、类型系统都是为了解决规模问题的。内部工具、个人项目、原型大多没有这个规模，直接用平台原生能力更快。

## 前端
### 1. ES Modules 是天然的模块系统
浏览器原生支持 `import/export`，不需要打包工具就能拆分代码。
```js
import { signal, computed } from './lib.js';
export const sessionsData = signal([]);
```
开发时改文件、刷新浏览器，零延迟。打包是**发布时的优化**，不是开发时的必要条件。

### 2. 响应式信号 > 手动 DOM 操作
Virtual DOM 的代价是运行时开销和心智负担。信号更轻量：只有真正变化的地方才更新 DOM。
```js
watch(isProcessing, val => {
  $('send-btn')?.classList.toggle('hidden', val);
});
```
原则：**响应性推到叶子节点**，不要在顶层重渲染整棵树。

### 3. 组件 = 返回 HTML 字符串的函数
不需要 JSX、模板编译器、虚拟节点。函数接收 props，返回 HTML 字符串，`innerHTML` 写入 DOM。
```js
const SessionItem = ({ s, active }) => `
  <div class="px-3 py-2 ${active ? 'bg-primary/5' : ''}"
       data-session-id="${esc(s.sessionId)}">
    ${esc(s.display)}
  </div>`;
```
**唯一要注意的**：用户输入必须 `esc()`，HTML 结构不需要。`keyedList` 的 `renderItem` 默认会 escape 返回值，需要显式传 `{ escape: false }` 才能正确渲染 HTML。

### 4. 事件委托 > 逐元素绑定
列表项动态增删时，给每个元素绑事件会造成内存泄漏。委托给父元素一次搞定：
```js
delegate.on('click', '[data-session-id]', (_, el) => {
  resumeSession(el.dataset.sessionId);
});
```

### 5. CSS 用工具类，自定义样式极少
Tailwind/DaisyUI 覆盖 95% 的场景，`style.css` 只放平台原语没法表达的东西（动画、伪元素）。本项目自定义 CSS 不到 60 行。

### 6. 路由延迟到数据就绪后再应用
Hash 路由的初始化必须等数据加载完再执行，否则找不到对应实体：
```js
await showApp();       // 先加载 sessions 进 state
applyInitialRoute();   // 再从 URL hash 恢复状态
```
过早调用路由会静默失败——没有报错，但什么都不发生。

### 7. AbortController 要在闭包里捕获
Effect 里共享 AbortController 变量会导致竞态：老请求的回调检查的是新 controller（未 abort），结果写错数据。
```js
effect(() => {
  const ctrl = new AbortController();  // 每次 effect 运行都创建新的
  fetch(url, { signal: ctrl.signal })
    .then(d => { if (!ctrl.signal.aborted) render(d); });  // 检查自己的
  return () => ctrl.abort();  // 清理自己的
});
```

## 后端
### 8. 单文件 server，路由即文档
`server.js` 一个文件，从上到下读完就知道所有 API。不需要 controller/service/repository 分层——那是为了团队协作和测试隔离，单人项目是过度设计。
```
配置常量 → 存储函数 → 业务工具函数 → HTTP 路由 → WebSocket → 启动
```

### 9. 文件 > 数据库
用户数、配置项在千级以下时，JSON 文件比 SQLite 更简单，比内存更持久。重启不丢数据，`cat` 直接可读，`jq` 直接可查。唯一缺点是并发写——单进程应用里不是问题。

### 10. 多 WebSocket 服务用 `noServer: true` + 手动路由
两个 `WebSocketServer` 绑同一个 `server` + `path` 选项会导致 upgrade 事件被处理两次，帧头损坏。正确做法：
```js
const wssChat  = new WebSocketServer({ noServer: true });
const wssShell = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/ws/chat')  wssChat.handleUpgrade(req, socket, head, ws => ...);
  else if (p === '/ws/shell') wssShell.handleUpgrade(req, socket, head, ws => ...);
  else socket.destroy();
});
```

### 11. 流式 > 缓冲
大文件上传/下载用 stream，不经过内存，无大小限制：
```js
req.pipe(fsSync.createWriteStream(filePath));   // 上传
fsSync.createReadStream(filePath).pipe(res);    // 下载
```

### 12. SDK > CLI 子进程
有官方 SDK 时优先用 SDK，不要 spawn CLI 子进程。SDK 暴露的能力往往比 CLI 更多：
- 运行时切换 `model`、`effort`、`permissionMode`
- 同时运行多个 session（并发 agent）
- 精确 AbortController 控制
- CLI 的 slash command 是 REPL 层的，SDK 里不存在；但 SDK options 能实现更多 CLI 做不到的事

## 构建 & 部署
### 13. 构建是发布时的事，不是开发时的事
```
开发：public/*.js  →  浏览器直接加载，改了刷新
发布：npm run build  →  esbuild 打包压缩，Tailwind CLI 生成 CSS
```
两种模式靠 `NODE_ENV` 区分，一行代码切换。

### 14. 静态资源走 CDN，服务器只跑逻辑
把 `dist/` push 到 GitHub 打 tag，jsDelivr 自动分发。服务器只处理 API/WS，带宽极小。版本号强绑定：`npm version patch` 改版本 + 打 tag，build 脚本读版本号生成带版本的文件名，CDN URL 永远不缓存错。

### 15. IndexedDB 做本地缓存，降低服务器压力
先渲染缓存，后台静默刷新：
```js
const cached = await db.get('sessions');
if (cached) sessionsData.value = cached;   // 立即显示
api('/api/sessions').then(fresh => {
  sessionsData.value = fresh;
  db.set('sessions', fresh, { ttl: 5 * 60000 });
});
```

## 取舍总结
| 没有用 | 理由 |
|---|---|
| React / Vue | 信号 + 字符串模板足够，不需要 VDOM |
| TypeScript | 单人小项目，类型推断的收益低于维护成本 |
| 打包工具（Vite/webpack）| 开发时 ES Modules 够用，发布时 esbuild 够快 |
| ORM / 数据库 | 数据量小，JSON 文件更简单 |
| 容器/编排 | 单进程 Node，`node server.js` 就是全部 |
| 测试框架 | 内部工具，手动测试成本更低 |

**规则**：能用平台原生的就不引入抽象，能用文件的就不上数据库，能用 CDN 的就不占服务器带宽，能用 SDK 的就不 spawn 子进程。复杂度只在真正需要时引入。
