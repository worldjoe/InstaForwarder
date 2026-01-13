const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');
const redgifApi = require('./redgifApi');

const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
const SEEN_FILE = path.resolve(process.cwd(), 'seen.json');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

class RedGifClient {
  constructor() {
    this._token = null;
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
      logger.error('Failed saving seen file', { error: e.message || e });
    }
  }

  // Initialize the redgif library and get access token
  async init() {
    try {
      // Get access token
      this._token = await redgifApi.accessToken();
      if (!this._token) {
        throw new Error('Failed to get RedGif access token');
      }
      logger.debug('RedGif client initialized successfully');
    } catch (error) {
      throw new Error(`Failed to initialize RedGif client: ${error.message}`);
    }
  }

  // Download gifs from creator usernames
  // Returns array of downloaded file paths (may be empty).
  async fetchMediaFromTargets(targets = []) {
    const results = [];
    
    for (const username of targets) {
      try {
        const trimmedUsername = String(username || '').trim().replace(/^@+/, '').toLowerCase();
        if (!trimmedUsername) continue;

        // Small delay to avoid bursts
        await new Promise(r => setTimeout(r, 500));

        const userFolder = path.resolve(DOWNLOADS_DIR, trimmedUsername);
        if (!fs.existsSync(userFolder)) {
          fs.mkdirSync(userFolder, { recursive: true });
        }

        logger.debug('Fetching RedGifs from creator', { username: trimmedUsername });
        
        const maxDownloads = parseInt(process.env.REDGIF_MAX_DOWNLOADS || '3', 10);
        
        // Download creator gifs using the redgif API
        const result = await redgifApi.downloadCreatorGifs(trimmedUsername, {
          downloadDir: DOWNLOADS_DIR,
          order: process.env.REDGIF_ORDER || 'recent',
          type: 'g', // 'g' for gifs/videos
          limit: maxDownloads,
          quality : 'sd'
        });

        // Collect downloaded files, excluding already seen gifs
        if (fs.existsSync(userFolder)) {
          const files = fs.readdirSync(userFolder);
          for (const file of files) {
            const filePath = path.join(userFolder, file);
            const stats = fs.statSync(filePath);
            
            // Extract gif ID from filename (filename format is: {gifId}.mp4)
            const gifId = path.basename(file, path.extname(file));
            
            // Only include files that haven't been seen yet
            const seenKey = `redgif:${trimmedUsername}`;
            if (!this.seen[seenKey] || !this.seen[seenKey].includes(gifId)) {
              if (stats.isFile()) {
                results.push(filePath);
                filePath = await this._reencodeMedia(filePath);
                
                // Mark as seen immediately after adding to results
                if (!this.seen[seenKey]) {
                  this.seen[seenKey] = [];
                }
                if (!this.seen[seenKey].includes(gifId)) {
                  this.seen[seenKey].push(gifId);
                }
              }
            }
          }
          this._saveSeen();
        }
        }   catch (e) {
        logger.error('RedGif fetch error', { target: username, error: e.message || e });
        }
    }
    return results;
    }

  // Re-encode media to optimize for web streaming and optionally remove audio
  async _reencodeMedia(filePath) {
    try {
      const dir = path.dirname(filePath);
      const nameWithoutExt = path.basename(filePath, path.extname(filePath));
      const outputFile = path.join(dir, `${nameWithoutExt}_optimized.mp4`);
      
      // Check if REDGIFS_AUDIO is disabled (false/0)
      const removeAudio = process.env.REDGIFS_AUDIO === '0' || 
                          process.env.REDGIFS_AUDIO === 'false' ||
                          process.env.REDGIFS_AUDIO === 'False' ||
                          process.env.REDGIFS_AUDIO === 'FALSE';
      
      // Build ffmpeg command with web streaming optimizations
      // -movflags +faststart: Move metadata to beginning for faster web playback
      // -c:v libx264: Use H.264 codec for wide compatibility
      // -preset fast: Balance encoding speed vs file size
      // -crf 23: Constant quality (18-28 range, 23 is default)
      const audioOption = removeAudio ? '-an' : '-c:a aac -b:a 128k';
      
      const ffmpegCommand = `ffmpeg -i "${filePath}" -c:v libx264 -preset fast -crf 23 ${audioOption} -movflags +faststart "${outputFile}"`;
      
      logger.debug('Re-encoding video for web streaming', { 
        file: path.basename(filePath), 
        removeAudio,
        command: ffmpegCommand 
      });
      
      execSync(ffmpegCommand, {
        cwd: process.cwd(),
        encoding: 'utf8'
      });
      
      if (fs.existsSync(outputFile)) {
        // Check file sizes
        const originalSize = fs.statSync(filePath).size / (1024 * 1024);
        const newSize = fs.statSync(outputFile).size / (1024 * 1024);
        
        logger.debug('Re-encode complete', { 
          originalSizeMB: originalSize.toFixed(2), 
          newSizeMB: newSize.toFixed(2) 
        });
        
        // Replace original with optimized version
        fs.unlinkSync(filePath);
        fs.renameSync(outputFile, filePath);
        
        return filePath;
      } else {
        logger.warn('Re-encoded file not found, using original');
        return filePath;
      }
    } catch (err) {
      logger.warn('Re-encoding failed', { error: err.message || err });
      return filePath;
    }
  }
}

module.exports = RedGifClient;
