// Prints a valid X-Kosta-Signature header for a JSON body, for testing webhooks with curl.
// Usage: npx tsx scripts/sign-webhook.ts '<raw json body>'
import { config } from '../src/config.js';
import { signWebhook } from '../src/routes/webhooks.js';

const body = process.argv[2];
if (!body) {
  console.error("usage: npx tsx scripts/sign-webhook.ts '<raw json body>'");
  process.exit(1);
}
console.log(signWebhook(body, config.webhookSecret));
