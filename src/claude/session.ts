import type { PluginConfig, Session } from '../types';
import { ClaudeProcess } from './process';
import { logger } from '../logger';

interface SessionEntry {
  session: Session;
  process: ClaudeProcess;
  timer: NodeJS.Timeout;
}

/**
 * SessionManager 管理每个聊天/用户的 Claude 会话生命周期。
 *
 * 每个会话对应一个持久化的 claude 子进程，支持多轮对话。
 * 超时后自动清理；超过最大并发数时，淘汰最久未活跃的会话。
 */
export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  /** 根据消息信息获取或创建会话 */
  getOrCreate(chatId: string, senderId: string): { session: Session; process: ClaudeProcess } {
    const key = this.makeKey(chatId, senderId);
    const existing = this.sessions.get(key);

    if (existing) {
      this.touch(key, existing);
      return { session: existing.session, process: existing.process };
    }

    return this.create(key, chatId, senderId);
  }

  /** 获取会话（不创建） */
  get(chatId: string, senderId: string): SessionEntry | undefined {
    const key = this.makeKey(chatId, senderId);
    return this.sessions.get(key);
  }

  /** 删除会话（销毁子进程） */
  destroy(chatId: string, senderId: string): void {
    const key = this.makeKey(chatId, senderId);
    const entry = this.sessions.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.process.stop();
    this.sessions.delete(key);
    logger.info('Session destroyed', { key });
  }

  /** 销毁所有会话 */
  destroyAll(): void {
    for (const [key, entry] of this.sessions) {
      clearTimeout(entry.timer);
      entry.process.stop();
      logger.info('Session destroyed on shutdown', { key });
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  // ──────────────────────────────────────────────────────────

  private makeKey(chatId: string, senderId: string): string {
    if (this.config.bot.sessionScope === 'user') {
      return `user:${senderId}`;
    }
    return `chat:${chatId}`;
  }

  private create(key: string, chatId: string, senderId: string): { session: Session; process: ClaudeProcess } {
    // 超过最大并发时淘汰最旧的
    if (this.sessions.size >= this.config.claude.maxSessions) {
      this.evictOldest();
    }

    const workdir = this.resolveWorkdir(chatId, senderId);
    const claudeProc = new ClaudeProcess(
      this.config.claude.bin,
      workdir,
      this.config.claude.extraArgs,
      this.config.claude.permissionMode,
      this.config.claude.systemPrompt
    );

    claudeProc.start();

    const session: Session = {
      sessionId: key,
      chatId,
      senderId,
      workdir,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      processing: false,
    };

    const timer = this.scheduleTimeout(key);
    this.sessions.set(key, { session, process: claudeProc, timer });

    logger.info('Session created', { key, workdir });
    return { session, process: claudeProc };
  }

  private touch(key: string, entry: SessionEntry): void {
    entry.session.lastActiveAt = Date.now();
    clearTimeout(entry.timer);
    entry.timer = this.scheduleTimeout(key);
  }

  private scheduleTimeout(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      const entry = this.sessions.get(key);
      if (!entry) return;
      // 正在处理消息时不超时，重新调度（避免杀死正在工作的子进程）
      if (entry.session.processing) {
        entry.timer = this.scheduleTimeout(key);
        logger.info('Session busy, timeout postponed', { key });
        return;
      }
      logger.info('Session timed out', { key });
      entry.process.stop();
      this.sessions.delete(key);
    }, this.config.claude.sessionTimeout);
  }

  private evictOldest(): void {
    let oldest: [string, SessionEntry] | null = null;
    for (const entry of this.sessions.entries()) {
      if (!oldest || entry[1].session.lastActiveAt < oldest[1].session.lastActiveAt) {
        oldest = entry;
      }
    }
    if (oldest) {
      clearTimeout(oldest[1].timer);
      oldest[1].process.stop();
      this.sessions.delete(oldest[0]);
      logger.info('Session evicted (oldest)', { key: oldest[0] });
    }
  }

  private resolveWorkdir(_chatId: string, _senderId: string): string {
    // 可根据 chatId/senderId 映射不同工作目录；当前统一使用默认目录
    return this.config.claude.defaultWorkdir;
  }
}
