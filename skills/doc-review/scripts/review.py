"""Run tools using a private Node runtime, installing it automatically if needed."""
import importlib
import importlib.metadata
import os
from pathlib import Path
import shutil
import subprocess
import sys

NODE_REQUIREMENT = 'nodejs-wheel-binaries>=24.16,<25'

def ensure_node(runtime):
    binary = 'node.exe' if os.name == 'nt' else 'node'
    target = runtime / 'bin' / binary
    if target.is_file():
        return target
    try:
        module = importlib.import_module('nodejs_wheel')
    except ImportError:
        packages = runtime / 'python-packages'
        sys.path.insert(0, str(packages))
        try:
            module = importlib.import_module('nodejs_wheel')
        except ImportError:
            print('Doc Review: preparing the private runtime...', file=sys.stderr)
            subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                            '--only-binary=:all:', '--target', str(packages), NODE_REQUIREMENT],
                           check=True, stdout=sys.stderr)
            importlib.invalidate_caches()
            module = importlib.import_module('nodejs_wheel')
    base = Path(module.__file__).parent
    candidates = [base / binary, base / 'bin' / binary]
    source = next((p for p in candidates if p.is_file()), None)
    if source is None:
        raise RuntimeError('The Node runtime package is incomplete; reinstall nodejs-wheel-binaries.')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    distribution = importlib.metadata.distribution('nodejs-wheel-binaries')
    for name in distribution.files or []:
        if str(name).replace('\\', '/').endswith('/licenses/LICENSE'):
            shutil.copy2(distribution.locate_file(name), target.parent / 'NODE-LICENSE')
    return target

def main():
    script = Path(__file__).resolve().parent
    runtime = script / 'runtime'
    root = runtime if (runtime / 'server/client.js').exists() else script.parents[2]
    if not (root / 'server/client.js').exists():
        raise RuntimeError('Install the complete Doc Review package first.')
    node = ensure_node(runtime)
    arguments = sys.argv[1:]
    if arguments and arguments[0] == '--doctor':
        return subprocess.call([str(node), str(root / 'server/doctor.js'), *arguments[1:]])
    if arguments and arguments[0] == '--mcp':
        return subprocess.call([str(node), str(root / 'server/mcp.js'), *arguments[1:]])
    return subprocess.call([str(node), str(root / 'server/client.js'), *arguments])

if __name__ == '__main__':
    raise SystemExit(main())
