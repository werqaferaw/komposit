// Komposit.exe: the tray half of Komposit on a Windows PC (the Mac's menu-bar
// app, packaging/macos/Komposit.swift, does the same job).
//
// It starts the bundled Node server (node\node.exe app\companion\server.mjs),
// keeps it alive, and opens the UI in the browser. The server runs in a job
// object, so it ends with this app even if this app is killed.
//
// C# 5, .NET Framework 4.x, WinForms: built with the csc.exe that ships with
// Windows. See packaging/windows/build.mjs.
//
//   Komposit.exe                    tray icon, opens the UI once the server is up
//   Komposit.exe --background       tray icon only (sign-in start)
//   Komposit.exe --selftest --out f  no UI: start the server, check /api/hello,
//                                   write JSON to f, stop, exit 0 on success
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Komposit
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            List<string> a = new List<string>(args);
            if (a.Contains("--selftest")) return SelfTest.Run(a);

            bool first;
            using (Mutex m = new Mutex(true, "Local\\KompositTray", out first))
            {
                if (!first)
                {
                    // Already running: just open the UI.
                    int port = Server.FindRunning();
                    if (port > 0) Tray.OpenUrl(Tray.UiUrl(port, Paths.WebUrl()));
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new Tray(!a.Contains("--background")));
            }
            return 0;
        }
    }

    // Where everything is. The installed layout:
    //   <install>\Komposit.exe  komposit-win.exe  tray-light.ico  tray-dark.ico  komposit.json
    //   <install>\node\node.exe
    //   <install>\app\companion\server.mjs, app\ui\..., app\node_modules\...
    static class Paths
    {
        public static string Install { get { return AppDomain.CurrentDomain.BaseDirectory; } }
        public static string Node { get { return Path.Combine(Install, "node", "node.exe"); } }
        public static string AppDir { get { return Path.Combine(Install, "app"); } }
        public static string Script { get { return Path.Combine(AppDir, "companion", "server.mjs"); } }
        public static string Helper { get { return Path.Combine(Install, "komposit-win.exe"); } }
        public static string DataDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Komposit"); } }
        public static string LogDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Komposit", "Logs"); } }
        public static string Log { get { return Path.Combine(LogDir, "server.log"); } }

        // The hosted UI this build points at, from komposit.json {"webUrl": "..."}.
        public static string WebUrl()
        {
            try
            {
                string f = Path.Combine(Install, "komposit.json");
                if (!File.Exists(f)) return null;
                string s = File.ReadAllText(f);
                int k = s.IndexOf("\"webUrl\"", StringComparison.Ordinal);
                if (k < 0) return null;
                int q1 = s.IndexOf('"', s.IndexOf(':', k) + 1);
                int q2 = s.IndexOf('"', q1 + 1);
                string v = q1 >= 0 && q2 > q1 ? s.Substring(q1 + 1, q2 - q1 - 1).Trim() : "";
                return v.Length > 0 ? v.TrimEnd('/') : null;
            }
            catch { return null; }
        }
    }

    // The Node server: start it (or use one that's already running), read its
    // output, write the log, and say when it's ready or gone.
    class Server
    {
        public static readonly int[] Ports = { 4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328, 4329, 4330 };

        public Process Proc;
        public int Port;
        public bool Attached;
        public event Action<int> Ready;
        public event Action<int> Exited;
        readonly Job job = new Job();
        StreamWriter log;
        readonly object logLock = new object();

        public static int FindRunning()
        {
            foreach (int p in Ports)
            {
                try
                {
                    HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + p + "/api/hello");
                    r.Timeout = 600;
                    r.ReadWriteTimeout = 600;
                    r.Proxy = null;
                    using (WebResponse res = r.GetResponse())
                    using (StreamReader sr = new StreamReader(res.GetResponseStream()))
                    {
                        if (sr.ReadToEnd().Contains("\"komposit\":true")) return p;
                    }
                }
                catch { }
            }
            return 0;
        }

        public void Start(bool allowAttach, IDictionary<string, string> extraEnv)
        {
            if (allowAttach)
            {
                int running = FindRunning();
                if (running > 0)
                {
                    Port = running;
                    Attached = true;
                    if (Ready != null) Ready(running);
                    return;
                }
            }
            Attached = false;
            if (!File.Exists(Paths.Node) || !File.Exists(Paths.Script)) throw new FileNotFoundException("Damaged install: node or the server is missing.", Paths.Node);
            OpenLog();

            ProcessStartInfo psi = new ProcessStartInfo(Paths.Node, "\"" + Paths.Script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Paths.AppDir;
            psi.EnvironmentVariables["KOMPOSIT_APP"] = "1";
            psi.EnvironmentVariables["KOMPOSIT_WIN_HELPER"] = Paths.Helper;
            string web = Paths.WebUrl();
            if (web != null) psi.EnvironmentVariables["KOMPOSIT_WEB_URL"] = web;
            if (extraEnv != null) foreach (KeyValuePair<string, string> kv in extraEnv) psi.EnvironmentVariables[kv.Key] = kv.Value;

            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += OnLine;
            p.ErrorDataReceived += OnLine;
            p.Exited += delegate
            {
                int code = 0;
                try { code = p.ExitCode; } catch { }
                Write("[komposit] server exited with code " + code);
                if (Exited != null) Exited(code);
            };
            p.Start();
            job.Add(p);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            Proc = p;
        }

        void OnLine(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Write(e.Data);
            const string tag = "KOMPOSIT_READY port=";
            if (e.Data.StartsWith(tag, StringComparison.Ordinal))
            {
                int port;
                if (int.TryParse(e.Data.Substring(tag.Length).Trim(), out port))
                {
                    Port = port;
                    if (Ready != null) Ready(port);
                }
            }
        }

        void OpenLog()
        {
            try
            {
                Directory.CreateDirectory(Paths.LogDir);
                string prev = Path.Combine(Paths.LogDir, "server.previous.log");
                if (File.Exists(prev)) File.Delete(prev);
                if (File.Exists(Paths.Log)) File.Move(Paths.Log, prev);
                lock (logLock)
                {
                    if (log != null) log.Dispose();
                    log = new StreamWriter(new FileStream(Paths.Log, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
                    log.AutoFlush = true;
                }
            }
            catch { }
        }

        public void Write(string line)
        {
            lock (logLock)
            {
                try { if (log != null) log.WriteLine(line); } catch { }
            }
        }

        // Stop the server we started (and everything it started).
        public void Stop()
        {
            Process p = Proc;
            Proc = null;
            if (p == null) return;
            try { if (!p.HasExited) p.Kill(); } catch { }
            try { p.WaitForExit(3000); } catch { }
            job.KillAll();
        }
    }

    // A job object that kills everything in it when its last handle closes,
    // so the server (and Claude Code under it) never outlives this app.
    class Job
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimit
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimit
        {
            public BasicLimit BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        readonly IntPtr handle;

        public Job()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return;
            ExtendedLimit info = new ExtendedLimit();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(ExtendedLimit));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(handle, 9, ptr, (uint)size); // JobObjectExtendedLimitInformation
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        public void Add(Process p)
        {
            if (handle != IntPtr.Zero) { try { AssignProcessToJobObject(handle, p.Handle); } catch { } }
        }

        public void KillAll()
        {
            if (handle != IntPtr.Zero) { try { TerminateJobObject(handle, 0); } catch { } }
        }
    }

    // The tray icon and its menu.
    class Tray : ApplicationContext
    {
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("Starting…");
        readonly ToolStripMenuItem loginItem = new ToolStripMenuItem("Open at Login");
        readonly SynchronizationContext ui;
        Server server;
        bool openWhenReady;
        bool quitting;
        readonly List<DateTime> restarts = new List<DateTime>();
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public Tray(bool openUi)
        {
            WindowsFormsSynchronizationContext.AutoInstall = true;
            ui = new WindowsFormsSynchronizationContext();
            openWhenReady = openUi;

            ToolStripMenuItem open = new ToolStripMenuItem("Open Komposit", null, delegate { OpenUI(); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            statusItem.Enabled = false;
            loginItem.Click += delegate { ToggleLogin(); };
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripMenuItem("Restart", null, delegate { Restart(); }));
            menu.Items.Add(new ToolStripMenuItem("Show Log", null, delegate { Shell(Paths.Log); }));
            menu.Items.Add(new ToolStripMenuItem("Show Data Folder", null, delegate { Directory.CreateDirectory(Paths.DataDir); Shell(Paths.DataDir); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(loginItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Quit Komposit", null, delegate { Quit(); }));
            menu.Opening += delegate { loginItem.Checked = LoginEnabled(); };

            icon.Text = "Komposit";
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenUI(); };
            icon.MouseClick += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenUI(); };
            SetIcon();
            SystemEvents.UserPreferenceChanged += delegate { ui.Post(delegate { SetIcon(); }, null); };
            icon.Visible = true;

            StartServer();
        }

        // The 04.C tile: dark tile on a light taskbar, light tile on a dark one.
        void SetIcon()
        {
            string name = TaskbarIsLight() ? "tray-dark.ico" : "tray-light.ico";
            string f = Path.Combine(Paths.Install, name);
            try
            {
                icon.Icon = File.Exists(f) ? new Icon(f, SystemInformation.SmallIconSize) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                icon.Icon = SystemIcons.Application;
            }
        }

        static bool TaskbarIsLight()
        {
            try
            {
                object v = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "SystemUsesLightTheme", 0);
                return v is int && (int)v == 1;
            }
            catch { return false; }
        }

        void SetStatus(string s)
        {
            ui.Post(delegate { statusItem.Text = s; icon.Text = s.Length > 60 ? "Komposit" : "Komposit: " + s; }, null);
        }

        void StartServer()
        {
            SetStatus("Starting…");
            Server s = new Server();
            s.Ready += delegate (int port)
            {
                SetStatus("Running on port " + port);
                if (openWhenReady)
                {
                    openWhenReady = false;
                    ui.Post(delegate { OpenUI(); }, null);
                }
            };
            s.Exited += delegate (int code) { ui.Post(delegate { ServerExited(s); }, null); };
            server = s;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { s.Start(true, null); }
                catch (Exception e) { SetStatus("Couldn't start: " + e.Message); }
            });
        }

        void ServerExited(Server s)
        {
            if (quitting || s != server) return;
            // Restart after a crash, but give up if it keeps failing.
            DateTime now = DateTime.UtcNow;
            restarts.RemoveAll(delegate (DateTime t) { return (now - t).TotalSeconds > 60; });
            restarts.Add(now);
            if (restarts.Count > 4)
            {
                SetStatus("Stopped. Choose Restart, or see the log");
                return;
            }
            SetStatus("Restarting…");
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 1500;
            timer.Tick += delegate { timer.Stop(); timer.Dispose(); if (!quitting) StartServer(); };
            timer.Start();
        }

        void Restart()
        {
            restarts.Clear();
            Server old = server;
            server = null;
            if (old != null) old.Stop();
            StartServer();
        }

        public static string UiUrl(int port, string web)
        {
            // The hosted page reaches this PC from Chromium browsers and Firefox
            // (with the browser's one-time Allow); the default browser on
            // Windows is one of those, so go through /connect when a hosted
            // UI is configured, else straight to the page the app serves.
            return "http://127.0.0.1:" + port + (web != null ? "/connect" : "/");
        }

        void OpenUI()
        {
            if (server == null || server.Port == 0)
            {
                openWhenReady = true;
                if (server == null) StartServer();
                return;
            }
            OpenUrl(UiUrl(server.Port, Paths.WebUrl()));
        }

        public static void OpenUrl(string url)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        static void Shell(string path)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(path);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        static bool LoginEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    return k != null && k.GetValue("Komposit") != null;
                }
            }
            catch { return false; }
        }

        static void ToggleLogin()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (k.GetValue("Komposit") != null) k.DeleteValue("Komposit", false);
                    else k.SetValue("Komposit", "\"" + Application.ExecutablePath + "\" --background");
                }
            }
            catch { SystemSounds(); }
        }

        static void SystemSounds()
        {
            try { System.Media.SystemSounds.Beep.Play(); } catch { }
        }

        void Quit()
        {
            quitting = true;
            if (server != null) server.Stop();
            icon.Visible = false;
            icon.Dispose();
            ExitThread();
        }
    }

    // --selftest: everything but the tray icon. Used by CI and by
    // docs/windows-testing.md to check an install end to end.
    static class SelfTest
    {
        public static int Run(List<string> args)
        {
            int i = args.IndexOf("--out");
            string outPath = i >= 0 && i + 1 < args.Count ? args[i + 1] : null;
            StringBuilder report = new StringBuilder();
            bool ok = false;
            Server s = new Server();
            ManualResetEvent ready = new ManualResetEvent(false);
            int port = 0;
            s.Ready += delegate (int p) { port = p; ready.Set(); };
            string hello = null, error = null;
            try
            {
                Dictionary<string, string> env = new Dictionary<string, string>();
                string data = Environment.GetEnvironmentVariable("KOMPOSIT_DATA_DIR");
                if (!string.IsNullOrEmpty(data)) env["KOMPOSIT_DATA_DIR"] = data;
                // Our own server, never someone else's: that is what's being tested.
                s.Start(false, env);
                if (!ready.WaitOne(60000)) throw new TimeoutException("the server didn't say KOMPOSIT_READY within 60 s");
                using (WebClient wc = new WebClient())
                {
                    wc.Proxy = null;
                    hello = wc.DownloadString("http://127.0.0.1:" + port + "/api/hello");
                }
                ok = hello.Contains("\"komposit\":true");
            }
            catch (Exception e)
            {
                error = e.Message;
            }
            finally
            {
                s.Stop();
            }
            bool icons = File.Exists(Path.Combine(Paths.Install, "tray-light.ico")) && File.Exists(Path.Combine(Paths.Install, "tray-dark.ico"));
            report.Append("{\"ok\":").Append(ok ? "true" : "false")
                  .Append(",\"port\":").Append(port)
                  .Append(",\"hello\":").Append(hello ?? "null")
                  .Append(",\"icons\":").Append(icons ? "true" : "false")
                  .Append(",\"helper\":").Append(File.Exists(Paths.Helper) ? "true" : "false")
                  .Append(",\"log\":\"").Append(Paths.Log.Replace("\\", "\\\\")).Append("\"")
                  .Append(",\"error\":").Append(error == null ? "null" : "\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")
                  .Append("}");
            if (outPath != null) File.WriteAllText(outPath, report.ToString(), new UTF8Encoding(false));
            return ok ? 0 : 1;
        }
    }
}
