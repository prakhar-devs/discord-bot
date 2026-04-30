import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { uploadVideoInChunks } from './videoChunkUploader.ts';

// ─── Configuration ───────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const REDDIT_COOKIE = process.env.REDDIT_COOKIE || '';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set. Add it to your .env file.');
  process.exit(1);
}

if (!REDDIT_COOKIE) {
  console.warn('⚠️  REDDIT_COOKIE not set — NSFW posts may fail. See .env.example for instructions.');
}

const REDDIT_URL_REGEX = /https?:\/\/(?:www\.)?reddit\.com\/\S+/gi;
const MAX_FILE_SIZE_MB = 8;
const MAX_MERGE_MB = 15;
const MERGE_TIMEOUT_MS = 30000;
const TEMP_DIR = './temp';

const AXIOS_CONFIG = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; RedditMediaBot/1.0)',
  },
  timeout: 15000,
};

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── FFmpeg Detection ────────────────────────────────────────────────────────

let FFMPEG_PATH = null;

// Try 1: ffmpeg-static npm package
try {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const staticPath = require('ffmpeg-static');
  if (staticPath && fs.existsSync(staticPath)) {
    FFMPEG_PATH = staticPath;
  }
} catch {
  // not installed
}

// Try 2: system ffmpeg
if (!FFMPEG_PATH) {
  for (const cmd of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      execSync(`"${cmd}" -version`, { stdio: 'ignore' });
      FFMPEG_PATH = cmd;
      break;
    } catch {
      // try next
    }
  }
}

if (FFMPEG_PATH) {
  console.log(`🎥 FFmpeg found: ${FFMPEG_PATH}`);
} else {
  console.warn('⚠️  FFmpeg not found — video+audio merge disabled.');
  console.warn('   Install: npm install ffmpeg-static');
}

// ─── Discord Client ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest: { timeout: 60000 }, // Prevent "This operation was aborted" on slow uploads
});

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Get file size in MB via HEAD request. Returns null if unavailable.
 */
async function getFileSize(url) {
  try {
    const res = await axios.head(url, AXIOS_CONFIG);
    const contentLength = res.headers['content-length'];
    if (!contentLength) return null;
    return parseInt(contentLength, 10) / (1024 * 1024);
  } catch {
    return null;
  }
}

/**
 * Download a file to a local temp path. Returns the path.
 */
async function downloadFile(url, filePath) {
  const res = await axios.get(url, {
    ...AXIOS_CONFIG,
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  fs.writeFileSync(filePath, Buffer.from(res.data));
  return filePath;
}

/**
 * Safely delete a temp file.
 */
function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // silent cleanup
  }
}

/**
 * Generate a unique temp file path.
 */
function tempPath(ext) {
  return path.join(TEMP_DIR, `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
}

/**
 * Get local file size in MB.
 */
function localSize(filePath) {
  return fs.statSync(filePath).size / (1024 * 1024);
}

// ─── FFmpeg Merge ────────────────────────────────────────────────────────────

/**
 * Merge video and audio files using FFmpeg.
 * Uses -c copy for fast muxing (no re-encoding).
 */
function mergeVideoAudio(videoPath, audioPath, outputPath) {
  if (!FFMPEG_PATH) {
    return Promise.reject(new Error('FFmpeg not installed'));
  }

  return new Promise((resolve, reject) => {
    const cmd = `"${FFMPEG_PATH}" -y -i "${videoPath}" -i "${audioPath}" -c copy -shortest "${outputPath}"`;

    const proc = exec(cmd, (error) => {
      clearTimeout(timer);
      if (error) {
        reject(new Error(`FFmpeg merge failed: ${error.message}`));
      } else {
        resolve(outputPath);
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`FFmpeg merge timed out after ${MERGE_TIMEOUT_MS / 1000}s`));
    }, MERGE_TIMEOUT_MS);
  });
}

/**
 * Derive audio URL from a Reddit video fallback URL.
 */
function getAudioUrl(videoUrl) {
  return videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4')
    .replace(/DASH_\d+/, 'DASH_AUDIO_128');
}

// ─── Media Sending ───────────────────────────────────────────────────────────

/**
 * Try to upload a file to Discord. Falls back to sending the URL on failure.
 */
async function sendMedia(message, url, ext, statusMsg = null) {
  const sizeMB = await getFileSize(url);
  const sizeStr = sizeMB !== null ? `${sizeMB.toFixed(2)} MB` : 'unknown';

  if (sizeMB !== null && sizeMB > MAX_FILE_SIZE_MB) {
    console.log(`   📏 ${sizeStr} → sending link (too large)`);
    await message.reply(`📎 File too large (${sizeStr}), here's the link:\n${url}`);
    return;
  }

  if (statusMsg) await statusMsg.edit('📥 Downloading media...');

  console.log(`   📏 ${sizeStr} → uploading to Discord`);
  const filePath = tempPath(ext);
  try {
    await downloadFile(url, filePath);

    const actualSize = localSize(filePath);
    if (actualSize > MAX_FILE_SIZE_MB) {
      console.log(`   📏 actual ${actualSize.toFixed(2)} MB → sending link instead`);
      await message.reply(`📎 File too large (${actualSize.toFixed(2)} MB), here's the link:\n${url}`);
      return;
    }

    if (statusMsg) await statusMsg.edit('📤 Uploading media...');
    await message.reply({ files: [filePath] });
    console.log(`   ✅ Uploaded (${actualSize.toFixed(2)} MB)`);
  } catch (error) {
    console.error(`   ❌ Upload failed → sending link: ${error.message}`);
    await message.reply(`⚠️ Couldn't upload, here's the link:\n${url}`);
  } finally {
    cleanupFile(filePath);
  }
}

/**
 * Download Reddit video, try to merge audio, and upload.
 */
async function sendRedditVideo(message, fallbackUrl, statusMsg = null) {
  const videoPath = tempPath('.mp4');
  const audioPath = tempPath('-audio.mp4');
  const mergedPath = tempPath('-merged.mp4');

  try {
    if (statusMsg) await statusMsg.edit('📥 Downloading media...');

    const remoteSizeMB = await getFileSize(fallbackUrl);
    if (remoteSizeMB !== null && remoteSizeMB > MAX_MERGE_MB) {
      console.log(`   📏 ${remoteSizeMB.toFixed(2)} MB → too large to process, sending link`);
      await message.reply(`📎 Video too large (${remoteSizeMB.toFixed(2)} MB), here's the link:\n${fallbackUrl}`);
      return;
    }

    console.log(`   ⬇️  Downloading video...`);
    await downloadFile(fallbackUrl, videoPath);
    const videoSize = localSize(videoPath);
    console.log(`   📏 Video: ${videoSize.toFixed(2)} MB`);

    const audioUrl = getAudioUrl(fallbackUrl);
    let hasAudio = false;

    try {
      console.log(`   🔊 Downloading audio: ${audioUrl}`);
      await downloadFile(audioUrl, audioPath);
      hasAudio = true;
      console.log(`   🔊 Audio: ${localSize(audioPath).toFixed(2)} MB`);
    } catch {
      console.log(`   🔇 No audio track available (404)`);
    }

    let uploadPath = videoPath;

    if (hasAudio && FFMPEG_PATH) {
      if (statusMsg) await statusMsg.edit('🔊 Merging audio...');
      try {
        console.log(`   🔀 Merging video + audio...`);
        await mergeVideoAudio(videoPath, audioPath, mergedPath);
        uploadPath = mergedPath;
      } catch (err) {
        console.log(`   ⚠️  Merge failed: ${err.message} — using video only`);
        uploadPath = videoPath;
      }
    }

    const finalSize = localSize(uploadPath);
    if (finalSize > MAX_FILE_SIZE_MB) {
      try {
        await uploadVideoInChunks({
          inputPath: uploadPath,
          channel: message.channel,
          maxChunkSizeMB: 9,
          enableTestMode: false
        });
        // Send fallback link alongside the chunks
        await message.channel.send({ content: `🎬 Full video link: ${fallbackUrl}` });
        return;
      } catch (chunkErr) {
        console.error(`   ❌ Chunk upload failed: ${chunkErr.message}`);
        console.log(`   📏 ${finalSize.toFixed(2)} MB → sending link instead`);
        await message.reply(`📎 Video splitting failed (${finalSize.toFixed(2)} MB), here's the link:\n${fallbackUrl}`);
        return;
      }
    }

    if (statusMsg) await statusMsg.edit('📤 Uploading media...');
    console.log(`   ⬆️  Uploading ${hasAudio && uploadPath === mergedPath ? '(with audio)' : '(video only)'}...`);
    await message.reply({ files: [uploadPath] });
    console.log(`   ✅ Uploaded (${finalSize.toFixed(2)} MB)`);

  } catch (error) {
    console.error(`   ❌ Video processing failed: ${error.message}`);
    await message.reply(`⚠️ Couldn't process video, here's the link:\n${fallbackUrl}`);
  } finally {
    cleanupFile(videoPath);
    cleanupFile(audioPath);
    cleanupFile(mergedPath);
  }
}

// ─── Reddit Helpers ──────────────────────────────────────────────────────────

async function resolveShareLink(url) {
  if (!url.includes('/s/')) return url;
  try {
    const res = await axios.get(url, { ...AXIOS_CONFIG, maxRedirects: 5 });
    const resolved = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || url;
    return resolved;
  } catch {
    return url;
  }
}

async function fetchRedditJSON(url, { useCookie = false, useOldReddit = false } = {}) {
  const cleanUrl = url.split('?')[0].replace(/\/+$/, '');
  const base = useOldReddit ? cleanUrl.replace('www.reddit.com', 'old.reddit.com') : cleanUrl;
  const jsonUrl = `${base}.json`;

  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; RedditMediaBot/1.0)' };
  if (useCookie && REDDIT_COOKIE) headers['Cookie'] = REDDIT_COOKIE;

  const res = await axios.get(jsonUrl, { headers, timeout: 15000 });
  const post = res.data?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error('No post data');
  return post;
}

async function getRedditData(url) {
  const resolvedUrl = await resolveShareLink(url);
  const attempts = [
    { label: 'normal', opts: {} },
    { label: 'cookie', opts: { useCookie: true } },
    { label: 'cookie + old.reddit', opts: { useCookie: true, useOldReddit: true } },
  ];

  for (const { label, opts } of attempts) {
    try {
      const post = await fetchRedditJSON(resolvedUrl, opts);
      return post;
    } catch {
      // try next
    }
  }
  throw new Error('Failed to fetch Reddit data');
}

async function getRedgifsToken() {
  const res = await axios.get('https://api.redgifs.com/v2/auth/temporary', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RedditMediaBot/1.0)' },
  });
  return res.data.token;
}

async function getRedgifsVideo(url) {
  const id = url.split('?')[0].split('/').pop().toLowerCase();
  const token = await getRedgifsToken();
  const res = await axios.get(`https://api.redgifs.com/v2/gifs/${id}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RedditMediaBot/1.0)',
      'Authorization': `Bearer ${token}`,
    },
  });
  const videoUrl = res.data?.gif?.urls?.hd || res.data?.gif?.urls?.sd;
  if (!videoUrl) throw new Error('No Redgifs video URL');
  return videoUrl;
}

async function processPost(message, post, statusMsg = null) {
  // ── Image ──
  if (post.post_hint === 'image') {
    const ext = post.url.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
    await sendMedia(message, post.url, ext, statusMsg);
    return;
  }

  // ── Video ──
  if (post.is_video) {
    const fallbackUrl = post.media?.reddit_video?.fallback_url;
    if (!fallbackUrl) {
      await message.reply('ℹ️ Video detected but no URL found.');
      return;
    }
    await sendRedditVideo(message, fallbackUrl, statusMsg);
    return;
  }

  // ── Gallery ──
  if (post.is_gallery) {
    const items = post.gallery_data?.items ?? [];
    const metadata = post.media_metadata ?? {};
    const urls = items.map(item => {
      const media = metadata[item.media_id];
      return media?.s?.u ? media.s.u.replace(/&amp;/g, '&') : null;
    }).filter(Boolean);

    if (urls.length === 0) {
      await message.reply('ℹ️ Gallery detected but no images found.');
      return;
    }

    if (statusMsg) await statusMsg.edit('📥 Downloading gallery images...');
    const files = [];
    const oversizeLinks = [];

    for (const url of urls) {
      const ext = url.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
      const sizeMB = await getFileSize(url);
      if (sizeMB !== null && sizeMB > MAX_FILE_SIZE_MB) {
        oversizeLinks.push(url);
        continue;
      }
      const filePath = tempPath(ext);
      try {
        await downloadFile(url, filePath);
        if (localSize(filePath) > MAX_FILE_SIZE_MB) {
          oversizeLinks.push(url);
          cleanupFile(filePath);
        } else {
          files.push(filePath);
        }
      } catch {
        oversizeLinks.push(url);
      }
    }

    for (const link of oversizeLinks) {
      await message.reply(`📎 File too large, here's the link:\n${link}`);
    }

    if (files.length > 0) {
      if (statusMsg) await statusMsg.edit('📤 Uploading gallery...');
      for (let i = 0; i < files.length; i += 10) {
        const chunk = files.slice(i, i + 10);
        await message.reply({ files: chunk });
        for (const fp of chunk) cleanupFile(fp);
      }
    }
    return;
  }

  // ── Redgifs ──
  if (post.url?.includes('redgifs.com')) {
    try {
      const videoUrl = await getRedgifsVideo(post.url);
      await sendMedia(message, videoUrl, '.mp4', statusMsg);
    } catch {
      await message.reply(`⚠️ Couldn't fetch Redgifs, link: ${post.url}`);
    }
    return;
  }

  await message.reply('ℹ️ No extractable media found.');
}

// ─── Events ──────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.trim() === 'begin-upload') {
    const inputPath = './input_videos/test.mp4';
    if (!fs.existsSync(inputPath)) {
      await message.reply('❌ No `test.mp4` found in `input_videos/` folder.');
      return;
    }

    const statusMsg = await message.reply('⏳ Preparing to split and upload local video...');
    try {
      await uploadVideoInChunks({
        inputPath,
        channel: message.channel,
        maxChunkSizeMB: 9,
        enableTestMode: false
      });
      await statusMsg.edit('✅ Finished uploading local video!');
    } catch (err) {
      await statusMsg.edit(`❌ Upload failed: ${err.message}`);
    }
    return;
  }

  const matches = message.content.match(REDDIT_URL_REGEX);
  if (!matches) return;

  // Suppress embeds
  if (message.guild && message.guild.members.me?.permissions.has('ManageMessages')) {
    try { await message.suppressEmbeds(true); } catch { }
    setTimeout(async () => { try { await message.suppressEmbeds(true); } catch { } }, 1500);
  }

  let statusMsg;
  try {
    statusMsg = await message.channel.send('⏳ Processing media...');
  } catch {
    // skip status if permission missing
  }

  for (const redditUrl of matches) {
    try {
      const post = await getRedditData(redditUrl);
      await processPost(message, post, statusMsg);
      if (statusMsg) await statusMsg.edit(`✅ ${post.title || 'Done'}`);
    } catch (err) {
      if (statusMsg) await statusMsg.edit('❌ Failed to process media');
      await message.reply('⚠️ Failed to process Reddit link.');
    }
  }

  if (statusMsg) {
    setTimeout(() => statusMsg.delete().catch(() => { }), 10000);
  }
});

client.login(BOT_TOKEN);
