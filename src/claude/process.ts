import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { ClaudeStreamEvent } from '../types';
import { logger } from '../logger';

export type ClaudeEventCallback = (event: ClaudeStreamEvent) => void;

/**
 * ClaudeProcess 封装了一个持久化的 claude CLI 子进程。
 *
 * 通信协议：
 *   stdin  → JSON Lines，每行一个 {type:"user", message:{role:"user", content:"..."}}
 *   stdout ← JSON Lines，每行一个流式事件 {type:"assistant"|"result"|"tool_use"|...}
 *
 * 使用 --input-format stream-json --output-format stream-json 模式
 * 以实现多轮对话 + 流式输出。
 */
export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stdoutBuffer = '';
  private running = false;
  private readonly bin: string;
  private readonly workdir: string;
  private readonly extraArgs: string[];
  private readonly permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default';
  private readonly systemPrompt: string;

  constructor(
    bin: string,
    workdir: string,
    extraArgs: string[] = [],
    permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default' = 'bypassPermissions',
    systemPrompt = ''
  ) {
    super();
    this.bin = bin;
    this.workdir = workdir;
    this.extraArgs = extraArgs;
    this.permissionMode = permissionMode;
    this.systemPrompt = systemPrompt;
  }

  /** 启动子进程 */
  start(): void {
    if (this.running) return;

    const permissionArgs = this.buildPermissionArgs();
    // 用 append 而非覆盖：--system-prompt 会替换掉 Claude Code 的全部内置提示词，
    // 导致工具使用/行为规范丢失。这里只是在默认提示词后追加飞书场景约定。
    const systemPromptArgs = this.systemPrompt
      ? ['--append-system-prompt', this.systemPrompt]
      : [];
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...permissionArgs,
      ...systemPromptArgs,
      ...this.extraArgs,
    ];

    logger.debug('Spawning claude process', { bin: this.bin, args, workdir: this.workdir });

    this.proc = spawn(this.bin, args, {
      cwd: this.workdir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.running = true;

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.flushBuffer();
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug('claude stderr', { text });
    });

    this.proc.on('exit', (code, signal) => {
      this.running = false;
      logger.info('Claude process exited', { code, signal });
      this.emit('exit', code, signal);
    });

    this.proc.on('error', (err) => {
      this.running = false;
      logger.error('Claude process error', { err });
      this.emit('error', err);
    });
  }

  /**
   * 发送用户消息，返回 AsyncGenerator 用于消费流式事件。
   *
   * 修复：先注册事件监听，再写 stdin，避免快速响应时的竞态条件。
   */
  async *sendMessage(content: string): AsyncGenerator<ClaudeStreamEvent> {
    if (!this.running || !this.proc) {
      throw new Error('Claude process is not running');
    }

    // ① 先注册监听队列，再写入 stdin，避免竞态丢事件
    const queue: ClaudeStreamEvent[] = [];
    let wakeup: (() => void) | null = null;

    const onEvent = (event: ClaudeStreamEvent) => {
      queue.push(event);
      wakeup?.();
      wakeup = null;
    };

    this.on('event', onEvent);

    try {
      // ② 写入用户消息
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
      });
      this.proc.stdin!.write(msg + '\n');
      logger.debug('Sent message to claude', { length: content.length });

      // ③ 逐个 yield 事件，直到 result / error
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          logger.debug('claude event', { type: event.type, subtype: event.subtype });
          yield event;

          if (event.type === 'result' || event.type === 'error') return;
        }

        if (!this.running) return;

        // 等待下一个事件到达（最长 60 秒，工具调用可能耗时较长）
        await new Promise<void>((res) => {
          wakeup = res;
          setTimeout(() => { wakeup = null; res(); }, 60_000);
        });
      }
    } finally {
      this.off('event', onEvent);
    }
  }

  /** 解析 stdout 缓冲区，逐行 emit 事件 */
  private flushBuffer(): void {
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ClaudeStreamEvent;
        logger.debug('claude event', { type: event.type, subtype: event.subtype });
        this.emit('event', event);
      } catch {
        logger.debug('Non-JSON line from claude', { line: trimmed });
      }
    }
  }

  /** 根据 permissionMode 生成对应的 CLI 参数 */
  private buildPermissionArgs(): string[] {
    switch (this.permissionMode) {
      case 'bypassPermissions':
        return ['--dangerously-skip-permissions'];
      case 'acceptEdits':
        return ['--permission-mode', 'acceptEdits'];
      case 'default':
      default:
        return [];
    }
  }

  /** 优雅停止子进程 */
  stop(): void {
    if (!this.proc || !this.running) return;
    this.proc.stdin!.end();
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.running) this.proc?.kill('SIGKILL');
    }, 3000);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
