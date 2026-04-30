import axios from 'axios';
import fs from 'fs';
import { CONFIG } from '../config.ts';

export class DownloadService {
  static async getRemoteFileSize(url: string): Promise<number | null> {
    try {
      const res = await axios.head(url, CONFIG.AXIOS_CONFIG);
      const contentLength = res.headers['content-length'];
      if (!contentLength) return null;
      
      const sizeBytes = Number(contentLength);
      if (isNaN(sizeBytes)) return null;
      
      return sizeBytes / (1024 * 1024);
    } catch {
      return null;
    }
  }

  static async downloadFile(url: string, filePath: string): Promise<string> {
    const res = await axios.get(url, {
      ...CONFIG.AXIOS_CONFIG,
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  }
}
