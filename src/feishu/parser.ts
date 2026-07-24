import type { FeishuMessage, FileAttachment } from '../types';
import { logger } from '../logger';

/**
 * 解析飞书 im.message.receive_v1 事件，提取标准化的消息对象。
 */
export function parseMessageEvent(
  event: Record<string, unknown>
): FeishuMessage | null {
  try {
    const msg = event['message'] as Record<string, unknown> | undefined;
    const sender = event['sender'] as Record<string, unknown> | undefined;

    if (!msg || !sender) return null;

    const messageId = msg['message_id'] as string;
    const chatId = msg['chat_id'] as string;
    const chatType = msg['chat_type'] as 'p2p' | 'group';
    const messageType = msg['message_type'] as string;
    const senderId = (sender['sender_id'] as Record<string, string>)?.['open_id'] ?? '';

    if (!messageId || !chatId || !senderId) return null;

    const content = extractContent(msg);
    const fileAttachments = extractFileAttachments(msg);

    // 文件类消息内容可以为空（仅携带附件），文本消息必须有内容
    if (!content && (!fileAttachments || fileAttachments.length === 0)) return null;

    const mentionList = (msg['mentions'] as Array<Record<string, unknown>>) ?? [];
    const mentionBot = mentionList.some(
      (m) => (m['key'] as string)?.startsWith('@_user') || (m['name'] as string) === 'bot'
    );

    return {
      messageId,
      chatId,
      chatType,
      senderId,
      senderName: extractSenderName(sender),
      content: content ?? '',
      messageType,
      rootId: msg['root_id'] as string | undefined,
      parentId: msg['parent_id'] as string | undefined,
      mentionBot,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined,
    };
  } catch (err) {
    logger.warn('Failed to parse message event', { err, event });
    return null;
  }
}

function extractContent(msg: Record<string, unknown>): string | null {
  const messageType = msg['message_type'] as string;
  const rawContent = msg['content'] as string | undefined;
  if (!rawContent) return null;

  try {
    const body = JSON.parse(rawContent);

    switch (messageType) {
      case 'text':
        return (body['text'] as string)?.trim() ?? null;

      case 'post': {
        // 富文本：提取所有 text 节点
        const content = body['content'] as Array<Array<Record<string, unknown>>>;
        const parts: string[] = [];
        for (const line of content ?? []) {
          for (const el of line ?? []) {
            if (el['tag'] === 'text') parts.push(el['text'] as string);
            if (el['tag'] === 'at') parts.push(`@${el['user_name'] ?? el['user_id']}`);
          }
        }
        return parts.join('').trim() || null;
      }

      default:
        return null;
    }
  } catch {
    return rawContent.trim() || null;
  }
}

/** 从飞书消息中提取文件附件信息（image/file/audio/media 类型） */
function extractFileAttachments(msg: Record<string, unknown>): FileAttachment[] {
  const messageType = msg['message_type'] as string;
  const rawContent = msg['content'] as string | undefined;
  if (!rawContent) return [];

  try {
    const body = JSON.parse(rawContent);

    switch (messageType) {
      case 'image': {
        const imageKey = body['image_key'] as string | undefined;
        if (!imageKey) return [];
        return [{ fileKey: imageKey, fileType: 'image' }];
      }
      case 'file': {
        const fileKey = body['file_key'] as string | undefined;
        if (!fileKey) return [];
        return [{
          fileKey,
          fileType: 'file',
          fileName: body['file_name'] as string | undefined,
          fileSize: body['file_size'] ? Number(body['file_size']) : undefined,
        }];
      }
      case 'audio': {
        const fileKey = body['file_key'] as string | undefined;
        if (!fileKey) return [];
        return [{ fileKey, fileType: 'audio' }];
      }
      case 'media': {
        const fileKey = body['file_key'] as string | undefined;
        if (!fileKey) return [];
        return [{
          fileKey,
          fileType: 'media',
          fileName: body['file_name'] as string | undefined,
        }];
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function extractSenderName(sender: Record<string, unknown>): string {
  return (sender['sender_id'] as Record<string, string>)?.['open_id'] ?? 'unknown';
}

/**
 * 去除消息中的 @机器人 提及前缀，以及多余空白。
 */
export function stripBotMention(text: string): string {
  // 飞书 @机器人 格式：<at user_id="ou_xxx">名字</at> 或 @名字 前缀
  return text
    .replace(/@\S+\s*/g, '')
    .replace(/<at[^>]*>.*?<\/at>/g, '')
    .trim();
}
