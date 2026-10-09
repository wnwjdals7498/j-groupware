ALTER TABLE customers
 ADD COLUMN contract_status text NOT NULL DEFAULT 'prepared'
   CHECK (contract_status IN ('prepared','active','ended')),
 ADD COLUMN contract_revision integer NOT NULL DEFAULT 1 CHECK (contract_revision>0),
 ADD COLUMN contract_changed_at timestamptz NOT NULL DEFAULT now();
