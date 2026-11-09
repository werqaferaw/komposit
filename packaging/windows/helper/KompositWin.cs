// komposit-win.exe: the small native helper Komposit's server uses on Windows.
// One file, C# 5, .NET Framework 4.x, so it builds with the csc.exe that ships
// with Windows (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe):
//
//   csc /nologo /optimize+ /target:exe /platform:anycpu /out:komposit-win.exe /r:System.Drawing.dll KompositWin.cs
//
// Commands (JSON on stdout; on failure a JSON {code, error, hresult} on stderr):
//   version
//   jsx --progid Illustrator.Application --script <file.jsx> --out <result.txt> [--retry-ms 20000]
//        Runs the script in the app through COM (DoJavaScript) and writes the
//        returned value to --out as UTF-8. Exit 3 NOT_INSTALLED, 4 BUSY,
//        5 GONE (the app died or closed), 6 SCRIPT, 7 OTHER.
//   procs --names Illustrator,Photoshop,AfterFX     running processes, start times, paths
//   windows --names AfterFX | --pid 1234            top-level windows (for the dialog notice)
//   activate --names Illustrator                    bring the app's main window to the front
//   open --path <file>                              open a file in the app that owns it
//   folders                                         Desktop, Documents, Downloads (known folders)
//   thumb --path <file> --out <file.png> [--size 400]   the Explorer thumbnail as a PNG
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace Komposit
{
    static class Program
    {
        const string Version = "0.1.0";
        static TextWriter Out;
        static TextWriter Err;

        [STAThread]
        static int Main(string[] args)
        {
            // UTF-8 whatever the console code page is: paths and window titles
            // can be in any language, and Node reads the pipes as UTF-8.
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            Err = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
            int code;
            try
            {
                code = Run(args);
            }
            catch (Exception e)
            {
                code = Fail(7, "OTHER", e.Message, 0);
            }
            Out.Flush();
            Err.Flush();
            return code;
        }

        static int Run(string[] args)
        {
            if (args.Length == 0) return Fail(2, "USAGE", "usage: komposit-win <version|jsx|procs|windows|activate|open|folders|thumb> [options]", 0);
            Dictionary<string, string> o = Options(args);
            switch (args[0])
            {
                case "version": Out.Write(Json.Obj("version", Version, "clr", Environment.Version.ToString(), "os", Environment.OSVersion.VersionString, "is64", Environment.Is64BitProcess)); return 0;
                case "jsx": return Jsx(o);
                case "procs": return Procs(o);
                case "windows": return Windows(o);
                case "activate": return Activate(o);
                case "open": return Open(o);
                case "folders": return Folders();
                case "thumb": return Thumb(o);
                default: return Fail(2, "USAGE", "unknown command " + args[0], 0);
            }
        }

        static Dictionary<string, string> Options(string[] args)
        {
            Dictionary<string, string> o = new Dictionary<string, string>();
            for (int i = 1; i < args.Length; i++)
            {
                if (!args[i].StartsWith("--")) continue;
                string k = args[i].Substring(2);
                string v = (i + 1 < args.Length && !args[i + 1].StartsWith("--")) ? args[++i] : "true";
                o[k] = v;
            }
            return o;
        }

        static string Opt(Dictionary<string, string> o, string k, string def)
        {
            string v;
            return o.TryGetValue(k, out v) ? v : def;
        }

        static int Fail(int exit, string code, string error, int hresult)
        {
            Err.Write(Json.Obj("code", code, "error", error, "hresult", hresult == 0 ? null : "0x" + hresult.ToString("X8")));
            return exit;
        }

        // ---------- jsx: run ExtendScript through COM ----------

        static int Jsx(Dictionary<string, string> o)
        {
            string progId = Opt(o, "progid", null), script = Opt(o, "script", null), outPath = Opt(o, "out", null);
            if (progId == null || script == null || outPath == null) return Fail(2, "USAGE", "jsx needs --progid, --script and --out", 0);
            int retryMs;
            if (!int.TryParse(Opt(o, "retry-ms", "20000"), out retryMs)) retryMs = 20000;
            string code = File.ReadAllText(script, Encoding.UTF8);

            Type t = Type.GetTypeFromProgID(progId, false);
            if (t == null) return Fail(3, "NOT_INSTALLED", progId + " is not registered on this PC.", 0);

            MessageFilter.Register(retryMs);
            object app = null;
            try
            {
                // Attaches to the running app (or starts it, as the Mac's
                // `tell application` does; Komposit checks first).
                app = Activator.CreateInstance(t);
                // DoJavaScript(code, [arguments], [executionMode]); mode 1 is
                // aiNeverShowDebugger / psNeverShowDebugger in both apps, so a
                // script error can't stop at a debugger nobody sees.
                object r = t.InvokeMember("DoJavaScript", BindingFlags.InvokeMethod, null, app, new object[] { code, Missing.Value, 1 }, CultureInfo.InvariantCulture);
                string s = r == null ? "" : Convert.ToString(r, CultureInfo.InvariantCulture);
                File.WriteAllText(outPath, s, new UTF8Encoding(false));
                return 0;
            }
            catch (TargetInvocationException e)
            {
                return ComFail(e.InnerException ?? e);
            }
            catch (Exception e)
            {
                return ComFail(e);
            }
            finally
            {
                if (app != null) { try { Marshal.ReleaseComObject(app); } catch { } }
                MessageFilter.Revoke();
            }
        }

        // A COM failure -> exit code and code word Komposit maps to a message.
        static int ComFail(Exception e)
        {
            int hr = Marshal.GetHRForException(e);
            switch ((uint)hr)
            {
                case 0x80040154: // REGDB_E_CLASSNOTREG
                case 0x800401F3: // CO_E_CLASSSTRING
                    return Fail(3, "NOT_INSTALLED", e.Message, hr);
                case 0x80010001: // RPC_E_CALL_REJECTED
                case 0x8001010A: // RPC_E_SERVERCALL_RETRYLATER
                    return Fail(4, "BUSY", e.Message, hr);
                case 0x800706BA: // RPC_S_SERVER_UNAVAILABLE
                case 0x800706BE: // RPC_S_CALL_FAILED
                case 0x80010108: // RPC_E_DISCONNECTED
                case 0x80080005: // CO_E_SERVER_EXEC_FAILURE
                    return Fail(5, "GONE", e.Message, hr);
                case 0x80020009: // DISP_E_EXCEPTION: the script threw inside the app
                    return Fail(6, "SCRIPT", e.Message, hr);
                default:
                    // FACILITY_CONTROL (0x800Axxxx): a script engine's own error
                    // number (a syntax error, an uncaught throw).
                    if (((uint)hr & 0xFFFF0000) == 0x800A0000) return Fail(6, "SCRIPT", e.Message, hr);
                    return Fail(7, "OTHER", e.Message, hr);
            }
        }

        // ---------- processes ----------

        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        static long Ms(DateTime utc)
        {
            return (long)(utc - Epoch).TotalMilliseconds;
        }

        static List<Process> ByNames(Dictionary<string, string> o)
        {
            List<Process> list = new List<Process>();
            string pid = Opt(o, "pid", null);
            if (pid != null)
            {
                try { list.Add(Process.GetProcessById(int.Parse(pid, CultureInfo.InvariantCulture))); } catch { }
                return list;
            }
            foreach (string n in Opt(o, "names", "").Split(','))
            {
                string name = n.Trim();
                if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
                if (name.Length > 0) list.AddRange(Process.GetProcessesByName(name));
            }
            return list;
        }

        static int Procs(Dictionary<string, string> o)
        {
            List<string> rows = new List<string>();
            long now = Ms(DateTime.UtcNow);
            foreach (Process p in ByNames(o))
            {
                object started = null;
                string path = null;
                try { started = Ms(p.StartTime.ToUniversalTime()); } catch { }
                try { path = p.MainModule.FileName; } catch { }
                long main = 0;
                string title = null;
                try { main = p.MainWindowHandle.ToInt64(); title = p.MainWindowTitle; } catch { }
                rows.Add(Json.Obj("pid", p.Id, "name", p.ProcessName + ".exe", "path", path, "startedMs", started, "nowMs", now, "mainWindow", main, "title", title));
            }
            Out.Write("[" + string.Join(",", rows) + "]");
            return 0;
        }

        // ---------- windows ----------

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        const uint GW_OWNER = 4;

        static string ClassOf(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static string TitleOf(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        // Top-level windows of the processes. A modal dialog shows up as a
        // visible "#32770" window, or an enabled window whose owner is disabled.
        static int Windows(Dictionary<string, string> o)
        {
            try { SetProcessDPIAware(); } catch { }
            HashSet<uint> pids = new HashSet<uint>();
            foreach (Process p in ByNames(o)) pids.Add((uint)p.Id);
            List<string> rows = new List<string>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) return true;
                RECT r;
                GetWindowRect(h, out r);
                IntPtr owner = GetWindow(h, GW_OWNER);
                object ownerEnabled = null;
                if (owner != IntPtr.Zero) ownerEnabled = IsWindowEnabled(owner);
                rows.Add(Json.Obj(
                    "hwnd", h.ToInt64(), "pid", (long)pid, "cls", ClassOf(h), "title", TitleOf(h),
                    "x", r.Left, "y", r.Top, "w", r.Right - r.Left, "h", r.Bottom - r.Top,
                    "visible", IsWindowVisible(h), "enabled", IsWindowEnabled(h), "iconic", IsIconic(h),
                    "owner", owner.ToInt64(), "ownerEnabled", ownerEnabled));
                return true;
            }, IntPtr.Zero);
            Out.Write("[" + string.Join(",", rows) + "]");
            return 0;
        }

        // Windows only lets the foreground app hand over the foreground; a
        // tap of Alt lifts that lock for this call. Best effort.
        static int Activate(Dictionary<string, string> o)
        {
            foreach (Process p in ByNames(o))
            {
                IntPtr h = IntPtr.Zero;
                try { h = p.MainWindowHandle; } catch { }
                if (h == IntPtr.Zero) continue;
                if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
                keybd_event(0x12, 0, 0, UIntPtr.Zero); // Alt down
                bool ok = SetForegroundWindow(h);
                keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt up
                Out.Write(Json.Obj("ok", ok, "pid", p.Id));
                return 0;
            }
            return Fail(5, "GONE", "no window to bring to the front", 0);
        }

        // ---------- files ----------

        static int Open(Dictionary<string, string> o)
        {
            string path = Opt(o, "path", null);
            if (path == null || !File.Exists(path)) return Fail(2, "USAGE", "open needs an existing --path", 0);
            ProcessStartInfo psi = new ProcessStartInfo(path);
            psi.UseShellExecute = true;
            Process.Start(psi);
            Out.Write(Json.Obj("ok", true));
            return 0;
        }

        [DllImport("shell32.dll")]
        static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);

        static string Known(string guid)
        {
            IntPtr p;
            if (SHGetKnownFolderPath(new Guid(guid), 0, IntPtr.Zero, out p) != 0) return null;
            try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
        }

        static int Folders()
        {
            Out.Write(Json.Obj(
                "desktop", Known("B4BFCC3A-DB2C-424C-B029-7FE99A87C641"),
                "documents", Known("FDD39AD0-238F-46AF-ADB4-6C85480369C7"),
                "downloads", Known("374DE290-123F-4565-9164-39C4925E467B")));
            return 0;
        }

        // ---------- thumbnails ----------

        [StructLayout(LayoutKind.Sequential)]
        struct SIZE { public int cx, cy; }

        [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItemImageFactory
        {
            [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

        static int Thumb(Dictionary<string, string> o)
        {
            string path = Opt(o, "path", null), outPath = Opt(o, "out", null);
            int size;
            if (!int.TryParse(Opt(o, "size", "400"), out size)) size = 400;
            if (path == null || outPath == null || !File.Exists(path)) return Fail(2, "USAGE", "thumb needs an existing --path and --out", 0);
            IShellItemImageFactory f;
            SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
            SIZE s;
            s.cx = size;
            s.cy = size;
            IntPtr hbm;
            // 0x8 SIIGBF_THUMBNAILONLY: a real thumbnail or nothing (no file-type icon).
            int hr = f.GetImage(s, 0x8, out hbm);
            Marshal.ReleaseComObject(f);
            if (hr != 0 || hbm == IntPtr.Zero) return Fail(7, "NO_THUMBNAIL", "no thumbnail for this file", hr);
            try
            {
                using (Bitmap b = Image.FromHbitmap(hbm)) b.Save(outPath, ImageFormat.Png);
            }
            finally
            {
                DeleteObject(hbm);
            }
            Out.Write(Json.Obj("ok", true, "out", outPath));
            return 0;
        }
    }

    // Retries COM calls the app rejects while it's busy (a modal dialog, a long
    // operation): the documented IMessageFilter pattern for out-of-process COM.
    // Needs the STA thread Main runs on.
    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleMessageFilter
    {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr interfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr callee, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr callee, int tickCount, int pendingType);
    }

    class MessageFilter : IOleMessageFilter
    {
        [DllImport("ole32.dll")]
        static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);

        static int retryMs = 20000;

        public static void Register(int ms)
        {
            retryMs = ms;
            IOleMessageFilter old;
            CoRegisterMessageFilter(new MessageFilter(), out old);
        }

        public static void Revoke()
        {
            IOleMessageFilter old;
            CoRegisterMessageFilter(null, out old);
        }

        public int HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr interfaceInfo)
        {
            return 0; // SERVERCALL_ISHANDLED
        }

        public int RetryRejectedCall(IntPtr callee, int tickCount, int rejectType)
        {
            // 2 = SERVERCALL_RETRYLATER: wait 250 ms and retry, up to retryMs.
            if (rejectType == 2 && tickCount < retryMs) return 250;
            return -1; // give up: the call fails with RPC_E_CALL_REJECTED
        }

        public int MessagePending(IntPtr callee, int tickCount, int pendingType)
        {
            return 2; // PENDINGMSG_WAITDEFPROCESS
        }
    }

    // Just enough JSON for flat objects of strings, numbers and booleans.
    static class Json
    {
        public static string Str(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Val(object v)
        {
            if (v == null) return "null";
            if (v is bool) return (bool)v ? "true" : "false";
            if (v is string) return Str((string)v);
            if (v is int || v is long || v is uint || v is short) return Convert.ToString(v, CultureInfo.InvariantCulture);
            if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
            return Str(Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        public static string Obj(params object[] kv)
        {
            List<string> parts = new List<string>();
            for (int i = 0; i + 1 < kv.Length; i += 2) parts.Add(Str((string)kv[i]) + ":" + Val(kv[i + 1]));
            return "{" + string.Join(",", parts) + "}";
        }
    }
}
