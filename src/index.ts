#!/usr/bin/env node
/**
 * feishu-claude-code
 * ==================
 * 让飞书/Lark 能够远程与 Claude Code 交互的插件服务。
 *
 * 架构：
 *   飞书 WebSocket ──► MessageHandler ──► SessionManager ──► ClaudeProcess (subprocess)
 *                                                        ◄── streaming events
 *   ◄── updateCard (throttled) ──────────────────────────────────────────────────────
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig, validateConfig } from './config';
import { createWSClient } from './feishu/client';
import { MessageHandler } from './feishu/handler';
import { SessionManager } from './claude/session';
import { logger } from './logger';
import { execSync } from 'child_process';

async function main(): Promise<void> {
  // 1. 加载并校验配置
  const config = loadConfig();
  validateConfig(config);

  // 2. 检查 claude CLI 可用性
  checkClaudeCLI(config.claude.bin);

  logger.info('feishu-claude-code starting', {
    appId: config.feishu.appId,
    domain: config.feishu.domain,
    workdir: config.claude.defaultWorkdir,
    requireMention: config.bot.requireMention,
    sessionScope: config.bot.sessionScope,
  });

  // 3. 初始化会话管理器
  const sessionManager = new SessionManager(config);

  // 4. 初始化消息处理器
  const handler = new MessageHandler(config, sessionManager);

  // 5. 创建事件分发器
  const eventDispatcher = new lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey,
    verificationToken: config.feishu.verificationToken,
  }).register({
    'im.message.receive_v1': async (data) => {
      try {
        // @larksuiteoapi/node-sdk 传入 event 字段作为事件数据
        await handler.handle(data as unknown as Record<string, unknown>);
      } catch (err) {
        logger.error('Unhandled error in message handler', { err });
      }
    },
    // 消息已读回执：本项目不需要处理，注册空函数避免 SDK 反复打印警告
    'im.message.message_read_v1': async () => {},
  });

  // 6. 启动 WebSocket 长连接（无需公网地址）
  const wsClient = createWSClient(config);

  wsClient.start({
    eventDispatcher,
  });

  logger.info('✅ Feishu WebSocket connected. Listening for messages…');
  logger.info('   Sessions will be cleaned up after idle timeout:', {
    timeoutMs: config.claude.sessionTimeout,
  });

  // 7. 优雅退出处理
  const shutdown = (sig: string) => {
    logger.info(`Received ${sig}, shutting down…`);
    sessionManager.destroyAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    sessionManager.destroyAll();
    process.exit(1);
  });
}

function checkClaudeCLI(bin: string): void {
  try {
    const version = execSync(`${bin} --version`, { encoding: 'utf-8' }).trim();
    logger.info('Claude CLI found', { version });
  } catch {
    logger.error(
      `Claude CLI not found: "${bin}". ` +
      'Please install Claude Code: https://code.claude.com'
    );
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
