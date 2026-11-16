"""Scan only allowlisted release files; print locations and categories, never values."""
from pathlib import Path, PurePosixPath
import json
import hashlib
import re
import sys
import zipfile

RULES = {
    'private-user-path': re.compile(r'(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"<>]+|/(?:Users|home)/[\w.-]+)'),
    'local-workspace-path': re.compile(r'[A-Za-z]:[\\/]+(?:CodexData|agentflow|XLSmove|Codex)[\\/]', re.I),
    'credential-token': re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'credential-assignment': re.compile(r'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'][^"'\s]{8,}["']'''),
    'personal-email': re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
    'session-identifier': re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I),
}
FORBIDDEN = {'.docx', '.pdf', '.png', '.jpg', '.jpeg', '.zip', '.db', '.sqlite', '.log', '.pem', '.key'}

APPROVED_ASSETS = {'assets/doc-review-logo.png': 'ab4a6ba172da74e9b21c6e96e3edbe0448f8fa6321b42d210caa6e4db127d454'}

def scan_content(name, data):
    asset_name = name.removeprefix('codex-docreview/')
    if asset_name in APPROVED_ASSETS:
        return [] if hashlib.sha256(data).hexdigest() == APPROVED_ASSETS[asset_name] else [{'file': name, 'category': 'changed-approved-asset'}]
    findings = []
    p = PurePosixPath(name)
    if p.suffix.lower() in FORBIDDEN or p.name in {'state.json', 'auth.json', 'config.toml', '.env'} or any(part.startswith('backup') for part in p.parts):
        findings.append({'file': name, 'category': 'private-or-generated-file'})
    try:
        content = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        return findings + [{'file': name, 'category': 'unexpected-binary'}]
    for category, rule in RULES.items():
        for match in rule.finditer(content):
            findings.append({'file': name, 'line': content[:match.start()].count('\n') + 1, 'category': category})
    return findings

def audit(root, names):
    findings = []
    for name in names:
        p = root / name
        if p.is_symlink() or root.resolve() not in p.resolve().parents:
            findings.append({'file': name, 'category': 'external-file'})
        elif not p.is_file():
            findings.append({'file': name, 'category': 'missing-file'})
        else:
            findings.extend(scan_content(name, p.read_bytes()))
    return findings

def audit_zip(archive_path, names):
    with zipfile.ZipFile(archive_path) as archive:
        expected = ['codex-docreview/' + name for name in names]
        if sorted(archive.namelist()) != sorted(expected) or archive.testzip():
            return [{'file': archive_path.name, 'category': 'archive-file-list-or-integrity'}]
        return [finding for name in archive.namelist() for finding in scan_content(name, archive.read(name))]

if __name__ == '__main__':
    from build_release import ROOT, FILES
    findings = audit_zip(Path(sys.argv[1]), FILES) if len(sys.argv) > 1 else audit(ROOT, FILES)
    print(json.dumps({'files': len(FILES), 'findings': findings}, ensure_ascii=False, indent=2))
    sys.exit(bool(findings))
