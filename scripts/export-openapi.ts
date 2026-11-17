import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/db.js';

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote docs/openapi.json (${Object.keys(spec.paths ?? {}).length} paths)`);
await app.close();
await closePool();
