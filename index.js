/**
 * build-progress —— 极简推送:只把「构建进度条那一行」实时推给前端。
 * ===========================================================================
 * 唯一需求:构建 APK 时,前端能在会话流的折叠工具条标题处**原地刷新**看到构建进度。
 *
 * 因此本插件**只做三件事**,没有任何多余东西:
 *   ① 只认构建命令(gradle/gradlew):给活跃的 subprocess 服务实例的 spawn 打一层可逆补丁;
 *   ② 从它的 stdout 增量里**只抽最后一行进度**(如 `<=====> 73% EXECUTING [1m 32s]`),
 *      变化才推;推的帧里**不含命令原文、不含输出正文**;
 *   ③ 自建 WebSocket `/api/build-progress` 推送(前端连上即收到当前状态,连不上就算了)。
 *
 * 明确不做(与上一版被回滚的 console-tap 的区别):
 *   · 不落任何日志文件(没有 console-logs、没有留档)
 *   · 不留历史(内存里每条构建只保留"当前一行",进程结束即丢)
 *   · 不推 stdout/stderr 正文,不做命令/会话身份的展示(只带 callId 用于**定位**到哪一行工具)
 *   · 没有浏览器侧 bundle(前端是 APP,不需要 WebUI 客户端)
 *
 * 挂载说明(实测踩过的坑,保留最小实现):启动路径下 Cordis 会按声明式 inject 等服务就位再调 apply;
 * 而**补丁层热插入**的条目 Cordis 不会调 apply,所以这里在 import 时自举挂载(拿 root ctx,
 * 等 webServer + subprocess 就位后再挂),拿到即还原原型。
 */

import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';

export const name = 'build-progress';


/**
 * 上下文注入:把"怎么看得到构建进度条"这两条前提**持久化**成运行时要求。
 *
 * 为什么必须注入而不是只写文档:
 *   ① `--console=plain` 下 Gradle 根本不画进度条(只有一行一个 `> Task :x`),助手很可能默认就这么跑;
 *   ② 一旦写了 `> log.txt` 或 `| tail`,那段输出就不流经进程 stdout,插件采集不到 → 界面上永远没有进度条。
 *   这两件事都发生在"助手决定怎么跑命令"的那一刻,所以要求只能放在模型每轮都能看到的运行时上下文里。
 *
 * 机制与官方 `file-output-format` 插件同一套:`ctx.inject(['systemPrompt'], …)` 等到服务就绪后
 * `systemPrompt.context({ name, order, text })` 注册一个片段,每次组装提示词时按 order 并入
 * (GUI 的「上下文注入」块里能看到)。order 130 排在 sandbox:policy(110)、file-output-format(120)之后。
 */
const CONTEXT_TEXT = [
  '【构建进度可视化要求】',
  '当你要执行构建类命令(Gradle:`assembleDebug`/`assembleRelease`/`bundle*`,以及其它耗时较长的构建)时,必须满足下面两条,否则用户看不到构建进度条:',
  '1. 必须让 Gradle 画进度条(rich 控制台 + pty 包装;非交互环境 Gradle 只在 TTY 下画进度条):',
  '   `TERM=xterm-256color script -q -f -c "gradle assembleDebug --console=rich" /dev/null`',
  '   不要用 `--console=plain` —— 它只输出一行一个 `> Task :x`,没有进度条。`script` 的 `/dev/null` 是 typescript 文件,会话内容仍会回显到 stdout,所以进度条照样能被采集。',
  '2. 不要重定向或接管道:`> log.txt`、`| tail`、`| grep` 都会让那段输出不再流经进程 stdout,进度条就采集不到(实测踩过)。要看尾部结果,等构建结束后再单独 `tail`/`cat` 日志文件。',
  '需要长时间可观察的进度时可加 `--rerun-tasks`(全量重跑,进度条持续推进)。',
].join('\n');

/** 声明式 inject:等服务就位再 apply(否则全新启动时 apply 早于服务注册)。 */
export const inject = ['webServer', 'subprocess'];

/** 只在"构建类"命令上工作(用户就这一个场景)。 */
const BUILD_CMD = /\b(gradlew|gradle)\b/;
/** Gradle 进度行:rich 控制台是 `<=====> 73% EXECUTING [1m 32s]`;plain 控制台没有进度行(那就什么都不推)。 */
const PROGRESS = /<\s*[-=]+>\s*(\d{1,3})%\s*([A-Z]+)(?:\s*\[([^\]]+)\])?/g;
/**
 * Gradle 的收尾行:`BUILD SUCCESSFUL in 2m 23s` / `BUILD FAILED in 1m 2s`。
 * 构建结束那一刻,这一行比任何自己拼的文案都准(时长是 Gradle 自己算的),
 * 所以优先用它作为"常驻收尾行"的文本。
 */
const BUILD_RESULT = /BUILD (SUCCESSFUL|FAILED)(?: in ([^\n\r]*))?/g;
/** 只看流末尾这么长的一段(进度行总在最新位置)。 */
const TAIL_BYTES = 8192;
/** 采集间隔(ms)。 */
const POLL_MS = 150;

let mounted = false;

export function apply(ctx) {
  mount(ctx, 'apply');
}

function mount(ctx, via) {
  if (mounted) return;
  mounted = true;
  const tap = new BuildProgress(ctx);
  try {
    tap.attachSubprocess();
    // 会话事件:只有这里能给出 (sessionId, callId, 命令原文) —— 前端要靠 callId 把进度画到
    // "哪一行工具"的折叠标题上;少了它进度就无处安放(实测第一版漏了,帧里 callId 为空)。
    ctx.effect(
      () => ctx.on('session/event', (session, event) => tap.onSessionEvent(session, event)),
      'build-progress: tool/call 关联',
    );
    tap.registerRoute();
    tap.startPolling();
    // 上下文注入:把"必须 rich+pty、不许重定向/管道"写成模型每轮都能看到的运行时要求
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({ name: 'build-progress', order: 130, text: CONTEXT_TEXT });
    });
    tap.log(`build-progress: 已挂载(via=${via}, path=${tap.path})`);
  } catch (error) {
    tap.log(`build-progress: 挂载失败(${String(error)})`);
  }
}

class BuildProgress {
  constructor(ctx) {
    this.ctx = ctx;
    this.path = '/api/build-progress';
    this.logger = ctx?.logger;
    /** WebSocket 订阅者。 */
    this.clients = new Set();
    /** 每条构建:当前一行 + 我们自己的读取游标。 */
    this.builds = new Map();
    /** tool/call 事件给出的 (sessionId, callId, command),用于把 spawn 对到具体那次工具调用。 */
    this.calls = [];
    this.pollTimer = null;
  }

  log(message) {
    try {
      this.logger?.info?.(message);
    } catch {
      // 日志失败不影响功能
    }
  }

  /** 只给活跃的 subprocess 服务实例的 spawn 打一层可逆补丁(不替换任何组合行)。 */
  attachSubprocess() {
    const rt = this.ctx.get('subprocess');
    if (rt === undefined || typeof rt.spawn !== 'function') {
      this.log('build-progress: 拿不到 subprocess.spawn,未接管');
      return () => {};
    }
    const original = rt.spawn;
    const self = this;
    const patched = function patchedSpawn(spec, ...rest) {
      const handle = original.call(this, spec, ...rest);
      try {
        self.track(spec, handle);
      } catch {
        // 采集失败绝不影响命令执行
      }
      return handle;
    };
    patched.__buildProgressPatched = true;
    rt.spawn = patched;
    return () => {
      if (rt.spawn === patched) rt.spawn = original;
    };
  }

  /** 命令原文(bash 工具把命令原样交给 bash -c,末位参数就是它)。 */
  commandOf(spec) {
    const argv = Array.isArray(spec?.argv) ? spec.argv : [];
    return argv.length === 0 ? '' : String(argv[argv.length - 1]);
  }

  track(spec, handle) {
    const command = this.commandOf(spec);
    if (!BUILD_CMD.test(command)) return;
    const reader = handle?.collected?.stdout;
    if (reader === undefined || typeof reader.readFrom !== 'function') return;
    // 认领身份:tool/call 里命令原文等值匹配(只为了拿到 callId 定位到哪一行工具)
    const index = this.calls.findIndex((c) => c.command === command);
    const hit = index === -1 ? null : this.calls.splice(index, 1)[0];
    const rec = {
      key: String(this.builds.size) + ':' + Date.now(),
      callId: hit?.callId ?? '',
      sessionId: hit?.sessionId ?? '',
      reader,
      offset: 0,
      tail: '',
      text: '',
      percent: 0,
      phase: '',
      elapsed: '',
      done: false,
    };
    this.builds.set(rec.key, rec);
    if (handle?.done !== undefined && typeof handle.done.then === 'function') {
      handle.done.then(
        (outcome) => this.finish(rec, outcome),
        () => this.finish(rec, {}),
      );
    }
  }

  /** 会话事件:记下 tool/call 的 (sessionId, callId, command),给 identity 用。 */
  onSessionEvent(session, event) {
    if (event?.type !== 'tool/call') return;
    const data = event.data ?? {};
    let args = {};
    try {
      args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : (data.arguments ?? {});
    } catch {
      args = {};
    }
    const command = typeof args?.command === 'string' ? args.command : '';
    this.calls.push({
      sessionId: session?.id ?? '',
      callId: data.callId ?? '',
      command,
      at: Date.now(),
    });
    // 只保留最近 20 条(不缓存历史)
    if (this.calls.length > 20) this.calls.splice(0, this.calls.length - 20);
  }

  startPolling() {
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.pollTimer.unref?.();
    return () => {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.pollTimer = null;
    };
  }

  /** 读一次新增输出并追加到 tail;读完返回 false。poll 与 finish 共用。 */
  drain(rec) {
    try {
      const read = rec.reader.readFrom(rec.offset);
      if (read === undefined || read === null) return false;
      rec.offset = read.nextOffset ?? rec.offset;
      const text = typeof read.text === 'string' ? read.text : '';
      if (text.length === 0) return false;
      rec.tail = (rec.tail + text).slice(-TAIL_BYTES);
      return true;
    } catch {
      return false;
    }
  }

  poll() {
    if (this.builds.size === 0) return;
    for (const rec of this.builds.values()) {
      if (rec.done) continue;
      if (!this.drain(rec)) continue;
      const line = lastProgress(rec.tail);
      if (line !== null && line.text !== rec.text) {
        rec.text = line.text;
        rec.percent = line.percent;
        rec.phase = line.phase;
        rec.elapsed = line.elapsed;
        this.broadcast({
          type: 'build-progress',
          callId: rec.callId,
          sessionId: rec.sessionId,
          text: line.text,
          percent: line.percent,
          phase: line.phase,
          elapsed: line.elapsed,
        });
      }
    }
  }

  /**
   * 构建结束。
   *
   * 用户明确要求(2026-09-18):"构建完成后进度条不要立刻消失,要持久一点"。
   * 所以这里不再只发一个"撤下"信号,而是给出**收尾行**文本:
   *   ① 优先 Gradle 自己的收尾行 `✅ BUILD SUCCESSFUL in 2m 23s`(时长由 Gradle 计算,最可信);
   *   ② 拿不到(被中断/超时/输出被重定向)就用最后一帧进度 + 退出码拼一句;
   *   ③ 既没有进度帧也没有收尾行(例如只是跑 `gradle --version`)→ text 为空,
   *      前端按老行为撤下进度行,不在非构建场景里留一行莫名其妙的字。
   * 前端收到后把这一行**留在折叠标题位置**直到应用重启/会话重载,不再随帧刷新。
   */
  finish(rec, outcome) {
    if (rec.done) return;
    rec.done = true;
    this.builds.delete(rec.key);
    // 结束前把最后一段输出读完:进度行和 Gradle 收尾行常常就在这最后一段里,
    // 不读完会漏掉最有用的那一行(实测 poll 周期 150ms,结束信号可能先到)。
    for (let i = 0; i < 4; i += 1) {
      if (!this.drain(rec)) break;
    }
    const line = lastProgress(rec.tail);
    if (line !== null) {
      rec.text = line.text;
      rec.percent = line.percent;
      rec.phase = line.phase;
      rec.elapsed = line.elapsed;
    }
    const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null;
    const ok = exitCode === 0;
    this.broadcast({
      type: 'build-done',
      callId: rec.callId,
      sessionId: rec.sessionId,
      exitCode,
      ok,
      text: finalLine(rec, exitCode),
      percent: rec.percent,
      elapsed: rec.elapsed,
    });
  }

  /** 自建下行通道(官方 registerUpgrade,与 /api/events.mux 同一套 API)。 */
  registerRoute() {
    const wss = new WebSocketServer({ noServer: true });
    const webServer = this.ctx.get('webServer');
    if (webServer === undefined || typeof webServer.registerUpgrade !== 'function') {
      this.log('build-progress: 拿不到 webServer.registerUpgrade,推送通道未建立');
      return () => {};
    }
    // 上一实例(热重载残留)若还占着同一路径,先回收,否则官方会以"重复路由"抛错
    try {
      if (webServer.upgrades?.has?.(this.path)) webServer.upgrades.delete(this.path);
    } catch {
      // 回收失败就让它去抛,下面会兜住
    }
    const dispose = webServer.registerUpgrade({
      path: this.path,
      handler: (req, socket, head) => {
        if (!isLoopback(req)) {
          try {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          } catch {
            // 忽略
          }
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.clients.add(ws);
          try {
            ws.send(JSON.stringify({
              type: 'hello',
              version: 1,
              builds: [...this.builds.values()]
                .filter((r) => r.text !== '')
                .map((r) => ({ callId: r.callId, sessionId: r.sessionId, text: r.text, percent: r.percent, phase: r.phase, elapsed: r.elapsed })),
            }));
          } catch {
            // 忽略
          }
          ws.on('close', () => this.clients.delete(ws));
          ws.on('error', () => this.clients.delete(ws));
        });
      },
    });
    return () => {
      dispose?.();
      for (const ws of this.clients) {
        try {
          ws.close();
        } catch {
          // 忽略
        }
      }
      this.clients.clear();
    };
  }

  broadcast(frame) {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(frame);
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1) ws.send(text);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}

/**
 * 取流末尾最后一行 Gradle 进度。
 * 先剥 ANSI(rich 控制台把 `<===>` 拆成好几段并夹带颜色/光标序列),再取**最后一次**匹配。
 * @returns {{text:string,percent:number,phase:string,elapsed:string}|null}
 */
function lastProgress(raw) {
  const clean = stripAnsi(raw);
  PROGRESS.lastIndex = 0;
  let hit = null;
  let m;
  while ((m = PROGRESS.exec(clean)) !== null) hit = m;
  if (hit === null) return null;
  return {
    text: hit[0].replace(/\s+/g, ' ').trim(),
    percent: Number(hit[1]),
    phase: hit[2],
    elapsed: hit[3] ?? '',
  };
}

/**
 * 构建收尾行(留在前端折叠标题位置的那一行)。没有可说的内容时返回 ''。
 * @returns {string}
 */
function finalLine(rec, exitCode) {
  const clean = stripAnsi(rec.tail);
  BUILD_RESULT.lastIndex = 0;
  let hit = null;
  let m;
  while ((m = BUILD_RESULT.exec(clean)) !== null) hit = m; // 取最后一次(重跑/多模块时以最终结论为准)
  if (hit !== null) {
    const verdict = hit[1] === 'SUCCESSFUL';
    const dur = String(hit[2] ?? '').replace(/\s+/g, ' ').trim();
    return `${verdict ? '✅' : '❌'} BUILD ${hit[1]}${dur === '' ? '' : ` in ${dur}`}`;
  }
  if (rec.text === '') return ''; // 既没进度也没收尾行:交给前端按老行为撤下
  if (exitCode === null) return `⚠️ 构建中断 · ${rec.text}`;
  if (exitCode === 0) return `✅ 构建完成 · ${rec.text}`;
  return `❌ 构建失败 (exit ${exitCode}) · ${rec.text}`;
}

/** 剔除 ANSI 转义(CSI/OSC;含光标移动与擦除行,只留可见文本)。 */
function stripAnsi(text) {
  return text
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}

/** 只信任本机回环(Host 必须是回环地址;有 Origin 时必须同源)。 */
function isLoopback(req) {
  const host = String(req?.headers?.host ?? '');
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false;
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 自举挂载:补丁层**热插入**的条目不会拿到 apply(父 include 事务不 settle),
// 所以 import 时自己找 root ctx:Context.prototype.extend/isolate/intercept 是 cordis 里
// 稳定可达的原型方法,钩子里拿 this.root,轮询到两个服务就位再挂。
// ---------------------------------------------------------------------------
function bootstrap() {
  if (mounted) return;
  const names = ['extend', 'isolate', 'intercept'];
  const originals = new Map();
  let candidate = null;
  let settled = false;
  let timer = null;
  const restore = () => {
    for (const [key, fn] of originals) {
      if (Context.prototype[key]?.__bpHook) Context.prototype[key] = fn;
    }
    originals.clear();
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const ready = () => {
    try {
      return candidate !== null
        && candidate.get?.('webServer') !== undefined
        && candidate.get?.('subprocess') !== undefined;
    } catch {
      return false;
    }
  };
  const attempt = () => {
    if (mounted) { settled = true; restore(); return; }
    if (!ready()) return;
    settled = true;
    restore();
    try {
      mount(candidate, 'self-mount');
    } catch {
      // 挂载失败不影响命令执行
    }
  };
  for (const key of names) {
    const original = Context.prototype[key];
    if (typeof original !== 'function') continue;
    originals.set(key, original);
    const patched = function (...args) {
      try {
        if (!settled && candidate === null) {
          const ctx = this?.root ?? this;
          if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') candidate = ctx;
        }
      } catch {
        // 忽略
      }
      return original.apply(this, args);
    };
    patched.__bpHook = true;
    Context.prototype[key] = patched;
  }
  timer = setInterval(attempt, 200);
  timer.unref?.();
  setTimeout(() => { if (!settled) restore(); }, 120_000).unref?.();
}

try {
  bootstrap();
} catch {
  // 自举失败不影响 DSH 本体
}
