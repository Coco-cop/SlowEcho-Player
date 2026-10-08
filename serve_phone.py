"""把播放器 + 局域网识别后端分享给手机（同一 WiFi 直接打开）。

做四件事：
  1. 自动找出本机在局域网里的 IP（排除虚拟机网卡、回环、Docker 之类的虚拟网段）
  2. 用 recognition_server 的处理器起 HTTP 服务，绑定 0.0.0.0
     （只绑 127.0.0.1 的话手机连不上），静态只公开白名单文件
  3. 生成二维码 PNG 并打印地址，默认顺手打开电脑上的浏览器
  4. 手机上选本地视频 -> POST 到电脑识别 -> 电脑生成带时间戳的英文句子

用法：
    python serve_phone.py                 # 默认 8876 端口，自动打开浏览器
    python serve_phone.py 9000            # 换端口
    python serve_phone.py --no-browser    # 不打开浏览器（只打印地址 + 二维码）
    python serve_phone.py 9000 --no-browser
"""
import os
import sys
import threading
import webbrowser
import json
import urllib.request

import recognition_server
import portable_paths
DEFAULT_PORT = 8876  # 播放器默认端口。

HERE = os.path.dirname(os.path.abspath(__file__))

USAGE = """用法: python serve_phone.py [端口] [--no-browser]

  端口          默认 %d
  --no-browser  只打印地址/二维码，不打开电脑上的浏览器
  -h, --help    显示这段说明
""" % DEFAULT_PORT


def make_qr(url, path):
    """生成二维码；没装 qrcode 库就退化成纯文本提示，不影响主流程。"""
    try:
        import qrcode
        q = qrcode.QRCode(version=None, box_size=10, border=2)
        q.add_data(url)
        q.make(fit=True)
        q.make_image(fill_color="black", back_color="white").save(path)
        return True
    except Exception as e:
        print("  （二维码生成失败：%s —— 手动在手机浏览器输入地址即可）" % e)
        return False


def parse_args(argv):
    port = DEFAULT_PORT
    no_browser = False
    for arg in argv:
        if arg in ("-h", "--help"):
            print(USAGE)
            raise SystemExit(0)
        if arg in ("--no-browser", "-n"):
            no_browser = True
            continue
        if arg.startswith("--port="):
            arg = arg.split("=", 1)[1]
        try:
            port = int(arg)
        except ValueError:
            print("看不懂的参数：%s\n" % arg)
            print(USAGE)
            raise SystemExit(2)
    if not (1 <= port <= 65535):
        print("端口不合法：%d" % port)
        raise SystemExit(2)
    return port, no_browser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    port, no_browser = parse_args(argv)

    ips = recognition_server.lan_ips()
    if not ips:
        print("没有局域网连接，仍可在这台电脑上使用。")
        ips = ["127.0.0.1"]
    primary = ips[0]
    url = "http://%s:%d/index.html" % (primary, port)

    manager = recognition_server.JobManager()
    try:
        httpd = recognition_server.create_server("0.0.0.0", port, HERE, manager)
    except OSError as e:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/api/status" % port, timeout=2) as response:
                running = json.load(response)
            if running.get("edition") == "SlowEcho Player":
                if not no_browser:
                    webbrowser.open("http://localhost:%d/index.html" % port)
                print("SlowEcho Player 已运行，已打开现有播放器。")
                manager.shutdown()
                return 0
        except Exception:
            pass
        print("端口 %d 起不来：%s" % (port, e))
        print("换个端口试试： python serve_phone.py 9000")
        manager.shutdown()
        return 1

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    has_recognizer = recognition_server.recognizer_available()

    print("")
    print("=" * 52)
    print("  SlowEcho Player")
    print("  电脑地址：http://localhost:%d/index.html" % port)
    print("  手机打开地址（和电脑连同一个 WiFi）：")
    print("")
    print("      %s" % url)
    print("")
    if len(ips) > 1:
        print("  如果上面这个连不上，试试：")
        for alt in ips[1:4]:
            print("      http://%s:%d/index.html" % (alt, port))
        print("")
    print("=" * 52)
    print("")

    qr_path = os.path.join(os.environ.get("TEMP") or HERE, "_echoplayer_phone.png")
    if make_qr(url, qr_path):
        print("  二维码已生成：%s" % qr_path)
        print("  用手机相机扫码，或在浏览器里输入上面的地址")
    else:
        print("  二维码文件：%s" % qr_path)

    if not has_recognizer:
        print("")
        print("  [!] 没检测到 faster-whisper，页面上的「生成字幕」会用不了。")
        print("      安装： python -m pip install -r requirements.txt")
    elif recognition_server.PORTABLE_MODE:
        print("")
        print("  [i] %s" % portable_paths.describe())
        if not portable_paths.model_available("base"):
            print("      注意：包内没找到 base 模型，识别时会报错。")
            print("      请确认 runtime/models 目录没有被杀毒软件清理。")

    if not no_browser:
        try:
            webbrowser.open("http://localhost:%d/index.html" % port)
        except Exception:
            pass

    print("")
    print("  说明：")
    print("    · 视频不会上传到别处，只在电脑和手机之间走局域网")
    print("    · 识别（faster-whisper）跑在电脑上，手机只负责选文件和播放")
    print("    · 手机浏览器建议用 Chrome / Edge；iPhone 用 Safari")
    print("    · 如果手机打不开，多半是 Windows 防火墙拦了，")
    print("      弹窗时允许专用网络访问即可")
    print("    · 接口：GET /api/status  POST /api/transcribe  GET|DELETE /api/jobs/{id}")
    print("")
    print("  按 Ctrl+C 停止")
    print("")

    try:
        while True:
            thread.join(1)
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.shutdown()
        httpd.server_close()
        manager.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
