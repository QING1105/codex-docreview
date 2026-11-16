import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('audit_release', Path(__file__).resolve().parents[1] / 'audit_release.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class ReleaseAuditTests(unittest.TestCase):
    def test_detects_secrets_without_echoing_values(self):
        sample = 'gh' + 'p_' + 'x' * 36
        result = audit.scan_content('sample.js', sample.encode())
        self.assertEqual(result[0]['category'], 'credential-token')
        self.assertNotIn(sample, str(result))

    def test_detects_personal_paths_and_state(self):
        sample = 'C:' + chr(92) + 'Users' + chr(92) + 'private-test' + chr(92) + 'draft'
        self.assertTrue(audit.scan_content('sample.txt', sample.encode()))
        self.assertTrue(audit.scan_content('state.json', b'{}'))

    def test_rejects_extra_zip_entries(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'sample.zip'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('codex-docreview/README.md', 'Example')
                z.writestr('codex-docreview/state.json', '{}')
            self.assertTrue(audit.audit_zip(p, ['README.md']))

if __name__ == '__main__':
    unittest.main()
