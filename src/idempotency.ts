import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getPool, withTx, type Tx } from './db.js';
import { AppError } from './errors.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value));

/**
 * Stripe-style idempotency for money-moving POST endpoints.
 *
 * 1. The key is claimed with an INSERT committed on its own, so a concurrent duplicate
 *    request sees the claim and gets 409 instead of double-spending.
 * 2. The business operation and the stored response are written in ONE transaction,
 *    so a response is recorded if and only if the money actually moved.
 * 3. A retry with the same key and same body replays the stored response
 *    (header Idempotent-Replayed: true). Same key with a different body is rejected.
 * 4. Client errors (4xx) are stored and replayed too. Server errors release the key
 *    so the client can safely retry.
 */
export async function idempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (tx: Tx) => Promise<HandlerResult>,
): Promise<FastifyReply> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 255) {
    throw new AppError(
      400,
      'idempotency_key_required',
      'Send a unique Idempotency-Key header (8 to 255 characters) with every money-moving request.',
    );
  }
  const apiKeyId = request.apiKey!.id;
  const path = request.routeOptions.url ?? request.url;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ method: request.method, path, params: request.params, body: request.body ?? null }))
    .digest('hex');

  const pool = getPool();
  const claim = await pool.query(
    `INSERT INTO idempotency_keys (api_key_id, key, method, path, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'in_progress')
     ON CONFLICT (api_key_id, key) DO UPDATE
        SET locked_at = now()
      WHERE idempotency_keys.status = 'in_progress'
        AND idempotency_keys.request_hash = EXCLUDED.request_hash
        AND idempotency_keys.locked_at < now() - make_interval(secs => $6)
     RETURNING key`,
    [apiKeyId, key, request.method, path, requestHash, config.idempotencyLockSeconds],
  );

  if (claim.rowCount === 0) {
    const { rows } = await pool.query<{
      request_hash: string;
      status: string;
      response_code: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, status, response_code, response_body
         FROM idempotency_keys WHERE api_key_id = $1 AND key = $2`,
      [apiKeyId, key],
    );
    const existing = rows[0]!;
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        422,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (existing.status === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed.');
    }
    return reply.header('Idempotent-Replayed', 'true').code(existing.response_code!).send(existing.response_body);
  }

  const save = (tx: Tx | typeof pool, status: number, body: unknown) =>
    tx.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_code = $3, response_body = $4
        WHERE api_key_id = $1 AND key = $2`,
      [apiKeyId, key, status, JSON.stringify(body)],
    );

  try {
    const result = await withTx(async (tx) => {
      const res = await operation(tx);
      const body = toJson(res.body);
      await save(tx, res.status, body);
      return { status: res.status, body };
    });
    return reply.code(result.status).send(result.body);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      const body = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
      await save(pool, err.statusCode, body);
      throw err;
    }
    await pool.query(`DELETE FROM idempotency_keys WHERE api_key_id = $1 AND key = $2`, [apiKeyId, key]);
    throw err;
  }
}
