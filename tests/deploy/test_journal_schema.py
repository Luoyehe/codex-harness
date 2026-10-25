import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from deploy.common import DeployError
from deploy.journal import recover_journal


class CurrentJournalCompatibilityTests(unittest.TestCase):
    def create_current_journal(self, path):
        # Use the actual gateway DDL, so future tables cannot silently diverge
        # from the independently implemented stop-confirmed recovery protocol.
        source = (Path(__file__).resolve().parents[2] / 'src/core/ledger.ts').read_text(encoding='utf-8')
        statement = re.search(r'this\.#db\.exec\(`([^`]+)`\);', source)
        self.assertIsNotNone(statement)
        db = sqlite3.connect(path)
        db.executescript(statement[1])
        db.execute("INSERT INTO receipts(id,method,scope,digest,state,created_at,updated_at) VALUES('pending','turn/start','thread:t','d','pending',1,1)")
        db.execute("INSERT INTO receipts(id,method,scope,digest,state,created_at,updated_at) VALUES('sent','turn/start','thread:t','d','dispatching',1,1)")
        db.execute("INSERT INTO retired_operations(id,created_at) VALUES('fenced',1)")
        db.execute("INSERT INTO metadata(key,value) VALUES('activityUncertain','true')")
        db.commit()
        return db

    def test_stopped_recovery_accepts_current_gateway_schema_and_preserves_fences(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite'
            with self.create_current_journal(path) as db:
                self.assertEqual(recover_journal(path, services_stopped=True), {'notSent': 1, 'unknown': 1})
                self.assertEqual(dict(db.execute('SELECT id,state FROM receipts')), {'pending': 'not_sent', 'sent': 'unknown'})
                self.assertEqual(db.execute('SELECT * FROM retired_operations').fetchall(), [('fenced', 1)])
                self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='activityUncertain'").fetchone()[0], 'false')
            db.close()

    def test_unexpected_schema_still_refuses_recovery_without_mutating_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite'
            with self.create_current_journal(path) as db:
                db.execute('CREATE TABLE unexpected(value TEXT)')
                db.commit()
                with self.assertRaises(DeployError):
                    recover_journal(path, services_stopped=True)
                self.assertEqual(db.execute("SELECT state FROM receipts WHERE id='pending'").fetchone()[0], 'pending')
            db.close()


if __name__ == '__main__':
    unittest.main()
