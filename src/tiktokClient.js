const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

class TikTokClient {
  constructor() {
    this._checked = false;
  }

  // verifies yt-dlp is available
  async init() {
    if (this._checked) return;
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', ['--version'], (err, stdout) => {
        this._checked = true;
        if (err) return reject(new Error('yt-dlp not found in PATH; install yt-dlp to use the yt-dlp TikTok client'));
        return resolve(stdout && String(stdout).trim());
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
          execFile('yt-dlp', args, { cwd: process.cwd(), windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
              // yt-dlp exits non-zero if no new files downloaded; still try to parse stdout
              const outLines = stdout ? String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
              return resolve(outLines);
            }
            const outLines = stdout ? String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
            return resolve(outLines);
          });
        });

        // Normalize paths and ensure they exist
        for (const p of filePaths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
          if (fs.existsSync(abs)) results.push(abs);
        }
      } catch (e) {
        console.error('yt-dlp TikTok fetch error for target', t, e && e.message ? e.message : e);
      }
    }
    return results;
  }
}

module.exports = TikTokClient;
