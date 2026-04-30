import { Client, GatewayIntentBits } from 'discord.js';
import { CONFIG } from '../config.ts';
import { MessageHandler } from './handlers/MessageHandler.ts';
import { Logger } from '../utils/logger.ts';
import { VideoService } from '../services/VideoService.ts';
import { FileUtils } from '../utils/fileUtils.ts';

export class BotClient {
  private client: Client;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: 60000 },
    });

    this.registerEvents();
  }

  private registerEvents() {
    this.client.once('ready', () => {
      Logger.success(`Bot online as ${this.client.user?.tag}`);
    });

    this.client.on('messageCreate', (message) => MessageHandler.handle(message));
  }

  async start() {
    // Initialize services
    FileUtils.ensureDir(CONFIG.TEMP_DIR);
    VideoService.initialize();

    await this.client.login(CONFIG.BOT_TOKEN);
  }
}
