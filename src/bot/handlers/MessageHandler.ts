import fs from 'fs';
import { Message } from 'discord.js';
import { CONFIG } from '../../config.ts';
import { RedditService } from '../../services/RedditService.ts';
import { DiscordService } from '../../services/DiscordService.ts';
import { DownloadService } from '../../services/DownloadService.ts';
import { VideoService } from '../../services/VideoService.ts';
import { FileUtils } from '../../utils/fileUtils.ts';
import { Logger } from '../../utils/logger.ts';

export class MessageHandler {
  static async handle(message: Message) {
    if (message.author.bot) return;

    // Local video upload command
    if (message.content.trim() === 'begin-upload') {
      await this.handleLocalUpload(message);
      return;
    }

    const matches = message.content.match(CONFIG.REDDIT_URL_REGEX);
    if (!matches) return;

    // Suppress embeds
    if (message.guild && message.guild.members.me?.permissions.has('ManageMessages')) {
      try { await message.suppressEmbeds(true); } catch { }
      setTimeout(async () => { try { await message.suppressEmbeds(true); } catch { } }, 1500);
    }

    let statusMsg: Message | null = null;
    if (message.channel.isTextBased()) {
      try {
        statusMsg = await (message.channel as any).send('⏳ Processing media...');
      } catch { }
    }

    for (const redditUrl of matches) {
      try {
        const post = await RedditService.getRedditData(redditUrl);
        await this.processPost(message, post, statusMsg);
        if (statusMsg) await statusMsg.edit(`✅ ${post.title || 'Done'}`);
      } catch (err: any) {
        Logger.error('Failed to process Reddit link', err);
        if (statusMsg) await statusMsg.edit('❌ Failed to process media');
        await message.reply('⚠️ Failed to process Reddit link.');
      }
    }

    if (statusMsg) {
      setTimeout(() => statusMsg?.delete().catch(() => { }), 10000);
    }
  }

  private static async handleLocalUpload(message: Message) {
    const inputPath = './input_videos/test.mp4';
    if (!fs.existsSync(inputPath)) {
      await message.reply('❌ No `test.mp4` found in `input_videos/` folder.');
      return;
    }

    const statusMsg = await message.reply('⏳ Preparing to split and upload local video...');
    try {
      await DiscordService.uploadVideoInChunks(inputPath, message.channel);
      await statusMsg.edit('✅ Finished uploading local video!');
    } catch (err: any) {
      await statusMsg.edit(`❌ Upload failed: ${err.message}`);
    }
  }

  private static async processPost(message: Message, post: any, statusMsg: Message | null) {
    // Image
    if (post.post_hint === 'image') {
      const ext = post.url.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
      await DiscordService.sendMedia(message, post.url, ext, statusMsg);
      return;
    }

    // Video
    if (post.is_video) {
      const fallbackUrl = post.media?.reddit_video?.fallback_url;
      if (!fallbackUrl) {
        await message.reply('ℹ️ Video detected but no URL found.');
        return;
      }
      await this.sendRedditVideo(message, fallbackUrl, statusMsg);
      return;
    }

    // Gallery
    if (post.is_gallery) {
      await this.processGallery(message, post, statusMsg);
      return;
    }

    // Redgifs
    if (post.url?.includes('redgifs.com')) {
      try {
        const videoUrl = await RedditService.getRedgifsVideo(post.url);
        await DiscordService.sendMedia(message, videoUrl, '.mp4', statusMsg);
      } catch {
        await message.reply(`⚠️ Couldn't fetch Redgifs, link: ${post.url}`);
      }
      return;
    }

    await message.reply('ℹ️ No extractable media found.');
  }

  private static async sendRedditVideo(message: Message, fallbackUrl: string, statusMsg: Message | null) {
    const videoPath = FileUtils.getTempPath('.mp4');
    const audioPath = FileUtils.getTempPath('-audio.mp4');
    const mergedPath = FileUtils.getTempPath('-merged.mp4');

    try {
      if (statusMsg) await statusMsg.edit('📥 Downloading media...');

      const remoteSizeMB = await DownloadService.getRemoteFileSize(fallbackUrl);
      if (remoteSizeMB !== null && remoteSizeMB > CONFIG.MAX_MERGE_MB) {
        Logger.info(`${remoteSizeMB.toFixed(2)} MB → too large to process, sending link`);
        await message.reply(`📎 Video too large (${remoteSizeMB.toFixed(2)} MB), here's the link:\n${fallbackUrl}`);
        return;
      }

      Logger.info(`Downloading video...`);
      await DownloadService.downloadFile(fallbackUrl, videoPath);
      const videoSize = FileUtils.getFileSizeMB(videoPath);

      const audioUrl = RedditService.getAudioUrl(fallbackUrl);
      let hasAudio = false;

      try {
        Logger.info(`Downloading audio: ${audioUrl}`);
        await DownloadService.downloadFile(audioUrl, audioPath);
        hasAudio = true;
      } catch {
        Logger.info(`No audio track available (404)`);
      }

      let uploadPath = videoPath;
      if (hasAudio && VideoService.getFFmpegPath()) {
        if (statusMsg) await statusMsg.edit('🔊 Merging audio...');
        try {
          Logger.info(`Merging video + audio...`);
          await VideoService.mergeVideoAudio(videoPath, audioPath, mergedPath);
          uploadPath = mergedPath;
        } catch (err: any) {
          Logger.warn(`Merge failed: ${err.message} — using video only`);
        }
      }

      const finalSize = FileUtils.getFileSizeMB(uploadPath);
      if (finalSize > CONFIG.MAX_FILE_SIZE_MB) {
        try {
          await DiscordService.uploadVideoInChunks(uploadPath, message.channel);
          if (message.channel.isTextBased()) {
            await (message.channel as any).send({ content: `🎬 Full video link: ${fallbackUrl}` });
          }
          return;
        } catch (chunkErr: any) {
          Logger.error('Chunk upload failed', chunkErr);
          await message.reply(`📎 Video splitting failed (${finalSize.toFixed(2)} MB), here's the link:\n${fallbackUrl}`);
          return;
        }
      }

      if (statusMsg) await statusMsg.edit('📤 Uploading media...');
      await message.reply({ files: [uploadPath] });
      Logger.success(`Uploaded (${finalSize.toFixed(2)} MB)`);
    } catch (error: any) {
      Logger.error('Video processing failed', error);
      await message.reply(`⚠️ Couldn't process video, here's the link:\n${fallbackUrl}`);
    } finally {
      FileUtils.cleanupFile(videoPath);
      FileUtils.cleanupFile(audioPath);
      FileUtils.cleanupFile(mergedPath);
    }
  }

  private static async processGallery(message: Message, post: any, statusMsg: Message | null) {
    const items = post.gallery_data?.items ?? [];
    const metadata = post.media_metadata ?? {};
    const urls = items.map((item: any) => {
      const media = metadata[item.media_id];
      return media?.s?.u ? media.s.u.replace(/&amp;/g, '&') : null;
    }).filter(Boolean);

    if (urls.length === 0) {
      await message.reply('ℹ️ Gallery detected but no images found.');
      return;
    }

    if (statusMsg) await statusMsg.edit('📥 Downloading gallery images...');
    const files: string[] = [];
    const oversizeLinks: string[] = [];

    for (const url of urls) {
      const ext = url.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
      const sizeMB = await DownloadService.getRemoteFileSize(url);
      if (sizeMB !== null && sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
        oversizeLinks.push(url);
        continue;
      }
      const filePath = FileUtils.getTempPath(ext);
      try {
        await DownloadService.downloadFile(url, filePath);
        if (FileUtils.getFileSizeMB(filePath) > CONFIG.MAX_FILE_SIZE_MB) {
          oversizeLinks.push(url);
          FileUtils.cleanupFile(filePath);
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
        for (const fp of chunk) FileUtils.cleanupFile(fp);
      }
    }
  }
}
