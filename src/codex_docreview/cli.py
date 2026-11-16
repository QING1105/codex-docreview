import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

RESOURCES = Path(__file__).resolve().parent / 'resources'

def default_skills():
    configured = os.environ.get('CODEX_HOME')
    return Path(configured) / 'skills' if configured else Path.home() / '.agents' / 'skills'

def install(skills_root, skip_mcp=False):
    target = skills_root.resolve() / 'doc-review'
    runtime = target / 'scripts/runtime'
    files = json.loads((RESOURCES / 'runtime-files.json').read_text(encoding='utf-8-sig'))
    copies = [(RESOURCES / name, runtime / name) for name in files]
    copies += [(RESOURCES / 'skills/doc-review' / name, target / name) for name in
               ['SKILL.md', 'agents/openai.yaml', 'scripts/review.js', 'scripts/review.py', 'scripts/run.ps1', 'scripts/bootstrap.ps1']]
    for source, destination in copies:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    spec = importlib.util.spec_from_file_location('docreview_bootstrap', target / 'scripts/review.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    node = bootstrap.ensure_node(runtime)
    # Keep stdout available for MCP JSON messages when this installer is called by a tool.
    check = subprocess.run([str(node), str(runtime / 'server/doctor.js')], capture_output=True, text=True)
    if check.returncode:
        print(check.stdout or check.stderr, file=sys.stderr)
        raise RuntimeError('Installation check found a problem; see the result above.')
    codex = shutil.which('codex')
    if not skip_mcp and codex:
        subprocess.run([codex, 'mcp', 'add', 'docreview', '--', str(node), str(runtime / 'server/mcp.js')],
                       check=True, stdout=sys.stderr)
    print('Doc Review installed. Reload Codex and use $doc-review.', file=sys.stderr)
    return target

def main(argv=None):
    parser = argparse.ArgumentParser(description='Install and run Doc Review with its private runtime.')
    parser.add_argument('command', choices=['install', 'doctor', 'tool', 'mcp'], nargs='?', default='install')
    parser.add_argument('--skills-root', type=Path, default=default_skills())
    parser.add_argument('--skip-mcp', action='store_true')
    args, remaining = parser.parse_known_args(argv)
    try:
        target = args.skills_root.resolve() / 'doc-review'
        if args.command == 'install' or not (target / 'scripts/runtime/bin' / ('node.exe' if os.name == 'nt' else 'node')).exists():
            target = install(args.skills_root, args.skip_mcp)
        if args.command == 'install':
            return 0
        runtime = target / 'scripts/runtime'
        node = runtime / 'bin' / ('node.exe' if os.name == 'nt' else 'node')
        script = {'doctor': 'doctor.js', 'mcp': 'mcp.js', 'tool': 'client.js'}[args.command]
        return subprocess.call([str(node), str(runtime / 'server' / script), *remaining])
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print('Doc Review: ' + str(error), file=sys.stderr)
        return 1
