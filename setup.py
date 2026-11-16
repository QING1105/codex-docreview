"""Bundle the explicitly listed runtime and skill assets into the wheel."""
import json
from pathlib import Path
from setuptools import setup
from setuptools.command.build_py import build_py

ROOT = Path(__file__).resolve().parent

class BuildRuntime(build_py):
    def run(self):
        super().run()
        names = json.loads((ROOT / 'runtime-files.json').read_text(encoding='utf-8-sig'))
        names += ['skills/doc-review/' + name for name in
                  ['SKILL.md', 'agents/openai.yaml', 'scripts/review.js', 'scripts/review.py', 'scripts/run.ps1', 'scripts/bootstrap.ps1']]
        for name in names:
            dest = Path(self.build_lib) / 'codex_docreview' / 'resources' / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            self.copy_file(str(ROOT / name), str(dest))

setup(cmdclass={'build_py': BuildRuntime})
