// Windows 10+ guardian. Compiled to a private temporary executable by system PowerShell.
// Chrome is assigned to the kill-on-close job at creation, never in a later attach step.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class NodriverGuardian {
    public static int Main() { try { Run(); return 0; } catch { return 1; } }
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    static StreamReader Input;
    static StreamWriter Output;
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
        public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
        public STARTUPINFO Info; public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, int size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly ConcurrentQueue<Dictionary<string, object>> Commands = new ConcurrentQueue<Dictionary<string, object>>();
    static volatile bool Lost;
    static volatile bool Released;
    static readonly object LogLock = new object();
    static readonly byte[] Tail = new byte[16384];
    static int TailCount, TailNext;
    static volatile bool Dirty;
    static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Send(object message) {
        try { Output.WriteLine(Json.Serialize(message)); Output.Flush(); }
        catch (IOException) { Lost = true; }
    }
    static string Snapshot() {
        lock (LogLock) {
            byte[] bytes = new byte[TailCount];
            int start = (TailNext - TailCount + Tail.Length) % Tail.Length;
            for (int i = 0; i < bytes.Length; i++) bytes[i] = Tail[(start + i) % Tail.Length];
            return Convert.ToBase64String(bytes);
        }
    }
    static void ReadLog(IntPtr read) {
        using (var stream = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false)) {
            byte[] bytes = new byte[4096];
            try {
                int count;
                while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) {
                    lock (LogLock) {
                        if (Released) continue; // Drain without retaining or using host pipes.
                        for (int i = 0; i < count; i++) {
                            Tail[TailNext] = bytes[i]; TailNext = (TailNext + 1) % Tail.Length;
                        }
                        TailCount = Math.Min(Tail.Length, TailCount + count); Dirty = true;
                    }
                }
            } catch (IOException) { }
        }
    }
    static void SetKillOnClose(IntPtr job, bool enabled) {
        EXTENDED_LIMIT limit = new EXTENDED_LIMIT();
        limit.Basic.Flags = enabled ? 0x2000u : 0;
        Check(SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
    }
    static string Quote(string argument) {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in argument) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') quoted.Append('\\', slashes * 2 + 1).Append('"');
            else quoted.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
    static PROCESS_INFORMATION Launch(Dictionary<string, object> config, IntPtr job, out Thread logger) {
        var security = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), Inherit = 1 };
        IntPtr read = IntPtr.Zero, write = IntPtr.Zero, nul = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, environment = IntPtr.Zero;
        bool initialized = false;
        logger = null;
        try {
            Check(CreatePipe(out read, out write, ref security, 0));
            Check(SetHandleInformation(read, 1, 0));
            nul = CreateFile("NUL", 0xC0000000u, 3, ref security, 3, 0, IntPtr.Zero);
            if (nul == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, nul); Marshal.WriteIntPtr(handles, IntPtr.Size, write);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero));
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new STARTUPINFOEX();
            startup.Info.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.Info.flags = 0x100;
            startup.Info.stdin = nul; startup.Info.stdout = nul; startup.Info.stderr = write;
            startup.Attributes = attributes;
            var vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in (Dictionary<string, object>)config["env"])
                if (entry.Value != null) vars[entry.Key] = (string)entry.Value;
            var block = new StringBuilder();
            foreach (var entry in vars) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
            block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            string executable = (string)config["executable"];
            var command = new StringBuilder(Quote(executable));
            foreach (object arg in (System.Collections.IEnumerable)config["args"]) command.Append(' ').Append(Quote((string)arg));
            if (Lost) throw new IOException("Host disconnected before Chrome spawn");
            PROCESS_INFORMATION info;
            // Job assignment and explicit handle inheritance are part of process creation.
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00080000u | 0x00000400u | 0x00000200u | 0x00000008u,
                environment, null, ref startup, out info));
            CloseHandle(info.Thread); info.Thread = IntPtr.Zero;
            IntPtr reader = read;
            logger = new Thread(() => ReadLog(reader)); logger.IsBackground = true; logger.Start();
            read = IntPtr.Zero;
            return info;
        } finally {
            if (write != IntPtr.Zero) CloseHandle(write);
            if (read != IntPtr.Zero) CloseHandle(read);
            if (nul != IntPtr.Zero && nul != new IntPtr(-1)) CloseHandle(nul);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
    static void TerminateAndWait(IntPtr job) {
        Check(TerminateJobObject(job, 1));
        for (int i = 0; i < 500; i++) {
            ACCOUNTING accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(10);
        }
        throw new IOException("Owned Chrome job did not empty within 5 seconds");
    }
    public static void Run() {
        // .NET Console treats DETACHED_PROCESS as having no console. Open only the explicit
        // inherited pipe handles instead; no console or original-host terminal is needed.
        Input = new StreamReader(new FileStream(new SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read, 4096, false), new UTF8Encoding(false));
        Output = new StreamWriter(new FileStream(new SafeFileHandle(GetStdHandle(-11), false), FileAccess.Write, 4096, false), new UTF8Encoding(false));
        FreeConsole(); // The helper must outlive destruction of its original host's console.
        string first = Input.ReadLine();
        if (first == null) return;
        var config = Json.Deserialize<Dictionary<string, object>>(first);
        var reader = new Thread(() => {
            try {
                string line;
                var parser = new JavaScriptSerializer();
                while ((line = Input.ReadLine()) != null)
                    Commands.Enqueue(parser.Deserialize<Dictionary<string, object>>(line));
            } catch { } finally { Lost = true; }
        });
        reader.IsBackground = true; reader.Start();
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        Thread logger = null;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            SetKillOnClose(job, true);
            child = Launch(config, job, out logger);
            Send(new { type = "started", pid = child.ProcessId });
            int reportTicks = 0;
            while (WaitForSingleObject(child.Process, 20) == 258) {
                if (!Released && Lost) { TerminateAndWait(job); break; }
                Dictionary<string, object> command;
                while (!Released && Commands.TryDequeue(out command)) {
                    string kind = (string)command["command"];
                    if (kind == "snapshot") Send(new { type = "snapshot", id = command["id"], stderr = Snapshot() });
                    else if (kind == "release") {
                        // Sole commit point. After this succeeds, even helper death cannot kill the job.
                        SetKillOnClose(job, false);
                        lock (LogLock) { Released = true; Array.Clear(Tail, 0, Tail.Length); TailCount = 0; }
                        Send(new { type = "released", id = command["id"] });
                        // Original-host streams are no longer needed. The logger is independently owned.
                    }
                }
                if (!Released && Dirty && ++reportTicks >= 5) {
                    reportTicks = 0; Dirty = false; Send(new { type = "stderr", stderr = Snapshot() });
                }
            }
            if (!Released) TerminateAndWait(job);
            if (logger != null) logger.Join(1000);
            uint code; Check(GetExitCodeProcess(child.Process, out code));
            if (!Released) Send(new { type = "exited", exitCode = code, stderr = Snapshot() });
        } catch (Exception error) {
            if (!Released) {
                if (job != IntPtr.Zero) { try { TerminateAndWait(job); } catch { } }
                Send(new { type = "error", error = error.Message, stderr = Snapshot() });
                if (child.Process != IntPtr.Zero && WaitForSingleObject(child.Process, 5000) == 0) {
                    uint code; GetExitCodeProcess(child.Process, out code);
                    Send(new { type = "exited", exitCode = code, stderr = Snapshot() });
                }
            }
            throw;
        } finally {
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
