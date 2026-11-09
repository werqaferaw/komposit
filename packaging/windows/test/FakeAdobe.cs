// A stand-in for After Effects on a Windows PC without it (GitHub's runner),
// so CI can drive Komposit's real Windows transport end to end: the
// AfterFX.exe -r handoff and result file, and real modal dialogs for the
// dialog notice. It does not run ExtendScript: it recognises the scripts
// Komposit sends and answers like After Effects would.
//
//   AfterFX.exe [--dir D]          the main window; scripts arrive through
//   AfterFX.exe -r <file.jsx>      the launcher, which hands the file over and exits
//
// Controls (files in --dir or %KOMPOSIT_FAKE_DIR%, default %TEMP%\komposit-fake):
//   dialog-box    shows a standard alert (#32770) until it's deleted
//   dialog-form   shows a custom modal window until it's deleted
//   log-aftereffects.txt  one line per script (whether it had a UTF-8 BOM)
//
// Script markers: __FAKE_THROW__, __FAKE_SLEEP_<ms>__, and Komposit's own
// listDocuments and selection scripts.
//
// Illustrator and Photoshop are stood in for by in-process JScript COM
// components (fake-adobe.mjs writes them). An out-of-process .NET COM server
// was tried first: on GitHub's runner its activation never completed (the
// server registered its class object, no CreateInstance ever arrived, and a
// plain PowerShell client hung the same way), so out-of-process activation is
// left to the real-PC test (docs/windows-testing.md).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace KompositFake
{
    static class Program
    {
        // Set by --dir (else KOMPOSIT_FAKE_DIR).
        static string dirArg;

        public static string Dir
        {
            get
            {
                string d = dirArg ?? Environment.GetEnvironmentVariable("KOMPOSIT_FAKE_DIR");
                if (string.IsNullOrEmpty(d)) d = Path.Combine(Path.GetTempPath(), "komposit-fake");
                Directory.CreateDirectory(d);
                return d;
            }
        }

        public static string Inbox
        {
            get { string d = Path.Combine(Dir, "inbox"); Directory.CreateDirectory(d); return d; }
        }

        public static void Log(string app, string line)
        {
            try { File.AppendAllText(Path.Combine(Dir, "log-" + app + ".txt"), line + "\n", new UTF8Encoding(false)); } catch { }
        }

        [STAThread]
        static int Main(string[] args)
        {
            List<string> a = new List<string>(args);
            int d = a.IndexOf("--dir");
            if (d >= 0 && d + 1 < a.Count) dirArg = a[d + 1];
            int r = a.IndexOf("-r");
            if (r >= 0 && r + 1 < a.Count) return Launcher(a[r + 1]);
            Application.EnableVisualStyles();
            Application.Run(new FakeAfterEffects());
            return 0;
        }

        // AfterFX.exe -r <file>: hand the script to the running instance and
        // return at once, as After Effects' launcher does.
        static int Launcher(string script)
        {
            string tmp = Path.Combine(Inbox, Guid.NewGuid().ToString("N") + ".tmp");
            File.Copy(script, tmp);
            File.Move(tmp, Path.ChangeExtension(tmp, ".jsx"));
            return 0;
        }

        // The envelope Komposit's wrapper returns: {"ok":..,"error":..,"logs":[],"data":..}
        public static string Envelope(bool ok, string error, string dataJson)
        {
            return "{\"ok\":" + (ok ? "true" : "false") + ",\"error\":" + Str(error) + ",\"logs\":[],\"data\":" + (dataJson ?? "null") + "}";
        }

        public static string Str(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                if (ch == '"') sb.Append("\\\"");
                else if (ch == '\\') sb.Append("\\\\");
                else if (ch == '\n') sb.Append("\\n");
                else if (ch == '\r') sb.Append("\\r");
                else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        // The answer to a script, by what it is.
        public static string Answer(string app, string code)
        {
            Match sleep = Regex.Match(code, "__FAKE_SLEEP_(\\d+)__");
            if (sleep.Success) Thread.Sleep(int.Parse(sleep.Groups[1].Value));
            if (code.Contains("__FAKE_THROW__")) throw new COMException("Error 21: undefined is not an object.\nLine: 3", unchecked((int)0x80020009));
            if (code.Contains("comps.push(it.name)"))
                return Envelope(true, null, "{\"documents\":[{\"name\":\"Fake Project.aep\",\"path\":null,\"active\":true,\"comps\":[\"Comp 1\"]}]}");
            if (code.Contains("out.kind = 'project'"))
                return Envelope(true, null, "{\"project\":\"Fake Project\",\"kind\":\"project\",\"items\":[]}");
            return Envelope(true, null, "\"ran in After Effects\"");
        }
    }

    // ---------- After Effects ----------

    // The main window (big, like AE's), picking up scripts from the inbox.
    // Like After Effects, it runs no scripts while a dialog is up.
    class FakeAfterEffects : Form
    {
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        bool boxUp, formUp;

        [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint threadId, EnumProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        delegate bool EnumProc(IntPtr h, IntPtr l);

        public FakeAfterEffects()
        {
            Text = "Adobe After Effects 2026 (fake)";
            StartPosition = FormStartPosition.Manual;
            Location = new Point(40, 40);
            Size = new Size(1000, 700);
            timer.Interval = 150;
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Program.Log("aftereffects", "main window up pid " + Process.GetCurrentProcess().Id);
        }

        void Tick()
        {
            string box = Path.Combine(Program.Dir, "dialog-box"), form = Path.Combine(Program.Dir, "dialog-form");
            if (boxUp)
            {
                if (!File.Exists(box)) CloseAlert();
                return;
            }
            if (formUp) return; // the modal form closes itself
            if (File.Exists(form))
            {
                formUp = true;
                using (ModalWindow m = new ModalWindow(form)) m.ShowDialog(this);
                formUp = false;
                return;
            }
            if (File.Exists(box))
            {
                boxUp = true;
                MessageBox.Show(this, "After Effects error: fake alert for Komposit's tests.", "After Effects");
                boxUp = false;
                return;
            }
            foreach (string f in Directory.GetFiles(Program.Inbox, "*.jsx")) RunScript(f);
        }

        void CloseAlert()
        {
            EnumThreadWindows(GetCurrentThreadId(), delegate (IntPtr h, IntPtr l)
            {
                StringBuilder sb = new StringBuilder(64);
                GetClassName(h, sb, sb.Capacity);
                if (sb.ToString() == "#32770") PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
                return true;
            }, IntPtr.Zero);
        }

        static void RunScript(string file)
        {
            byte[] raw;
            try { raw = File.ReadAllBytes(file); } catch { return; }
            try { File.Delete(file); } catch { }
            // Komposit writes AE scripts with a UTF-8 byte order mark (ReadAllText would hide it).
            bool bom = raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF;
            string code = Encoding.UTF8.GetString(raw, bom ? 3 : 0, raw.Length - (bom ? 3 : 0));
            Program.Log("aftereffects", "script length=" + code.Length + " bom=" + (bom ? "true" : "false"));
            // The result file the wrapped script would write (Komposit's wrapper).
            Match m = Regex.Match(code, "var __f = new File\\(\"((?:[^\"\\\\]|\\\\.)*)\"\\)");
            if (!m.Success) return;
            string path = Regex.Unescape(m.Groups[1].Value);
            string answer;
            try { answer = Program.Answer("aftereffects", code); }
            catch (COMException e) { answer = Program.Envelope(false, e.Message, null); }
            File.WriteAllText(path, answer, new UTF8Encoding(false));
        }
    }

    // A custom modal window (not the standard dialog class), like Adobe's own dialogs.
    class ModalWindow : Form
    {
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();

        public ModalWindow(string marker)
        {
            Text = "Composition Settings";
            Size = new Size(520, 420);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            timer.Interval = 150;
            timer.Tick += delegate { if (!File.Exists(marker)) Close(); };
            timer.Start();
        }
    }
}
