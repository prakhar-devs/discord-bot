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
    const targetSizeBytes = 9.8 * 1024 * 1024; // Aim for 9.8MB to be safe

    let currentStart = 0;
    let keyframeIndex = 0;
    let chunkCount = 0;

    while (currentStart < totalDuration - 0.1) {
      // 1. Find a candidate keyframe based on average bitrate estimation
      let candidateIdx = keyframeIndex + 1;
      while (candidateIdx < keyframeTimes.length) {
        const estDuration = keyframeTimes[candidateIdx] - currentStart;
        if (estDuration * bytesPerSecond > targetSizeBytes) {
          // Go back one if the estimation exceeded target
          candidateIdx = Math.max(candidateIdx - 1, keyframeIndex + 1);
          break;
        }
        candidateIdx++;
      }

      // 2. Iteratively refine the cut point by checking actual file size
      let success = false;
      while (candidateIdx > keyframeIndex) {
        const end = (candidateIdx >= keyframeTimes.length) ? totalDuration : keyframeTimes[candidateIdx];
        const outputPath = path.join(tempDir, `chunk_${String(chunkCount).padStart(3, '0')}.mp4`);

        await new Promise<void>((resolve, reject) => {
          const args = ['-y', '-ss', String(currentStart), '-to', String(end), '-i', inputPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath];
          const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Split failed: ${code}`)));
          proc.on('error', reject);
        });

        const sizeMB = FileUtils.getFileSizeMB(outputPath);
        if (sizeMB <= 9.9 || candidateIdx === keyframeIndex + 1) {
          // Success! Either it fits, or it's the smallest possible GOP (which we must keep)
          chunks.push(outputPath);
          Logger.success(`chunk_${chunkCount}: ${sizeMB.toFixed(2)} MB (${currentStart.toFixed(2)}s → ${end.toFixed(2)}s)`);
          
          currentStart = end;
          keyframeIndex = candidateIdx;
          chunkCount++;
          success = true;
          break;
        } else {
          // Too large! Backtrack one keyframe and try again
          Logger.warn(`chunk_${chunkCount} too large (${sizeMB.toFixed(2)} MB), backtracking one keyframe...`);
          candidateIdx--;
        }
      }

      if (!success) {
        // This only happens if a single GOP is somehow larger than 10MB
        // For now, we'll break to avoid infinite loop, but in production we might re-encode
        Logger.error('Could not find a valid split point for GOP.');
        break;
      }
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
