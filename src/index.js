const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const IGClient = require('./igClient');
const TwitterClient = require('./twitterClient');


const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60', 10) * 1000;
const TARGETS = (process.env.INSTAGRAM_TARGET_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TWITTER_TARGETS = (process.env.TWITTER_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);

function envEnabled(name) {
  const v = process.env[name];
  if (v === undefined) return true; // default enabled
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const IG_ENABLED = envEnabled('ENABLE_IG');
const TWITTER_ENABLED = envEnabled('ENABLE_TWITTER');

async function main() {
  if (IG_ENABLED) {
    if (!process.env.INSTAGRAM_USERNAME || !process.env.INSTAGRAM_PASSWORD) {
      console.error('Please set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD in your .env');
      process.exit(1);
    }
    if (!TARGETS.length) {
      console.error('Please set INSTAGRAM_TARGET_IDS in your .env (comma-separated)');
      process.exit(1);
    }
  }

  const clients = {};
  if (IG_ENABLED) clients.ig = new IGClient({ headless: true });
  if (TWITTER_ENABLED) clients.twitter = new TwitterClient();

  if (IG_ENABLED) {
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
    for (const target of TARGETS) {
      const newReels = await clients.ig.fetchNewReelsForUser(target);
      for (const reel of newReels) {
        console.log('Forwarding reel', reel.url, 'to', process.env.FORWARD_TO);
        await clients.ig.forwardReelAsDM(reel, process.env.FORWARD_TO);
      }
    }
  }

  if (TWITTER_ENABLED) {
    for (const twitterUser of TWITTER_TARGETS) {
      console.log(new Date().toISOString(), 'Fetching media from Twitter user', twitterUser);
      const mediaFiles = await clients.twitter.fetchMediaFromUser(twitterUser, parseInt(process.env.MAX_REELS_PER_POLL || '5', 10));
      for (const filePath of mediaFiles) {
        if (IG_ENABLED && clients.ig) {
          console.log('Forwarding Twitter media', filePath, 'to', process.env.FORWARD_TO);
          await clients.ig.sendMediaAsDM(filePath, process.env.FORWARD_TO);
        } else {
          console.log('Got Twitter media but Instagram disabled; saved to', filePath);
        }
      }
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
