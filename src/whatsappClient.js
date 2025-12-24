const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

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
                console.warn('WhatsApp client disconnected', reason);
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
                onsole.log(`File ${path.basename(resolvedPath)} is ${fileSizeInMB.toFixed(2)}MB (> 4MB), re-encoding...`);
                mediaPath = await this._reencodeMedia(resolvedPath);
            }
        }
        
        const media = MessageMedia.fromFilePath(mediaPath);
        return this.client.sendMessage(toId, media);
    }

    // Re-encode media to reduce file size using whatsAppReEncode.bat
    async _reencodeMedia(filePath) {
        // First resize the resolution
        const resizeBatchFile = path.resolve(process.cwd(), 'src', 'resizeResolution.bat');
        let currentPath = filePath;
        
        if (fs.existsSync(resizeBatchFile)) {
            try {
            const resizeCommand = `"${resizeBatchFile}" "${filePath}"`;
            console.log(`Running resize resolution: ${resizeCommand}`);
            const resizeResult = execSync(resizeCommand, { 
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            console.log('Resize resolution output:', resizeResult);
            
            // Construct the expected output filename from resize
            const dir = path.dirname(filePath);
            const nameWithoutExt = path.basename(filePath, path.extname(filePath));
            const resizedFile = path.join(dir, `${nameWithoutExt} 45.mp4`);
            
            if (fs.existsSync(resizedFile)) {
                console.log(`Resized file saved to: ${resizedFile}`);
                currentPath = resizedFile;
            } else {
                console.warn('Resized file not found, using original for re-encode');
            }
            } catch (err) {
            console.warn('Resize resolution failed:', err.message || err);
            }
        } else {
            console.warn('resizeResolution.bat not found, skipping resolution resize');
        }
        
        // Then re-encode the file (using resized version if available)
        const batchFile = path.resolve(process.cwd(), 'src', 'whatsAppReEncode.bat');
        if (!fs.existsSync(batchFile)) {
            console.warn('whatsAppReEncode.bat not found, sending original file');
            return filePath;
        }

        
        try {
            // Run the batch file with target size of 4MB
            // Use execSync with manual quoting to properly handle spaces in file paths
            const command = `"${batchFile}" "${currentPath}" 3.5`;
            console.log(`Running re-encode: ${command}`);
            const result = execSync(command, { 
                cwd: process.cwd(),
                encoding: 'utf8'
            });
            console.log('Re-encode command output:', result);
            
            // Construct the expected output filename (from the batch script logic)
            const dir = path.dirname(currentPath);
            const nameWithoutExt = path.basename(currentPath, path.extname(currentPath));
            const encodedFile = path.join(dir, `${nameWithoutExt} 4MB.mp4`);
            
            if (fs.existsSync(encodedFile)) {
                console.log(`Re-encoded file saved to: ${encodedFile}`);
                return encodedFile;
            } else {
                console.warn('Re-encoded file not found, using original');
                return filePath;
            }
        } catch (err) {
            console.warn('Re-encoding failed:', err.message || err);
            return filePath;
        }
    }
}

module.exports = WhatsAppClient;