using System;
using System.Diagnostics;
using System.Collections.Generic;

public static class Program {
  public static int Main(string[] args) {
    try {
      var psi = new ProcessStartInfo();
      psi.FileName = @"C:\Users\DH\AppData\Local\nodejs\node.exe";
      psi.WorkingDirectory = @"c:\Users\DH\Desktop\无限试用脚本\aiMCPTool\extension\mcp-helper";
      psi.UseShellExecute = false;
      psi.Arguments = JoinArgs(BuildArgs(args));
      using (var process = Process.Start(psi)) {
        process.WaitForExit();
        return process.ExitCode;
      }
    } catch (Exception ex) {
      Console.Error.WriteLine(ex.ToString());
      return 1;
    }
  }

  private static string[] BuildArgs(string[] args) {
    var list = new List<string>();
    list.Add(@"c:\Users\DH\Desktop\无限试用脚本\aiMCPTool\extension\mcp-helper\server.mjs");
    for (int i = 0; i < args.Length; i++) {
      list.Add(args[i]);
    }
    return list.ToArray();
  }

  private static string JoinArgs(string[] args) {
    var parts = new string[args.Length];
    for (int i = 0; i < args.Length; i++) {
      parts[i] = Quote(args[i]);
    }
    return string.Join(" ", parts);
  }

  private static string Quote(string arg) {
    if (string.IsNullOrEmpty(arg)) return "\"\"";
    if (arg.IndexOf(' ') < 0 && arg.IndexOf('\t') < 0 && arg.IndexOf('"') < 0) return arg;
    return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }
}