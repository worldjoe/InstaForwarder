# Instagram Forwarder

Small automation to detect new Instagram Reels and Twitter posts from a list of target users and forward them as a DM to an Instagram user.
This was initially created specifically so that I can watch Instagram Reels on my Meta Display glasses.

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