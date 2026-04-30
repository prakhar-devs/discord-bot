import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Message, TextChannel, AttachmentBuilder } from 'discord.js';
import { CONFIG } from '../config.ts';
import { DownloadService } from './DownloadService.ts';
import { VideoService } from './VideoService.ts';
import { FileUtils } from '../utils/fileUtils.ts';
import { Logger } from '../utils/logger.ts';

export class DiscordService {
  static async sendMedia(message: Message, url: string, ext: string, statusMsg: Message | null = null) {
    const sizeMB = await DownloadService.getRemoteFileSize(url);
    const sizeStr = sizeMB !== null ? `${sizeMB.toFixed(2)} MB` : 'unknown';

    if (sizeMB !== null && sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
      Logger.info(`${sizeStr} → sending link (too large)`);
      await message.reply(`📎 File too large (${sizeStr}), here's the link:\n${url}`);
      return;
    }

    if (statusMsg) await statusMsg.edit('📥 Downloading media...');

    Logger.info(`${sizeStr} → uploading to Discord`);
    const filePath = FileUtils.getTempPath(ext);
    try {
      await DownloadService.downloadFile(url, filePath);

      const actualSize = FileUtils.getFileSizeMB(filePath);
      if (actualSize > CONFIG.MAX_FILE_SIZE_MB) {
        Logger.info(`actual ${actualSize.toFixed(2)} MB → sending link instead`);
        await message.reply(`📎 File too large (${actualSize.toFixed(2)} MB), here's the link:\n${url}`);
        return;
      }

      if (statusMsg) await statusMsg.edit('📤 Uploading media...');
      await message.reply({ files: [filePath] });
      Logger.success(`Uploaded (${actualSize.toFixed(2)} MB)`);
    } catch (error: any) {
      Logger.error(`Upload failed → sending link`, error);
      await message.reply(`⚠️ Couldn't upload, here's the link:\n${url}`);
    } finally {
      FileUtils.cleanupFile(filePath);
    }
  }

  static async uploadVideoInChunks(inputPath: string, channel: any, maxChunkSizeMB = 9): Promise<any> {
    if (!fs.existsSync(inputPath)) throw new Error(`Input video not found: ${inputPath}`);

    const absoluteInputPath = path.resolve(inputPath);
    const totalSizeMB = FileUtils.getFileSizeMB(absoluteInputPath);
    const totalSizeBytes = fs.statSync(absoluteInputPath).size;

    const tempDir = path.join('/tmp', `video_chunks_${Date.now()}_${Math.random().toString(36).substring(7)}`);
    FileUtils.ensureDir(tempDir);

    Logger.info(`Initializing Video Uploader`);
    Logger.info(`File: ${path.basename(absoluteInputPath)} | Size: ${totalSizeMB.toFixed(2)} MB`);

    try {
      let duration = 0;
      try {
        const meta = await VideoService.getVideoMetadata(absoluteInputPath, totalSizeBytes);
        duration = meta.duration;
      } catch (err: any) {
        Logger.warn(`Could not get metadata (${err.message}).`);
      }

      Logger.info(`Analyzing keyframes...`);
      const keyframeTimes = await VideoService.getKeyframeTimes(absoluteInputPath);
      
      Logger.info(`Splitting video adaptively...`);
      const chunkFiles = await VideoService.splitVideo(absoluteInputPath, keyframeTimes, duration, totalSizeBytes, tempDir);

      // NEW: Extract frames, upload them, and create a thread for the parts
      let uploadTarget = channel;
      if (channel.isTextBased()) {
        try {
          const frames = await VideoService.extractRandomFrames(absoluteInputPath, duration, CONFIG.FRAME_EXTRACT_COUNT, tempDir);
          const frameFiles = frames.map((f, idx) => ({ attachment: f, name: `preview_${idx}.jpg` }));
          
          const imageMsg = await channel.send({ 
            content: `🎬 **Video Preview** (${chunkFiles.length} parts)`,
            files: frameFiles 
          });
          
          // Use any for thread creation to bypass potential type narrowing issues with partials
          const thread = await (imageMsg as any).startThread({
            name: 'Media',
            autoArchiveDuration: 60,
          });
          
          uploadTarget = thread;
          Logger.success(`Thread 'Media' created for sequential upload.`);
        } catch (threadErr: any) {
          Logger.warn(`Failed to create thread: ${threadErr.message}. Falling back to channel.`);
        }
      }

      Logger.info(`Uploading sequentially to ${uploadTarget.name || 'target'}...`);
      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = chunkFiles[i];
        const fileName = `part_${String(i + 1).padStart(3, '0')}.mp4`;
        const chunkSize = FileUtils.getFileSizeMB(chunkPath);
        
        Logger.info(`Uploading Part ${i + 1}/${chunkFiles.length} (${chunkSize.toFixed(2)} MB)...`);

        let success = false;
        let retries = CONFIG.CHUNK_UPLOAD_RETRY_LIMIT;

        while (!success && retries >= 0) {
          try {
            const fileBuffer = await fsPromises.readFile(chunkPath);
            const uploadPromise = (uploadTarget as any).send({
              content: `🎞️ Part ${i + 1}/${chunkFiles.length}`,
              files: [{ attachment: fileBuffer, name: fileName }]
            });

            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Upload timed out')), CONFIG.CHUNK_UPLOAD_TIMEOUT_MS)
            );

            await Promise.race([uploadPromise, timeoutPromise]);
            success = true;
            Logger.success(`Part ${i + 1} uploaded.`);
            await new Promise(r => setTimeout(r, CONFIG.UPLOAD_COOLDOWN_MS));
          } catch (uploadErr: any) {
            retries--;
            Logger.warn(`Upload failed: ${uploadErr.message}. Retries left: ${retries + 1}`);
            if (retries >= 0) await new Promise(r => setTimeout(r, CONFIG.BACKOFF_MS));
          }
        }

        if (!success) throw new Error(`Failed to upload Part ${i + 1} after all retries.`);
      }
      return uploadTarget;
    } finally {
      FileUtils.cleanupDir(tempDir);
    }
  }
}
