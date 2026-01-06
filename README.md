# Meta Rayban Display Forwarder
I'm currently testing the aspect ratio and resolution limits on the glasses.
I think it's 4:5 and 3.5MB. But I'm not getting consistant playback yet.
So if you have news on this front, please open an Issue against this repo and I will investigate.

Small automation to detect new Instagram Reels, TikTok posts, and RedGif creators from a list of target users and forward them as a DM to an Instagram or WhatsApp user.
This was created specifically so that I can watch Instagram Reels on my Meta Display glasses.

### Disclaimer
**WARNING**: Using this bot may violate the Terms of Service of any connected service you enable and could
result in the accounts specified in .env being suspended or
permanently banned for automated/bot activity. For safety, create and use a
separate accounts dedicated to this bot (do NOT use a personal or
primary account). Use at your own risk.

Quick start

1. Copy `.env.example` to `.env` and fill in the settings there.
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



## Usage

If you're trying to send anything other than Instagram Reels to an Instagram account then you'll need to manually login to Instagram the first time the application launches "Chrome For Testing". When it launches the browser, just ignore the automation and open instagram.com and login. Then navigate to your DMs to ensure there aren't any popups you need to click through. Then the automation will start working automatically from then on. The browser will stay logged in between sessions/runs. If it even logs out, you just need to login again while it's running.

### Getting TikTok Cookie

I don't think this cookie part was implemented yet. For now only public videos can be grabbed.

1. Install the browser extension "Cookie-Editor".
2. Login to TikTok in your browser.
3. Open the Cookie-Editor extension while on tiktok.com.
4. Copy the cookie value you need and add it to your `.env` (or code) as:

```
COOKIE: "YOUR_COOKIE"
```

Provide the cookie string exactly as copied; this allows the TikTok downloader library to authenticate when required.

### TIKTOK_MAX_DOWNLOADS
You need yt-dlp/yt-dlp.exe downloaded and in your path to download TikTok videos.
You also need ffmpeg and ffprobe downloaded and in your path to do the conversion of videos to the resolution and size that the glasses support.

This environment variable sets the maximum number of TikTok downloads allowed per session. The default value is set to 3.

### Getting Your TikTok Following List

The `parseTikTokFollowing.js` script can help you easily populate `TIKTOK_TARGETS` in your `.env` file.

**To download your TikTok data:**

1. Open TikTok on your phone
2. Tap on your profile (bottom right)
3. Tap the hamburger menu icon (☰) in the top right
4. Select "Settings and privacy"
5. Go to "Account"
6. Select "Download your data"
7. Change the format to **JSON** (not TXT)
8. Request the download
9. Wait for the download to be ready (this can take anywhere from half a day to a full day)
10. Once ready, download the zip file on your phone
11. Forward the zip file to your email
12. Extract the JSON file from the zip

**To extract your following list:**

```bash
node src/parseTikTokFollowing.js path/to/user_data_tiktok.json
```

This will output a comma-delimited list of usernames that you can copy directly into the `TIKTOK_TARGETS` variable in your `.env` file.


### Whats APP support.
The best way to send messages/videos to yourself. Significantly less risky than Instagram. But use at your own risk. You are likely violating Whats App's Terms of Service.
When it launches Chrome you'll need to login to WhatsApp using your phone to scan the QR code. On subsequent runs it will remember your cookie/session information in .wwebjs_*

## Chrome for Testing required for WhatsApp
Install "Chrome for Testing" which supports puppeteer. This is because the whatsapp-web.js client requires a non headless browser for sending media.
https://wwebjs.dev/guide/creating-your-bot/handling-attachments.html#caveat-for-sending-videos-and-gifs
Set the path in .env for this Chrome.
Run these commands to install:
```bash
npx @puppeteer/browsers --help
npx @puppeteer/browsers install chrome@stable
```
this will output the path it installed to. Add that to your .env file

### RedGif support
A "friend" of mine asked for something a little more NSFW. Redgif support has been added, but not thoroughly tested. Feel free to send PRs.

## Twitter support
You need a Twitter Bearer token. Grab a free account here: https://developer.x.com/en/portal/products
The free account only allows 1 request per 15 minutes and also has a monthly limit!
Twitter is not fully implemented and probably will never be without someone providing a pull request or financial support to pay for a Twitter API account.

