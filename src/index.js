const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const IGClient = require('./igClient');
const TwitterClient = require('./twitterClient');
const TikTokClient = require('./tiktokClient');
const WhatsAppClient = require('./whatsappClient');


const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60', 10) * 1000;
const TARGETS = (process.env.INSTAGRAM_TARGET_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TWITTER_TARGETS = (process.env.TWITTER_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);
const TIKTOK_TARGETS = (process.env.TIKTOK_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);

function envEnabled(name) {
  const v = process.env[name];
  if (v === undefined) return true; // default enabled
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const IG_ENABLED = envEnabled('ENABLE_IG');
const IG_ENABLED_FOR_SENDING = envEnabled('ENABLE_IG_SENDING');
const WA_ENABLED_FOR_SENDING = envEnabled('WA_ENABLED_FOR_SENDING');
const TWITTER_ENABLED = envEnabled('ENABLE_TWITTER');
const TIKTOK_ENABLED = envEnabled('ENABLE_TIKTOK');

async function main() {
  if (IG_ENABLED) {
    if (!TARGETS.length) {
      console.error('Please set INSTAGRAM_TARGET_IDS in your .env (comma-separated)');
      process.exit(1);
    }
  }

  // If sending via IG is enabled we must have credentials and a forward target.
  if (IG_ENABLED_FOR_SENDING) {
    if (!process.env.INSTAGRAM_USERNAME || !process.env.INSTAGRAM_PASSWORD) {
      console.error('Please set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD in your .env');
      process.exit(1);
    }
    if (!process.env.INSTAGRAM_FORWARD_TO) {
      console.error('Please set INSTAGRAM_FORWARD_TO in your .env when ENABLE_IG_SENDING is true');
      process.exit(1);
    }
  }

  if (WA_ENABLED_FOR_SENDING && !process.env.WHATSAPP_FORWARD_TO) {
    console.error('Please set WHATSAPP_FORWARD_TO in your .env when WA_ENABLED_FOR_SENDING is true');
    process.exit(1);
  }

  const clients = {};
  // Initialize IG client only when sending via IG is enabled.
  if (IG_ENABLED_FOR_SENDING || IG_ENABLED) clients.ig = new IGClient({ headless: true });
  if (TWITTER_ENABLED) clients.twitter = new TwitterClient();
  if (WA_ENABLED_FOR_SENDING) clients.wa = new WhatsAppClient({ headless: true });

  if (IG_ENABLED_FOR_SENDING || IG_ENABLED) {
    try {
      await clients.ig.init();
    } catch (err) {
      console.error('Failed to init Instagram client', err);
      process.exit(1);
    }
  }

  if (TWITTER_ENABLED) {
    try {
      await clients.twitter.init();
      if (!TWITTER_TARGETS.length) console.warn('TWITTER_ENABLED is true but TWITTER_TARGETS is empty');
    } catch (err) {
      console.error('Failed to init Twitter client', err);
      process.exit(1);
    }
  }

  if (WA_ENABLED_FOR_SENDING) {
    try {
      await clients.wa.init();
    } catch (err) {
      console.error('Failed to init WhatsApp client', err);
      process.exit(1);
    }
  }

  if (TIKTOK_ENABLED) {
    try {
      clients.tiktok = new TikTokClient();
      await clients.tiktok.init();
      if (!TIKTOK_TARGETS.length) console.warn('TIKTOK_ENABLED is true but TIKTOK_TARGETS is empty');
    } catch (err) {
      console.error('Failed to init TikTok client', err);
      process.exit(1);
    }
  }

  // initial poll
  await pollOnce(clients);

  setInterval(async () => {
    try {
      await pollOnce(clients);
    } catch (err) {
      console.error('Poll error', err);
    }
  }, POLL_INTERVAL);
}

async function pollOnce(clients) {
  if (IG_ENABLED) {
    console.log(new Date().toISOString(), 'Polling for new reels for', TARGETS);
    if (!clients.ig) {
      console.warn('IG_ENABLED is true but IG client is not initialized (ENABLE_IG_SENDING=false); skipping Instagram fetches');
    } else {
      for (const target of TARGETS) {
        const newReels = await clients.ig.fetchNewReelsForUser(target);
        for (const reel of newReels) {
          if (WA_ENABLED_FOR_SENDING && clients.wa) {
            console.log('Forwarding reel', reel.url, 'to', process.env.WHATSAPP_FORWARD_TO);
            await clients.wa.sendMessage(process.env.WHATSAPP_FORWARD_TO, reel.url);
          } else if (IG_ENABLED_FOR_SENDING && clients.ig) {
            console.log('Forwarding reel', reel.url, 'to', process.env.INSTAGRAM_FORWARD_TO);
            await clients.ig.forwardReelAsDM(reel, process.env.INSTAGRAM_FORWARD_TO);
          } else {
            console.log('Instagram reel sending disabled; reel link:', reel.url);
          }
        }
      }
    }
    console.log(new Date().toISOString(), 'Finished polling Instagram');
  }

  if (TWITTER_ENABLED) {
      console.log(new Date().toISOString(), 'Fetching media from Twitter users');
      const mediaFiles = await clients.twitter.fetchMediaFromTargets(TWITTER_TARGETS);
      for (const filePath of mediaFiles) {
        if (WA_ENABLED_FOR_SENDING && clients.wa) {
          console.log('Forwarding Twitter media via WhatsApp', filePath, 'to', process.env.WHATSAPP_FORWARD_TO);
          await clients.wa.sendMediaAsDM(filePath, process.env.WHATSAPP_FORWARD_TO);
        } else if (IG_ENABLED_FOR_SENDING && clients.ig) {
          console.log('Forwarding Twitter media via Instagram', filePath, 'to', process.env.INSTAGRAM_FORWARD_TO);
          await clients.ig.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO);
        } else {
          console.log('Got Twitter media but sending is disabled; saved to', filePath);
        }
      }
      console.log(new Date().toISOString(), 'Finished polling Twitter');
  }

  if (TIKTOK_ENABLED) {
    console.log(new Date().toISOString(), 'Fetching media from TikTok targets');
    try {
      const mediaFiles = await clients.tiktok.fetchMediaFromTargets(TIKTOK_TARGETS);
      for (const filePath of mediaFiles) {
        if (WA_ENABLED_FOR_SENDING && clients.wa) {
          console.log('Forwarding TikTok media via WhatsApp', filePath, 'to', process.env.WHATSAPP_FORWARD_TO);
          await clients.wa.sendMediaAsDM(filePath, process.env.WHATSAPP_FORWARD_TO);
        } else if (IG_ENABLED_FOR_SENDING && clients.ig) {
          console.log('Forwarding TikTok media via Instagram', filePath, 'to', process.env.INSTAGRAM_FORWARD_TO);
          await clients.ig.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO);
        } else {
          console.log('Got TikTok media but sending is disabled; saved to', filePath);
        }
      }
    } catch (e) {
      console.error('Error polling TikTok targets', e && e.message ? e.message : e);
    }
    console.log(new Date().toISOString(), 'Finished polling TikTok');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
