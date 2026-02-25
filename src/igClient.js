// ...existing code...
const fs = require('fs');
const path = require('path');
const { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError, IgLoginRequiredError } = require('instagram-private-api');
const readline = require('readline');
const logger = require('./logger');
const puppeteer = require('puppeteer');

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
    this.browser = null;
    this.page = null;
    this.puppeteerConfig = null;
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
  async init(retries = 3, userDataDir = null) {
    // Store userDataDir for later use in puppeteer
    if (userDataDir) {
      this.userDataDir = userDataDir;
    }
    
    // Initialize browser for puppeteer operations
    if (!this.browser) {
      logger.debug('Initializing puppeteer browser');
      const executablePath = process.env.CHROME_EXECUTABLE_PATH;
      const dataDir = this.userDataDir || path.resolve(process.cwd(), '.wwebjs_cache');
      
      this.puppeteerConfig = {
        headless: false,
        userDataDir: dataDir,
        ...(executablePath ? { executablePath } : {}),
      };
      
      this.browser = await puppeteer.launch(this.puppeteerConfig);
      // Small delay after browser launch
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
      
      // Initialize page
      this.page = await this.browser.newPage();
      
      // Random delay after opening new page
      await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));

      // Set viewport
      await this.page.setViewport({
        width: 1200,
        height: 787,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false
      });

      // Set up the reaction listener
      await this._setupReactionListener();
      
    } else {
      logger.debug('Puppeteer browser already initialized, reusing existing instance');
    }

    // Check if Instagram API login is needed
    const igForwardReelsEnabled = this._envEnabled('ENABLE_IG_FORWARD_REELS');
    const needsApiLogin = igForwardReelsEnabled;
    
    logger.debug('Instagram init - checking if API login needed', { needsApiLogin, igForwardReelsEnabled });

    if (!needsApiLogin) {
      logger.info('Instagram API login skipped (ENABLE_IG_FORWARD_REELS is disabled)');
      return;
    }

    const user = process.env.INSTAGRAM_USERNAME;
    const pass = process.env.INSTAGRAM_PASSWORD;
    if (!user || !pass) throw new Error('Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD');

    // Check if all device config values are present
    const hasFullDeviceConfig = 
      process.env.IG_DEVICE_STRING && 
      process.env.IG_DEVICE_ID && 
      process.env.IG_UUID && 
      process.env.IG_PHONE_ID && 
      process.env.IG_ADID && 
      process.env.IG_BUILD;

    if (hasFullDeviceConfig) {
      // Use device configuration from env
      this.ig.state.deviceString = process.env.IG_DEVICE_STRING;
      this.ig.state.deviceId = process.env.IG_DEVICE_ID;
      this.ig.state.uuid = process.env.IG_UUID;
      this.ig.state.phoneId = process.env.IG_PHONE_ID;
      this.ig.state.adid = process.env.IG_ADID;
      this.ig.state.build = process.env.IG_BUILD;
    } else {
      // Generate new device
      this.ig.state.generateDevice(user);
    }

    // optional proxy from env
    if (process.env.IG_PROXY) this.ig.state.proxyUrl = process.env.IG_PROXY;

    // Persist state after every request completes
    const sessionFile = path.resolve(process.cwd(), 'session.json');
    this.ig.request.end$.subscribe(async () => {
      try {
        const serialized = await this.ig.state.serialize();
        delete serialized.constants;
        const cookies = await this.ig.state.serializeCookieJar();
        fs.writeFileSync(sessionFile, JSON.stringify({ ...serialized, cookies }, null, 2));
      } catch (e) {
        logger.warn('Failed to persist session', { error: e.message || e });
      }
    });

      // Try to load cached session first (deserialize accepts string or object)
      if (fs.existsSync(sessionFile)) {
        try {
          const data = fs.readFileSync(sessionFile, 'utf8');
          const sessionData = JSON.parse(data);
          await this.ig.state.deserialize(sessionData);
          if (sessionData.cookies) {
            await this.ig.state.deserializeCookieJar(sessionData.cookies);
          }

          // Validate session with retry
          let retryCount = 0;
          let loggedIn = true;
          const maxRetries = 2;

          while (retryCount <= maxRetries) {
            try {
              await this.ig.account.currentUser();
              break;
            } catch (error) {
              if (error instanceof IgCheckpointError) {
                logger.error('Checkpoint error during session validation - account requires verification');
                loggedIn = false;
              }

              if (error instanceof IgLoginRequiredError || retryCount === maxRetries) {
                logger.warn('Session expired, logging in fresh');
                loggedIn = false;
              }

              logger.warn(`Retry ${retryCount + 1} for session validation`);
              await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
              retryCount++;
            }
          }
          
          this.loggedIn = loggedIn;
          if (this.loggedIn) {
            logger.info('Instagram session restored from cache');
            return;
          } else {
            this.ig.state.clear();
          }
        } catch (e) {
          logger.warn('Failed to deserialize cached session, logging in fresh', { error: e.message || e });
        }
      }

    try {

      await this.ig.simulate.preLoginFlow();
      // No usable cached session, perform login
      await this.ig.account.login(user, pass);
      logger.info('Instagram login successful');
      logger.info(`Logged in with DeviceID: ${this.ig.state.deviceId}`);


      // Force an immediate serialize/save once (subscription will also save on subsequent requests)
      try {
        const serialized = await this.ig.state.serialize();
        delete serialized.constants;
        const cookies = await this.ig.state.serializeCookieJar();
        fs.writeFileSync(sessionFile, JSON.stringify({ ...serialized, cookies }, null, 2));
      } catch (e) {
        logger.warn('Failed to cache session', { error: e.message || e });
      }

      //await this.ig.simulate.postLoginFlow();
      this.loggedIn = true;
      return;
    } catch (err) {
      logger.error('Instagram login error', { error: err.message || err });
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

  _envEnabled(name) {
    const v = process.env[name];
    if (v === undefined) return true; // default enabled
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  }

  // ...existing code...
  async _resolveUserId(identifier) {
    if (/^\d+$/.test(String(identifier))) return Number(identifier);
    
    // Check if we have a logged in session (required for API calls)
    if (!this.loggedIn) {
      throw new Error('Instagram API session required to resolve user IDs. Enable ENABLE_IG_FORWARD_REELS or ENABLE_IG to establish a session.');
    }
    
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
  async sendMediaAsDM(filePath, toUsername, fromTarget = null) {
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
    const recipientId = await this._resolveUserId(toUsername);
    try {
      await this.sleep();
      const thread = this.ig.entity.directThread([String(recipientId)]);
      // NOTE: broadcastVideo is broken - see https://github.com/subzeroid/instagrapi/issues/2216
      // just going to to use puppeteer for both video and image for consistency
      // await thread.broadcastVideo({ video: fileBuffer });
      // Using puppeteer replay as workaround
      return await this._sendVideoViaPuppeteer(filePath, recipientId, fromTarget);
    } catch (e) {
      logger.error('Failed to send media as DM', { error: e.message || e, fromTarget });
      return false;
    }
  }

  // Send video using puppeteer (workaround for broken broadcastVideo API)
  async _sendVideoViaPuppeteer(filePath, recipientId, fromTarget = null) {
    try {
      // Browser and page should already be initialized in init()
      if (!this.browser || !this.page) {
        throw new Error('Browser/page not initialized. Call init() first.');
      }

      const page = this.page;

      // Navigate to DM thread only if not already there
      const dmUrl = `https://www.instagram.com/direct/t/${recipientId}/`;
      const currentUrl = page.url();
      logger.debug('Current page URL', { currentUrl });
      
      if (!currentUrl.includes(`/direct/t/${recipientId}/`)) {
        logger.debug('Navigating to DM thread', { dmUrl });
        await page.goto(dmUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for page to load - human-like delay
        await this.sleep();
        await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 1000));
      } else {
        logger.debug('Already on correct DM thread, skipping navigation');
        // Small delay to simulate human checking page
        await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 300));
      }

      // Type the target name in the message field if provided
      if (fromTarget) {
        try {
          logger.debug('Typing target name into message field', { fromTarget });
          
          // Wait for message field to be available
          const messageField = await page.waitForSelector('div[aria-label="Message"][contenteditable="true"]', { timeout: 5000 });
          
          // Random delay before typing (simulating human thinking)
          await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
          
          // Click on the message field to focus it
          await messageField.click();
          
          // Small delay after click
          await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 200));
          
          // Type the target name
          await page.keyboard.type(fromTarget, { delay: Math.random() * 50 + 50 }); // Random typing speed
          
          // Random delay after typing
          await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 300));
          
          logger.debug('Successfully typed target name', { fromTarget });
        } catch (e) {
          logger.warn('Failed to type target name in message field', { error: e.message || e, fromTarget });
          // Continue anyway - this is not critical
        }
      }

      logger.debug("Waiting for file input element to appear");
      // Wait for and upload file
      const fileElement = await page.waitForSelector('input[type=file]', { timeout: 10000 });
      
      // Random delay before uploading (simulating human thinking/selecting file)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1200 + 800));
      logger.info('Uploading media via puppeteer', { filePath, recipientId });
      const resolvedPath = path.resolve(filePath);
      logger.debug('Resolved file path for upload', { resolvedPath });
      await fileElement.uploadFile(resolvedPath);

      // Wait for upload to process - longer random delay
      await this.sleep();
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 2000));

      // Random delay before attempting to click send (human reviewing upload)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 1000));

      // Click send button - try multiple selectors
      const sendButtonSelectors = [
        'button[aria-label="Send"]',
        'div[role="button"][aria-label="Send"]'
      ];

      let clicked = false;
      for (const selector of sendButtonSelectors) {
        try {
          // Small random delay before clicking
          await new Promise(resolve => setTimeout(resolve, Math.random() * 600 + 300));

          await page.waitForSelector(selector, { timeout: 3000 });
          
          // Click at random position within element to avoid bot detection
          const element = await page.$(selector);
          if (element) {
            const box = await element.boundingBox();
            if (box) {
              // Generate random click position within the element bounds
              const randomX = Math.random() * box.width + box.x;
              const randomY = Math.random() * box.height + box.y;
              await page.mouse.click(randomX, randomY);
              clicked = true;
              break;
            }
          }
        } catch (e) {
          logger.warn('Send button selector not found, trying next', { selector });
          logger.debug(e.message || e);
          // Try next selector
          continue;
        }
      }

      // If standard selectors didn't work, try finding by text content
      if (!clicked) {
        try {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 600 + 300));
          
          // Use page.evaluate to find element by text
          const sendButton = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const sendBtn = buttons.find(btn => btn.textContent.trim() === 'Send');
            if (sendBtn) {
              const rect = sendBtn.getBoundingClientRect();
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                found: true
              };
            }
            return { found: false };
          });
          
          if (sendButton.found) {
            await page.mouse.click(sendButton.x, sendButton.y);
            clicked = true;
            logger.debug('Send button clicked via text search');
          }
        } catch (e) {
          logger.warn('Text-based selector also failed', { error: e.message || e });
        }
      }

      if (!clicked) {
        throw new Error('Could not find Send button');
      }

      // Wait for send to complete with random delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 2000));
      
      // Don't close the page - reuse it for next send
      // await page.close();

      logger.info('Video sent successfully via puppeteer', { filePath, recipientId });
      return true;
    } catch (e) {
      logger.error('Failed to send video via puppeteer', { error: e.message || e, filePath, recipientId });
      return false;
    }
  }

  async _setupReactionListener() {
    if (!this.page) {
      logger.warn('Cannot set up reaction listener, page is not initialized.');
      return;
    }

    try {
      await this.page.exposeFunction('onNewReaction', async (reactionData) => {
        const { emoji, messageText } = reactionData;
        logger.info('New emoji reaction detected!', { emoji, messageText });

        // Log to JSON file
        const logFilePath = path.resolve(process.cwd(), 'reaction_log.json');
        let logs = {};
        try {
          if (fs.existsSync(logFilePath)) {
            logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
          }
        } catch (e) {
          logger.warn('Could not read reaction_log.json, starting fresh.', { error: e.message });
        }

        const [userId, fromTarget] = messageText.split(' ');
        const key = `${userId}_${fromTarget || ''}`.trim();
        if (!logs[key]) {
          logs[key] = {};
        }
        if (!logs[key][emoji]) {
          logs[key][emoji] = 0;
        }
        logs[key][emoji]++;

        try {
          fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2));
        } catch (e) {
          logger.error('Failed to write to reaction_log.json', { error: e.message });
        }

        // Handle angry emoji
        if (emoji.includes('😡')) {
          logger.info('Angry emoji detected. Attempting to unsend message.');
          try {
            await this.page.evaluate(async (emojiToFind) => {
                const emojiSpan = Array.from(document.querySelectorAll('span')).find(s => /\p{Emoji}/u.test(s.innerText) && s.innerText.includes(emojiToFind));
                if (!emojiSpan) {
                  console.log(`Could not find emoji span for ${emojiToFind} to start unsend process.`);
                  return;
                }

                const messageContainer = emojiSpan.closest('div[role="button"]');
                 if (!messageContainer) {
                    console.log('Could not find message container for angry emoji.');
                    return;
                }

                // The message container is where the reaction is. We need to find the message it's attached to.
                // This seems to be a sibling div.
                const messageRow = messageContainer.parentElement;
                if (!messageRow) {
                    console.log('Could not find message row.');
                    return;
                }
                
                // Hover over the message to make the 'More' button appear
                const mediaMessage = messageRow.querySelector('div[role="button"][tabindex="0"]');
                if(mediaMessage) {
                    mediaMessage.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 500)); // wait for hover effect
                }


                // Find and click the 'More' button (three dots)
                const moreButton = messageRow.querySelector('div[aria-label="More"]');
                if (moreButton) {
                  moreButton.click();
                  await new Promise(r => setTimeout(r, 500)); // wait for menu

                  // Find and click 'Unsend'
                  const unsendButton = Array.from(document.querySelectorAll('div[role="button"]')).find(el => el.innerText === 'Unsend');
                  if (unsendButton) {
                    unsendButton.click();
                    await new Promise(r => setTimeout(r, 500)); // wait for confirmation dialog

                    // Find and click 'Unsend' confirmation
                    const confirmButton = Array.from(document.querySelectorAll('button')).find(el => el.innerText === 'Unsend');
                    if (confirmButton) {
                      confirmButton.click();
                      console.log('Unsend confirmed.');
                    } else {
                       console.log('Could not find Unsend confirmation button.');
                    }
                  } else {
                    console.log('Could not find Unsend button in menu.');
                  }
                } else {
                    console.log('Could not find More button.');
                }
            }, '😡');
          } catch (e) {
            logger.error('Failed to execute unsend logic in Puppeteer', { error: e.message });
          }
        }
      });

      await this.page.evaluate(() => {
        const observer = new MutationObserver(mutations => {
          for (const mutation of mutations) {
            if (mutation.type === 'childList') {
              mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                  // Look for a span that contains an emoji
                  const emojiSpans = Array.from(node.querySelectorAll('span'));
                  const emojiRegex = /\p{Emoji}/u;

                  for (const span of emojiSpans) {
                    if (emojiRegex.test(span.innerText)) {
                      const emoji = span.innerText;
                      
                      let messageText = 'Could not determine message content.';
                      // Find the reaction node, which is a button
                      const reactionNode = span.closest('div[role="button"]');
                      if (reactionNode) {
                        // The reaction is inside a container, which is a sibling of the message container.
                        // Let's go up to the parent that holds both the message and the reaction list.
                        const messageRow = reactionNode.parentElement.parentElement; // up to the div that holds the message and reaction
                        if (messageRow) {
                            // The message with the text is a previous sibling.
                            let prevSibling = messageRow.previousElementSibling;
                            while(prevSibling) {
                                const textDiv = prevSibling.querySelector('div[dir="auto"]');
                                if (textDiv && textDiv.innerText.trim() !== '') {
                                    messageText = textDiv.innerText.trim();
                                    break; // Found it
                                }
                                prevSibling = prevSibling.previousElementSibling;
                            }
                        }
                      }
                      
                      window.onNewReaction({ emoji, messageText });
                      break; // Assume one reaction per mutation
                    }
                  }
                }
              });
            }
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      });

      logger.debug('Emoji reaction listener set up successfully.');
    } catch (error) {
      logger.error('Failed to set up emoji reaction listener', { error: error.message || error });
    }
  }

  async dispose() {
    // instagram-private-api manages its own connections; nothing to explicitly close
    if (this.page && !this.page.isClosed()) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = IGClient;