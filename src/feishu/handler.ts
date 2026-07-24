import type { PluginConfig, FeishuMessage, ClaudeStreamEvent } from '../types';
import { SessionManager } from '../claude/session';
import { parseMessageEvent, stripBotMention } from './parser';
import { buildCard, sendCard, updateCard, sendFile, sendImage } from './sender';
import { downloadMessageFile, uploadAuto } from './file-transfer';
import { logger } from '../logger';
import * as path from 'path';

/**
 * MessageHandler 是核心处理类：
 *   1. 接收飞书事件 → 解析消息
 *   2. 权限检查
 *   3. 路由到 Claude 会话
 *   4. 将 Claude 流式输出实时回写到飞书卡片
 */
export class MessageHandler {
  private readonly config: PluginConfig;
  private readonly sessions: SessionManager;
  /** 已处理消息 ID 缓存，防止飞书 WebSocket 重连时重复投递同一消息 */
  private readonly processedIds = new Map<string, number>();
  /** 缓存保留时间：10 分钟后清理，避免无限增长 */
  private static readonly DEDUP_RETENTION_MS = 10 * 60 * 1000;
  /** 缓存清理间隔 */
  private static readonly DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private lastCleanup = Date.now();

  constructor(config: PluginConfig, sessions: SessionManager) {
    this.config = config;
    this.sessions = sessions;
  }

  /** 飞书 im.message.receive_v1 事件入口 */
  async handle(eventData: Record<string, unknown>): Promise<void> {
    const msg = parseMessageEvent(eventData);
    if (!msg) {
      logger.debug('Ignored unparseable event');
      return;
    }

    // 去重：飞书 WebSocket 重连可能重复投递同一 messageId
    const now = Date.now();
    if (this.processedIds.has(msg.messageId)) {
      logger.debug('Duplicate message ignored', { messageId: msg.messageId });
      return;
    }
    this.processedIds.set(msg.messageId, now);
    this.maybeCleanup(now);

    logger.info('Received message', {
      chatType: msg.chatType,
      chatId: msg.chatId,
      sender: msg.senderId,
      type: msg.messageType,
      mention: msg.mentionBot,
    });

    // 权限过滤
    if (!this.isAllowed(msg)) {
      logger.debug('Message filtered by permission policy', {
        chatId: msg.chatId,
        senderId: msg.senderId,
      });
      return;
    }

    // 群聊中需要 @机器人
    if (msg.chatType === 'group' && this.config.bot.requireMention && !msg.mentionBot) {
      logger.debug('Group message without mention, ignored');
      return;
    }

    const isFileMessage = ['image', 'file', 'audio', 'media'].includes(msg.messageType);
    const isTextMessage = ['text', 'post'].includes(msg.messageType);

    if (!isTextMessage && !isFileMessage) {
      logger.debug('Unsupported message type', { type: msg.messageType });
      return;
    }

    // 构建发送给 Claude 的 prompt
    let prompt = isTextMessage ? stripBotMention(msg.content) : '';

    // 如果携带文件附件，先下载到工作目录，再追加文件信息到 prompt
    if (isFileMessage && msg.fileAttachments?.length) {
      await this.processPrompt(msg, prompt || '请处理我发送的文件。', true);
      return;
    }

    if (!prompt) return;

    await this.processPrompt(msg, prompt, false);
  }

  // ──────────────────────────────────────────────────────────

  private async processPrompt(msg: FeishuMessage, prompt: string, hasFiles: boolean): Promise<void> {
    const { session, process: claudeProc } = this.sessions.getOrCreate(
      msg.chatId,
      msg.senderId
    );

    // 防止并发：同一会话正在处理中
    if (session.processing) {
      logger.warn('Session busy, dropping message', { sessionId: session.sessionId });
      return;
    }

    session.processing = true;
    const startTime = Date.now();

    // 若携带文件附件，先下载到工作目录，将路径追加到 prompt
    if (hasFiles && msg.fileAttachments?.length) {
      const downloadedPaths: string[] = [];
      for (const att of msg.fileAttachments) {
        try {
          const localPath = await downloadMessageFile(
            this.config,
            msg.messageId,
            att.fileKey,
            att.fileType,
            session.workdir,
            att.fileName
          );
          downloadedPaths.push(localPath);
          logger.info('Attachment downloaded', { fileKey: att.fileKey, localPath });
        } catch (err) {
          logger.warn('Failed to download attachment', { fileKey: att.fileKey, err });
        }
      }
      if (downloadedPaths.length > 0) {
        const fileList = downloadedPaths
          .map((p) => `- ${path.relative(session.workdir, p)} (${p})`)
          .join('\n');
        prompt = prompt
          ? `${prompt}\n\n用户同时发送了以下文件（已保存到工作目录）：\n${fileList}`
          : `用户发送了以下文件（已保存到工作目录）：\n${fileList}`;
      }
    }

    // 发送初始"思考中"卡片
    let cardMessageId: string | null = null;
    try {
      const initialCard = buildCard('', 'thinking', { workdir: session.workdir });
      cardMessageId = await sendCard(this.config, msg.chatId, initialCard, msg.messageId);
    } catch (err) {
      logger.error('Failed to send initial card', { err });
      session.processing = false;
      return;
    }

    // 流式累积输出文本
    let accumulated = '';
    let lastUpdateTime = 0;
    const interval = this.config.bot.streamingInterval;

    const throttledUpdate = async (text: string, final: boolean) => {
      const now = Date.now();
      if (!final && now - lastUpdateTime < interval) return;
      lastUpdateTime = now;

      const status = final ? 'done' : 'streaming';
      const card = buildCard(text, status, {
        workdir: session.workdir,
        duration: final ? Date.now() - startTime : undefined,
      });

      if (cardMessageId) {
        await updateCard(this.config, cardMessageId, card);
      }
    };

    try {
      // 若子进程未在运行，重新启动
      if (!claudeProc.isRunning) {
        claudeProc.start();
      }

      // 发送消息并流式读取响应
      for await (const event of claudeProc.sendMessage(prompt)) {

        // stream_event 是 --include-partial-messages 模式下的增量包装
        // 内部 content_block_delta 才是真正的文本增量，用 += 累积
        if (event.type === 'stream_event') {
          const inner = event.event;
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
            accumulated += inner.delta.text ?? '';
            await throttledUpdate(accumulated, false);
          }
        }

        if (event.type === 'result') {
          // result.result 是最终规范文本，始终以它为准
          if (event.result) accumulated = event.result;
          break;
        }

        if (event.type === 'error') {
          const errMsg = event.error ?? 'Unknown error from Claude';
          const errCard = buildCard(`**Error:** ${errMsg}`, 'error', {
            workdir: session.workdir,
          });
          if (cardMessageId) {
            await updateCard(this.config, cardMessageId, errCard);
          }
          logger.error('Claude error event', { error: errMsg });
          return;
        }
      }

      // 最终更新
      await throttledUpdate(accumulated || '_（无输出）_', true);
      logger.info('Response complete', {
        sessionId: session.sessionId,
        duration: Date.now() - startTime,
        length: accumulated.length,
      });

      // 扫描 Claude 输出中的文件发送指令 [[SEND_FILE:/path/to/file]]
      await this.sendOutputFiles(accumulated, msg.chatId, msg.messageId);
    } catch (err) {
      logger.error('Error during Claude processing', { err });
      const errCard = buildCard(
        `**系统错误：** ${(err as Error).message}`,
        'error',
        { workdir: session.workdir }
      );
      if (cardMessageId) {
        await updateCard(this.config, cardMessageId, errCard).catch(() => {});
      }
    } finally {
      session.processing = false;
    }
  }

  private isAllowed(msg: FeishuMessage): boolean {
    const { allowedGroupIds, allowedUserIds } = this.config.bot;

    if (msg.chatType === 'group') {
      if (allowedGroupIds.length > 0 && !allowedGroupIds.includes(msg.chatId)) {
        return false;
      }
    }

    if (allowedUserIds.length > 0 && !allowedUserIds.includes(msg.senderId)) {
      return false;
    }

    return true;
  }

  /** 定期清理过期的去重缓存，防止内存无限增长 */
  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < MessageHandler.DEDUP_CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    const expired = now - MessageHandler.DEDUP_RETENTION_MS;
    for (const [id, ts] of this.processedIds) {
      if (ts < expired) this.processedIds.delete(id);
    }
  }

  /**
   * 扫描 Claude 输出，查找 [[SEND_FILE:/path/to/file]] 标记，
   * 上传对应文件并发送到飞书。
   */
  private async sendOutputFiles(
    text: string,
    chatId: string,
    replyMessageId: string
  ): Promise<void> {
    const pattern = /\[\[SEND_FILE:([^\]]+)\]\]/g;
    let match: RegExpExecArray | null;
    const sent = new Set<string>();

    while ((match = pattern.exec(text)) !== null) {
      const filePath = match[1].trim();
      if (sent.has(filePath)) continue;
      sent.add(filePath);

      try {
        const { type, key, msgType } = await uploadAuto(this.config, filePath);
        if (type === 'image') {
          await sendImage(this.config, chatId, key, replyMessageId);
        } else {
          // msgType 在 type==='file' 分支下只可能是 'file' | 'audio'
          await sendFile(this.config, chatId, key, replyMessageId, msgType as 'file' | 'audio');
        }
        logger.info('Output file sent to Feishu', { filePath, type, key });
      } catch (err) {
        logger.warn('Failed to send output file', { filePath, err });
      }
    }
  }
}

/** 从 assistant 事件（全量快照）中提取文本，备用 */
function extractText(event: ClaudeStreamEvent): string {
  if (event.type !== 'assistant' || !event.message?.content) return '';
  const content = event.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  }
  return '';
}

// 避免 TS unused warning
void extractText;
