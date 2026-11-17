-- Kosta schema
-- All money is stored as bigint in minor units (kobo, cents, pence). No floats anywhere.

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL UNIQUE,              -- sha256 of the secret; the secret itself is never stored
  role        text NOT NULL CHECK (role IN ('client', 'admin')),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_id  uuid REFERENCES api_keys(id),
  kind          text NOT NULL CHECK (kind IN ('customer', 'system')),
  system_code   text,
  label         text,
  currency      char(3) NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  balance       bigint NOT NULL DEFAULT 0,       -- cached; always equals SUM(postings.amount), verified by /admin/reconciliation
  version       bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Last line of defence against overdrafts, even if application code is wrong.
  CONSTRAINT customer_balance_non_negative CHECK (kind = 'system' OR balance >= 0),
  CONSTRAINT system_code_matches_kind CHECK ((kind = 'system') = (system_code IS NOT NULL)),
  CONSTRAINT system_account_unique UNIQUE (system_code, currency)
);
CREATE INDEX accounts_owner_idx ON accounts (owner_key_id, created_at DESC);

CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  currency        char(3) NOT NULL,
  reference_type  text,
  reference_id    uuid,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE postings (
  id             bigserial PRIMARY KEY,
  entry_id       uuid NOT NULL REFERENCES journal_entries(id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  amount         bigint NOT NULL CHECK (amount <> 0),  -- positive = credit, negative = debit
  balance_after  bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON postings (account_id, id DESC);
CREATE INDEX postings_entry_idx ON postings (entry_id);

-- Double-entry invariant enforced by the database: every journal entry must sum to zero
-- at commit time. Deferred so all legs of an entry can be inserted first.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total FROM postings WHERE entry_id = NEW.entry_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (sum = %)', NEW.entry_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_must_balance
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- The ledger is append-only. Corrections are made with new reversing entries, never edits.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id  uuid NOT NULL REFERENCES accounts(id),
  to_account_id    uuid NOT NULL REFERENCES accounts(id),
  amount           bigint NOT NULL CHECK (amount > 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL CHECK (status IN ('completed')),
  narration        text,
  entry_id         uuid NOT NULL REFERENCES journal_entries(id),
  created_by       uuid NOT NULL REFERENCES api_keys(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

CREATE TABLE withdrawals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  amount           bigint NOT NULL CHECK (amount > 0),
  fee              bigint NOT NULL CHECK (fee >= 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'completed', 'rejected')),
  destination      jsonb NOT NULL,
  hold_entry_id    uuid NOT NULL REFERENCES journal_entries(id),
  settle_entry_id  uuid REFERENCES journal_entries(id),
  review_note      text,
  reviewed_by      uuid REFERENCES api_keys(id),
  reviewed_at      timestamptz,
  created_by       uuid NOT NULL REFERENCES api_keys(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals (status, created_at);

CREATE TABLE deposits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id),
  amount              bigint NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  provider            text NOT NULL,
  provider_reference  text NOT NULL,
  entry_id            uuid NOT NULL REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference)          -- a provider reference can only ever credit once
);

CREATE TABLE webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('processed', 'ignored', 'failed')),
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE idempotency_keys (
  api_key_id     uuid NOT NULL REFERENCES api_keys(id),
  key            text NOT NULL,
  method         text NOT NULL,
  path           text NOT NULL,
  request_hash   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_code  int,
  response_body  jsonb,
  locked_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, key)
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_key_id  uuid REFERENCES api_keys(id),
  actor         text NOT NULL,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     uuid,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
