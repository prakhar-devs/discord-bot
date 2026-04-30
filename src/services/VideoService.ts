import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { exec, execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { CONFIG } from '../config.ts';
import { FileUtils } from '../utils/fileUtils.ts';
import { Logger } from '../utils/logger.ts';

const require = createRequire(import.meta.url);

export class VideoService {
  private static ffmpegPath: string | null = null;

  static initialize() {
    // Try 1: ffmpeg-static
    try {
      const staticPath = require('ffmpeg-static');
      if (staticPath && fs.existsSync(staticPath)) {
        this.ffmpegPath = staticPath;
      }
    } catch { }

    // Try 2: system ffmpeg
    if (!this.ffmpegPath) {
      for (const cmd of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
        try {
          execSync(`"${cmd}" -version`, { stdio: 'ignore' });
          this.ffmpegPath = cmd;
          break;
        } catch { }
      }
    }

    if (this.ffmpegPath) {
      Logger.success(`FFmpeg found: ${this.ffmpegPath}`);
    } else {
      Logger.warn('FFmpeg not found — video processing disabled.');
    }
  }

  static getFFmpegPath(): string | null {
    if (!this.ffmpegPath) this.initialize();
    return this.ffmpegPath;
  }

  static async mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
    const ffmpeg = this.getFFmpegPath();
    if (!ffmpeg) throw new Error('FFmpeg not installed');

    return new Promise((resolve, reject) => {
      const cmd = `"${ffmpeg}" -y -i "${videoPath}" -i "${audioPath}" -c copy -shortest "${outputPath}"`;
      const proc = exec(cmd, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error(`FFmpeg merge failed: ${error.message}`));
        else resolve(outputPath);
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`FFmpeg merge timed out after ${CONFIG.MERGE_TIMEOUT_MS / 1000}s`));
      }, CONFIG.MERGE_TIMEOUT_MS);
    });
  }

  static async getVideoMetadata(inputPath: string, totalSizeBytes: number): Promise<{ duration: number, bitrate: number }> {
    return new Promise((resolve, reject) => {
      exec(`ffprobe -v error -show_entries format=duration,bit_rate -of json "${inputPath}"`, (error, stdout) => {
        if (!error && stdout) {
          try {
            const data = JSON.parse(stdout);
            const duration = parseFloat(data?.format?.duration);
            let bitrate = parseFloat(data?.format?.bit_rate);
            if (duration > 0) {
              if (!bitrate || isNaN(bitrate)) bitrate = (totalSizeBytes * 8) / duration;
              return resolve({ duration, bitrate });
            }
          } catch { }
        }

        const ffmpeg = this.getFFmpegPath();
        if (!ffmpeg) return reject(new Error('FFmpeg not installed'));

        exec(`"${ffmpeg}" -i "${inputPath}"`, (err, out, stderr) => {
          const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
          if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseFloat(match[3]);
            const duration = (hours * 3600) + (minutes * 60) + seconds;
            const bitrate = (totalSizeBytes * 8) / duration;
            resolve({ duration, bitrate });
          } else {
            reject(new Error('Could not parse duration from FFmpeg output'));
          }
        });
      });
    });
  }

  static async getKeyframeTimes(inputPath: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      exec(
        `ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of json "${inputPath}"`,
        { maxBuffer: 10 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return reject(error);
          try {
            const data = JSON.parse(stdout);
            const keyframes = data.packets
              .filter((p: any) => p.flags?.includes('K'))
              .map((p: any) => parseFloat(p.pts_time))
              .filter((t: number) => !isNaN(t));
            resolve(keyframes);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }

  static async splitVideo(
    inputPath: string, 
    keyframeTimes: number[], 
    totalDuration: number, 
    totalSizeBytes: number, 
    tempDir: string
  ): Promise<string[]> {
    const chunks: string[] = [];
    const ffmpeg = this.getFFmpegPath();
    if (!ffmpeg) throw new Error('FFmpeg not installed');

    const bytesPerSecond = totalSizeBytes / totalDuration;
    const targetSizeBytes = 9.8 * 1024 * 1024;

    let currentStart = 0;
    let keyframeIndex = 0;
    let chunkCount = 0;

    while (currentStart < totalDuration - 0.1) {
      // 1. Initial guess based on average bitrate
      let candidateIdx = keyframeIndex + 1;
      while (candidateIdx < keyframeTimes.length) {
        const estDuration = keyframeTimes[candidateIdx] - currentStart;
        if (estDuration * bytesPerSecond > targetSizeBytes) {
          candidateIdx = Math.max(candidateIdx - 1, keyframeIndex + 1);
          break;
        }
        candidateIdx++;
      }

      // 2. Greedy search phase
      let lastGoodPath: string | null = null;
      let lastGoodSize = 0;
      let lastGoodIdx = candidateIdx;

      while (true) {
        const end = (candidateIdx >= keyframeTimes.length) ? totalDuration : keyframeTimes[candidateIdx];
        const trialPath = path.join(tempDir, `trial.mp4`);

        await new Promise<void>((resolve, reject) => {
          const args = ['-y', '-ss', String(currentStart), '-to', String(end), '-i', inputPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', trialPath];
          const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Split failed: ${code}`)));
          proc.on('error', reject);
        });

        const sizeMB = FileUtils.getFileSizeMB(trialPath);

        if (sizeMB <= 9.9) {
          // This fits. Cache it as the best so far.
          if (lastGoodPath) FileUtils.cleanupFile(lastGoodPath);
          lastGoodPath = path.join(tempDir, `best_chunk_${chunkCount}.mp4`);
          fs.renameSync(trialPath, lastGoodPath);
          lastGoodSize = sizeMB;
          lastGoodIdx = candidateIdx;

          if (candidateIdx >= keyframeTimes.length || sizeMB >= 9.6) {
            // Reached end or close enough to 10MB
            break;
          }
          // Try adding more
          Logger.info(`chunk_${chunkCount} is small (${sizeMB.toFixed(2)} MB), trying to add more keyframes...`);
          candidateIdx++;
        } else {
          // Too large!
          if (!lastGoodPath) {
            // We started too high and haven't found a single good segment yet.
            if (candidateIdx === keyframeIndex + 1) {
              // Even a single GOP is too large. We have to take it.
              lastGoodPath = path.join(tempDir, `best_chunk_${chunkCount}.mp4`);
              fs.renameSync(trialPath, lastGoodPath);
              lastGoodSize = sizeMB;
              lastGoodIdx = candidateIdx;
              break;
            }
            // Backtrack and keep looking
            Logger.warn(`chunk_${chunkCount} too large (${sizeMB.toFixed(2)} MB), backtracking...`);
            candidateIdx--;
          } else {
            // We already had a good segment, and this trial made it too large.
            // So the previous segment is the maximum possible.
            FileUtils.cleanupFile(trialPath);
            break;
          }
        }
      }

      // 3. Finalize chunk
      const finalPath = path.join(tempDir, `chunk_${String(chunkCount).padStart(3, '0')}.mp4`);
      fs.renameSync(lastGoodPath!, finalPath);
      
      chunks.push(finalPath);
      const chunkEnd = (lastGoodIdx >= keyframeTimes.length) ? totalDuration : keyframeTimes[lastGoodIdx];
      Logger.success(`chunk_${chunkCount}: ${lastGoodSize.toFixed(2)} MB (${currentStart.toFixed(2)}s → ${chunkEnd.toFixed(2)}s)`);
      
      currentStart = chunkEnd;
      keyframeIndex = lastGoodIdx;
      chunkCount++;
    }

    return chunks;
  }

  static async extractRandomFrames(inputPath: string, duration: number, count: number, tempDir: string): Promise<string[]> {
    const frames: string[] = [];
    const ffmpeg = this.getFFmpegPath();
    if (!ffmpeg) throw new Error('FFmpeg not installed');

    Logger.info(`Extracting ${count} preview frames...`);
    for (let i = 0; i < count; i++) {
      // Pick a random time with a 10% buffer from start/end
      const buffer = duration * 0.1;
      const time = buffer + (Math.random() * (duration - 2 * buffer));
      const outputPath = path.join(tempDir, `frame_${i}.jpg`);

      await new Promise<void>((resolve, reject) => {
        const args = ['-y', '-ss', String(time), '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath];
        const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Frame extraction failed: ${code}`)));
        proc.on('error', reject);
      });

      frames.push(outputPath);
    }
    return frames;
  }
}
