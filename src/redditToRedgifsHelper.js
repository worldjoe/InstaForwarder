const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const OUTPUT_FILE = path.resolve(process.cwd(), 'redgifs_users.json');

class RedditToRedgifsHelper {
  constructor(redditCookie) {
    this.redditCookie = redditCookie; // Reddit cookie for authentication (e.g., "reddit_session=...")
    this.foundUsers = [];
  }

  // Fetch Reddit page and extract followed users
  async getFollowedRedditUsers() {
    // Try multiple endpoints to find followed users
    const urls = [
      'https://old.reddit.com/subreddits/mine',  // Subscribed subreddits (may include user profiles)
      'https://old.reddit.com/prefs/friends/'     // Friends list
    ];
    
    const allUsers = new Set();
    
    for (const url of urls) {
      logger.info('Fetching Reddit page', { url });
      
      try {
        const users = await this._fetchPageUsers(url);
        users.forEach(u => allUsers.add(u));
        logger.info('Found users from page', { url, count: users.length });
      } catch (e) {
        logger.error('Error fetching page', { url, error: e.message });
      }
    }
    
    logger.info('Total Reddit users found', { count: allUsers.size });
    return Array.from(allUsers);
  }

  async _fetchPageUsers(url) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'Cookie': this.redditCookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };

      https.get(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            // Save debug output
            if (process.env.DEBUG_REDDIT) {
              const debugFile = path.join(process.cwd(), `debug_reddit_${Date.now()}.html`);
              fs.writeFileSync(debugFile, data);
              logger.info('Saved debug HTML', { file: debugFile });
            }

            const users = new Set();
            
            // Pattern 1: Links to user profiles (/u/username or /user/username)
            // Updated to handle full URLs properly
            const userPattern1 = /reddit\.com\/user\/([a-zA-Z0-9_-]+)/gi;
            let match;
            while ((match = userPattern1.exec(data)) !== null) {
              users.add(match[1]);
            }
            
            // Pattern 2: Links to user profiles with /u/ pattern
            const userPattern2 = /reddit\.com\/u\/([a-zA-Z0-9_-]+)/gi;
            while ((match = userPattern2.exec(data)) !== null) {
              users.add(match[1]);
            }
            
            // Pattern 3: Subreddits that are actually user profiles (data-sr_name="u_username")
            const userPattern3 = /data-sr_name="u_([a-zA-Z0-9_-]+)"/gi;
            while ((match = userPattern3.exec(data)) !== null) {
              users.add(match[1]);
            }
            
            // Pattern 4: Friends list format (if using prefs/friends)
            const friendPattern = /<span class="user"[^>]*>([a-zA-Z0-9_-]+)<\/span>/gi;
            while ((match = friendPattern.exec(data)) !== null) {
              users.add(match[1]);
            }
            
            logger.debug('Parsed users from HTML', { count: users.size, sample: Array.from(users).slice(0, 5) });
            resolve(Array.from(users));
          } catch (e) {
            logger.error('Error parsing Reddit response', { error: e.message });
            reject(e);
          }
        });
      }).on('error', (e) => {
        logger.error('Error fetching Reddit page', { error: e.message });
        reject(e);
      });
    });
  }

  // Check if a user has a Redgifs account
  async checkRedgifsAccount(username) {
    const url = `https://www.redgifs.com/users/${username.toLowerCase()}`;
    
    return new Promise((resolve) => {
      const options = {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };

      https.request(url, options, (res) => {
        // If we get 200 or 3xx, the user likely exists
        // 404 means no account
        const exists = res.statusCode >= 200 && res.statusCode < 400;
        resolve(exists);
      }).on('error', () => {
        resolve(false);
      }).end();
    });
  }

  // Main process: get Reddit users and check Redgifs
  async process() {
    try {
      logger.info('Starting Reddit to Redgifs user discovery...');
      
      // Get followed Reddit users
      const redditUsers = await this.getFollowedRedditUsers();
      
      if (redditUsers.length === 0) {
        logger.warn('No Reddit users found. Make sure you provide a valid Reddit cookie.');
        return [];
      }

      logger.info('Checking Redgifs accounts...', { totalUsers: redditUsers.length });
      
      // Check each user for Redgifs account
      const results = [];
      for (let i = 0; i < redditUsers.length; i++) {
        const username = redditUsers[i];
        
        // Add delay to avoid rate limiting
        if (i > 0) {
          await new Promise(r => setTimeout(r, 1000));
        }
        
        logger.debug(`Checking ${i + 1}/${redditUsers.length}: ${username}`);
        
        const hasRedgifs = await this.checkRedgifsAccount(username);
        
        if (hasRedgifs) {
          results.push(username);
          logger.info('Found Redgifs account', { username });
        }
      }

      // Save results
      this.foundUsers = results;
      this._saveResults();
      
      logger.info('Completed Reddit to Redgifs discovery', { 
        totalChecked: redditUsers.length,
        foundAccounts: results.length 
      });
      
      return results;
      
    } catch (e) {
      logger.error('Error in Reddit to Redgifs process', { error: e.message });
      throw e;
    }
  }

  _saveResults() {
    try {
      const output = {
        timestamp: new Date().toISOString(),
        count: this.foundUsers.length,
        users: this.foundUsers
      };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
      logger.info('Saved Redgifs users list', { file: OUTPUT_FILE, count: this.foundUsers.length });
    } catch (e) {
      logger.error('Failed to save results', { error: e.message });
    }
  }
}

// Run as standalone script
if (require.main === module) {
  (async () => {
    // Get Reddit cookie from environment variable or command line
    const redditCookie = process.env.REDDIT_COOKIE || process.argv[2];
    
    if (!redditCookie) {
      console.error('ERROR: Reddit cookie required!');
      console.error('');
      console.error('Usage:');
      console.error('  node redditToRedgifsHelper.js "reddit_session=YOUR_SESSION_COOKIE"');
      console.error('');
      console.error('Or set REDDIT_COOKIE environment variable');
      console.error('');
      console.error('To get your Reddit cookie:');
      console.error('  1. Log in to https://old.reddit.com');
      console.error('  2. Open browser DevTools (F12)');
      console.error('  3. Go to Application/Storage > Cookies > https://old.reddit.com');
      console.error('  4. Copy the "reddit_session" cookie value');
      process.exit(1);
    }

    const helper = new RedditToRedgifsHelper(redditCookie);
    const users = await helper.process();
    
    console.log('');
    console.log('='.repeat(50));
    console.log(`Found ${users.length} Redgifs accounts:`);
    console.log('='.repeat(50));
    users.forEach(u => console.log(`  - ${u}`));
    console.log('');
    console.log(`Results saved to: ${OUTPUT_FILE}`);
  })();
}

module.exports = RedditToRedgifsHelper;
