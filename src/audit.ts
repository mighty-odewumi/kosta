import type { Tx } from './db.js';

export interface Actor {
  keyId: string | null;
  label: string;
}

export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor_key_id, actor, action, target_type, target_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.keyId, actor.label, action, targetType, targetId, JSON.stringify(data)],
  );
}
