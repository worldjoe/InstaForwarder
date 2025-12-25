const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const logger = require('./logger');

class WhatsAppClient {
    constructor(options = {}) {
        const executablePath = options.executablePath || process.env.CHROME_EXECUTABLE_PATH;
        const headless = options.headless !== undefined ? options.headless : true;
        const userDataDir = options.userDataDir || path.resolve(process.cwd(), '.wwebjs_cache');
        this.puppeteer = options.puppeteer || {
            headless: false,
            userDataDir,
            ...(executablePath ? { executablePath } : {}),
        };
        this.authStrategy = options.authStrategy;
        this.client = null;
    }

    async init() {
        if (this.client) return;
        this.client = new Client({
            authStrategy: this.authStrategy,
            puppeteer: this.puppeteer,
        });

        return new Promise((resolve, reject) => {
            const onReady = () => {
                this.client.removeListener('auth_failure', onAuthFail);
                resolve();
            };
            const onAuthFail = (msg) => {
                this.client.removeListener('ready', onReady);
                reject(new Error('WhatsApp auth failure: ' + msg));
            };

            this.client.once('ready', onReady);
            this.client.once('auth_failure', onAuthFail);
            this.client.on('disconnected', (reason) => {
                logger.warn('WhatsApp client disconnected', { reason });
            });

            this.client.initialize();
        });
    }

    // filePath: local path to media; to: phone number (e.g. +15551234567) or full chat id (e.g. 15551234567@c.us or group id)
    async sendMediaAsDM(filePath, to) {
        if (!this.client) throw new Error('WhatsApp client not initialized');
        // normalize recipient: if plain phone number provided, convert to WhatsApp id
        let toId = to;
        if (/^\+?\d+$/.test(String(to))) {
            toId = String(to).replace(/\D/g, '') + '@c.us';
        }
        const resolvedPath = path.resolve(process.cwd(), filePath);

        // Check if file is larger than 4MB and re-encode if needed
        let mediaPath = resolvedPath;
        if (fs.existsSync(resolvedPath)) {
            const stats = fs.statSync(resolvedPath);
            const fileSizeInMB = stats.size / (1024 * 1024);
            if (fileSizeInMB > 4) {
                logger.debug('File exceeds 4MB, re-encoding', { file: path.basename(resolvedPath), sizeMB: fileSizeInMB.toFixed(2) });
                mediaPath = await this._reencodeMedia(resolvedPath);
            }
        }
        
        const media = MessageMedia.fromFilePath(mediaPath);
        const result = await this.client.sendMessage(toId, media);
        
        // Zero out the video file after sending to save disk space while keeping the file
        // as a marker to prevent yt-dlp from re-downloading it. yt-dlp checks file existence,
        // not file size, so a 0-byte file will still be recognized as "already downloaded"
        try {
            fs.writeFileSync(resolvedPath, '');
            logger.trace('Zeroed out file', { file: resolvedPath });
        } catch (err) {
            logger.warn('Failed to zero out file', { error: err.message });
        }
        
        return result;
    }

    // Re-encode media to reduce file size using whatsAppReEncode.bat
    async _reencodeMedia(filePath) {
        // First resize the resolution using ffmpeg directly to 320x400 with padding
        // which I believe is the Meta Display's preferred resolution for videos
        let currentPath = filePath;
        
        try {
            const dir = path.dirname(filePath);
            const nameWithoutExt = path.basename(filePath, path.extname(filePath));
            const resizedFile = path.join(dir, `${nameWithoutExt} 45.mp4`);
            
            // ffmpeg -i "%input_file%" -vf "scale=-1:400,pad=320:400:(320-iw)/2:(400-ih)/2:black" -c:v libx265 -tag:v hvc1 -c:a copy "%output_file%"
            const ffmpegCommand = `ffmpeg -i "${filePath}" -vf "scale=-1:400,pad=320:400:(320-iw)/2:(400-ih)/2:black" -c:v libx265 -tag:v hvc1 -c:a copy "${resizedFile}"`;
            logger.debug('Running resize resolution', { command: ffmpegCommand });
            const resizeResult = execSync(ffmpegCommand, { 
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            logger.trace('Resize resolution output', { output: resizeResult });
            
            if (fs.existsSync(resizedFile)) {
                logger.debug('Resized file saved', { file: resizedFile });
                // Rename resized file to overwrite original
                fs.unlinkSync(filePath);
                fs.renameSync(resizedFile, filePath);
                logger.trace('Renamed resized file', { from: resizedFile, to: filePath });
                currentPath = filePath;
            } else {
                logger.warn('Resized file not found, using original for re-encode');
            }
        } catch (err) {
            logger.warn('Resize resolution failed', { error: err.message || err });
        }
        
        // Then re-encode the file so that it's no bigger than 3.5MB. Above that limit you will get a message
        // to open your phone to view large media.
        const targetVideoSizeMB = 3.5;
        const twopass = true;
        
        // Check if file is already small enough
        const stats = fs.statSync(currentPath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        if (fileSizeInMB <= targetVideoSizeMB) {
            logger.debug('File size acceptable, skipping re-encode', { sizeMB: fileSizeInMB.toFixed(2), targetMB: targetVideoSizeMB });
            return filePath;
        }
        
        try {
            // Get audio duration and bitrate using ffprobe
            logger.debug('Probing file for duration and audio bitrate', { file: currentPath });
            
            // Get duration
            const durationOutput = execSync(`ffprobe -v error -show_streams -select_streams a "${currentPath}"`, {
            cwd: process.cwd(),
            encoding: 'utf8'
            });
            const durationMatch = durationOutput.match(/duration=([\d.]+)/);
            if (!durationMatch) {
            throw new Error('Could not determine audio duration');
            }
            const duration = parseFloat(durationMatch[1]);
            logger.trace('File duration', { duration: `${duration}s` });
            
            // Get audio bitrate
            const bitrateOutput = execSync(`ffprobe -v error -pretty -show_streams -select_streams a "${currentPath}"`, {
            cwd: process.cwd(),
            encoding: 'utf8'
            });
            const bitrateMatch = bitrateOutput.match(/bit_rate=(\d+)/);
            if (!bitrateMatch) {
            throw new Error('Could not determine audio bitrate');
            }
            const audioBitrate = parseInt(bitrateMatch[1]) / 1000; // Convert to kbps
            logger.trace('Audio bitrate', { bitrate: `${audioBitrate}k` });
            
            // Calculate target video bitrate
            // Formula: (target_size_MB * 8192) / (1.048576 * duration) - audio_bitrate
            const targetVideoBitrate = Math.floor((targetVideoSizeMB * 8192) / (1.048576 * duration) - audioBitrate);
            logger.debug('Target video bitrate', { bitrate: `${targetVideoBitrate}k` });
            
            // Construct output filename
            const dir = path.dirname(currentPath);
            const nameWithoutExt = path.basename(currentPath, path.extname(currentPath));
            const encodedFile = path.join(dir, `${nameWithoutExt} ${targetVideoSizeMB}MB.mp4`);
            
            // Two-pass encoding if enabled
            if (twopass) {
            logger.debug('Two-Pass Encoding: Pass 1');
            execSync(`ffmpeg -y -i "${currentPath}" -c:v libx264 -b:v ${targetVideoBitrate}k -pass 1 -an -f mp4 nul`, {
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            
            logger.debug('Two-Pass Encoding: Pass 2');
            execSync(`ffmpeg -i "${currentPath}" -c:v libx264 -b:v ${targetVideoBitrate}k -pass 2 -c:a aac -b:a ${audioBitrate}k "${encodedFile}"`, {
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            } else {
            logger.debug('Single-Pass Encoding');
            execSync(`ffmpeg -i "${currentPath}" -c:v libx264 -b:v ${targetVideoBitrate}k -c:a aac -b:a ${audioBitrate}k "${encodedFile}"`, {
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            }
            
            if (fs.existsSync(encodedFile)) {
            logger.debug('Re-encoded file saved', { file: encodedFile });
            // Rename encoded file to overwrite original
            fs.unlinkSync(filePath);
            fs.renameSync(encodedFile, filePath);
            logger.trace('Renamed encoded file', { from: encodedFile, to: filePath });
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

module.exports = WhatsAppClient;