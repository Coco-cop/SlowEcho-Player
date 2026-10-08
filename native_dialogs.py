"""Unicode Windows pickers using only the bundled Python standard library."""
import ctypes
from ctypes import wintypes


class NativeDialogError(Exception):
    """Raised on native dialog failures other than user cancellation."""


_win_dlls = {}


def _get_dll(name):
    dll = _win_dlls.get(name)
    if dll is None:
        try:
            dll = ctypes.WinDLL(name, use_last_error=True)
        except (OSError, AttributeError) as exc:
            raise NativeDialogError("无法加载 Windows 对话框组件 %s：%s" % (name, exc)) from exc
        _win_dlls[name] = dll
    return dll


_OFN_HIDEREADONLY = 0x00000004
_OFN_NOCHANGEDIR = 0x00000008
_OFN_PATHMUSTEXIST = 0x00000800
_OFN_FILEMUSTEXIST = 0x00001000
_OFN_EXPLORER = 0x00080000

def _openfilenamew_size():
    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", ctypes.POINTER(ctypes.c_wchar)),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]
    return ctypes.sizeof(OPENFILENAMEW), OPENFILENAMEW


_OPENFILENAMEW_SIZE, _OPENFILENAMEW = _openfilenamew_size()


class _BROWSEINFOW(ctypes.Structure):
    _fields_ = [
        ("hwndOwner", wintypes.HWND),
        ("pidlRoot", ctypes.c_void_p),
        ("pszDisplayName", wintypes.LPWSTR),
        ("lpszTitle", wintypes.LPCWSTR),
        ("ulFlags", wintypes.UINT),
        ("lpfn", ctypes.c_void_p),
        ("lParam", wintypes.LPARAM),
        ("iImage", ctypes.c_int),
    ]


_BFFM_INITIALIZED = 1
_BFFM_SETSELECTIONW = 0x0400 + 103
_BIF_RETURNONLYFSDIRS = 0x00000001
_BIF_EDITBOX = 0x00000010
_BIF_NEWDIALOGSTYLE = 0x00000040


def _build_filter(extensions):
    patterns = ["*." + ext.strip().lstrip("*.")
                for ext in (extensions or []) if ext.strip()]
    parts = ["视频 / 音频", ";".join(patterns)] if patterns else []
    return "\0".join(parts + ["所有文件", "*.*"]) + "\0\0"


def _get_foreground_owner():
    try:
        user32 = _get_dll("user32")
        user32.GetForegroundWindow.argtypes = []
        user32.GetForegroundWindow.restype = wintypes.HWND
        return user32.GetForegroundWindow()
    except Exception:
        return None


def pick_file(title, extensions=None, initial=None):
    comdlg32 = _get_dll("comdlg32")
    func = comdlg32.GetOpenFileNameW
    func.argtypes = [ctypes.POINTER(_OPENFILENAMEW)]
    func.restype = wintypes.BOOL
    comdlg32.CommDlgExtendedError.argtypes = []
    comdlg32.CommDlgExtendedError.restype = wintypes.DWORD

    filter_str = _build_filter(extensions)
    file_buf = ctypes.create_unicode_buffer(32768)
    ofn = _OPENFILENAMEW()
    ofn.lStructSize = _OPENFILENAMEW_SIZE
    ofn.hwndOwner = _get_foreground_owner()
    ofn.hInstance = None
    ofn.lpstrFilter = filter_str
    ofn.nFilterIndex = 1
    ofn.lpstrFile = file_buf
    ofn.nMaxFile = len(file_buf)
    ofn.lpstrInitialDir = initial
    ofn.lpstrTitle = title
    ofn.Flags = (
        _OFN_PATHMUSTEXIST
        | _OFN_FILEMUSTEXIST
        | _OFN_EXPLORER
        | _OFN_NOCHANGEDIR
        | _OFN_HIDEREADONLY
    )
    ok = func(ctypes.byref(ofn))
    if not ok:
        err = comdlg32.CommDlgExtendedError()
        if err == 0:
            return None
        raise NativeDialogError(
            "GetOpenFileNameW failed with extended error 0x%08X" % err
        )
    return file_buf.value


def _folder_callback(hwnd, msg, lparam, lpdata):
    if msg == _BFFM_INITIALIZED:
        user32 = _get_dll("user32")
        # The portable backend is launched with a hidden startup window. Show
        # this user-requested modal explicitly, independent of STARTUPINFO.
        user32.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.ShowWindowAsync.restype = wintypes.BOOL
        user32.ShowWindowAsync(hwnd, 5)
        if not lpdata:
            return 0
        user32.SendMessageW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        user32.SendMessageW.restype = wintypes.LPARAM
        user32.SendMessageW(hwnd, _BFFM_SETSELECTIONW, 1, lpdata)
    return 0


def pick_folder(title, initial=None):
    ole32 = _get_dll("ole32")
    shell32 = _get_dll("shell32")

    ole32.OleInitialize.argtypes = [ctypes.c_void_p]
    ole32.OleInitialize.restype = ctypes.c_long
    ole32.OleUninitialize.argtypes = []
    ole32.OleUninitialize.restype = None
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None

    hr = ole32.OleInitialize(None)
    ole_initialized = hr in (0, 1)  # S_OK or S_FALSE
    if not ole_initialized:
        raise NativeDialogError("OleInitialize failed with HRESULT 0x%08X" % (hr & 0xFFFFFFFF))

    pidl = None
    try:
        shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(_BROWSEINFOW)]
        shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
        shell32.SHGetPathFromIDListEx.argtypes = [
            ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        ]
        shell32.SHGetPathFromIDListEx.restype = wintypes.BOOL
        display = ctypes.create_unicode_buffer(260)
        # Keep both buffers and the native callback alive until the modal returns.
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HWND,
                                          wintypes.UINT, wintypes.LPARAM, wintypes.LPARAM)
        callback = callback_type(_folder_callback)
        initial_buf = ctypes.create_unicode_buffer(initial) if initial else None
        bi = _BROWSEINFOW()
        bi.hwndOwner = _get_foreground_owner()
        bi.pidlRoot = None
        bi.pszDisplayName = ctypes.cast(display, wintypes.LPWSTR)
        bi.lpszTitle = title
        bi.ulFlags = _BIF_RETURNONLYFSDIRS | _BIF_EDITBOX | _BIF_NEWDIALOGSTYLE
        bi.lpfn = ctypes.cast(callback, ctypes.c_void_p)
        bi.lParam = ctypes.cast(initial_buf, ctypes.c_void_p).value if initial_buf else 0

        pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
        if not pidl:
            return None

        path_buf = ctypes.create_unicode_buffer(32768)
        got = shell32.SHGetPathFromIDListEx(pidl, path_buf, len(path_buf), 0)
        if not got:
            raise NativeDialogError("SHGetPathFromIDListEx failed to convert PIDL")
        return path_buf.value
    finally:
        if pidl:
            ole32.CoTaskMemFree(ctypes.cast(pidl, ctypes.c_void_p))
        if ole_initialized:
            ole32.OleUninitialize()
