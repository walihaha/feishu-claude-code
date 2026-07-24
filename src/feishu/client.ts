import * as lark from '@larksuiteoapi/node-sdk';
import type { PluginConfig } from '../types';
import { logger } from '../logger';

let _client: lark.Client | null = null;

/** 获取飞书 API 客户端单例 */
export function getClient(config: PluginConfig): lark.Client {
  if (_client) return _client;

  const domain = resolveDomain(config.feishu.domain);

  _client = new lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.warn,
  });

  logger.info('Feishu API client created', { appId: config.feishu.appId, domain });
  return _client;
}

/** 创建 WebSocket 客户端 */
export function createWSClient(config: PluginConfig): lark.WSClient {
  return new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });
}

function resolveDomain(domain: string): lark.Domain | string {
  if (domain === 'feishu') return lark.Domain.Feishu;
  if (domain === 'lark') return lark.Domain.Lark;
  return domain; // 自定义私有部署地址
}
