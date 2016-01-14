DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE EXTENSION IF NOT EXISTS plv8;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE draws(
  id                              bigint      PRIMARY KEY,
  prize                           bigint      NOT NULL DEFAULT 0,
  tickets_bought                  bigint      NOT NULL DEFAULT 0,
  sponsor_contribution            bigint      NOT NULL DEFAULT 0,
  block_hash                      text        NULL,
  winning_ticket                  bigint      NULL,
  winning_lottery_payment_id      bigint      NULL,
  winner_registered_address_id    uuid        NULL,
  winner_txid                     text        NULL,
  stretched_block_hash            text        NULL,
  bonus_carry                     bigint      NOT NULL DEFAULT 0,
  winner_bonus                    bigint      NOT NULL DEFAULT 0
);

INSERT INTO draws(id) (
    SELECT i  FROM generate_series(1, 1000) i
);


CREATE TABLE sponsors (
  id                   bigserial                 PRIMARY KEY,
  name                 text                      NOT NULL,
  url                  text                      NOT NULL,
  bitcoin_address      text                      NOT NULL UNIQUE,
  pic                  bytea                     NOT NULL,
  scanned_height       bigint                    NOT NULL DEFAULT 0,
  created              timestamptz               NOT NULL DEFAULT NOW(),
  unique(bitcoin_address)
);

CREATE INDEX sponsors_bitcoin_address_idx ON sponsors(bitcoin_address);


CREATE TABLE sponsor_payments (
  id           bigserial   PRIMARY KEY,
  sponsor_id   bigint      NOT NULL REFERENCES sponsors(id),
  draw_id      bigint      NOT NULL REFERENCES draws(id),
  txid         text        NOT NULL,
  vout         bigint      NOT NULL,
  block_height bigint      NULL,
  amount       bigint      NOT NULL,
  dust         boolean     NOT NULL,
  created      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(txid, vout)
);

CREATE INDEX sponsor_payments_sponsor_id_idx ON sponsor_payments(sponsor_id);
CREATE INDEX sponsor_payments_draw_idx ON sponsor_payments(draw_id, block_height DESC NULLS FIRST, id);
CREATE INDEX sponsor_payments_block_height_idx ON sponsor_payments(block_height);

CREATE OR REPLACE FUNCTION sponsor_payments_update_draw_trigger()
  RETURNS trigger AS $$

  var updateQuery = 'UPDATE draws SET ' +
    'prize = prize + ROUND($1*0.9), ' +
    'sponsor_contribution = sponsor_contribution + ROUND($1*0.9) ' +
    'WHERE id = $2';

  if (OLD && !OLD.dust) {
    plv8.execute(updateQuery, [-OLD.amount, OLD.draw_id]);
  }

  if (NEW && !NEW.dust) {
    plv8.execute(updateQuery, [NEW.amount, NEW.draw_id]);
  }

$$ LANGUAGE plv8;

CREATE TRIGGER sponsor_payments_update_draw_trigger
AFTER INSERT OR UPDATE OR DELETE ON sponsor_payments
    FOR EACH ROW EXECUTE PROCEDURE sponsor_payments_update_draw_trigger();


-- single row table
CREATE TABLE info (
  lottery_scanned_height bigint NOT NULL
);

CREATE UNIQUE INDEX info_single_row ON info((1)); -- force it single row
INSERT INTO info(lottery_scanned_height)
          VALUES(0);

CREATE TABLE registered_addresses (
  id                    uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  bitcoin_address       text        NOT NULL,
  message               text        NOT NULL,
  signature             text        NOT NULL,
  forwarding_index      bigint      NULL  UNIQUE,
  forwarding_last_check timestamptz NULL,
  forwarding_next_check interval    NULL,
  created               timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX registered_addresses_need_check ON
   registered_addresses((forwarding_last_check AT TIME ZONE 'utc' + forwarding_next_check));


CREATE INDEX registered_addresses_bitcoin_address_idx ON
  registered_addresses(bitcoin_address, id);

CREATE SEQUENCE forwarding_index_seq;

CREATE TABLE lottery_payments(
  id                      bigserial   PRIMARY KEY,
  draw_id                 bigint      NOT NULL REFERENCES draws(id),
  txid                    text        NOT NULL,
  vout                    bigint      NOT NULL,
  amount                  bigint      NOT NULL,
  dust                    boolean     NOT NULL,
  sending_bitcoin_address text        NULL,
  block_height            bigint      NULL,
  created                 timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(txid, vout)
);

CREATE INDEX lottery_payments_draw_idx ON lottery_payments(draw_id, dust, txid, vout);
CREATE INDEX lottery_payments_block_height_idx ON lottery_payments(block_height);

CREATE OR REPLACE FUNCTION lottery_payments_update_draw_trigger()
  RETURNS trigger AS $$

  var updateQuery = 'UPDATE draws SET ' +
    'prize = prize + $1, ' +
    'tickets_bought = tickets_bought + $1 ' +
    'WHERE id = $2';

  if (OLD && !OLD.dust) {
    plv8.execute(updateQuery, [-OLD.amount, OLD.draw_id]);
  }

  if (NEW && !NEW.dust) {
    plv8.execute(updateQuery, [NEW.amount, NEW.draw_id]);
  }

$$ LANGUAGE plv8;

CREATE TRIGGER lottery_payments_update_draw_trigger
AFTER INSERT OR UPDATE OR DELETE ON lottery_payments
    FOR EACH ROW EXECUTE PROCEDURE lottery_payments_update_draw_trigger();
