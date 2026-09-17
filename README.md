# dsh-build-progress —— 构建进度条推送插件

**唯一用途**:构建 APK(或任何 Gradle 构建)时,让前端在**会话流的折叠工具条标题处原地刷新**看到构建进度条,
形如 `<=====> 73% EXECUTING [1m 32s]`。除此之外什么都不做。

- 🎯 只认 `gradle` / `gradlew` 命令
- 📉 只抽**进度那一行**(剥掉 ANSI 后取最后一次匹配),变化才推
- 🔌 自建 WebSocket `/api/build-progress`(官方 `registerUpgrade`)
- 🧠 自动**注入一条运行时要求**,让助手用能看到进度条的方式跑构建(见下)
- 🚫 不落日志、不留历史、不推 stdout/stderr 正文、不推命令原文
- 🪶 单文件、零依赖(宿主侧复用 DSH 自带的 `ws`)

配套的 Android 前端(dsh-aui 2.0.2)把它渲染到会话流里那条构建工具行的标题位置,收到 `build-done` 立即撤下。

---

## 安装

```bash
# 1) 放插件文件
mkdir -p ~/.dsh/profiles/web/plugins/build-progress
curl -fsSL https://raw.githubusercontent.com/akvi0921/dsh-build-progress/main/index.js \
  -o ~/.dsh/profiles/web/plugins/build-progress/index.js
# 国内网络可用镜像:https://ghfast.top/https://raw.githubusercontent.com/...

# 2) 追加组合行(保存即热生效;~/.dsh/profiles/web/cordis.patch.yml)
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'

- insert:
    - id: build-progress
      name: './plugins/build-progress/index.js'
      config: { pollMs: 150 }
YAML
```

自查(应能连上并收到 `hello`):

```bash
node -e "
const WS=require(require('path').join(process.env.HOME,'.dsh/profiles/node_modules/ws'));
const ws=new WS('ws://127.0.0.1:3080/api/build-progress',{headers:{Origin:'http://127.0.0.1:3080'}});
ws.on('message',m=>{console.log(String(m).slice(0,120));process.exit(0)});
ws.on('error',e=>{console.log('✗',e.message);process.exit(1)});"
```

---

## 它自动注入的运行时要求(关键)

`--console=plain` 下 Gradle **根本不画进度条**;而一旦输出被 `> log.txt`、`| tail` 接走,插件也就采不到。
这两件事都发生在"助手决定怎么跑命令"的那一刻,所以插件在挂载时通过官方 `systemPrompt.context()`
注册一条每轮都会并入上下文的片段(GUI 的「上下文注入」块里能看到):

- 构建必须这样跑:`TERM=xterm-256color script -q -f -c "gradle assembleDebug --console=rich" /dev/null`
- 不要重定向/接管道;要看尾部结果就等构建结束再单独 `tail`/`cat`

也就是说:**装了这个插件,助手自己就会用能看到进度条的方式跑构建**,不需要你每次叮嘱。

---

## 帧协议(WS `/api/build-progress`,版本 1)

| 帧 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `builds:[{callId,sessionId,text,percent,phase,elapsed}]` | 连上即发,只反映**此刻**在跑的构建(不是历史) |
| `build-progress` | `callId,sessionId,text,percent,phase,elapsed` | 进度行变化时推;`text` 如 `<=====> 73% EXECUTING [1m 32s]` |
| `build-done` | `callId,sessionId,exitCode` | 构建结束,前端撤下该行进度 |

`callId` 是官方 `tool/call` 事件的调用 id,前端靠它把进度画到**对应的那一行工具**上。

---

## 实现要点(踩过的坑)

- **热插入的条目 Cordis 不调 `apply`**(父 include 事务不 settle),所以插件在 import 时**自举挂载**:
  钩住 `Context.prototype.extend/isolate/intercept` 取 root ctx,轮询到 `webServer` + `subprocess` 就位再挂。
- **声明式 `inject = ['webServer','subprocess']`** 是启动路径的正确姿势(否则 apply 早于服务注册)。
- 进度行要**剥 ANSI 后取最后一次匹配**:rich 控制台把 `<===>` 拆成多段并夹带光标移动/擦除序列,
  只处理 `\r` 会把重绘串成一行垃圾。
- 改插件内容想在本进程内立即生效:组合行的 `name` 加个查询串换 URL(如 `index.js?v=3`)—— ESM 按 URL 缓存。

---

## 边界

1. 只对 Gradle 类构建生效(其它工具的花式 spinner 不推)。
2. 后端基址必须是本机回环(`127.0.0.1`/`localhost`):通道只信任回环请求。
3. 进度只在**构建进行中**显示,结束即撤下,不留任何痕迹。

## License

MIT
