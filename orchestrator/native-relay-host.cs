using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

internal static class NativeRelayHost
{
    private static int Main(string[] args)
    {
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string configPath = Path.Combine(baseDir, "native-relay-host.config");
        string nodeExe = "node";
        string relayJs = Path.Combine(baseDir, "native-relay.js");

        if (File.Exists(configPath))
        {
            string[] lines = File.ReadAllLines(configPath, Encoding.UTF8);
            if (lines.Length > 0 && !string.IsNullOrWhiteSpace(lines[0]))
            {
                nodeExe = lines[0].Trim();
            }
            if (lines.Length > 1 && !string.IsNullOrWhiteSpace(lines[1]))
            {
                relayJs = lines[1].Trim();
            }
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = nodeExe;
        startInfo.Arguments = Quote(relayJs) + BuildPassthroughArgs(args);
        startInfo.WorkingDirectory = baseDir;
        startInfo.UseShellExecute = false;
        startInfo.RedirectStandardInput = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.CreateNoWindow = true;

        using (Process child = Process.Start(startInfo))
        {
            Thread stdinThread = new Thread(() => CopyStream(Console.OpenStandardInput(), child.StandardInput.BaseStream, true));
            Thread stdoutThread = new Thread(() => CopyStream(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
            Thread stderrThread = new Thread(() => CopyStream(child.StandardError.BaseStream, Console.OpenStandardError(), false));

            stdinThread.Start();
            stdoutThread.Start();
            stderrThread.Start();

            child.WaitForExit();
            stdoutThread.Join();
            stderrThread.Join();
            return child.ExitCode;
        }
    }

    private static void CopyStream(Stream input, Stream output, bool closeOutput)
    {
        byte[] buffer = new byte[81920];
        try
        {
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
                output.Flush();
            }
        }
        catch
        {
        }
        finally
        {
            if (closeOutput)
            {
                try { output.Close(); } catch { }
            }
        }
    }

    private static string BuildPassthroughArgs(string[] args)
    {
        if (args == null || args.Length == 0)
        {
            return string.Empty;
        }

        StringBuilder builder = new StringBuilder();
        foreach (string arg in args)
        {
            builder.Append(' ');
            builder.Append(Quote(arg));
        }
        return builder.ToString();
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
