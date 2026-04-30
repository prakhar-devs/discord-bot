import { BotClient } from './bot/client.ts';
import { Logger } from './utils/logger.ts';

const bot = new BotClient();

bot.start().catch((err) => {
  Logger.error('Failed to start bot', err);
  process.exit(1);
});
