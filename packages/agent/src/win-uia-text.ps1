# Read all text Windows exposes through UI Automation for visible on-screen windows.
# Writes UTF-8 text to -OutPath. Empty file means nothing readable.
param(
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$uiaClient = [Reflection.Assembly]::LoadWithPartialName('UIAutomationClient').Location
$uiaTypes = [Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes').Location
$windowsBase = [Reflection.Assembly]::LoadWithPartialName('WindowsBase').Location

Add-Type -ReferencedAssemblies @($uiaClient, $uiaTypes, $windowsBase) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class SsUiaText {
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  const int DWMWA_CLOAKED = 14;
  const int MaxChars = 100000;

  static string Normalize(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    s = s.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
    if (s.Length > MaxChars) s = s.Substring(0, MaxChars);
    return s;
  }

  static int Total(List<string> parts) {
    int n = 0;
    foreach (string p in parts) n += p.Length;
    return n;
  }

  static bool IsCloaked(IntPtr hwnd) {
    int cloaked = 0;
    try {
      if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) != 0) return false;
    } catch {
      return false;
    }
    return cloaked != 0;
  }

  static bool OnScreenWindow(AutomationElement el) {
    IntPtr hwnd = IntPtr.Zero;
    try { hwnd = new IntPtr(el.Current.NativeWindowHandle); } catch { return false; }
    if (hwnd == IntPtr.Zero) return false;
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || IsCloaked(hwnd)) return false;
    try { if (el.Current.IsOffscreen) return false; } catch { }
    return true;
  }

  static void AddPart(List<string> parts, string text) {
    text = Normalize(text);
    if (text.Length == 0) return;
    if (Total(parts) >= MaxChars) return;
    int room = MaxChars - Total(parts);
    if (text.Length > room) text = text.Substring(0, room);
    parts.Add(text);
  }

  static bool TakeVisibleText(AutomationElement el, List<string> parts) {
    object pat;
    if (!el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) return false;
    TextPattern tp = (TextPattern)pat;
    TextPatternRange[] ranges = null;
    try { ranges = tp.GetVisibleRanges(); } catch { ranges = null; }
    if (ranges == null || ranges.Length == 0) return false;
    bool any = false;
    foreach (TextPatternRange r in ranges) {
      string t = "";
      try { t = r.GetText(MaxChars); } catch { t = ""; }
      if (!string.IsNullOrWhiteSpace(t)) {
        AddPart(parts, t);
        any = true;
      }
      if (Total(parts) >= MaxChars) break;
    }
    return any;
  }

  static void Walk(AutomationElement el, List<string> parts, int depth) {
    if (el == null || depth > 40 || Total(parts) >= MaxChars) return;
    try {
      if (el.Current.IsPassword) return;
      if (depth > 0 && el.Current.IsOffscreen) return;
    } catch {
      return;
    }

    bool took = false;
    try { took = TakeVisibleText(el, parts); } catch { took = false; }
    if (took) return;

    try {
      object pat;
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
        string v = ((ValuePattern)pat).Current.Value;
        if (!string.IsNullOrWhiteSpace(v)) AddPart(parts, v);
      }
    } catch { }

    try {
      string name = el.Current.Name;
      if (!string.IsNullOrWhiteSpace(name)) AddPart(parts, name);
    } catch { }

    AutomationElement child = null;
    try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { child = null; }
    int n = 0;
    while (child != null && n < 500 && Total(parts) < MaxChars) {
      Walk(child, parts, depth + 1);
      try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
      catch { break; }
      n++;
    }
  }

  static string JoinUnique(List<string> parts) {
    List<int> keep = new List<int>();
    List<int> order = new List<int>();
    for (int i = 0; i < parts.Count; i++) order.Add(i);
    order.Sort(delegate(int a, int b) {
      int c = parts[b].Length.CompareTo(parts[a].Length);
      if (c != 0) return c;
      return a.CompareTo(b);
    });
    foreach (int i in order) {
      bool dup = false;
      foreach (int k in keep) {
        if (parts[k].Length > parts[i].Length && parts[k].IndexOf(parts[i], StringComparison.Ordinal) >= 0) {
          dup = true;
          break;
        }
      }
      if (!dup) keep.Add(i);
    }
    keep.Sort();
    StringBuilder sb = new StringBuilder();
    foreach (int i in keep) {
      if (sb.Length > 0) sb.Append("\n\n");
      sb.Append(parts[i]);
      if (sb.Length >= MaxChars) break;
    }
    if (sb.Length > MaxChars) sb.Length = MaxChars;
    return sb.ToString().Trim();
  }

  public static void Run(string outPath) {
    List<string> parts = new List<string>();
    try {
      AutomationElement desktop = AutomationElement.RootElement;
      AutomationElementCollection windows = desktop.FindAll(TreeScope.Children, Condition.TrueCondition);
      foreach (AutomationElement win in windows) {
        if (!OnScreenWindow(win)) continue;
        Walk(win, parts, 0);
        if (Total(parts) >= MaxChars) break;
      }
    } catch { }

    string text = JoinUnique(parts);
    File.WriteAllText(outPath, text ?? "", new UTF8Encoding(false));
  }
}
"@

[SsUiaText]::Run($OutPath)
