import axios from 'axios';
import { CONFIG } from '../config.ts';

export class RedditService {
  static async resolveShareLink(url: string): Promise<string> {
    if (!url.includes('/s/')) return url;
    try {
      const res = await axios.get(url, { ...CONFIG.AXIOS_CONFIG, maxRedirects: 5 });
      return res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || url;
    } catch {
      return url;
    }
  }

  static async fetchRedditJSON(url: string, { useCookie = false, useOldReddit = false } = {}): Promise<any> {
    const cleanUrl = url.split('?')[0].replace(/\/+$/, '');
    const base = useOldReddit ? cleanUrl.replace('www.reddit.com', 'old.reddit.com') : cleanUrl;
    const jsonUrl = `${base}.json`;

    const headers: any = { 'User-Agent': CONFIG.AXIOS_CONFIG.headers['User-Agent'] };
    if (useCookie && CONFIG.REDDIT_COOKIE) headers['Cookie'] = CONFIG.REDDIT_COOKIE;

    const res = await axios.get(jsonUrl, { headers, timeout: 15000 });
    const post = res.data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error('No post data');
    return post;
  }

  static async getRedditData(url: string): Promise<any> {
    const resolvedUrl = await this.resolveShareLink(url);
    const attempts = [
      { label: 'normal', opts: {} },
      { label: 'cookie', opts: { useCookie: true } },
      { label: 'cookie + old.reddit', opts: { useCookie: true, useOldReddit: true } },
    ];

    for (const { label, opts } of attempts) {
      try {
        const post = await this.fetchRedditJSON(resolvedUrl, opts);
        return post;
      } catch {
        // try next
      }
    }
    throw new Error('Failed to fetch Reddit data');
  }

  static async getRedgifsToken(): Promise<string> {
    const res = await axios.get('https://api.redgifs.com/v2/auth/temporary', {
      headers: { 'User-Agent': CONFIG.AXIOS_CONFIG.headers['User-Agent'] },
    });
    return res.data.token;
  }

  static async getRedgifsVideo(url: string): Promise<string> {
    const id = url.split('?')[0].split('/').pop()?.toLowerCase();
    if (!id) throw new Error('Invalid Redgifs URL');
    const token = await this.getRedgifsToken();
    const res = await axios.get(`https://api.redgifs.com/v2/gifs/${id}`, {
      headers: {
        'User-Agent': CONFIG.AXIOS_CONFIG.headers['User-Agent'],
        'Authorization': `Bearer ${token}`,
      },
    });
    const videoUrl = res.data?.gif?.urls?.hd || res.data?.gif?.urls?.sd;
    if (!videoUrl) throw new Error('No Redgifs video URL');
    return videoUrl;
  }

  static getAudioUrl(videoUrl: string): string {
    return videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4')
      .replace(/DASH_\d+/, 'DASH_AUDIO_128');
  }
}
