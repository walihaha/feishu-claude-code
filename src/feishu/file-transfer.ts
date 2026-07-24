import * as fs from 'fs';
import * as path from 'path';
import type { PluginConfig } from '../types';
import { getClient } from './client';
import { logger } from '../logger';

/**
 * 从飞书消息中下载附件（图片/文件/音频/视频），保存到指定目录，返回本地文件路径。
 */
export async function downloadMessageFile(
  config: PluginConfig,
  messageId: string,
  fileKey: string,
  fileType: 'image' | 'file' | 'audio' | 'media',
  destDir: string,
  fileName?: string
): Promise<string> {
  const client = getClient(config);

  await fs.promises.mkdir(destDir, { recursive: true });

  // 根据类型确定默认扩展名
  const defaultExt: Record<string, string> = {
    image: 'jpg',
    file: 'bin',
    audio: 'opus',
    media: 'mp4',
  };
  const safeName = fileName
    ? sanitizeFileName(fileName)
    : `${fileKey}.${defaultExt[fileType] ?? 'bin'}`;
  const destPath = path.join(destDir, safeName);

  // 飞书 messageResource.get 的 type 参数只支持 'image' | 'file'。
  // audio/media 附件必须用 'file'，否则 API 返回错误（参见 OpenClaw #8746）。
  const apiType: 'image' | 'file' = fileType === 'image' ? 'image' : 'file';
  const resource = await client.im.messageResource.get({
    params: { type: apiType },
    path: { message_id: messageId, file_key: fileKey },
  });

  await resource.writeFile(destPath);
  logger.info('File downloaded from message', { fileKey, fileType, destPath });
  return destPath;
}

/**
 * 上传本地文件到飞书，返回 file_key。
 * 支持 pdf/doc/docx/xls/xlsx/ppt/pptx/mp4/opus 及其他通用文件（stream 类型）。
 */
export async function uploadFile(config: PluginConfig, filePath: string): Promise<string> {
  const client = getClient(config);
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);

  const fileTypeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
    opus: 'opus',
    mp4: 'mp4',
    pdf: 'pdf',
    doc: 'doc',
    docx: 'doc',
    xls: 'xls',
    xlsx: 'xls',
    ppt: 'ppt',
    pptx: 'ppt',
  };
  const fileType = fileTypeMap[ext] ?? 'stream';

  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0) throw new Error(`File is empty: ${filePath}`);
  if (stat.size > 30 * 1024 * 1024) throw new Error(`File exceeds 30MB limit: ${filePath}`);

  const fileStream = fs.createReadStream(filePath);
  const resp = await client.im.file.create({
    data: { file_type: fileType, file_name: fileName, file: fileStream },
  });

  const fileKey = resp?.file_key;
  if (!fileKey) throw new Error('Upload returned no file_key');
  logger.info('File uploaded', { filePath, fileKey, fileType });
  return fileKey;
}

/**
 * 上传本地图片到飞书，返回 image_key。
 * 支持 JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO，不超过 10MB。
 */
export async function uploadImage(config: PluginConfig, imagePath: string): Promise<string> {
  const client = getClient(config);

  const stat = await fs.promises.stat(imagePath);
  if (stat.size === 0) throw new Error(`Image is empty: ${imagePath}`);
  if (stat.size > 10 * 1024 * 1024) throw new Error(`Image exceeds 10MB limit: ${imagePath}`);

  const imageStream = fs.createReadStream(imagePath);
  const resp = await client.im.image.create({
    data: { image_type: 'message', image: imageStream },
  });

  const imageKey = resp?.image_key;
  if (!imageKey) throw new Error('Upload returned no image_key');
  logger.info('Image uploaded', { imagePath, imageKey });
  return imageKey;
}

/**
 * 根据文件路径决定是上传图片还是文件，返回 { type, key, msgType }。
 * msgType: 'image' 用于图片消息，'audio' 用于 opus 音频，'file' 用于其他文件。
 */
export async function uploadAuto(
  config: PluginConfig,
  filePath: string
): Promise<{ type: 'image' | 'file'; key: string; msgType: 'image' | 'file' | 'audio' }> {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const imageExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'tif', 'bmp', 'ico']);
  if (imageExts.has(ext)) {
    const key = await uploadImage(config, filePath);
    return { type: 'image', key, msgType: 'image' };
  }
  const key = await uploadFile(config, filePath);
  // opus 音频发送时需用 msg_type='audio'，其余（含 mp4/video）用 'file'
  const msgType = (ext === 'opus' || ext === 'ogg') ? 'audio' : 'file';
  return { type: 'file', key, msgType };
}

/** 去除文件名中的危险字符，防止路径穿越 */
function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[/\\:*?"<>|]/g, '_');
}
