// ...existing code...
const fs = require('fs');
const path = require('path');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const readline = require('readline');
const logger = require('./logger');

const SEEN_FILE = path.resolve(process.cwd(), 'seen.json');

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

class IGClient {
  constructor() {
    this.ig = new IgApiClient();
    this.loggedIn = false;
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
  
  sleep() {
    const randomBaseDelay = Math.floor(Math.random() * 1000) + 3000; // 3-4 second base delay
    return new Promise(resolve => setTimeout(resolve, randomBaseDelay));
  }

  // ...existing code...
  async init(retries = 3) {
    const user = process.env.INSTAGRAM_USERNAME;
    const pass = process.env.INSTAGRAM_PASSWORD;
    if (!user || !pass) throw new Error('Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD');

    this.ig.state.generateDevice(user);
    // optional proxy from env
    if (process.env.IG_PROXY) this.ig.state.proxyUrl = process.env.IG_PROXY;

    // Persist state after every request completes
    const sessionFile = path.resolve(process.cwd(), 'session.json');
    this.ig.request.end$.subscribe(async () => {
      try {
        const serialized = await this.ig.state.serialize();
        delete serialized.constants;
        fs.writeFileSync(sessionFile, JSON.stringify(serialized, null, 2));
      } catch (e) {
        logger.warn('Failed to persist session', { error: e.message || e });
      }
    });

      // Try to load cached session first (deserialize accepts string or object)
      if (fs.existsSync(sessionFile)) {
        try {
          const data = fs.readFileSync(sessionFile, 'utf8');
          await this.ig.state.deserialize(data);
          this.loggedIn = true;
          return;
        } catch (e) {
          logger.warn('Failed to deserialize cached session, logging in fresh', { error: e.message || e });
        }
      }

    try {
      await this.ig.simulate.preLoginFlow();
      // No usable cached session, perform login
      await this.ig.account.login(user, pass);

      // Force an immediate serialize/save once (subscription will also save on subsequent requests)
      try {
        const serialized = await this.ig.state.serialize();
        delete serialized.constants;
        fs.writeFileSync(sessionFile, JSON.stringify(serialized, null, 2));
      } catch (e) {
        logger.warn('Failed to cache session', { error: e.message || e });
      }

      //await this.ig.simulate.postLoginFlow();
      this.loggedIn = true;
      return;
    } catch (err) {
      const body = err && err.response && err.response.body;
      // Two-factor required
      if (body && (body.two_factor_required || err instanceof IgLoginTwoFactorRequiredError)) {
        try {
          const twoInfo = body.two_factor_info || {};
          const twoFactorIdentifier = twoInfo.two_factor_identifier;
          const methodHint = twoInfo?.obfuscated_phone ? `phone (${twoInfo.obfuscated_phone})` : (twoInfo?.username ? `email/other: ${twoInfo.username}` : 'unknown');
          logger.error('Two-factor auth required', { method: methodHint });
          const code = await prompt('Enter the 2FA code: ');
          await this.ig.account.twoFactorLogin({
            username: user,
            verificationCode: code.trim(),
            twoFactorIdentifier,
            verificationMethod: twoInfo?.obfuscated_phone ? '1' : '0',
            trustThisDevice: '1'
          });
          this.loggedIn = true;
          return;
        } catch (tfErr) {
          logger.error('2FA attempt failed', { error: tfErr.message || tfErr });
          if (retries > 0) {
            await prompt('Press Enter to retry 2FA attempt...');
            return this.init(retries - 1);
          }
          throw new Error('Instagram two-factor login failed: ' + (tfErr.message || tfErr));
        }
      }

      // Checkpoint / challenge flow (open challenge URL in browser and complete)
      const checkpoint = body && (body.checkpoint_url || body.challenge || body.challenge_url);
      if (checkpoint) {
        const checkpointUrl = String(checkpoint).startsWith('http') ? checkpoint : `https://instagram.com${checkpoint}`;
        logger.error('Instagram checkpoint/challenge detected. Open this URL in your browser and complete verification', { url: checkpointUrl });
        await prompt('Press Enter after you complete the challenge in the browser to retry login...');
        if (retries > 0) return this.init(retries - 1);
        throw new Error('Instagram challenge not completed');
      }

      // Temporary block / token expired / rate limit handling
      if (err && err.message && /Please wait|token_expired|Unauthorized|rate limit/i.test(err.message)) {
        logger.error('Temporary Instagram auth error (token/rate limit). Wait a few minutes then retry', { 
          error: err.message || '',
          response: err.response && err.response.body ? err.response.body : undefined
        });
        if (retries > 0) {
          await prompt('Press Enter to retry login...');
          return this.init(retries - 1);
        }
        throw new Error('Instagram login failed after retries: ' + (err.message || err));
      }

      // Fallback: rethrow original error
      throw new Error('Instagram login failed: ' + (err.message || err));
    }
  }
  // ...existing code...
  async _resolveUserId(identifier) {
    if (/^\d+$/.test(String(identifier))) return Number(identifier);
    try {
      await this.sleep();
      return await this.ig.user.getIdByUsername(identifier);
    } catch (e) {
      // fallback: attempt search
      await this.sleep();
      const results = await this.ig.user.search(identifier);
      const exact = results.find(r => r.username && r.username.toLowerCase() === String(identifier).toLowerCase());
      if (exact) return exact.pk || exact.pk_id || exact.id;
      throw new Error('Unable to resolve user id for ' + identifier);
    }
  }

  _isReelItem(item) {
    try {
      if (!item) return false;
      if (item.product_type && String(item.product_type).toLowerCase() === 'clips') return true;
      if (item.media_type && Number(item.media_type) === 2) return true; // video
      if (item.item_type && String(item.item_type).toLowerCase() === 'clip') return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  async fetchNewReelsForUser(userIdOrName) {
    const uid = await this._resolveUserId(userIdOrName);
    const feed = this.ig.feed.user(uid);
    let items = [];
    try {
      await this.sleep();
      items = await feed.items();
    } catch (e) {
      logger.error('Failed to fetch feed', { user: userIdOrName, error: e.message || e });
      return [];
    }

    const reels = items.filter(i => this._isReelItem(i)).map(i => {
      const id = i.id || i.pk || i.pk_id || (i.media && i.media[0] && (i.media[0].id || i.media[0].pk));
      const code = i.code || i.media && i.media[0] && i.media[0].code;
      const url = code ? (String(i.product_type).toLowerCase() === 'clips' ? `https://www.instagram.com/reel/${code}/` : `https://www.instagram.com/p/${code}/`) : (i.link || null);
      return { id: String(id || ''), code, url };
    }).filter(r => r.id);

    const seenForUser = new Set(this.seen[String(uid)] || []);
    const newReels = reels.filter(r => !seenForUser.has(r.id));
    if (newReels.length) {
      this.seen[String(uid)] = Array.from(new Set([...(this.seen[String(uid)] || []), ...newReels.map(r => r.id)]));
      this._saveSeen();
    }
    // mark all as "seen" above, even if we limit them to maxReels below
    const maxReels = parseInt(process.env.MAX_REELS_PER_POLL, 10);
    const filtered = isNaN(maxReels) ? newReels : newReels.slice(0, maxReels);
    return filtered;
  }

  async forwardReelAsDM(reel, toUsername) {
    if (!reel || !reel.url) throw new Error('Invalid reel provided');
    const recipientId = await this._resolveUserId(toUsername);
    const text = `${reel.url}`;
    try {
      await this.sleep();
      await this.ig.entity.directThread([String(recipientId)]).broadcastText(text);
      return true;
    } catch (e) {
      console.error('Failed sending DM to', toUsername, e.message || e);
      return false;
    }
  }

  // Send a media file (image or video) as a DM to given username
  async sendMediaAsDM(filePath, toUsername) {
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
    const recipientId = await this._resolveUserId(toUsername);
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    try {
      await this.sleep();
      const thread = this.ig.entity.directThread([String(recipientId)]);
      if (isImage) {
        await thread.broadcastPhoto({ file: fs.createReadStream(filePath) });
      } else {
        await thread.broadcastVideo({ video: fs.createReadStream(filePath) });
      }
      return true;
    } catch (e) {
      console.error('Direct media send failed, attempting upload fallback', e && e.message ? e.message : e);
      // Fallback: upload to feed and send post link
      try {
        if (isImage) {
          const publish = await this.ig.publish.photo({ file: fs.createReadStream(filePath) });
          const shortcode = publish && publish.media && (publish.media.code || publish.media[0] && publish.media[0].code);
          const url = shortcode ? `https://www.instagram.com/p/${shortcode}/` : null;
          await this.ig.entity.directThread([String(recipientId)]).broadcastText(url || 'Uploaded image');
        } else {
          const publish = await this.ig.publish.video({ video: fs.createReadStream(filePath), coverImage: fs.createReadStream(filePath) });
          const shortcode = publish && publish.media && (publish.media.code || publish.media[0] && publish.media[0].code);
          const url = shortcode ? `https://www.instagram.com/p/${shortcode}/` : null;
          await this.ig.entity.directThread([String(recipientId)]).broadcastText(url || 'Uploaded video');
        }
        return true;
      } catch (e2) {
        console.error('Upload fallback failed', e2 && e2.message ? e2.message : e2);
        return false;
      }
    }
  }

  async dispose() {
    // instagram-private-api manages its own connections; nothing to explicitly close
  }
}

module.exports = IGClient;