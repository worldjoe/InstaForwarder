// ...existing code...
const fs = require('fs');
const path = require('path');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const readline = require('readline');

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
      console.error('Failed saving seen file', e);
    }
  }

  // ...existing code...
  async init(retries = 3) {
    const user = process.env.INSTAGRAM_USERNAME;
    const pass = process.env.INSTAGRAM_PASSWORD;
    if (!user || !pass) throw new Error('Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD');

    this.ig.state.generateDevice(user);

    try {
      await this.ig.simulate.preLoginFlow();
      await this.ig.account.login(user, pass);
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
          console.error(`Two-factor auth required. Verification method hint: ${methodHint}`);
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
          console.error('2FA attempt failed:', tfErr.message || tfErr);
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
        console.error('Instagram checkpoint/challenge detected. Open this URL in your browser and complete verification:');
        console.error(checkpointUrl);
        await prompt('Press Enter after you complete the challenge in the browser to retry login...');
        if (retries > 0) return this.init(retries - 1);
        throw new Error('Instagram challenge not completed');
      }

      // Temporary block / token expired / rate limit handling
      if (err && err.message && /Please wait|token_expired|Unauthorized|rate limit/i.test(err.message)) {
        console.error('Temporary Instagram auth error (token/rate limit). Wait a few minutes then retry.' + (err.message || ''));
        console.error(err.response && err.response.body ? ' ' + JSON.stringify(err.response.body) : '');
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
      return await this.ig.user.getIdByUsername(identifier);
    } catch (e) {
      // fallback: attempt search
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
      items = await feed.items();
    } catch (e) {
      console.error('Failed to fetch feed for', userIdOrName, e.message || e);
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