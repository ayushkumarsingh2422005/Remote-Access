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
  public const int VK_CONTROL = 0x11;
  public const int VK_MENU = 0x12; // Alt
  public const int VK_SHIFT = 0x10;
  public const int VK_LWIN = 0x5B;
  public const int VK_RWIN = 0x5C;

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

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  public static IntPtr keyboardHook = IntPtr.Zero;
  public static IntPtr mouseHook = IntPtr.Zero;
  public static HookProc kbProc;
  public static HookProc msProc;
  public static long lastActivityMs = 0;
  public static long lastHotkeyMs = 0;
  public static readonly object gate = new object();

  public static uint lockVk = 0;
  public static uint unlockVk = 0;
  public static bool lockNeedCtrl = true;
  public static bool lockNeedAlt = true;
  public static bool lockNeedShift = false;
  public static bool lockNeedWin = false;
  public static bool unlockNeedCtrl = true;
  public static bool unlockNeedAlt = true;
  public static bool unlockNeedShift = false;
  public static bool unlockNeedWin = false;

  public static void Emit(string line) {
    Console.WriteLine(line);
    Console.Out.Flush();
  }

  public static void EmitActivity() {
    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (gate) {
      if (now - lastActivityMs < 80) return;
      lastActivityMs = now;
    }
    Emit("HOST_ACTIVITY");
  }

  public static void EmitHotkey(string kind) {
    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (gate) {
      if (now - lastHotkeyMs < 400) return;
      lastHotkeyMs = now;
    }
    Emit(kind);
  }

  static bool Down(int vk) {
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
  }

  static bool ModsMatch(bool needCtrl, bool needAlt, bool needShift, bool needWin) {
    bool ctrl = Down(VK_CONTROL);
    bool alt = Down(VK_MENU);
    bool shift = Down(VK_SHIFT);
    bool win = Down(VK_LWIN) || Down(VK_RWIN);
    return ctrl == needCtrl && alt == needAlt && shift == needShift && win == needWin;
  }

  public static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        KBDLLHOOKSTRUCT hs = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        bool injected = (hs.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
        if (!injected) {
          // Fallback hotkeys via LL hook — more reliable than RegisterHotKey alone
          if (hs.vkCode == unlockVk &&
              ModsMatch(unlockNeedCtrl, unlockNeedAlt, unlockNeedShift, unlockNeedWin)) {
            EmitHotkey("UNLOCK");
            // Do not treat unlock chord as "host using PC"
          } else if (hs.vkCode == lockVk &&
              ModsMatch(lockNeedCtrl, lockNeedAlt, lockNeedShift, lockNeedWin)) {
            EmitHotkey("LOCK");
          } else {
            EmitActivity();
          }
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
      if (!injected) {
        if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN ||
            msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL || msg == WM_MOUSEMOVE) {
          EmitActivity();
        }
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

function Test-ModFlag([int]$mods, [int]$flag) {
  return ($mods -band $flag) -ne 0
}

# Configure chord detection for LL-hook fallback
[SsHostWatch]::lockVk = [uint32]$LockVk
[SsHostWatch]::unlockVk = [uint32]$UnlockVk
[SsHostWatch]::lockNeedAlt = Test-ModFlag $LockMods 0x0001
[SsHostWatch]::lockNeedCtrl = Test-ModFlag $LockMods 0x0002
[SsHostWatch]::lockNeedShift = Test-ModFlag $LockMods 0x0004
[SsHostWatch]::lockNeedWin = Test-ModFlag $LockMods 0x0008
[SsHostWatch]::unlockNeedAlt = Test-ModFlag $UnlockMods 0x0001
[SsHostWatch]::unlockNeedCtrl = Test-ModFlag $UnlockMods 0x0002
[SsHostWatch]::unlockNeedShift = Test-ModFlag $UnlockMods 0x0004
[SsHostWatch]::unlockNeedWin = Test-ModFlag $UnlockMods 0x0008

$lockId = 1
$unlockId = 2

$lockOk = [SsHostWatch]::RegisterHotKey([IntPtr]::Zero, $lockId, [uint32]$LockMods, [uint32]$LockVk)
$unlockOk = [SsHostWatch]::RegisterHotKey([IntPtr]::Zero, $unlockId, [uint32]$UnlockMods, [uint32]$UnlockVk)

if (-not $lockOk) {
  Write-Output "ERR: failed to register lock hotkey (LL-hook fallback still active)"
}
if (-not $unlockOk) {
  Write-Output "ERR: failed to register unlock hotkey (LL-hook fallback still active)"
}

try {
  [SsHostWatch]::InstallHooks()
}
catch {
  if ($lockOk) { [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $lockId) }
  if ($unlockOk) { [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $unlockId) }
  Write-Output ("ERR: " + $_.Exception.Message)
  exit 1
}

Write-Output "READY"
[Console]::Out.Flush()

try {
  $msg = New-Object MSG
  while ([SsHostWatch]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)) {
    if ($msg.message -eq [SsHostWatch]::WM_HOTKEY) {
      # Robust id compare (UIntPtr / IntPtr quirks across runtimes)
      $id = 0
      try { $id = [int64]$msg.wParam.ToUInt64() } catch { $id = [int64]$msg.wParam }
      if ($id -eq $lockId) {
        [SsHostWatch]::EmitHotkey("LOCK")
      }
      elseif ($id -eq $unlockId) {
        [SsHostWatch]::EmitHotkey("UNLOCK")
      }
    }
    [void][SsHostWatch]::TranslateMessage([ref]$msg)
    [void][SsHostWatch]::DispatchMessage([ref]$msg)
  }
}
finally {
  [SsHostWatch]::RemoveHooks()
  if ($lockOk) { [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $lockId) }
  if ($unlockOk) { [void][SsHostWatch]::UnregisterHotKey([IntPtr]::Zero, $unlockId) }
}
