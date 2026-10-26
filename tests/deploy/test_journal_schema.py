import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

from deploy.common import DeployError
from deploy.journal import recover_journal
from deploy.journal_schema import BASE, RETIREMENTS


class CurrentJournalCompatibilityTests(unittest.TestCase):
    def create_current_journal(self, path):
        # Construct the actual compiled class, including every child module.
        # Extracting one DDL string silently omitted automations and worktrees.
        self.open_real_ledger(path)
        db = sqlite3.connect(path)
        db.execute("INSERT INTO receipts(id,method,scope,digest,state,created_at,updated_at) VALUES('pending','turn/start','thread:t','d','pending',1,1)")
        db.execute("INSERT INTO receipts(id,method,scope,digest,state,created_at,updated_at) VALUES('sent','turn/start','thread:t','d','dispatching',1,1)")
        db.execute("INSERT INTO retired_operations(id,created_at) VALUES('fenced',1)")
        db.execute("INSERT INTO metadata(key,value) VALUES('activityUncertain','true')")
        db.execute("INSERT INTO projects VALUES('project','/project','Retained project')")
        db.execute("INSERT INTO automations VALUES('automation',1,'paused','{}',NULL,1,1)")
        db.execute("INSERT INTO automation_runs VALUES('run','automation',1,1,0,'operation','client','completed',NULL,NULL,1,2,0,0,NULL,'{}')")
        db.execute("INSERT INTO worktree_projects VALUES('worktree','project','/worktree','Retained worktree','active','head','revision',1,1)")
        db.commit()
        return db

    def open_real_ledger(self, path):
        entry = Path(__file__).resolve().parents[2] / 'dist/src/core/ledger.js'
        self.assertTrue(entry.is_file(), 'Run pnpm build:server before the cross-language Ledger integration test')
        node = os.environ.get('HARNESS_TEST_NODE') or shutil.which('node')
        self.assertTrue(node, 'Node 24 is required for the actual Ledger integration')
        script = "const {Ledger}=await import(process.argv[1]);const ledger=new Ledger(process.argv[2]);console.log(JSON.stringify(ledger.read('pending')));ledger.close();"
        result = subprocess.run([node, '--input-type=module', '-e', script, entry.as_uri(), str(path)],
                                capture_output=True, text=True, timeout=30, check=True)
        return json.loads(result.stdout)

    def test_stopped_recovery_accepts_current_gateway_schema_and_preserves_fences(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite'
            with self.create_current_journal(path) as db:
                self.assertEqual(recover_journal(path, services_stopped=True), {'notSent': 1, 'unknown': 1})
                self.assertEqual(dict(db.execute('SELECT id,state FROM receipts')), {'pending': 'not_sent', 'sent': 'unknown'})
                self.assertEqual(db.execute('SELECT * FROM retired_operations').fetchall(), [('fenced', 1)])
                self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='activityUncertain'").fetchone()[0], 'false')
                self.assertEqual(db.execute('SELECT name FROM projects').fetchall(), [('Retained project',)])
                self.assertEqual(db.execute('SELECT state FROM automations').fetchall(), [('paused',)])
                self.assertEqual(db.execute('SELECT state FROM automation_runs').fetchall(), [('completed',)])
                self.assertEqual(db.execute('SELECT name FROM worktree_projects').fetchall(), [('Retained worktree',)])
            db.close()
            self.assertEqual(self.open_real_ledger(path)['state'], 'not_sent')

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

    def test_explicit_legacy_schemas_remain_recoverable(self):
        for ddl in (BASE, BASE + RETIREMENTS):
            with self.subTest(retirements=RETIREMENTS in ddl), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'journal.sqlite'
                with sqlite3.connect(path) as db:
                    db.executescript(ddl)
                db.close()
                self.assertEqual(recover_journal(path, services_stopped=True), {'notSent': 0, 'unknown': 0})

    def test_schema_formatting_normalization_does_not_erase_literal_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite'
            db = sqlite3.connect(path)
            db.executescript(BASE.replace("'pending'", "'pen ding'"))
            db.close()
            with self.assertRaises(DeployError): recover_journal(path, services_stopped=True)

    def test_current_schema_rejects_changed_indexes_views_columns_and_hidden_prefix(self):
        for mutation in (
            'DROP INDEX automation_run_order; CREATE INDEX automation_run_order ON automation_runs(state)',
            'DROP INDEX automation_occurrence; CREATE UNIQUE INDEX automation_occurrence ON automation_runs(automation_id,revision,scheduled_at)',
            'CREATE VIEW unexpected AS SELECT * FROM receipts',
            'ALTER TABLE worktree_projects ADD COLUMN unexpected TEXT',
            'CREATE TABLE sqlitex_hidden(value TEXT)',
            'PRAGMA user_version=99',
        ):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'journal.sqlite'
                with self.create_current_journal(path) as db:
                    db.executescript(mutation)
                    with self.assertRaises(DeployError):
                        recover_journal(path, services_stopped=True)
                    self.assertEqual(db.execute("SELECT state FROM receipts WHERE id='pending'").fetchone()[0], 'pending')
                db.close()


if __name__ == '__main__':
    unittest.main()
