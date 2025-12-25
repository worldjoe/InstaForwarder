const fs = require('fs');
const path = require('path');

/**
 * Parse TikTok JSON export and extract Following usernames
 * Usage: node parseTikTokFollowing.js <path-to-json-file>
 */

function parseTikTokFollowing(jsonFilePath) {
  try {
    // Read and parse JSON file
    const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
    const data = JSON.parse(jsonData);

    // Navigate to Following.Following array
    const following = data?.['Your Activity']?.Following?.Following || [];

    // Extract UserNames, filter out "N/A" and empty values
    const usernames = following
      .map(entry => entry.UserName)
      .filter(username => username && username !== 'N/A');

    // Return comma-delimited list
    return usernames.join(',');
  } catch (error) {
    console.error('Error parsing TikTok JSON:', error.message);
    throw error;
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node parseTikTokFollowing.js <path-to-json-file>');
    process.exit(1);
  }

  const jsonFilePath = path.resolve(args[0]);

  if (!fs.existsSync(jsonFilePath)) {
    console.error(`File not found: ${jsonFilePath}`);
    process.exit(1);
  }

  const result = parseTikTokFollowing(jsonFilePath);
  console.log(result);
}

// Export for use as module
module.exports = { parseTikTokFollowing };
