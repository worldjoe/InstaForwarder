const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
//import { TwitterV2IncludesHelper } from 'twitter-api-v2';

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
const SEEN_FILE = path.resolve(process.cwd(), 'seen.json');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

class TwitterClient {
  constructor() {
    this.client = null;
    this.seen = {};
    this._loadSeen();
  }

  async init() {
    const bearer = process.env.TWITTER_BEARER_TOKEN;
    if (!bearer) throw new Error('Missing TWITTER_BEARER_TOKEN in .env');
    this.client = new TwitterApi(bearer);
  }

  async _downloadUrl(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
    return new Promise((resolve, reject) => {
      res.data.pipe(writer);
      let error = null;
      writer.on('error', err => { error = err; writer.close(); reject(err); });
      writer.on('close', () => { if (!error) resolve(destPath); });
    });
  }

  async _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _loadSeen() {
    try {
      if (fs.existsSync(SEEN_FILE)) {
        this.seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {};
      } else {
        this.seen = {};
      }
    } catch (e) {
      this.seen = {};
    }
  }

  _saveSeen() {
    try {
      fs.writeFileSync(SEEN_FILE, JSON.stringify(this.seen, null, 2));
    } catch (e) {
      console.error('Failed saving seen file', e);
    }
  }

  async fetchMediaFromUser(username, maxCount = 200) {
    if (!this.client) throw new Error('Twitter client not initialized');
    const out = [];
    await this._ensureDir(DOWNLOADS_DIR);
    const userDir = path.join(DOWNLOADS_DIR, username.replace(/[^a-z0-9_-]/gi, '_'));
    await this._ensureDir(userDir);

    const seenForUser = new Set(this.seen[String(username)] || []);
    let sawNew = false;

    // Resolve username to user id (v2 endpoints require user id)
    let tweets = [];
    let userId = username;
    if (!/^\d+$/.test(String(username))) {
      try {
        const u = await this.client.v2.userByUsername(username);
        userId = u && u.data && u.data.id;
        if (!userId) {
          console.error('Failed resolving user id for', username);
          return out;
        }
      } catch (err) {
        console.error('Failed resolving username', username, err && err.message ? err.message : err);
        return out;
      }
    }
    // ensure userId is a string
    userId = String(userId);

    try {
      tweets = await this.client.v2.userTimeline(userId, {
        expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id'],
        'media.fields': ['media_key', 'url', 'type', 'variants'],
        max_results: Math.min(Math.max(5, maxCount), 100)
      });
    } catch (e) {
      // improved debug output for 400s
      if (e && e.data) {
        console.error('Twitter fetch failed for', username, e.code || e.status, e.data);
      } else {
        console.error('Twitter fetch failed for', username, e && e.message ? e.message : e);
      }
      return;
    }

    // build media map from includes for quick lookup
    const includes = (tweets && tweets.includes) || {};
    const mediaArr = includes.media || [];
    const mediaMap = new Map((mediaArr || []).map(m => [m.media_key, m]));

    for await (const tweet of tweets) {
      if (seenForUser.has(String(tweet.id))) continue;
      const medias = (tweet.attachments?.media_keys || []).map(key => mediaMap.get(key)).filter(Boolean);
      let hadMedia = false;
      for (const media of medias) {
        const url = media.url;
        const ext = path.extname(url).split('?')[0] || '.jpg';
        const fileName = `${tweet.id}_${media.media_key}${ext}`;
        const dest = path.join(userDir, fileName);
        if (!fs.existsSync(dest)) await this._downloadUrl(url, dest);
        out.push(dest);
        hadMedia = true;
      }
      if (hadMedia) {
        seenForUser.add(String(tweet.id));
        sawNew = true;
      }
    }
/*
    for (const t of tweets) {
      const entities = t.extended_entities || t.entities;
      if (!entities || !entities.media) continue;
      for (const m of entities.media) {
        try {
          if (m.type === 'photo') {
            const url = m.media_url_https || m.media_url;
            const ext = path.extname(url).split('?')[0] || '.jpg';
            const fileName = `${t.id_str}_${m.id_str}${ext}`;
            const dest = path.join(userDir, fileName);
            if (!fs.existsSync(dest)) await this._downloadUrl(url, dest);
            out.push(dest);
          } else if (m.type === 'video' || m.type === 'animated_gif') {
            const variants = (m.video_info && m.video_info.variants) || [];
            const mp4s = variants.filter(v => v.content_type === 'video/mp4');
            if (!mp4s.length) continue;
            // choose highest bitrate
            const best = mp4s.reduce((a, b) => ( (a.bitrate||0) > (b.bitrate||0) ? a : b ));
            const url = best.url;
            const fileName = `${t.id_str}_${m.id_str}.mp4`;
            const dest = path.join(userDir, fileName);
            if (!fs.existsSync(dest)) await this._downloadUrl(url, dest);
            out.push(dest);
          }
        } catch (e) {
          console.error('Failed processing media', e && e.message ? e.message : e);
        }
      }
    }
*/
    if (sawNew) {
      this.seen[String(username)] = Array.from(seenForUser);
      this._saveSeen();
    }

    return out;
  }

  // Download media from a list of twitter usernames (comma-separated string)
  async fetchMediaFromTargets(commaSeparated) {
    const names = (commaSeparated || '').split(',').map(s => s.trim()).filter(Boolean);
    const all = [];
    for (const n of names) {
      try {
        const files = await this.fetchMediaFromUser(n);
        all.push(...files);
      } catch (e) {
        console.error('Error fetching for', n, e && e.message ? e.message : e);
      }
    }
    return all;
  }

  // Forward downloaded files to Instagram via provided igClient instance
  async forwardFilesToInstagram(filePaths, igClient, toUsername) {
    const results = [];
    for (const f of filePaths) {
      try {
        const ok = await igClient.sendMediaAsDM(f, toUsername);
        results.push({ file: f, ok });
      } catch (e) {
        results.push({ file: f, ok: false, error: e.message || e });
      }
    }
    return results;
  }
}

module.exports = TwitterClient;
