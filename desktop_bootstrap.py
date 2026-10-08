"""Hidden desktop entry for the existing portable EchoPlayer backend."""
from pathlib import Path
import os
import runpy
import sys


def main():
    root = Path(__file__).resolve().parent
    os.chdir(root)
    sys.path.insert(0, str(root))
    os.environ.setdefault('PYTHONUTF8', '1')
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
    os.environ.setdefault('DO_NOT_TRACK', '1')
    os.environ.setdefault('ECHOPLAYER_MODEL_DIR', str(root / 'runtime/models'))
    log_dir = root / 'data'
    log_dir.mkdir(exist_ok=True)
    log = (log_dir / 'desktop-server.log').open('a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = log
    port = next((arg.split('=', 1)[1] for arg in sys.argv[1:] if arg.startswith('--port=')), '8876')
    session = root / '.desktop-session'
    session.write_text('%s\n%s\n' % (port, os.getpid()), encoding='utf-8')
    sys.argv = [str(root / 'serve_phone.py'), '--port=' + port, '--no-browser']
    try:
        runpy.run_path(str(root / 'serve_phone.py'), run_name='__main__')
    finally:
        try:
            if session.read_text(encoding='utf-8').splitlines()[1] == str(os.getpid()):
                session.unlink()
        except (OSError, IndexError):
            pass
        log.close()


if __name__ == '__main__':
    main()
