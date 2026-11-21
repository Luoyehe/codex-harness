import tomllib
import unittest

from deploy import native_toml
from deploy.mcp_user_toml import edit_server
from deploy.provider_layers import toml_value


class UserMcpToml(unittest.TestCase):
    def test_create_without_config_or_with_other_sections(self):
        for source in ("", "\ufeff", "# Local settings\r\n[another]\r\nkey = 1 # EOF"):
            with self.subTest(source=source):
                result = edit_server(source, 'server.with space"\\q', {"command": "/bin/tool", "args": ["a#b"]})
                self.assertTrue(result.startswith(source))
                self.assertEqual(native_toml.loads(result)["mcp_servers"],
                                 {'server.with space"\\q': {"command": "/bin/tool", "args": ["a#b"]}})
                self.assertEqual(edit_server(result, 'server.with space"\\q', {"command": "/bin/tool"}), result)
                self.assertEqual(edit_server(source, "absent", None), source)

    def test_ordinary_field_changes_preserve_exact_bytes(self):
        source = ("\ufeff# config header\r\nmodel = 'custom'\r\n"
                  '["mcp\\u005fservers"."service.with space"] # service\n'
                  "  command  =  'old'   # path\r\n"
                  "args = [\n 'old', # keep the literal spelling and newlines\r\n]\n"
                  "startup_timeout_sec = 1e+01\r\nenabled = false\n"
                  "# adjacent section\r\n[mcp_servers.sibling]\r\ncommand='keep' # EOF")
        modified = edit_server(source, "service.with space", {"command": "new"})
        self.assertEqual(modified, source.replace("  'old'   # path", '  "new"   # path'))
        self.assertEqual(edit_server(source, "service.with space", {"command": "old"}), source)

    def test_embedded_quotes_backslashes_and_control_characters_in_keys_and_values(self):
        left = "[metadata]\nlabel='neighbor'\n"
        for name in ('service.1', 'two words', "quoted'\"", "back\\slash", 'ctl\n#name', ''):
            with self.subTest(name=name):
                key = toml_value(name)
                document = left + '[mcp_servers.' + key + ']\ncommand="old"\n'
                values = {'A.\\B"\n': 'value\n#fake.header"'}
                result = edit_server(document, name, {"env": values})
                self.assertEqual(tomllib.loads(result)["mcp_servers"][name], {"command": "old", "env": values})
                self.assertTrue(result.startswith(document))
                self.assertEqual(edit_server(result, name, None), left)

    def test_nested_and_dotted_maps_keep_unchanged_entries(self):
        for head, prefix in [("[mcp_servers.me.env]\n", ""), ("[mcp_servers.me]\n", "env."),
                             ("[mcp_servers]\n", "me.env."), ("", "mcp_servers.me.env.")]:
            with self.subTest(prefix=prefix):
                keep = prefix + "'A.A' = 'same'  # unchanged entry\r\n"
                source = (head + keep + prefix + 'B = "old" # B\n' + prefix + 'C = "gone" # C\r\n'
                          + "# following server\n[mcp_servers.neighbor]\ncommand = 'keep'\r\n")
                result = edit_server(source, "me", {"env": {"A.A": "same", "B": "fresh", '"D"': "added"}})
                self.assertIn(keep, result)
                self.assertIn(prefix + 'B = "fresh" # B\n', result)
                self.assertIn("# C\r\n", result)
                self.assertTrue(result.endswith("# following server\n[mcp_servers.neighbor]\ncommand = 'keep'\r\n"))
                self.assertEqual(tomllib.loads(result)["mcp_servers"]["me"]["env"],
                                 {"A.A": "same", "B": "fresh", '"D"': "added"})

    def test_dotted_inline_and_parent_inline_changes_are_local(self):
        neighbor = "neighbor = { command='exact', note=' [fake] # ' }"
        source = ("mcp_servers = { " + neighbor + ", 'x.y'.command = 'old', "
                  "'x.y'.env = { 'A#1' = 'keep', B = 'edit', C = 'remove' }, 'x.y'.custom = 0xCA_FE }\n")
        changes = {"env": {"A#1": "keep", "B": "edited", "D": "new"}, "command": "new"}
        result = edit_server(source, "x.y", changes)
        self.assertIn(neighbor, result)
        self.assertIn("'A#1' = 'keep'", result)
        self.assertIn("'x.y'.custom = 0xCA_FE", result)
        self.assertEqual(tomllib.loads(result)["mcp_servers"]["x.y"], {**changes, "custom": 0xCAFE})
        deleted = edit_server(result, "x.y", None)
        self.assertIn(neighbor, deleted)
        self.assertEqual(tomllib.loads(deleted)["mcp_servers"], {"neighbor": {"command": "exact", "note": " [fake] # "}})

    def test_native_multiline_inline_bom_dates_and_strings(self):
        untouched = ('\ufeffrelease = 0000-02-29\r\nleap = 23:59:60\nprecise=04:05:06.123456789\r\n'
                     "template = '''\n[mcp_servers.me]\r\n# not a real comment\n'''\r\n")
        sibling = "# note for sibling\r\n sibling = { command = 'keep', }, # sibling suffix\n"
        source = (untouched + "mcp_servers = {\n " + sibling + " me = {\n  command = 'tool',\r\n"
                  "  http_headers = {\n   'X.Test' = 'retain', # key note\r\n   B = 'change',\n  },\n },\r\n}\n")
        additions = edit_server(source, "created", {"command": "also here"})
        self.assertIn(sibling, additions)
        self.assertTrue(additions.startswith(untouched))
        result = edit_server(source, "me", {"http_headers": {"X.Test": "retain", "B": "new", "Added": "value"}})
        for part in (untouched, sibling, "'X.Test' = 'retain', # key note\r\n", "command = 'tool',\r\n"):
            self.assertIn(part, result)
        self.assertEqual(native_toml.loads(result)["mcp_servers"]["me"]["http_headers"],
                         {"X.Test": "retain", "B": "new", "Added": "value"})

    def test_removing_last_inline_member_reads_as_toml_10(self):
        for names in (("me",), ("me", "other"), ("other", "me"), ("first", "me", "last")):
            with self.subTest(names=names):
                source = "mcp_servers = {" + ", ".join(n + "={command='tool'}" for n in names) + "}"
                result = edit_server(source, "me", None)
                self.assertEqual(tomllib.loads(result)["mcp_servers"],
                                 {n: {"command": "tool"} for n in names if n != "me"})

    def test_transport_conversion_preserves_unselected_fields_and_comments(self):
        top = ("[mcp_servers.me] # selected server\r\n"
               "enabled = false\nstartup_timeout_sec = 1e1 # spelling\n"
               "custom = '''one\n# text\n'''\n")
        cmd = ("command = 'tool' # executable\nargs = [\r\n  '-x', # option\r\n]\r\n"
               "[mcp_servers.me.env] # map\n# operator note\n'A.A' = 'private'\r\n")
        sibling = "# next provider\n[mcp_servers.other]\nurl='kept'\n"
        result = edit_server(top + cmd + sibling, "me",
                             {"command": None, "args": None, "env": None, "url": "https://example.invalid",
                              "http_headers": {"X-Access": "fixture"}})
        self.assertTrue(result.startswith(top))
        self.assertTrue(result.endswith(sibling))
        for note in ("# executable\n", "# option\r\n", "# map\n", "# operator note\n"):
            self.assertIn(note, result)
        row = tomllib.loads(result)["mcp_servers"]["me"]
        self.assertEqual(set(row), {"url", "http_headers", "enabled", "startup_timeout_sec", "custom"})
        self.assertEqual(row["http_headers"], {"X-Access": "fixture"})

    def test_empty_or_omitted_maps_and_implicit_server(self):
        for source in ("mcp_servers.me.env.key = 'v'\r\n",
                       "[mcp_servers.me.env]\nkey = 'v'\r\n",
                       "[mcp_servers]\nme = {env.key='v'}\n",
                       "mcp_servers={me.env.key = 'v'}"):
            with self.subTest(source=source):
                empty = edit_server(source, "me", {"env": {}})
                self.assertEqual(tomllib.loads(empty)["mcp_servers"]["me"], {"env": {}})
                no_env = edit_server(source, "me", {"env": None})
                self.assertEqual(tomllib.loads(no_env)["mcp_servers"]["me"], {})
                self.assertEqual(edit_server(no_env, "me", {}), no_env)

    def test_user_array_tables_and_disjoint_sections(self):
        neighbor = "[[mcp_servers.other.filters]]\nname = 'untouched'\n"
        source = ("[[mcp_servers.me.filters]] # one\nname='first'\n" + neighbor
                  + "[[mcp_servers.me.filters]] # two\nname='second'\n[mcp_servers.me]\ncommand='keep'\n")
        updated = edit_server(source, "me", {"command": "new"})
        self.assertEqual(updated, source.replace("command='keep'", 'command="new"'))
        removed = edit_server(source, "me", None)
        self.assertEqual(removed, "# one\n" + neighbor + "# two\n")
        changed = edit_server(source, "me", {"filters": ["ready"]})
        self.assertIn(neighbor, changed)
        self.assertEqual(tomllib.loads(changed)["mcp_servers"]["me"], {"command": "keep", "filters": ["ready"]})

    def test_selected_inline_removal_preserves_real_comments_only(self):
        source = ("mcp_servers = { keep = {command='sibling'}, me={\n"
                  " command='hash # in string', # maintain\r\n"
                  ' args=["""\n# data in text\n""", # options\n ],\n}, }\n')
        result = edit_server(source, "me", None)
        self.assertIn("# maintain\r\n", result)
        self.assertIn("# options\n", result)
        self.assertNotIn("in string", result)
        self.assertNotIn("data in text", result)
        self.assertIn("keep = {command='sibling'}", result)
        self.assertEqual(native_toml.loads(result), {"mcp_servers": {"keep": {"command": "sibling"}}})

    def test_commented_array_in_a_toml_10_inline_table(self):
        source = ("# settings\n"
                  "mcp_servers = {me={args=['one', # keep this note\r\n 'two'], command='keep'}}\n")
        result = edit_server(source, "me", {"args": ["new"]})
        self.assertIn("# keep this note\r\n", result)
        self.assertIn("command='keep'", result)
        self.assertEqual(tomllib.loads(result)["mcp_servers"]["me"], {"args": ["new"], "command": "keep"})

    def test_reject_invalid_original_before_edits(self):
        for source in ("mcp_servers = 42", "[mcp_servers.me]\ncommand='first'\ncommand='second'"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                edit_server(source, "me", {"command": "new"})


if __name__ == "__main__":
    unittest.main()
