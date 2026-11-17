"""Create a distributable ZIP from an explicit file list."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = [
    "test/colors.test.js",
    "server/instances.js", "test/concurrent.test.js",
    "assets/doc-review-logo.png",
    ".codex/INSTALL.md", "skills/doc-review/scripts/bootstrap.ps1",
    "skills/doc-review/scripts/run.ps1",
    "pyproject.toml", "setup.py", "MANIFEST.in", "src/codex_docreview/__init__.py",
    "src/codex_docreview/__main__.py", "src/codex_docreview/cli.py",
    "skills/doc-review/scripts/review.py", "test/pip.test.py",
    '.gitignore', '.gitattributes', 'doctor.cmd', 'doctor.ps1', 'runtime-files.json',
    'server/doctor.js', 'audit_release.py', 'test/release.test.py', 'test/install.test.js',
    '.codex-plugin/plugin.json', 'mcp.json', 'README.md',
    'install.cmd', 'install.ps1', 'register.cmd', 'start.cmd',
    'server/daemon.js', 'server/mcp.js', 'server/client.js',
    'server/docx.js', 'server/diff.js', 'server/zip.js', 'server/host-bridge.js', 'server/rich.js', 'web/index.html',
    'skills/doc-review/SKILL.md', 'skills/doc-review/agents/openai.yaml',
    'skills/doc-review/scripts/review.js', 'test/session.test.js',
    'build_release.py', 'test/diff.test.js', 'test/source-revisions.test.js', 'test/host-bridge.test.js', 'test/rich.test.js', 'test/rich-session.test.js', 'test/make-rich-fixtures.js',
]

if __name__ == '__main__':
    from audit_release import audit, audit_zip
    findings = audit(ROOT, FILES)
    if findings:
        raise SystemExit(json.dumps(findings, ensure_ascii=False, indent=2))
    version = json.loads((ROOT / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))['version']
    target = ROOT / 'dist' / f'codex-docreview-{version}-windows.zip'
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(ROOT / name, f'codex-docreview/{name}')
    with zipfile.ZipFile(target) as archive:
        assert len(archive.namelist()) == len(FILES)
        assert archive.testzip() is None
    findings = audit_zip(target, FILES)
    if findings:
        target.unlink()
        raise SystemExit(json.dumps(findings, ensure_ascii=False, indent=2))
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n', encoding='ascii')
    print(f'{target}\n{len(FILES)} files\nSHA256 {digest}')
