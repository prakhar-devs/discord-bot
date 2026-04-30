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

  static calculateCutPoints(keyframeTimes: number[], totalDuration: number, totalSizeBytes: number, maxSizeMB: number): number[] {
    const bytesPerSecond = totalSizeBytes / totalDuration;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const cutPoints: number[] = [0];
    let chunkStart = 0;

    for (let i = 1; i < keyframeTimes.length; i++) {
      const chunkDuration = keyframeTimes[i] - chunkStart;
      const estimatedSize = chunkDuration * bytesPerSecond;

      if (estimatedSize > maxSizeBytes) {
        const cutAt = keyframeTimes[i - 1];
        if (cutAt > chunkStart) {
          cutPoints.push(cutAt);
          chunkStart = cutAt;
        }
      }
    }
    return cutPoints;
  }

  static async splitVideo(inputPath: string, cutPoints: number[], totalDuration: number, tempDir: string): Promise<string[]> {
    const chunks: string[] = [];
    const ffmpeg = this.getFFmpegPath();
    if (!ffmpeg) throw new Error('FFmpeg not installed');

    for (let i = 0; i < cutPoints.length; i++) {
      const start = cutPoints[i];
      const end = i + 1 < cutPoints.length ? cutPoints[i + 1] : totalDuration;
      const outputPath = path.join(tempDir, `chunk_${String(i).padStart(3, '0')}.mp4`);

      await new Promise<void>((resolve, reject) => {
        const args = ['-y', '-ss', String(start), '-to', String(end), '-i', inputPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath];
        const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Segment ${i} failed: ${code}`)));
        proc.on('error', reject);
      });

      chunks.push(outputPath);
      Logger.info(`chunk_${i}: ${FileUtils.getFileSizeMB(outputPath).toFixed(2)} MB (${start.toFixed(2)}s → ${end.toFixed(2)}s)`, '✅');
    }
    return chunks;
  }
}
