import * as lark from '@larksuiteoapi/node-sdk';
import type { PluginConfig, FeishuCard } from '../types';
import { getClient } from './client';
import { logger } from '../logger';

/**
 * 构造飞书流式输出卡片。
 *
 * 使用 Markdown 元素展示 Claude 输出，header 颜色指示状态：
 *   蓝色  → 处理中
 *   绿色  → 完成
 *   红色  → 出错
 */
export function buildCard(
  content: string,
  status: 'thinking' | 'streaming' | 'done' | 'error',
  meta?: { workdir?: string; duration?: number }
): FeishuCard {
  const headerMap: Record<typeof status, { title: string; color: string }> = {
    thinking: { title: '⏳ Claude Code 思考中…', color: 'blue' },
    streaming: { title: '⚡ Claude Code 输出中…', color: 'turquoise' },
    done: { title: '✅ Claude Code', color: 'green' },
    error: { title: '❌ Claude Code 出错', color: 'red' },
  };

  const { title, color } = headerMap[status];
  const elements: FeishuCard['elements'] = [];

  if (content) {
    elements.push({ tag: 'markdown', content: truncate(content, 4000) });
  } else {
    elements.push({ tag: 'markdown', content: '_等待输出…_' });
  }

  // 底部元数据栏
  const metaParts: string[] = [];
  if (meta?.workdir) metaParts.push(`📂 \`${meta.workdir}\``);
  if (meta?.duration !== undefined) metaParts.push(`⏱ ${(meta.duration / 1000).toFixed(1)}s`);
  if (metaParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: metaParts.join('  |  ') });
  }

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    elements,
  };
}

/** 发送卡片消息，返回 message_id */
export async function sendCard(
  config: PluginConfig,
  chatId: string,
  card: FeishuCard,
  replyMessageId?: string
): Promise<string> {
  const client = getClient(config);

  const msgContent = JSON.stringify({
    type: 'template',
    data: {
      template_id: undefined, // 使用内联卡片，不需要模板 ID
    },
  });

  // 使用内联卡片格式
  const cardJson = JSON.stringify(card);

  try {
    let resp: { data?: { message_id?: string } };

    if (replyMessageId) {
      resp = await client.im.message.reply({
        path: { message_id: replyMessageId },
        data: {
          content: cardJson,
          msg_type: 'interactive',
        },
      });
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardJson,
          msg_type: 'interactive',
        },
      });
    }

    const messageId = resp.data?.message_id ?? '';
    logger.debug('Card sent', { messageId, chatId });
    return messageId;
  } catch (err) {
    logger.error('Failed to send card', { err });
    throw err;
  }
}

/** 更新已有卡片内容 */
export async function updateCard(
  config: PluginConfig,
  messageId: string,
  card: FeishuCard
): Promise<void> {
  const client = getClient(config);
  const cardJson = JSON.stringify(card);

  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
    logger.debug('Card updated', { messageId });
  } catch (err) {
    logger.warn('Failed to update card', { messageId, err });
    // 更新失败不抛出，继续累积内容等待下次更新
  }
}

/** 发送纯文本消息 */
export async function sendText(
  config: PluginConfig,
  chatId: string,
  text: string,
  replyMessageId?: string
): Promise<string> {
  const client = getClient(config);
  const content = JSON.stringify({ text: truncate(text, 4000) });

  try {
    let resp: { data?: { message_id?: string } };

    if (replyMessageId) {
      resp = await client.im.message.reply({
        path: { message_id: replyMessageId },
        data: { content, msg_type: 'text' },
      });
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'text' },
      });
    }

    return resp.data?.message_id ?? '';
  } catch (err) {
    logger.error('Failed to send text', { err });
    throw err;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '…';
}

/** 发送文件消息（需先用 uploadFile 获取 file_key） */
export async function sendFile(
  config: PluginConfig,
  chatId: string,
  fileKey: string,
  replyMessageId?: string,
  msgType: 'file' | 'audio' = 'file'
): Promise<string> {
  const client = getClient(config);
  const content = JSON.stringify({ file_key: fileKey });

  try {
    let resp: { data?: { message_id?: string } };
    if (replyMessageId) {
      resp = await client.im.message.reply({
        path: { message_id: replyMessageId },
        data: { content, msg_type: msgType },
      });
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: msgType },
      });
    }
    const messageId = resp.data?.message_id ?? '';
    logger.debug('File message sent', { messageId, chatId, msgType });
    return messageId;
  } catch (err) {
    logger.error('Failed to send file message', { err });
    throw err;
  }
}

/** 发送图片消息（需先用 uploadImage 获取 image_key） */
export async function sendImage(
  config: PluginConfig,
  chatId: string,
  imageKey: string,
  replyMessageId?: string
): Promise<string> {
  const client = getClient(config);
  const content = JSON.stringify({ image_key: imageKey });

  try {
    let resp: { data?: { message_id?: string } };
    if (replyMessageId) {
      resp = await client.im.message.reply({
        path: { message_id: replyMessageId },
        data: { content, msg_type: 'image' },
      });
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'image' },
      });
    }
    const messageId = resp.data?.message_id ?? '';
    logger.debug('Image message sent', { messageId, chatId });
    return messageId;
  } catch (err) {
    logger.error('Failed to send image message', { err });
    throw err;
  }
}
