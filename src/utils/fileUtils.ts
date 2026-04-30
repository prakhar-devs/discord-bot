import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.ts';

export const FileUtils = {
  ensureDir: (dir: string) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },

  getFileSizeMB: (filePath: string): number => {
    const stats = fs.statSync(filePath);
    return stats.size / (1024 * 1024);
  },

  getTempPath: (ext: string): string => {
    return path.join(CONFIG.TEMP_DIR, `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  },

  cleanupFile: (filePath: string) => {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // silent cleanup
    }
  },

  cleanupDir: (dirPath: string) => {
    try {
      if (dirPath && fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {
      // silent cleanup
    }
  }
};
