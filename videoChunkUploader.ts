import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn, exec } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let FFMPEG_PATH: string | null = null;
try {
  const staticPath = require('ffmpeg-static');
  if (staticPath && fs.existsSync(staticPath)) {
    FFMPEG_PATH = staticPath;
  }
} catch { }

if (!FFMPEG_PATH) {
  for (const cmd of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      import('child_process').then(cp => cp.execSync(`"${cmd}" -version`, { stdio: 'ignore' }));
      FFMPEG_PATH = cmd;
      break;
    } catch { }
  }
}

export interface UploadOptions {
  inputPath: string;
  channel: any; // Discord channel
  maxChunkSizeMB?: number;
  enableTestMode?: boolean;
}

/**
 * Get video metadata (duration and bitrate) using ffprobe or ffmpeg.
 */
function getVideoMetadata(inputPath: string, totalSizeBytes: number): Promise<{ duration: number, bitrate: number }> {
  return new Promise((resolve, reject) => {
    // Attempt 1: Use ffprobe if available
    exec(`ffprobe -v error -show_entries format=duration,bit_rate -of json "${inputPath}"`, (error, stdout) => {
      if (!error && stdout) {
        try {
          const data = JSON.parse(stdout);
          const duration = parseFloat(data?.format?.duration);
          let bitrate = parseFloat(data?.format?.bit_rate);
          if (duration > 0) {
            if (!bitrate || isNaN(bitrate)) {
              bitrate = (totalSizeBytes * 8) / duration;
            }
            return resolve({ duration, bitrate });
          }
        } catch { }
      }

      // Attempt 2: Fallback to ffmpeg
      if (!FFMPEG_PATH) return reject(new Error('FFmpeg not installed'));

      exec(`"${FFMPEG_PATH}" -i "${inputPath}"`, (err, out, stderr) => {
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

function getFileSizeMB(filePath: string): number {
  const stats = fs.statSync(filePath);
  return stats.size / (1024 * 1024);
}

function getKeyframeTimes(inputPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of json "${inputPath}"`,
      { maxBuffer: 10 * 1024 * 1024 }, // Fix: Added maxBuffer to prevent crash on large videos
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

function calculateCutPoints(
  keyframeTimes: number[],
  totalDuration: number,
  totalSizeBytes: number,
  maxSizeMB: number
): number[] {
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

async function splitByKeyframeCutPoints(
  inputPath: string,
  cutPoints: number[],
  totalDuration: number,
  tempDir: string
): Promise<string[]> {
  const chunks: string[] = [];

  for (let i = 0; i < cutPoints.length; i++) {
    const start = cutPoints[i];
    const end = i + 1 < cutPoints.length ? cutPoints[i + 1] : totalDuration;
    const outputPath = path.join(tempDir, `chunk_${String(i).padStart(3, '0')}.mp4`);

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-ss', String(start),
        '-to', String(end),
        '-i', inputPath,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        outputPath
      ];
      const ffmpeg = spawn(FFMPEG_PATH!, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Segment ${i} failed: ${code}`)));
      ffmpeg.on('error', reject);
    });

    chunks.push(outputPath);
    console.log(`✅ chunk_${i}: ${getFileSizeMB(outputPath).toFixed(2)} MB (${start.toFixed(2)}s → ${end.toFixed(2)}s)`);
  }

  return chunks;
}

/**
 * Core chunking and upload logic.
 */
export async function uploadVideoInChunks(options: UploadOptions): Promise<void> {
  const { inputPath, channel, maxChunkSizeMB = 9, enableTestMode = false } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input video not found: ${inputPath}`);
  }

  const absoluteInputPath = path.resolve(inputPath);
  const totalSizeMB = getFileSizeMB(absoluteInputPath);
  const totalSizeBytes = fs.statSync(absoluteInputPath).size;

  const tempDir = path.join('/tmp', `video_chunks_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  console.log(`\n📦 Initializing Video Uploader [${enableTestMode ? 'TEST MODE' : 'LIVE'}]`);
  console.log(`📄 Input: ${path.basename(absoluteInputPath)}`);
  console.log(`📏 Size: ${totalSizeMB.toFixed(2)} MB`);

  try {
    let duration = 0;
    let bitrate = 0;
    try {
      const meta = await getVideoMetadata(absoluteInputPath, totalSizeBytes);
      duration = meta.duration;
      bitrate = meta.bitrate;
    } catch (err: any) {
      console.warn(`⚠️ Could not get metadata (${err.message}). Using fallback split time.`);
    }

    const estimatedParts = Math.ceil(totalSizeMB / maxChunkSizeMB);
    console.log(`⏱️ Duration: ${duration.toFixed(2)}s | Target Segment: ~${(duration / estimatedParts).toFixed(2)}s`);
    console.log(`🎯 Estimated parts: ~${estimatedParts}`);

    if (!FFMPEG_PATH) throw new Error('FFmpeg is required but not installed.');

    let chunkFiles: string[] = [];

    console.log(`🔍 Analyzing keyframes...`);
    const keyframeTimes = await getKeyframeTimes(absoluteInputPath);
    console.log(`🎯 Found ${keyframeTimes.length} keyframes`);

    const cutPoints = calculateCutPoints(keyframeTimes, duration, totalSizeBytes, 9.5);
    console.log(`✂️ Splitting into ${cutPoints.length} chunks...`);

    chunkFiles = await splitByKeyframeCutPoints(absoluteInputPath, cutPoints, duration, tempDir);
    console.log(`✅ Splitting complete. Generated ${chunkFiles.length} chunks.`);

    if (enableTestMode) {
      console.log(`🧪 Test Mode Enabled: Skipping upload to Discord.`);
      return;
    }

    console.log(`📤 Uploading sequentially to Discord...`);
    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkPath = chunkFiles[i];
      const fileName = `part_${String(i + 1).padStart(3, '0')}.mp4`;
      console.log(`   ⬆️ Uploading Part ${i + 1}/${chunkFiles.length} (${getFileSizeMB(chunkPath).toFixed(2)} MB)...`);

      let success = false;
      let retries = 3;

      while (!success && retries >= 0) {
        try {
          // Read into buffer to avoid stream timeout issues with large files
          const fileBuffer = await fsPromises.readFile(chunkPath);

          const uploadPromise = channel.send({
            content: `🎞️ Part ${i + 1}/${chunkFiles.length}`,
            files: [{ attachment: fileBuffer, name: fileName }]
          });

          // Give Discord up to 2 minutes per chunk upload
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Upload timed out after 120s')), 120_000)
          );

          await Promise.race([uploadPromise, timeoutPromise]);
          success = true;
          console.log(`   ✅ Part ${i + 1} uploaded.`);
          await new Promise(r => setTimeout(r, 2000)); // 2s cooldown between uploads
        } catch (uploadErr: any) {
          retries--;
          console.warn(`   ⚠️ Upload failed: ${uploadErr.message}. Retries left: ${retries + 1}`);
          if (retries >= 0) await new Promise(r => setTimeout(r, 5000)); // 5s backoff
        }
      }

      if (!success) {
        throw new Error(`Failed to upload Part ${i + 1} after all retries.`);
      }
    }
    console.log(`🎉 All chunks uploaded successfully!`);

  } finally {
    console.log(`🧹 Cleaning up temporary files...`);
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      console.log(`✅ Cleanup complete.\n`);
    } catch (err: any) {
      console.error(`❌ Cleanup failed: ${err.message}`);
    }
  }
}
