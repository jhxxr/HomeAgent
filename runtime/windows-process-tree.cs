using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace HomeAgent {
    // Assign a suspended child before user code runs. The Job owns descendants even after their leader exits.
    public static class ProcessTree {
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong r, w, o, rb, wb, ob; }
        [StructLayout(LayoutKind.Sequential)] struct LIMITS {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
            public LIMITS Basic; public IO_COUNTERS IO;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
            public uint cb; public string reserved, desktop, title;
            public uint x, y, width, height, cx, cy, fill, flags; public ushort show, reserved2;
            public IntPtr reservedPtr, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
        [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
            public long User, Kernel, PeriodUser, PeriodKernel;
            public uint PageFaults, Processes, Active, Terminated;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXTENDED_LIMITS data, uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out ACCOUNTING data, uint length, IntPtr returned);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO info, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint SearchPathW(string path, string file, string extension, uint size, StringBuilder buffer, IntPtr filePart);
        static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void TerminateTree(IntPtr job, uint code) {
            Check(TerminateJobObject(job, code));
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (true) {
                ACCOUNTING accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
                if (accounting.Active == 0) return;
                if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Process tree did not finish terminating");
                System.Threading.Thread.Sleep(10);
            }
        }
        static string Quote(string value) {
            if (value.IndexOf('\0') >= 0) throw new ArgumentException("NUL is not a valid argument");
            StringBuilder output = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append('"'); }
                else { output.Append('\\', slashes); output.Append(c); }
                slashes = 0;
            }
            output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
        }
        public static int Run(string executable, string[] args, int parentPid) {
            IntPtr job = IntPtr.Zero, parent = IntPtr.Zero; PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            bool assigned = false;
            try {
                parent = OpenProcess(0x00100000, false, (uint)parentPid);
                if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (WaitForSingleObject(parent, 0) == 0) throw new InvalidOperationException("Runner exited before process admission");
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.Basic.Flags = 0x00002000;
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
                StringBuilder resolved = new StringBuilder(32768);
                uint length = SearchPathW(null, executable, ".exe", (uint)resolved.Capacity, resolved, IntPtr.Zero);
                if (length == 0 || length >= resolved.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
                StringBuilder command = new StringBuilder(Quote(resolved.ToString()));
                foreach (string arg in args) command.Append(" ").Append(Quote(arg));
                STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
                startup.flags = 0x00000100; startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
                Check(SetHandleInformation(startup.input, 1, 1)); Check(SetHandleInformation(startup.output, 1, 1)); Check(SetHandleInformation(startup.error, 1, 1));
                Check(CreateProcessW(resolved.ToString(), command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child));
                Check(AssignProcessToJobObject(job, child.process)); assigned = true;
                if (ResumeThread(child.thread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint wait = WaitForMultipleObjects(2, new IntPtr[] { parent, child.process }, false, 0xFFFFFFFF);
                if (wait == 0) { TerminateTree(job, 130); return 130; }
                if (wait != 1) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint code; Check(GetExitCodeProcess(child.process, out code));
                TerminateTree(job, code);
                return unchecked((int)code);
            } finally {
                if (!assigned && child.process != IntPtr.Zero) TerminateProcess(child.process, 127);
                if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
                if (child.process != IntPtr.Zero) CloseHandle(child.process);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (parent != IntPtr.Zero) CloseHandle(parent);
            }
        }
    }
}
