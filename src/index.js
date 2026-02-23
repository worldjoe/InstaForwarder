const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const logger = require('./logger');
const IGClient = require('./igClient');
const TwitterClient = require('./twitterClient');
const TikTokClient = require('./tiktokClient');
const RedGifClient = require('./redgifClient');
const WhatsAppClient = require('./whatsappClient');

// Poll interval in milliseconds (default: 60 seconds)
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60', 10) * 1000;
const TARGETS = (process.env.INSTAGRAM_TARGET_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TWITTER_TARGETS = (process.env.TWITTER_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);
const TIKTOK_TARGETS = (process.env.TIKTOK_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);
const REDGIF_TARGETS = (process.env.REDGIF_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);

// Secondary targets for second IG client
const TARGETS_2 = (process.env.INSTAGRAM_TARGET_IDS_2 || '').split(',').map(s => s.trim()).filter(Boolean);
const TWITTER_TARGETS_2 = (process.env.TWITTER_TARGETS_2 || '').split(',').map(s => s.trim()).filter(Boolean);
const TIKTOK_TARGETS_2 = (process.env.TIKTOK_TARGETS_2 || '').split(',').map(s => s.trim()).filter(Boolean);
const REDGIF_TARGETS_2 = (process.env.REDGIF_TARGETS_2 || '').split(',').map(s => s.trim()).filter(Boolean);

function envEnabled(name) {
  const v = process.env[name];
  if (v === undefined) return true; // default enabled
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const IG_ENABLED = envEnabled('ENABLE_IG');
const IG_ENABLED_FORWARD_REELS = envEnabled('ENABLE_IG_FORWARD_REELS');
const IG_ENABLED_SEND_MEDIA = envEnabled('ENABLE_IG_SEND_MEDIA');
const IG_ENABLED_SEND_MEDIA_2 = envEnabled('ENABLE_IG_SEND_MEDIA_2');
const WA_ENABLED_FOR_SENDING = envEnabled('WA_ENABLED_FOR_SENDING');
const TWITTER_ENABLED = envEnabled('ENABLE_TWITTER');
const TIKTOK_ENABLED = envEnabled('ENABLE_TIKTOK');
const REDGIF_ENABLED = envEnabled('ENABLE_REDGIF');

async function main() {
  if (IG_ENABLED) {
    if (!TARGETS.length) {
      logger.error('Please set INSTAGRAM_TARGET_IDS in your .env (comma-separated)');
      process.exit(1);
    }
  }

  // If forwarding reels via IG is enabled we must have credentials and a forward target.
  if (IG_ENABLED_FORWARD_REELS) {
    if (!process.env.INSTAGRAM_USERNAME || !process.env.INSTAGRAM_PASSWORD) {
      logger.error('Please set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD in your .env');
      process.exit(1);
    }
    if (!process.env.INSTAGRAM_FORWARD_TO) {
      logger.error('Please set INSTAGRAM_FORWARD_TO in your .env when ENABLE_IG_FORWARD_REELS is true');
      process.exit(1);
    }
  }

  // If sending media via IG is enabled we must have a forward target.
  if (IG_ENABLED_SEND_MEDIA || IG_ENABLED_SEND_MEDIA_2) {
    if (!process.env.INSTAGRAM_FORWARD_TO) {
      logger.error('Please set INSTAGRAM_FORWARD_TO in your .env when ENABLE_IG_SEND_MEDIA or ENABLE_IG_SEND_MEDIA_2 is true');
      process.exit(1);
    }
  }

  if (WA_ENABLED_FOR_SENDING && !process.env.WHATSAPP_FORWARD_TO) {
    logger.error('Please set WHATSAPP_FORWARD_TO in your .env when WA_ENABLED_FOR_SENDING is true');
    process.exit(1);
  }

  const clients = {};
  // Initialize IG client when any IG feature is enabled
  if (IG_ENABLED_FORWARD_REELS || IG_ENABLED || IG_ENABLED_SEND_MEDIA) {
    clients.ig = new IGClient({ headless: true });
  }
  // Secondary IG client for second account
  if (IG_ENABLED_SEND_MEDIA_2) clients.ig2 = new IGClient({ headless: true });
  if (TWITTER_ENABLED) clients.twitter = new TwitterClient();
  if (WA_ENABLED_FOR_SENDING) clients.wa = new WhatsAppClient({ headless: true });

  // Initialize primary IG client (API login only if ENABLE_IG_FORWARD_REELS or ENABLE_IG is enabled)
  if (clients.ig) {
    try {
      const igUserDataDir = path.resolve(process.cwd(), '.wwebjs_cache');
      await clients.ig.init(3, igUserDataDir);
    } catch (err) {
      logger.error('Failed to init Instagram client', { error: err.message || err });
      process.exit(1);
    }
  }

  // Initialize secondary IG client (puppeteer only, no API login)
  if (IG_ENABLED_SEND_MEDIA_2) {
    try {
      const ig2UserDataDir = path.resolve(process.cwd(), '.ig_cache_2');
      await clients.ig2.init(3, ig2UserDataDir);
    } catch (err) {
      logger.error('Failed to init secondary Instagram client', { error: err.message || err });
      process.exit(1);
    }
  }

  if (TWITTER_ENABLED) {
    try {
      await clients.twitter.init();
      if (!TWITTER_TARGETS.length) logger.warn('TWITTER_ENABLED is true but TWITTER_TARGETS is empty');
    } catch (err) {
      logger.error('Failed to init Twitter client', { error: err.message || err });
      process.exit(1);
    }
  }

  if (WA_ENABLED_FOR_SENDING) {
    try {
      await clients.wa.init();
    } catch (err) {
      logger.error('Failed to init WhatsApp client', { error: err.message || err });
      process.exit(1);
    }
  }

  if (TIKTOK_ENABLED) {
    try {
      clients.tiktok = new TikTokClient();
      await clients.tiktok.init();
      if (!TIKTOK_TARGETS.length) logger.warn('TIKTOK_ENABLED is true but TIKTOK_TARGETS is empty');
    } catch (err) {
      logger.error('Failed to init TikTok client', { error: err.message || err });
      process.exit(1);
    }
  }

  if (REDGIF_ENABLED) {
    try {
      clients.redgif = new RedGifClient();
      await clients.redgif.init();
      if (!REDGIF_TARGETS.length) logger.warn('REDGIF_ENABLED is true but REDGIF_TARGETS is empty');
    } catch (err) {
      logger.error('Failed to init RedGif client', { error: err.message || err });
      process.exit(1);
    }
  }

  // initial poll
  await pollOnce(clients);

  setInterval(async () => {
    try {
      await pollOnce(clients);
    } catch (err) {
      logger.error('Poll error', { error: err.message || err, stack: err.stack });
    }
  }, POLL_INTERVAL);
}

async function pollOnce(clients) {
  if (IG_ENABLED) {
    logger.info('Polling for new reels', { targets: TARGETS });
    if (!clients.ig) {
      logger.warn('IG_ENABLED is true but IG client is not initialized; skipping Instagram fetches');
    } else {
      for (const target of TARGETS) {
        const newReels = await clients.ig.fetchNewReelsForUser(target);
        for (const reel of newReels) {
          if (WA_ENABLED_FOR_SENDING && clients.wa) {
            logger.info('Forwarding reel via WhatsApp', { url: reel.url, recipient: process.env.WHATSAPP_FORWARD_TO });
            await clients.wa.sendMessage(process.env.WHATSAPP_FORWARD_TO, reel.url);
          } else if (IG_ENABLED_FORWARD_REELS && clients.ig) {
            logger.info('Forwarding reel via Instagram', { url: reel.url, recipient: process.env.INSTAGRAM_FORWARD_TO });
            await clients.ig.forwardReelAsDM(reel, process.env.INSTAGRAM_FORWARD_TO);
          } else {
            logger.debug('Instagram reel sending disabled', { url: reel.url });
          }
        }
      }
    }
    logger.info('Finished polling Instagram');
  }

  if (TWITTER_ENABLED) {
      logger.info('Fetching media from Twitter users');
      const mediaFiles = await clients.twitter.fetchMediaFromTargets(TWITTER_TARGETS);
      for (const filePath of mediaFiles) {
        if (WA_ENABLED_FOR_SENDING && clients.wa) {
          logger.info('Forwarding Twitter media via WhatsApp', { file: filePath, recipient: process.env.WHATSAPP_FORWARD_TO });
          await clients.wa.sendMediaAsDM(filePath, process.env.WHATSAPP_FORWARD_TO);
        } else if (IG_ENABLED_SEND_MEDIA && clients.ig) {
          logger.info('Forwarding Twitter media via Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
          await clients.ig.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, 'Twitter');
        } else {
          logger.debug('Twitter media saved (sending disabled)', { file: filePath });
        }
      }
      logger.info('Finished polling Twitter');
  }

  if (TIKTOK_ENABLED) {
    logger.info('Fetching media from TikTok targets');
    try {
      for (const target of TIKTOK_TARGETS) {
        const mediaFiles = await clients.tiktok.fetchMediaFromTargets([target]);
        for (const filePath of mediaFiles) {
          if (WA_ENABLED_FOR_SENDING && clients.wa) {
            logger.info('Forwarding TikTok media via WhatsApp', { file: filePath, recipient: process.env.WHATSAPP_FORWARD_TO });
            await clients.wa.sendMediaAsDM(filePath, process.env.WHATSAPP_FORWARD_TO);
          } else if (IG_ENABLED_SEND_MEDIA && clients.ig) {
            logger.info('Forwarding TikTok media via Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
            await clients.ig.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, target);
          } else {
            logger.debug('TikTok media saved (sending disabled)', { file: filePath });
          }
        }
      }
    } catch (e) {
      logger.error('Error polling TikTok targets', { error: e.message || e });
    }
    logger.info('Finished polling TikTok');
  }

  if (REDGIF_ENABLED) {
    logger.info('Fetching media from RedGif targets');
    try {
      for (const target of REDGIF_TARGETS) {
        const mediaFiles = await clients.redgif.fetchMediaFromTargets([target]);
        for (const filePath of mediaFiles) {
          if (WA_ENABLED_FOR_SENDING && clients.wa) {
            logger.info('Forwarding RedGif media via WhatsApp', { file: filePath, recipient: process.env.WHATSAPP_FORWARD_TO });
            await clients.wa.sendMediaAsDM(filePath, process.env.WHATSAPP_FORWARD_TO);
          } else if (IG_ENABLED_SEND_MEDIA && clients.ig) {
            logger.info('Forwarding RedGif media via Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
            await clients.ig.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, target);
          } else {
            logger.debug('RedGif media saved (sending disabled)', { file: filePath });
          }
        }
      }
    } catch (e) {
      logger.error('Error polling RedGif targets', { error: e.message || e });
    }
    logger.info('Finished polling RedGif');
  }

  // Secondary client polling for Twitter targets 2
  if (TWITTER_ENABLED && IG_ENABLED_SEND_MEDIA_2 && TWITTER_TARGETS_2.length) {
    logger.info('Fetching media from secondary Twitter users');
    try {
      const mediaFiles = await clients.twitter.fetchMediaFromTargets(TWITTER_TARGETS_2);
      for (const filePath of mediaFiles) {
        logger.info('Forwarding Twitter media via secondary Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
        await clients.ig2.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, 'Twitter');
      }
    } catch (e) {
      logger.error('Error polling secondary Twitter targets', { error: e.message || e });
    }
    logger.info('Finished polling secondary Twitter');
  }

  // Secondary client polling for TikTok targets 2
  if (TIKTOK_ENABLED && IG_ENABLED_SEND_MEDIA_2 && TIKTOK_TARGETS_2.length) {
    logger.info('Fetching media from secondary TikTok targets');
    try {
      for (const target of TIKTOK_TARGETS_2) {
        const mediaFiles = await clients.tiktok.fetchMediaFromTargets([target]);
        for (const filePath of mediaFiles) {
          logger.info('Forwarding TikTok media via secondary Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
          await clients.ig2.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, target);
        }
      }
    } catch (e) {
      logger.error('Error polling secondary TikTok targets', { error: e.message || e });
    }
    logger.info('Finished polling secondary TikTok');
  }

  // Secondary client polling for RedGif targets 2
  if (REDGIF_ENABLED && IG_ENABLED_SEND_MEDIA_2 && REDGIF_TARGETS_2.length) {
    logger.info('Fetching media from secondary RedGif targets');
    try {
      for (const target of REDGIF_TARGETS_2) {
        const mediaFiles = await clients.redgif.fetchMediaFromTargets([target]);
        for (const filePath of mediaFiles) {
          logger.info('Forwarding RedGif media via secondary Instagram', { file: filePath, recipient: process.env.INSTAGRAM_FORWARD_TO });
          await clients.ig2.sendMediaAsDM(filePath, process.env.INSTAGRAM_FORWARD_TO, target);
        }
      }
    } catch (e) {
      logger.error('Error polling secondary RedGif targets', { error: e.message || e });
    }
    logger.info('Finished polling secondary RedGif');
  }

  // Secondary client polling for Instagram targets 2
  if (IG_ENABLED && IG_ENABLED_SEND_MEDIA_2 && TARGETS_2.length && clients.ig) {
    logger.info('Polling for new reels from secondary targets', { targets: TARGETS_2 });
    try {
      for (const target of TARGETS_2) {
        const newReels = await clients.ig.fetchNewReelsForUser(target);
        for (const reel of newReels) {
          logger.info('Forwarding reel via secondary Instagram', { url: reel.url, recipient: process.env.INSTAGRAM_FORWARD_TO });
          await clients.ig2.sendMediaAsDM(reel.url, process.env.INSTAGRAM_FORWARD_TO, target);
        }
      }
    } catch (e) {
      logger.error('Error polling secondary Instagram targets', { error: e.message || e });
    }
    logger.info('Finished polling secondary Instagram');
  }
}

main().catch(err => {
  logger.error('Fatal error in main', { error: err.message || err, stack: err.stack });
  process.exit(1);
});
