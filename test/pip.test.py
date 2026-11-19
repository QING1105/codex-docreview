import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import venv

ROOT = Path(__file__).resolve().parents[1]

class PipInstallTests(unittest.TestCase):
    def test_fresh_install_without_system_node(self):
        wheels = os.environ.get('DOCREVIEW_TEST_WHEELHOUSE')
        if not wheels:
            self.skipTest('Set DOCREVIEW_TEST_WHEELHOUSE to the built wheel and dependency directory')
        with tempfile.TemporaryDirectory(prefix='docreview-pip-') as tmp:
            root = Path(tmp)
            envroot = root / 'python'
            venv.EnvBuilder(with_pip=True).create(envroot)
            python = envroot / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            env = os.environ.copy()
            env.update(PIP_NO_INDEX='1', PIP_FIND_LINKS=wheels, PIP_NO_CACHE_DIR='1',
                       CODEX_HOME=str(root / 'codex'), DOCREVIEW_DATA=str(root / 'data'),
                       CODEX_APP_TOOLS_PIPE_PATH='', DOCREVIEW_PORT='24583', DOCREVIEW_NO_PAUSE='1')
            env['PATH'] = str(python.parent) + os.pathsep + str(Path(os.environ.get('SystemRoot', '/')) / 'System32')
            self.assertIsNone(shutil.which('node', path=env['PATH']))
            def run(*args):
                p = subprocess.run([str(python), *args], env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                return p.stdout
            run('-m', 'pip', 'install', 'codex-docreview==0.8.5')
            skills = root / '中文 skills'
            for _ in range(2):
                run('-m', 'codex_docreview', 'install', '--skills-root', str(skills), '--skip-mcp')
            runtime = skills / 'doc-review/scripts/runtime'
            self.assertTrue((runtime / 'bin/node.exe').exists())
            self.assertTrue((runtime / 'bin/NODE-LICENSE').exists())
            result = json.loads(run('-m', 'codex_docreview', 'doctor', '--skills-root', str(skills), '--skip-port'))
            self.assertTrue(result['ok'])
            self.assertFalse((root / 'data/state.json').exists())
            # The skill runtime remains usable after removal of the Python dependency.
            run('-m', 'pip', 'uninstall', '-y', 'nodejs-wheel-binaries')
            entry = skills / 'doc-review/scripts/review.py'
            self.assertTrue(json.loads(run(str(entry), '--doctor', '--skip-port'))['ok'])
            # First-use bootstrap also prepares Node automatically in a standalone skill.
            (runtime / 'bin/node.exe').unlink()
            self.assertTrue(json.loads(run(str(entry), '--doctor', '--skip-port'))['ok'])
            self.assertTrue((runtime / 'python-packages').exists())
            request = json.dumps({'jsonrpc':'2.0', 'id':1, 'method':'initialize', 'params':{}})+'\n'
            handshake = subprocess.run([str(python), str(entry), '--mcp'], input=request, env=env,
                                       capture_output=True, text=True, timeout=20)
            self.assertEqual(handshake.returncode, 0, handshake.stderr)
            self.assertEqual(json.loads(handshake.stdout)['result']['serverInfo']['version'], '0.8.5')
            # One-click installer takes the same pip path in the isolated environment.
            ps = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
            p = subprocess.run([str(ps), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                str(ROOT / 'install.ps1'), '-PythonExe', str(python),
                                '-SkillsRoot', str(skills), '-SkipMcp'], env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)

if __name__ == '__main__':
    unittest.main()
