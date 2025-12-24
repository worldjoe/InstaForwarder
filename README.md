# Instagram Forwarder

Small automation to detect new Instagram Reels and Twitter posts from a list of target users and forward them as a DM to an Instagram user.
This was initially created specifically so that I can watch Instagram Reels on my Meta Display glasses.
Disclaimer

WARNING: Using this bot may violate Instagram's Terms of Service and could
result in the account specified by `INSTAGRAM_USERNAME` being suspended or
permanently banned for automated/bot activity. For safety, create and use a
separate Instagram account dedicated to this bot (do NOT use a personal or
primary account). Use at your own risk.

Quick start

1. Copy `.env.example` to `.env` and fill `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, and `INSTAGRAM_TARGET_IDS`.
2. Install dependencies:

```bash
npm install
```

3. Run the bot:

```bash
npm start
```

Notes
- Provide credentials in `.env` and consider using a throwaway account for testing.

You need a Twitter Bearer token. Grab a free account here: https://developer.x.com/en/portal/products
The free account only allows 1 request per 15 minutes.
Twitter support is not fully tested yet...

## Usage

### Getting TikTok Cookie

1. Install the browser extension "Cookie-Editor".
2. Login to TikTok in your browser.
3. Open the Cookie-Editor extension while on tiktok.com.
4. Copy the cookie value you need and add it to your `.env` (or code) as:

```
COOKIE: "YOUR_COOKIE"
```

Provide the cookie string exactly as copied; this allows the TikTok downloader library to authenticate when required.

### TIKTOK_MAX_DOWNLOADS
Currently windows only (because my .bat files), but could be ported to *nix easily.
You need yt-dlp/yt-dlp.exe downloaded and in your path to download TikTok videos.
You also need ffmpeg downloaded and in your path to do the conversion of videos to the resolution and size that the glasses support.

This environment variable sets the maximum number of TikTok downloads allowed per session. The default value is set to 3.

Install "Chrome for Testing" which supports puppeteer. This is because the whatsapp-web.js client requires a non headless browser for sending media.
https://wwebjs.dev/guide/creating-your-bot/handling-attachments.html#caveat-for-sending-videos-and-gifs
Set the path in .env for this Chrome.
npx @puppeteer/browsers --help
npx @puppeteer/browsers install chrome@stable

### Whats APP support.
The best way to send messages/videos to yourself. Significantly less risky than Instagram. But use at your own risk. You are likely violating Whats App's Terms of Service.
When it launches Chrome you'll need to login to WhatsApp using your phone. On subsequent runs it will remember your cookie/session information in .wwebjs_*
