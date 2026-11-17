import { createApiKey } from '../src/auth.js';
import { closePool } from '../src/db.js';
import { migrate } from './migrate.js';

await migrate(false);
const admin = await createApiKey('ops-admin', 'admin');
const client = await createApiKey('demo-app', 'client');

console.log('\nAPI keys created. These secrets are shown once and only their hashes are stored.\n');
console.log(`  admin   ${admin.secret}`);
console.log(`  client  ${client.secret}\n`);
console.log('Open http://localhost:3000/docs, click Authorize and paste a key.\n');
await closePool();
