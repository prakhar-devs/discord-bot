export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  REDDIT_COOKIE: process.env.REDDIT_COOKIE || '',
  REDDIT_URL_REGEX: /https?:\/\/(?:www\.)?reddit\.com\/\S+/gi,
  MAX_FILE_SIZE_MB: 8,
  MAX_MERGE_MB: 15,
  MERGE_TIMEOUT_MS: 30000,
  TEMP_DIR: './temp',
  AXIOS_CONFIG: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RedditMediaBot/1.0)',
    },
    timeout: 15000,
  },
  CHUNK_SIZE_LIMIT_MB: 9, // Target chunk size for splitting
  CHUNK_UPLOAD_RETRY_LIMIT: 3,
  CHUNK_UPLOAD_TIMEOUT_MS: 120_000,
  UPLOAD_COOLDOWN_MS: 2000,
  BACKOFF_MS: 5000,
};

if (!CONFIG.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set. Add it to your .env file.');
  process.exit(1);
}

if (!CONFIG.REDDIT_COOKIE) {
  console.warn('⚠️  REDDIT_COOKIE not set — NSFW posts may fail. See .env.example for instructions.');
}
