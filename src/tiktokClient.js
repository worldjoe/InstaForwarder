const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
const SEEN_FILE = path.resolve(process.cwd(), 'tiktok_seen.json');

class TikTokClient {
  constructor() {
    this._checked = false;
    this._ytdlpPath = 'yt-dlp'; // default to PATH
    this.seen = {};
    this._loadSeen();
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
      logger.error('Failed saving TikTok seen file', { error: e.message || e });
    }
  }

  // verifies yt-dlp is available
  async init() {
    if (this._checked) return;
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', ['--version'], (err, stdout) => {
        if (err) {
          logger.warn('yt-dlp not found in PATH; checking current directory');
          // Try running from current directory
          const localPath = path.join(process.cwd(), 'yt-dlp');
          execFile(localPath, ['--version'], (err2, stdout2) => {
        this._checked = true;
        if (err2) return reject(new Error('yt-dlp not found in PATH or current directory; install yt-dlp to use the yt-dlp TikTok client'));
        this._ytdlpPath = localPath; // Store local path for future use
        return resolve(stdout2 && String(stdout2).trim());
          });
        } else {
          this._checked = true;
          this._ytdlpPath = 'yt-dlp'; // Use PATH version
          return resolve(stdout && String(stdout).trim());
        }
      });
    });
  }

  // Run yt-dlp for each target. Targets can be full TikTok URLs or usernames.
  // Returns array of downloaded file paths (may be empty).
  async fetchMediaFromTargets(targets = []) {
    const results = [];
    for (const t of targets) {
      try {
        // small delay to avoid bursts
        await new Promise(r => setTimeout(r, 500));

        let url = String(t || '').trim();
        if (!url) continue;
        if (!url.includes('tiktok.com')) {
          // assume username
          // strip leading @ if present
          const uname = url.replace(/^@+/, '');
          url = `https://www.tiktok.com/@${t}`;
        }
        const userFolder = path.resolve(DOWNLOADS_DIR, t);
        if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });
        // Build yt-dlp args. Use --print to output the downloaded filepath(s).
        const outTemplate = path.join(userFolder, '%(title)s-%(id)s.%(ext)s');
        const maxDownloads = process.env.TIKTOK_MAX_DOWNLOADS || '3';
        const args = [url, '-o', outTemplate, '--no-warnings', '--no-overwrites', '--print', 'after_move:filepath', '--playlist-end', maxDownloads];

        const filePaths = await new Promise((resolve, reject) => {
          const out = [];
          logger.debug('Running yt-dlp', { args, executable: this._ytdlpPath });
          execFile(this._ytdlpPath, args, { cwd: process.cwd(), windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
              logger.error('yt-dlp execution error', { error: err.message || err, stderr: stderr ? String(stderr).trim() : '' });
              // yt-dlp exits non-zero if no new files downloaded; still try to parse stdout
              const outLines = stdout ? String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
              return resolve(outLines);
            }
            const outLines = stdout ? String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
            return resolve(outLines);
          });
        });

        // Normalize paths and collect all downloaded files with their IDs
        const allFiles = [];
        for (const p of filePaths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
          if (fs.existsSync(abs) && fs.statSync(abs).size > 0) {
            // Extract video ID from filename (format: title-ID.ext)
            const filename = path.basename(abs);
            const match = filename.match(/-(\d+)\.\w+$/);
            const videoId = match ? match[1] : filename;
            allFiles.push({ path: abs, id: videoId });
          }
        }

        // Filter out seen videos
        const targetId = String(t);
        const seenForTarget = new Set(this.seen[targetId] || []);
        const newFiles = allFiles.filter(f => !seenForTarget.has(f.id));
        
        if (newFiles.length) {
          this.seen[targetId] = Array.from(new Set([...(this.seen[targetId] || []), ...newFiles.map(f => f.id)]));
          this._saveSeen();
        }

        // mark all as "seen" above, even if we limit them to maxMedia below
        const maxMedia = parseInt(process.env.MAX_TIKTOK_PER_POLL, 10);
        const filtered = isNaN(maxMedia) ? newFiles : newFiles.slice(0, maxMedia);
        results.push(...filtered.map(f => f.path));

      } catch (e) {
        logger.error('TikTok fetch error', { target: t, error: e.message || e });
      }
    }
    return results;
  }
}

module.exports = TikTokClient;
