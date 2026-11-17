import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from './db.js';
import { Errors } from './errors.js';
import type { Actor } from './audit.js';

export interface ApiKeyContext {
  id: string;
  name: string;
  role: 'client' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
    rawBody?: string;
  }
}

export const hashKey = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Generates a new API key. Only the hash is persisted; the plain secret is shown once. */
export async function createApiKey(name: string, role: 'client' | 'admin') {
  const secret = `ks_${role === 'admin' ? 'admin' : 'live'}_${randomBytes(24).toString('base64url')}`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO api_keys (name, key_prefix, key_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, secret.slice(0, 12), hashKey(secret), role],
  );
  return { id: rows[0]!.id, secret, role, name };
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();
  const secret = header.slice('Bearer '.length).trim();
  if (!secret) throw Errors.unauthorized();

  const { rows } = await getPool().query<ApiKeyContext>(
    `SELECT id, name, role FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashKey(secret)],
  );
  if (!rows[0]) throw Errors.unauthorized();
  request.apiKey = rows[0];
}

export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.apiKey?.role !== 'admin') throw Errors.forbidden();
}

export const actorOf = (request: FastifyRequest): Actor => ({
  keyId: request.apiKey?.id ?? null,
  label: request.apiKey ? `${request.apiKey.role}:${request.apiKey.name}` : 'system',
});
