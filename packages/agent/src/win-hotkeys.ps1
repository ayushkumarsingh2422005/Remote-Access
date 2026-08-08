# SS Remote — Windows hotkeys + host physical activity detection
# Args: lockMods lockVk unlockMods unlockVk
param(
  [Parameter(Mandatory = $true)][int]$LockMods,
  [Parameter(Mandatory = $true)][int]$LockVk,
  [Parameter(Mandatory = $true)][int]$UnlockMods,
  [Parameter(Mandatory = $true)][int]$UnlockVk
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public struct MSG {
  public IntPtr hwnd;
  public uint message;
  public UIntPtr wParam;
  public IntPtr lParam;
  public uint time;
  public int pt_x;
  public int pt_y;
}

[StructLayout(LayoutKind.Sequential)]
public struct POINT {
  public int x;
  public int y;
}

[StructLayout(LayoutKind.Sequential)]
public struct KBDLLHOOKSTRUCT {
  public uint vkCode;
  public uint scanCode;
  public uint flags;
  public uint time;
  public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct MSLLHOOKSTRUCT {
  public POINT pt;
  public uint mouseData;
  public uint flags;
  public uint time;
  public IntPtr dwExtraInfo;
}

public static class SsHostWatch {
  public const uint WM_HOTKEY = 0x0312;
  public const int WH_KEYBOARD_LL = 13;
  public const int WH_MOUSE_LL = 14;
  public const int WM_KEYDOWN = 0x0100;
  public const int WM_SYSKEYDOWN = 0x0104;
  public const int WM_LBUTTONDOWN = 0x0201;
  public const int WM_RBUTTONDOWN = 0x0204;
  public const int WM_MBUTTONDOWN = 0x0207;
  public const int WM_MOUSEWHEEL = 0x020A;
  public const int WM_MOUSEHWHEEL = 0x020E;
  public const int WM_MOUSEMOVE = 0x0200;
  public const uint LLKHF_INJECTED = 0x10;
  public const uint LLKHF_LOWER_IL_INJECTED = 0x02;
  public const uint LLMHF_INJECTED = 0x01;
  public const uint LLMHF_LOWER_IL_INJECTED = 0x02;

  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [DllImport("user32.dll")]
  public static extern bool TranslateMessage(ref MSG lpMsg);

  [DllImport("user32.dll")]
  public static extern IntPtr DispatchMessage(ref MSG lpMsg);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnhookWindowsHookEx(IntPtr hhk);

  [DllImport("user32.dll")]
  public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetModuleHandle(string lpModuleName);

  public static IntPtr keyboardHook = IntPtr.Zero;
  public static IntPtr mouseHook = IntPtr.Zero;
  public static HookProc kbProc;
  public static HookProc msProc;
  public static long lastActivityMs = 0;
  public static readonly object gate = new object();

  public static void EmitActivity() {
    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (gate) {
      // Throttle: mouse-move can be very chatty
      if (now - lastActivityMs < 80) return;
      lastActivityMs = now;
    }
    Console.WriteLine("HOST_ACTIVITY");
    Console.Out.Flush();
  }

  public static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        KBDLLHOOKSTRUCT hs = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        if ((hs.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) == 0) {
          EmitActivity();
        }
      }
    }
    return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
  }

  public static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      MSLLHOOKSTRUCT hs = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      bool injected = (hs.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0;
      if (injected) {
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
      }
      // Real host: click, wheel, OR mouse-move (so host always wins while using the PC)
      if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN ||
          msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL || msg == WM_MOUSEMOVE) {
        EmitActivity();
      }
    }
    return CallNextHookEx(mouseHook, nCode, wParam, lParam);
  }

  public static void InstallHooks() {
    kbProc = KeyboardCallback;
    msProc = MouseCallback;
    using (Process cur = Process.GetCurrentProcess())
    using (ProcessModule mod = cur.MainModule) {
      IntPtr hMod = GetModuleHandle(mod.ModuleName);
      keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, hMod, 0);
      mouseHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, hMod, 0);
    }
    if (keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero) {
      throw new Exception("Failed to install input hooks");
    }
  }

  public static void RemoveHooks() {
    if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
    if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
    keyboardHook = IntPtr.Zero;
    mouseHook = IntPtr.Zero;
  }
}
"@

$lockId = 1
$unlockId = 2

if (-not [SsHostWatch]::RegisterHotKey([IntPtr]::Zero, $lockId, [uint32]$LockMods, [uint32]$LockVk)) {
  Write-Output "ERR: failed to register lock hotkey (maybe already in use)"
  exit 1
}
if (-not [SsHostWatch]::RegisterHotKey([IntPtr]::Zero, $unlockId, [uint32]$UnlockMods, [uint32]$UnlockVk)) {
  [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $lockId)
  Write-Output "ERR: failed to register unlock hotkey (maybe already in use)"
  exit 1
}

try {
  [SsHostWatch]::InstallHooks()
}
catch {
  [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $lockId)
  [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $unlockId)
  Write-Output ("ERR: " + $_.Exception.Message)
  exit 1
}

Write-Output "READY"
[Console]::Out.Flush()

try {
  $msg = New-Object MSG
  while ([SsHostWatch]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)) {
    if ($msg.message -eq [SsHostWatch]::WM_HOTKEY) {
      if ($msg.wParam.ToUInt32() -eq $lockId) {
        Write-Output "LOCK"
        [Console]::Out.Flush()
      }
      elseif ($msg.wParam.ToUInt32() -eq $unlockId) {
        Write-Output "UNLOCK"
        [Console]::Out.Flush()
      }
    }
    [void][SsHostWatch]::TranslateMessage([ref]$msg)
    [void][SsHostWatch]::DispatchMessage([ref]$msg)
  }
}
finally {
  [SsHostWatch]::RemoveHooks()
  [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $lockId)
  [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $unlockId)
}
